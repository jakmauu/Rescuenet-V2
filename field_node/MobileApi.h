#pragma once
#include "MobileJournal.h"
#include "MobileWebServer.h"
#include <esp_system.h>
#include <esp_heap_caps.h>
#include <esp_https_server.h>
#include <esp_tls_errors.h>
#include <mbedtls/ssl.h>
#include <freertos/FreeRTOS.h>
#include <freertos/semphr.h>
#include "tls_secrets.h"

class MobileApi {
  rescue_mobile::NvsJournal journal;
  rescue_mobile::MobileQueue queue{journal};
  MobileWebServer &server;
  SemaphoreHandle_t queueMutex = nullptr;
  httpd_handle_t httpsHandle = nullptr;
  bool tlsErrorHandlerRegistered = false;
  uint8_t node;
  bool radioReady = false;
  bool meshStarted = false, meshSynchronized = false, gatewayFound = false;
  uint16_t meshAddress = 0, gatewayAddress = 0;
  size_t routes = 0;
  uint32_t deliveredSos = 0;
  char lastAck[33]{};
  void lockQueue() const { if (queueMutex) xSemaphoreTake(queueMutex, portMAX_DELAY); }
  void unlockQueue() const { if (queueMutex) xSemaphoreGive(queueMutex); }
  static esp_err_t secureStatus(httpd_req_t *request) {
    return static_cast<MobileApi *>(request->user_ctx)->secureApi(request, true);
  }
  static esp_err_t secureLocation(httpd_req_t *request) {
    return static_cast<MobileApi *>(request->user_ctx)->secureApi(request, false);
  }
  static const char *statusText(int code) {
    switch (code) {
      case 200: return "200 OK"; case 202: return "202 Accepted";
      case 204: return "204 No Content"; case 400: return "400 Bad Request";
      case 403: return "403 Forbidden"; case 404: return "404 Not Found";
      case 405: return "405 Method Not Allowed"; case 409: return "409 Conflict";
      case 413: return "413 Payload Too Large"; case 415: return "415 Unsupported Media Type";
      default: return "503 Service Unavailable";
    }
  }
  static bool header(httpd_req_t *request, const char *name, char *out, size_t capacity) {
    if (!capacity) return false;
    out[0] = 0;
    return httpd_req_get_hdr_value_str(request, name, out, capacity) == ESP_OK;
  }
  static bool allowedOrigin(const char *origin) {
    return !origin[0] || !strcmp(origin, "https://jakmauu.github.io");
  }
  static const char *tlsErrorClass(const esp_https_server_last_error_t &error) {
    if (error.last_error == ESP_ERR_NO_MEM) return "memory allocation failed";
    if (error.last_error == ESP_ERR_ESP_TLS_SERVER_HANDSHAKE_TIMEOUT) return "server handshake timeout";
    if (error.esp_tls_error_code == MBEDTLS_ERR_SSL_CONN_EOF) return "client closed connection during TLS handshake (EOF)";
    if (error.esp_tls_error_code == MBEDTLS_ERR_SSL_FATAL_ALERT_MESSAGE)
      return "peer sent a fatal TLS alert; alert description is not exposed by this callback";
    return "TLS/socket error; inspect numeric ESP-TLS and mbedTLS codes";
  }
  static void onHttpsError(void *, esp_event_base_t eventBase, int32_t eventId, void *eventData) {
    if (eventBase != ESP_HTTPS_SERVER_EVENT || eventId != HTTPS_SERVER_EVENT_ERROR || !eventData) return;
    const auto &error = *static_cast<const esp_https_server_last_error_t *>(eventData);
    const int64_t tlsCode = error.esp_tls_error_code;
    const char *tlsSign = tlsCode < 0 ? "-" : "";
    const uint32_t tlsMagnitude = uint32_t(tlsCode < 0 ? -tlsCode : tlsCode);
    Serial.printf("[HTTPS ERROR] class=%s esp=%s(0x%08x) tls=%s0x%04x(%d) cert_flags=0x%08x heap_internal=%u largest_internal=%u min_internal=%u\n",
      tlsErrorClass(error), esp_err_to_name(error.last_error), unsigned(error.last_error),
      tlsSign, unsigned(tlsMagnitude), error.esp_tls_error_code, unsigned(error.esp_tls_flags),
      unsigned(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
      unsigned(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
      unsigned(heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
  }
  static bool validRequestedHeaders(char *headers) {
    for (char *part = headers; part && *part;) {
      while (*part == ' ' || *part == '\t' || *part == ',') ++part;
      if (!*part) break;
      char *end = strchr(part, ',');
      if (end) *end = 0;
      size_t n = strlen(part);
      while (n && (part[n - 1] == ' ' || part[n - 1] == '\t')) part[--n] = 0;
      for (char *c = part; *c; ++c) *c = char(tolower(uint8_t(*c)));
      if (strcmp(part, "accept") && strcmp(part, "content-type") && strcmp(part, "idempotency-key")) return false;
      if (!end) break;
      part = end + 1;
    }
    return true;
  }
  esp_err_t secureSend(httpd_req_t *request, int code, const char *body, bool cors) {
    httpd_resp_set_status(request, statusText(code));
    httpd_resp_set_type(request, "application/json");
    httpd_resp_set_hdr(request, "Cache-Control", "no-store");
    if (cors) {
      httpd_resp_set_hdr(request, "Access-Control-Allow-Origin", "https://jakmauu.github.io");
      httpd_resp_set_hdr(request, "Vary", "Origin");
    }
    return httpd_resp_send(request, body, HTTPD_RESP_USE_STRLEN);
  }
  int acceptMobile(bool sos, char *body, size_t size, const char *idempotency,
                   char *response, size_t capacity) {
    rescue_mobile::Message message;
    const char *invalid = rescue_mobile::parseMessage(body, size, sos, message);
    if (invalid) {
      snprintf(response, capacity, "{\"service\":\"rescuenet-field-node\",\"accepted\":false,\"error\":\"%s\"}", invalid);
      return 400;
    }
    if (idempotency[0] && strcmp(idempotency, message.requestId)) {
      snprintf(response, capacity, "{\"service\":\"rescuenet-field-node\",\"accepted\":false,\"error\":\"idempotency_key_mismatch\"}");
      return 400;
    }
    if (!radioReady || !rescue_mobile::digestMessage(message)) {
      snprintf(response, capacity, "{\"service\":\"rescuenet-field-node\",\"accepted\":false,\"error\":\"radio_unavailable\"}");
      return 503;
    }
    lockQueue();
    auto result = queue.accept(message, millis());
    const unsigned pendingSos = unsigned(queue.pendingSos());
    const unsigned pendingLocation = unsigned(queue.pendingLocations());
    unlockQueue();
    if (result.error) {
      snprintf(response, capacity, "{\"service\":\"rescuenet-field-node\",\"accepted\":false,\"error\":\"%s\"}", result.error);
      return result.code;
    }
    StaticJsonDocument<512> doc;
    doc["service"] = "rescuenet-field-node"; doc["accepted"] = true;
    doc["request_id"] = message.requestId; doc["node_id"] = node;
    doc["state"] = result.state; doc["duplicate"] = result.duplicate; doc["name_truncated"] = message.nameTruncated;
    serializeJson(doc, response, capacity);
    Serial.printf("[MOBILE %s] %s request=%s pending_sos=%u pending_location=%u\n", sos ? "SOS" : "LOCATION",
      result.duplicate ? "duplicate" : result.coalesced ? "coalesced" : "accepted", message.requestId,
      pendingSos, pendingLocation);
    return result.code;
  }
  esp_err_t secureApi(httpd_req_t *request, bool statusRoute) {
    char origin[128]{}, requestedHeaders[160]{};
    const size_t originLength = httpd_req_get_hdr_value_len(request, "Origin");
    if (originLength >= sizeof(origin) || (originLength && !header(request, "Origin", origin, sizeof(origin))))
      return secureSend(request, 403, "{\"service\":\"rescuenet-field-node\",\"accepted\":false,\"error\":\"invalid_origin\"}", false);
    const bool hasOrigin = originLength != 0;
    if (!allowedOrigin(origin)) return secureSend(request, 403,
      "{\"service\":\"rescuenet-field-node\",\"accepted\":false,\"error\":\"origin_not_allowed\"}", false);
    const bool cors = hasOrigin && origin[0];
    if (request->method == HTTP_OPTIONS) {
      char method[16]{};
      const bool gotMethod = header(request, "Access-Control-Request-Method", method, sizeof(method));
      header(request, "Access-Control-Request-Headers", requestedHeaders, sizeof(requestedHeaders));
      const bool validMethod = gotMethod && ((statusRoute && !strcmp(method, "GET")) || (!statusRoute && !strcmp(method, "POST")));
      if (!cors || !validMethod || !validRequestedHeaders(requestedHeaders) || request->content_len)
        return secureSend(request, 403, "{\"service\":\"rescuenet-field-node\",\"accepted\":false,\"error\":\"invalid_cors_preflight\"}", false);
      httpd_resp_set_status(request, statusText(204));
      httpd_resp_set_hdr(request, "Access-Control-Allow-Origin", "https://jakmauu.github.io");
      httpd_resp_set_hdr(request, "Access-Control-Allow-Methods", statusRoute ? "GET, OPTIONS" : "POST, OPTIONS");
      httpd_resp_set_hdr(request, "Access-Control-Allow-Headers", "Accept, Content-Type, Idempotency-Key");
      httpd_resp_set_hdr(request, "Access-Control-Allow-Private-Network", "true");
      httpd_resp_set_hdr(request, "Access-Control-Max-Age", "600");
      httpd_resp_set_hdr(request, "Vary", "Origin");
      return httpd_resp_send(request, nullptr, 0);
    }
    if (statusRoute && request->method == HTTP_GET) {
      StaticJsonDocument<768> doc;
      lockQueue();
      doc["service"] = "rescuenet-field-node"; doc["api_version"] = 1; doc["node_id"] = node;
      doc["device"] = "field_node"; doc["status"] = radioReady && queue.ready() && meshStarted ? "ready" : "degraded";
      doc["mobile_protocol"] = 1; doc["mobile_tx_enabled"] = true;
      doc["pending_sos"] = queue.pendingSos(); doc["pending_locations"] = queue.pendingLocations();
      doc["sos_capacity"] = rescue_mobile::SOS_CAPACITY; doc["location_capacity"] = rescue_mobile::LOCATION_CAPACITY;
      doc["mesh_enabled"] = true; doc["mesh_started"] = meshStarted;
      doc["mesh_synchronized"] = meshSynchronized; doc["mesh_address"] = meshAddress;
      doc["gateway_found"] = gatewayFound; doc["gateway_address"] = gatewayAddress;
      doc["route_count"] = routes; doc["delivered_sos_count"] = deliveredSos;
      doc["last_server_ack"] = lastAck[0] ? lastAck : nullptr;
      unlockQueue();
      char response[768]; serializeJson(doc, response, sizeof(response));
      return secureSend(request, 200, response, cors) == ESP_OK ? ESP_OK : ESP_FAIL;
    }
    if (statusRoute || request->method != HTTP_POST) return secureSend(request, 405,
      "{\"service\":\"rescuenet-field-node\",\"accepted\":false,\"error\":\"method_not_allowed\"}", cors);
    if (!request->content_len || request->content_len > rescue_mobile::BODY_LIMIT) return secureSend(request,
      request->content_len ? 413 : 400,
      "{\"service\":\"rescuenet-field-node\",\"accepted\":false,\"error\":\"invalid_body_size\"}", cors);
    char contentType[96]{};
    if (!header(request, "Content-Type", contentType, sizeof(contentType)) || strncasecmp(contentType, "application/json", 16)
        || (contentType[16] && contentType[16] != ';'))
      return secureSend(request, 415, "{\"service\":\"rescuenet-field-node\",\"accepted\":false,\"error\":\"unsupported_media_type\"}", cors);
    char idempotency[48]{};
    const size_t idempotencyLength = httpd_req_get_hdr_value_len(request, "Idempotency-Key");
    if (idempotencyLength > 40 || (idempotencyLength && !header(request, "Idempotency-Key", idempotency, sizeof(idempotency))))
      return secureSend(request, 400, "{\"service\":\"rescuenet-field-node\",\"accepted\":false,\"error\":\"invalid_idempotency_key\"}", cors);
    char body[rescue_mobile::BODY_LIMIT + 1]{};
    size_t received = 0;
    while (received < request->content_len) {
      int count = httpd_req_recv(request, body + received, request->content_len - received);
      if (count <= 0) return secureSend(request, 400,
        "{\"service\":\"rescuenet-field-node\",\"accepted\":false,\"error\":\"body_receive_failed\"}", cors);
      received += size_t(count);
    }
    char response[512]{};
    int code = acceptMobile(strcmp(request->uri, "/api/sos") == 0, body, received, idempotency, response, sizeof(response));
    return secureSend(request, code, response, cors) == ESP_OK ? ESP_OK : ESP_FAIL;
  }
  void reply(int code, const JsonDocument &doc) {
    char response[512];
    if (measureJson(doc) >= sizeof(response)) { error(503, "response_unavailable"); return; }
    serializeJson(doc, response, sizeof(response));
    server.send(code, "application/json", response);
  }
  void error(int code, const char *reason) {
    StaticJsonDocument<256> doc;
    doc["service"] = "rescuenet-field-node"; doc["accepted"] = false; doc["error"] = reason;
    char response[512]; serializeJson(doc, response, sizeof(response));
    server.send(code, "application/json", response);
    Serial.printf("[MOBILE API] rejected: %s\n", reason);
  }
  void post(bool sos) {
    char response[512]{};
    const auto &headers = server.mobileHeaders();
    int code = acceptMobile(sos, server.mobileBody(), server.mobileBodySize(),
      headers.hasIdempotencyKey ? headers.idempotencyKey : "", response, sizeof(response));
    server.send(code, "application/json", response);
  }
public:
  MobileApi(MobileWebServer &web, uint8_t id) : server(web), node(id) {}
  void begin(bool radio) {
    queueMutex = xSemaphoreCreateMutex();
    radioReady = radio;
    uint64_t boot;
    do { boot = (uint64_t(esp_random()) << 32) | esp_random(); } while (!boot);
    bool ready = queueMutex && queue.begin(node, boot);
    Serial.printf("[MOBILE QUEUE] %s recovered_sos=%u static_bytes=%u free_heap=%u\n",
      ready ? "ready" : "storage fault", unsigned(queue.pendingSos()), unsigned(sizeof(*this)), unsigned(ESP.getFreeHeap()));
    server.on("/api/status", HTTP_GET, [this]() { status(); });
    server.on("/api/location", HTTP_POST, [this]() { post(false); });
    server.on("/api/sos", HTTP_POST, [this]() { post(true); });
  }
  bool beginHttps() {
    if (!queueMutex) { Serial.println("[HTTPS] not started: mobile queue mutex unavailable"); return false; }
    const uint32_t freeBefore = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    const uint32_t largestBefore = heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    const uint32_t minimumBefore = heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    Serial.printf("[HTTPS] before start heap_internal=%u largest_internal=%u min_internal=%u\n",
      unsigned(freeBefore), unsigned(largestBefore), unsigned(minimumBefore));

    esp_err_t eventResult = esp_event_handler_register(ESP_HTTPS_SERVER_EVENT,
      HTTPS_SERVER_EVENT_ERROR, onHttpsError, this);
    tlsErrorHandlerRegistered = eventResult == ESP_OK;
    if (!tlsErrorHandlerRegistered)
      Serial.printf("[HTTPS] error diagnostics unavailable: event handler registration failed: %s\n", esp_err_to_name(eventResult));

    httpd_ssl_config_t config = HTTPD_SSL_CONFIG_DEFAULT();
    config.port_secure = 443;
    config.port_insecure = 0;
    config.httpd.max_open_sockets = 1;
    config.httpd.max_uri_handlers = 3;
    config.httpd.stack_size = 10240;
    config.tls_handshake_timeout_ms = 8000;
    // One SSL socket is intentional: ESP-IDF documents roughly 40 kB per
    // secure socket; the captive portal and DNS server also need RAM/sockets.
    // The HTTP portal uses its own port-80 server and is not replaced here.
    config.servercert = reinterpret_cast<const uint8_t *>(RN_FIELD_NODE_CERT_PEM);
    config.servercert_len = sizeof(RN_FIELD_NODE_CERT_PEM);
    config.prvtkey_pem = reinterpret_cast<const uint8_t *>(RN_FIELD_NODE_KEY_PEM);
    config.prvtkey_len = sizeof(RN_FIELD_NODE_KEY_PEM);
    esp_err_t result = httpd_ssl_start(&httpsHandle, &config);
    if (result != ESP_OK) {
      Serial.printf("[HTTPS] start failed: %s heap_internal=%u largest_internal=%u min_internal=%u\n",
        esp_err_to_name(result), unsigned(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
        unsigned(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
        unsigned(heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
      if (tlsErrorHandlerRegistered) {
        esp_event_handler_unregister(ESP_HTTPS_SERVER_EVENT, HTTPS_SERVER_EVENT_ERROR, onHttpsError);
        tlsErrorHandlerRegistered = false;
      }
      return false;
    }
    httpd_uri_t statusUri{}; statusUri.uri = "/api/status"; statusUri.method = static_cast<httpd_method_t>(HTTP_ANY);
    statusUri.handler = secureStatus; statusUri.user_ctx = this;
    httpd_uri_t locationUri{}; locationUri.uri = "/api/location"; locationUri.method = static_cast<httpd_method_t>(HTTP_ANY);
    locationUri.handler = secureLocation; locationUri.user_ctx = this;
    httpd_uri_t sosUri{}; sosUri.uri = "/api/sos"; sosUri.method = static_cast<httpd_method_t>(HTTP_ANY);
    sosUri.handler = secureLocation; sosUri.user_ctx = this;
    if (httpd_register_uri_handler(httpsHandle, &statusUri) != ESP_OK
        || httpd_register_uri_handler(httpsHandle, &locationUri) != ESP_OK
        || httpd_register_uri_handler(httpsHandle, &sosUri) != ESP_OK) {
      httpd_ssl_stop(httpsHandle); httpsHandle = nullptr;
      if (tlsErrorHandlerRegistered) {
        esp_event_handler_unregister(ESP_HTTPS_SERVER_EVENT, HTTPS_SERVER_EVENT_ERROR, onHttpsError);
        tlsErrorHandlerRegistered = false;
      }
      Serial.println("[HTTPS] URI registration failed"); return false;
    }
    Serial.printf("[HTTPS] API listening on https://192.168.4.1:443; TLS sockets=1 heap_internal=%u largest_internal=%u min_internal=%u\n",
      unsigned(heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
      unsigned(heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)),
      unsigned(heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT)));
    return true;
  }
  void status() {
    StaticJsonDocument<768> doc;
    lockQueue();
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
    unlockQueue();
    reply(200, doc);
  }
  bool copyNextPending(rescue_mobile::Message &out) const {
    lockQueue(); const auto *message = queue.nextPending();
    if (message) out = *message;
    unlockQueue(); return message != nullptr;
  }
  bool hasPending() const { rescue_mobile::Message ignored{}; return copyNextPending(ignored); }
  size_t pendingCount() const { lockQueue(); size_t count = queue.pendingSos() + queue.pendingLocations(); unlockQueue(); return count; }
  bool completeStored(const uint8_t key[16]) {
    lockQueue();
    const rescue_mobile::Message *message = queue.nextPending();
    bool sos = message && message->kind == 'S' && memcmp(message->digest, key, 16) == 0;
    bool completed = queue.completeStored(key);
    if (completed) {
      if (sos) ++deliveredSos;
      static const char *hex = "0123456789abcdef";
      for (int i = 0; i < 16; ++i) { lastAck[2*i] = hex[key[i] >> 4]; lastAck[2*i+1] = hex[key[i] & 15]; }
      lastAck[32] = 0;
    }
    unlockQueue();
    return completed;
  }
  void meshStatus(bool started, bool synchronized, uint16_t address, bool found, uint16_t gateway, size_t routeCount) {
    lockQueue();
    meshStarted = started; meshSynchronized = synchronized; meshAddress = address;
    gatewayFound = found; gatewayAddress = gateway; routes = routeCount;
    unlockQueue();
  }
};
