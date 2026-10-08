#pragma once
#include <loramesher.hpp>
#include <memory>
#include <vector>
#include <mbedtls/sha256.h>
#include "MobileApi.h"
#include "RescueNetWire.h"

class RescueNetMeshTransport {
  MobileApi &api;
  uint8_t node;
  std::unique_ptr<loramesher::LoraMesher> mesh;
  struct Received { loramesher::AddressType source; uint8_t size; uint8_t data[rnwire::MAX_PACKET]; };
  QueueHandle_t received = nullptr;
  struct LegacyItem { uint8_t size; uint8_t data[rnwire::MAX_PACKET]; };
  QueueHandle_t legacy = nullptr;
  QueueHandle_t legacySos = nullptr;
  uint8_t inflight[16]{};
  bool hasInflight = false;
  uint32_t attemptedAt = 0;
  uint32_t attempts = 0;
  uint32_t lastDiagnostic = 0;
  uint32_t lastStatusUpdate = 0;
  size_t cachedRouteCount = 0;
public:
  RescueNetMeshTransport(MobileApi &mobile, uint8_t id) : api(mobile), node(id) {}
  bool begin(bool radioPowered) {
    if (!radioPowered) { Serial.println("[MESH] ALDO2 unavailable"); return false; }
    received = xQueueCreate(8, sizeof(Received)); legacy = xQueueCreate(8, sizeof(LegacyItem)); legacySos = xQueueCreate(2, sizeof(LegacyItem));
    if (!received || !legacy || !legacySos) return false;
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
    if (!legacy) return false;
    LegacyItem item{}; size_t n = rnwire::encodeLegacy(report, item.data);
    if (!n) return false;
    item.size = uint8_t(n);
    return xQueueSend((report.flags & 2) ? legacySos : legacy, &item, 0) == pdTRUE;
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
      Serial.printf("[SERVER ACK] request=%s status=STORED\n", key);
      if (api.completeStored(ack.key)) {
        Serial.printf("[MOBILE QUEUE] completed request=%s\n", key);
        if (hasInflight && !memcmp(inflight, ack.key, 16)) hasInflight = false;
      }
    }
    if (!gateway || !status.is_synchronized || !mesh->IsReadyToSend(gateway->destination)) return;
    const rescue_mobile::Message *pending = api.nextPending();
    if (pending) {
      bool changed = !hasInflight || memcmp(inflight, pending->digest, 16);
      if (changed || uint32_t(millis() - attemptedAt) >= 15000) {
        if (changed) { attempts = 0; memcpy(inflight, pending->digest, 16); hasInflight = true; }
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
        if (n && mesh->Send(gateway->destination, std::vector<uint8_t>(packet, packet + n)))
          Serial.println("[MOBILE TX] queued by mesher; awaiting server STORED ACK");
        return; // One application TX decision per loop iteration.
      }
    }
    else hasInflight = false;
    LegacyItem report;
    QueueHandle_t selected = uxQueueMessagesWaiting(legacySos) ? legacySos : legacy;
    if (xQueueReceive(selected, &report, 0) == pdTRUE) {
      auto result = mesh->Send(gateway->destination, std::vector<uint8_t>(report.data, report.data + report.size));
      if (!result) xQueueSendToFront(selected, &report, 0);
    }
  }
};
