#pragma once
#include <loramesher.hpp>
#include <memory>
#include <vector>
#include <mbedtls/sha256.h>
#include "MobileApi.h"
#include "RescueNetWire.h"
#include "LegacyReportQueue.h"

class RescueNetMeshTransport {
  MobileApi &api;
  uint8_t node;
  std::unique_ptr<loramesher::LoraMesher> mesh;
  struct Received { loramesher::AddressType source; uint8_t size; uint8_t data[rnwire::MAX_PACKET]; };
  QueueHandle_t received = nullptr;
  rescue_legacy::ReportQueue legacyQueue;
  uint8_t inflight[16]{};
  bool hasInflight = false;
  uint32_t attemptedAt = 0;
  uint32_t attempts = 0;
  uint32_t retryDelayMs = 5000;
  uint32_t lastDiagnostic = 0;
  uint32_t lastStatusUpdate = 0;
  uint32_t lastLegacyDiagnostic = 0;
  uint32_t lastHeartbeatAt = 0;
  size_t cachedRouteCount = 0;
public:
  RescueNetMeshTransport(MobileApi &mobile, uint8_t id) : api(mobile), node(id) {}
  bool begin(bool radioPowered) {
    if (!radioPowered) { Serial.println("[MESH] ALDO2 unavailable"); return false; }
    received = xQueueCreate(8, sizeof(Received));
    if (!received || !legacyQueue.begin(node)) {
      Serial.println("[LEGACY JOURNAL] unavailable; captive portal reports will be rejected safely");
      if (received) { vQueueDelete(received); received = nullptr; }
      return false;
    }
    Serial.printf("[LEGACY JOURNAL] ready recovered_normal=%u recovered_sos=%u capacity_normal=%u capacity_sos=%u\n",
      unsigned(legacyQueue.pendingNormal()), unsigned(legacyQueue.pendingSos()),
      unsigned(rescue_legacy::NORMAL_CAPACITY), unsigned(rescue_legacy::SOS_CAPACITY));
    loramesher::RadioConfig radio(loramesher::RadioType::kSx1276, 923.0F, 9, 125.0F, 5, 17, 0xF3, true, 8);
    loramesher::PinConfig pins(18, 23, 26, 33, 5, 19, 27);
    loramesher::LoRaMeshProtocolConfig protocol;
    protocol.setNodeRole(loramesher::NodeRole::NODE_ONLY); protocol.setMaxPacketSize(115);
    mesh = loramesher::LoraMesher::Builder().withRadioConfig(radio).withPinConfig(pins).withLoRaMeshProtocol(protocol).Build();
    mesh->SetDataCallback([this](loramesher::AddressType source, const std::vector<uint8_t> &data) {
      if (data.empty() || data.size() > rnwire::MAX_PACKET) return;
      Received item{}; item.source = source; item.size = uint8_t(data.size());
      memcpy(item.data, data.data(), data.size()); xQueueSend(received, &item, 0);
    });
    auto result = mesh->Start();
    if (!result) { Serial.printf("[MESH] start failed: %s\n", result.GetErrorMessage().c_str()); mesh.reset(); return false; }
    Serial.printf("[MESH] started address=%u\n", unsigned(mesh->GetNodeAddress()));
    return true;
  }
  bool enqueueLegacy(const rnwire::Legacy &report) {
    if (!legacyQueue.enqueue(report)) return false;
    Serial.printf("[LEGACY QUEUED] uptime_ms=%lu packet_id=%u sos=%u normal_pending=%u sos_pending=%u\n",
      (unsigned long)millis(), unsigned(report.packetId), unsigned((report.flags >> 1) & 1),
      unsigned(legacyQueue.pendingNormal()), unsigned(legacyQueue.pendingSos()));
    return true;
  }
  void tick() {
    if (!mesh) return;
    auto status = mesh->GetNetworkStatus();
    auto gateway = mesh->GetClosestGateway();
    if (!lastStatusUpdate || uint32_t(millis() - lastStatusUpdate) >= 1000) {
      cachedRouteCount = mesh->GetRoutingTable().size();
      lastStatusUpdate = millis();
    }
    api.meshStatus(true, status.is_synchronized, mesh->GetNodeAddress(), bool(gateway), gateway ? gateway->destination : 0, cachedRouteCount);
    if (!lastDiagnostic || uint32_t(millis() - lastDiagnostic) > 10000) {
      if (gateway) {
        Serial.printf("[MESH] gateway found address=%u hops=%u synced=%d\n", unsigned(gateway->destination), unsigned(gateway->hop_count), int(status.is_synchronized));
      } else {
        Serial.printf("[MESH] searching for gateway... synced=%d routes=%u\n", int(status.is_synchronized), unsigned(cachedRouteCount));
      }
      lastDiagnostic = millis();
    }
    Received item;
    for (int i = 0; i < 4 && xQueueReceive(received, &item, 0) == pdTRUE; ++i) {
      rnwire::Ack ack;
      if (!gateway || item.source != gateway->destination || !rnwire::decodeAck(item.data, item.size, ack)) continue;
      char key[33]; rnwire::hexKey(ack.key, key);
      Serial.printf("[SERVER ACK] key=%s status=STORED\n", key);
      if (api.completeStored(ack.key)) {
        Serial.printf("[MOBILE QUEUE] completed request=%s\n", key);
        if (hasInflight && !memcmp(inflight, ack.key, 16)) hasInflight = false;
      } else if (legacyQueue.confirm(ack.key)) {
        Serial.printf("[LEGACY STORED] key=%s pending_normal=%u pending_sos=%u\n", key,
          unsigned(legacyQueue.pendingNormal()), unsigned(legacyQueue.pendingSos()));
      }
    }
    const size_t queuedLegacy = legacyQueue.pendingNormal() + legacyQueue.pendingSos();
    if (!gateway || !status.is_synchronized) {
      if (queuedLegacy && (!lastLegacyDiagnostic || uint32_t(millis() - lastLegacyDiagnostic) >= 5000)) {
        const char *reason = !gateway ? "Gateway not discovered" : "mesh not synchronized";
        Serial.printf("[LEGACY WAIT] normal_pending=%u sos_pending=%u in_flight=%u reason=%s synced=%u routes=%u\n",
          unsigned(legacyQueue.pendingNormal()), unsigned(legacyQueue.pendingSos()),
          0U, reason, unsigned(status.is_synchronized), unsigned(cachedRouteCount));
        lastLegacyDiagnostic = millis();
      }
      return;
    }
    // IsReadyToSend() is a conservative prediction. LoRaMesher::Send() can
    // still queue a direct one-hop packet when the route lookup has not caught
    // up with gateway discovery. Let Send() decide, with the retry timer below
    // bounding attempts instead of blocking the first report for minutes.
    auto readiness = mesh->IsReadyToSend(gateway->destination);
    if (!readiness && queuedLegacy &&
        (!lastLegacyDiagnostic || uint32_t(millis() - lastLegacyDiagnostic) >= 5000)) {
      Serial.printf("[MESH READINESS] gateway=%u reason=%s state=%u tx_slots=%u tx_queue=%u; trying bounded send\n",
        unsigned(gateway->destination), readiness.GetErrorMessage().c_str(),
        unsigned(status.current_state), unsigned(mesh->GetDataSlotsPerSuperframe()),
        unsigned(mesh->GetTxQueueSize()));
      lastLegacyDiagnostic = millis();
    }
    rescue_mobile::Message pendingCopy{};
    const bool hasMobilePending = api.copyNextPending(pendingCopy);
    const rescue_mobile::Message *pending = hasMobilePending ? &pendingCopy : nullptr;
    const size_t txQueueDepth = mesh->GetTxQueueSize();
    if (txQueueDepth >= 8) {
      if ((queuedLegacy || hasMobilePending) &&
          (!lastLegacyDiagnostic || uint32_t(millis() - lastLegacyDiagnostic) >= 5000)) {
        Serial.printf("[MESH BACKPRESSURE] tx_queue=%u/10; reports remain queued locally until radio backlog drains\n",
          unsigned(txQueueDepth));
        lastLegacyDiagnostic = millis();
      }
      return;
    }
    // Preserve cross-queue SOS priority: a captive-portal SOS may bypass a
    // waiting mobile LOCATION, while a mobile SOS still goes first.
    if (pending && (pending->kind == 'S' || legacyQueue.pendingSos() == 0)) {
      bool changed = !hasInflight || memcmp(inflight, pending->digest, 16);
      const bool retryDue = !changed && uint32_t(millis() - attemptedAt) >= retryDelayMs;
      // A successful Send() only means that the library accepted the frame,
      // not that it reached the radio. Avoid filling its 10-entry TX queue
      // with duplicate application retries while the original is still queued.
      if (retryDue && txQueueDepth > 2) return;
      if (changed || retryDue) {
        if (changed) { attempts = 0; retryDelayMs = 5000; memcpy(inflight, pending->digest, 16); hasInflight = true; }
        rnwire::Mobile event{};
        event.kind = pending->kind == 'S' ? 2 : 1; event.node = node;
        event.flags = pending->hasGps ? 1 : 0;
        if (pending->hasGps && pending->accuracyKnown) event.flags |= 2;
        size_t nameBytes = rnwire::utf8Prefix(pending->name, rnwire::MAX_NAME);
        if (strlen(pending->name) > nameBytes) event.flags |= 4;
        memcpy(event.name, pending->name, nameBytes); event.name[nameBytes] = 0;
        memcpy(event.key, pending->digest, 16);
        uint8_t digest[32];
        mbedtls_sha256(reinterpret_cast<const uint8_t *>(pending->userId), strlen(pending->userId), digest, 0);
        memcpy(event.user, digest, 8);
        event.eventTime = pending->eventTime;
        if (pending->hasGps) {
          event.fixTime = pending->fixTime;
          event.latE6 = int32_t(llround(pending->lat * 1000000.0));
          event.lonE6 = int32_t(llround(pending->lon * 1000000.0));
          event.accuracyDm = pending->accuracyKnown ? uint16_t(lround(pending->accuracy * 10.0)) : 0xffff;
        }
        uint8_t packet[rnwire::MAX_PACKET]; size_t n = rnwire::encodeMobile(event, packet);
        attemptedAt = millis(); ++attempts;
        char key[33]; rnwire::hexKey(event.key, key);
        Serial.printf("[MOBILE TX] request=%s type=%s attempt=%u\n", key, event.kind == 2 ? "SOS" : "LOCATION", unsigned(attempts));
        if (n) {
          auto result = mesh->Send(gateway->destination, std::vector<uint8_t>(packet, packet + n));
          if (result) {
            // Retry unconfirmed SOS quickly; routine locations keep more
            // breathing room on the shared LoRa airtime.
            retryDelayMs = pending->kind == 'S' ? 15000U : 60000U;
            Serial.println("[MOBILE TX] queued by mesher; awaiting server STORED ACK");
          } else {
            if (attempts > 1 && retryDelayMs < 40000U) retryDelayMs *= 2;
            if (retryDelayMs > 40000U) retryDelayMs = 40000U;
            Serial.printf("[MOBILE TX] mesher rejected; retained for retry backoff_ms=%u reason=%s\n",
              unsigned(retryDelayMs), result.GetErrorMessage().c_str());
          }
        }
        return; // One application TX decision per loop iteration.
      }
    }
    else hasInflight = false;
    rescue_legacy::Pending nextReport{};
    // A pending mobile LOCATION must not reserve the only legacy in-flight
    // slot and thereby block a captive-portal SOS behind an already accepted
    // normal report. Temporarily allow one urgent portal SOS past that limit.
    const size_t legacyInFlightLimit = legacyQueue.pendingSos() > 0
      ? 3
      : (hasMobilePending ? 1 : 2);
    if (!legacyQueue.next(millis(), txQueueDepth, legacyInFlightLimit, nextReport)) {
      // Liveness is deliberately below every report and is emitted only when
      // the local and LoRaMesher queues are empty. 60 s avoids radio chatter.
      if (queuedLegacy || hasMobilePending || txQueueDepth != 0 ||
          (lastHeartbeatAt && uint32_t(millis() - lastHeartbeatAt) < 60000U)) return;
      rnwire::Heartbeat heartbeat{};
      heartbeat.node = node; heartbeat.meshSynced = status.is_synchronized;
      heartbeat.gatewayFound = bool(gateway);
      heartbeat.uptimeSeconds = millis() / 1000U;
      size_t pending = queuedLegacy + api.pendingCount();
      heartbeat.pendingCount = uint16_t(pending > 65535 ? 65535 : pending);
      uint8_t frame[rnwire::MAX_PACKET]; const size_t size = rnwire::encodeHeartbeat(heartbeat, frame);
      lastHeartbeatAt = millis();
      if (size) {
        auto result = mesh->Send(gateway->destination, std::vector<uint8_t>(frame, frame + size));
        if (result) Serial.printf("[HEARTBEAT TX] node=%u uptime=%u pending=%u enqueued; low priority\n",
          unsigned(node), unsigned(heartbeat.uptimeSeconds), unsigned(heartbeat.pendingCount));
        else Serial.printf("[HEARTBEAT WAIT] mesh rejected reason=%s\n", result.GetErrorMessage().c_str());
      }
      return;
    }
    rnwire::Legacy report{};
    if (!rnwire::decodeLegacy(nextReport.data, nextReport.size, report)) {
      Serial.printf("[LEGACY JOURNAL] invalid in-memory record slot=%u; retained for inspection\n",
        unsigned(nextReport.slot));
      return;
    }
    auto result = mesh->Send(gateway->destination,
      std::vector<uint8_t>(nextReport.data, nextReport.data + nextReport.size));
    legacyQueue.attempted(nextReport, bool(result), millis());
    char keyHex[33]; rnwire::hexKey(nextReport.key, keyHex);
    if (result) Serial.printf("[LEGACY TX] uptime_ms=%lu key=%s packet_id=%u sos=%u mesh_enqueued dst=%u queue=%u; STORED ACK pending\n",
      (unsigned long)millis(), keyHex, unsigned(report.packetId), unsigned((report.flags >> 1) & 1),
      unsigned(gateway->destination), unsigned(mesh->GetTxQueueSize()));
    else Serial.printf("[LEGACY TX] uptime_ms=%lu key=%s packet_id=%u retained; retry backoff reason=%s queue=%u\n",
      (unsigned long)millis(), keyHex, unsigned(report.packetId), result.GetErrorMessage().c_str(), unsigned(txQueueDepth));
  }
};
