#pragma once
#include "MobileJournal.h"
#include "MobileWebServer.h"
#include <esp_system.h>

class MobileApi {
  rescue_mobile::NvsJournal journal;
  rescue_mobile::MobileQueue queue{journal};
  MobileWebServer &server;
  uint8_t node;
  bool radioReady = false;
  bool meshStarted = false, meshSynchronized = false, gatewayFound = false;
  uint16_t meshAddress = 0, gatewayAddress = 0;
  size_t routes = 0;
  uint32_t deliveredSos = 0;
  char lastAck[33]{};
  void reply(int code, const JsonDocument &doc) {
    char response[512];
    if (measureJson(doc) >= sizeof(response)) { error(503, "response_unavailable"); return; }
    serializeJson(doc, response, sizeof(response)); server.send(code, "application/json", response);
  }
  void error(int code, const char *reason) {
    StaticJsonDocument<256> doc;
    doc["service"] = "rescuenet-field-node"; doc["accepted"] = false; doc["error"] = reason;
    char response[512]; serializeJson(doc, response, sizeof(response));
    server.send(code, "application/json", response);
    Serial.printf("[MOBILE API] rejected: %s\n", reason);
  }
  void post(bool sos) {
    rescue_mobile::Message message;
    const char *invalid = rescue_mobile::parseMessage(server.mobileBody(), server.mobileBodySize(), sos, message);
    if (invalid) { error(400, invalid); return; }
    const auto &headers = server.mobileHeaders();
    if (headers.hasIdempotencyKey && strcmp(headers.idempotencyKey, message.requestId)) { error(400, "idempotency_key_mismatch"); return; }
    if (!radioReady) { error(503, "radio_unavailable"); return; }
    if (!rescue_mobile::digestMessage(message)) { error(503, "digest_unavailable"); return; }
    auto result = queue.accept(message, millis());
    if (result.error) { error(result.code, result.error); return; }
    StaticJsonDocument<512> doc;
    doc["service"] = "rescuenet-field-node"; doc["accepted"] = true;
    doc["request_id"] = message.requestId; doc["node_id"] = node;
    doc["state"] = result.state; doc["duplicate"] = result.duplicate; doc["name_truncated"] = message.nameTruncated;
    reply(result.code, doc);
    Serial.printf("[MOBILE %s] %s request=%s pending_sos=%u pending_location=%u\n", sos ? "SOS" : "LOCATION",
      result.duplicate ? "duplicate" : result.coalesced ? "coalesced" : "accepted", message.requestId,
      unsigned(queue.pendingSos()), unsigned(queue.pendingLocations()));
  }
public:
  MobileApi(MobileWebServer &web, uint8_t id) : server(web), node(id) {}
  void begin(bool radio) {
    radioReady = radio;
    uint64_t boot;
    do { boot = (uint64_t(esp_random()) << 32) | esp_random(); } while (!boot);
    bool ready = queue.begin(node, boot);
    Serial.printf("[MOBILE QUEUE] %s recovered_sos=%u static_bytes=%u free_heap=%u\n",
      ready ? "ready" : "storage fault", unsigned(queue.pendingSos()), unsigned(sizeof(*this)), unsigned(ESP.getFreeHeap()));
    server.on("/api/status", HTTP_GET, [this]() { status(); });
    server.on("/api/location", HTTP_POST, [this]() { post(false); });
    server.on("/api/sos", HTTP_POST, [this]() { post(true); });
  }
  void status() {
    StaticJsonDocument<768> doc;
    doc["service"] = "rescuenet-field-node"; doc["api_version"] = 1; doc["node_id"] = node;
    doc["device"] = "field_node"; doc["status"] = radioReady && queue.ready() && meshStarted ? "ready" : "degraded";
    doc["mobile_protocol"] = 1;
    doc["mobile_tx_enabled"] = true;
    doc["pending_sos"] = queue.pendingSos(); doc["pending_locations"] = queue.pendingLocations();
    doc["sos_capacity"] = rescue_mobile::SOS_CAPACITY; doc["location_capacity"] = rescue_mobile::LOCATION_CAPACITY;
    doc["mesh_enabled"] = true; doc["mesh_started"] = meshStarted;
    doc["mesh_synchronized"] = meshSynchronized; doc["mesh_address"] = meshAddress;
    doc["gateway_found"] = gatewayFound; doc["gateway_address"] = gatewayAddress;
    doc["route_count"] = routes; doc["delivered_sos_count"] = deliveredSos;
    doc["last_server_ack"] = lastAck[0] ? lastAck : nullptr;
    reply(200, doc);
  }
  const rescue_mobile::Message *nextPending() const { return queue.nextPending(); }
  bool completeStored(const uint8_t key[16]) {
    const rescue_mobile::Message *message = queue.nextPending();
    bool sos = message && message->kind == 'S' && memcmp(message->digest, key, 16) == 0;
    bool completed = queue.completeStored(key);
    if (completed) {
      if (sos) ++deliveredSos;
      static const char *hex = "0123456789abcdef";
      for (int i = 0; i < 16; ++i) { lastAck[2*i] = hex[key[i] >> 4]; lastAck[2*i+1] = hex[key[i] & 15]; }
      lastAck[32] = 0;
    }
    return completed;
  }
  void meshStatus(bool started, bool synchronized, uint16_t address, bool found, uint16_t gateway, size_t routeCount) {
    meshStarted = started; meshSynchronized = synchronized; meshAddress = address;
    gatewayFound = found; gatewayAddress = gateway; routes = routeCount;
  }
};
