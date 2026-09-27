#pragma once
#include <WebServer.h>
#include <lwip/sockets.h>
#include "MobileHttpHeaders.h"

// ESP32 core 3.3.3: preflight API bytes before WebServer's form/plain parser.
// Peek preserves legacy bytes; API reads are cooperative, bounded and do not
// allocate a body based on an untrusted Content-Length or multipart boundary.
class MobileWebServer : public WebServer {
  char header[rescue_mobile::HEADER_LIMIT + 1]{};
  char body[rescue_mobile::BODY_LIMIT + 1]{};
  rescue_mobile::HttpHeaders incoming{};
  size_t headerRemaining = 0, received = 0;
  uint32_t began = 0;
  bool readingBody = false;

  void release() {
    _currentClient.stop(); _currentClient = NetworkClient(); _currentStatus = HC_NONE;
    _currentRaw.reset(); _currentUpload.reset(); readingBody = false; received = headerRemaining = 0;
  }
  void resetResponse() { _contentLength = CONTENT_LENGTH_NOT_SET; _responseCode = 0; _clearResponseHeaders(); }
  void error(int code, const char *reason) {
    _currentVersion = 1;
    resetResponse();
    char response[192];
    snprintf(response, sizeof(response), "{\"service\":\"rescuenet-field-node\",\"accepted\":false,\"error\":\"%s\"}", reason);
    sendHeader("Connection", "close"); send(code, "application/json", response);
    release();
  }
  void dispatch() {
    body[received] = 0;
    _currentUri = incoming.path;
    _currentMethod = strcmp(incoming.method, "GET") == 0 ? HTTP_GET : HTTP_POST;
    _currentVersion = 1;
    // The normal route registry still owns endpoint dispatch.
    _currentHandler = nullptr;
    for (RequestHandler *handler = _firstHandler; handler; handler = handler->next()) {
      if (handler->canHandle(*this, _currentMethod, _currentUri)) { _currentHandler = handler; break; }
    }
    resetResponse(); sendHeader("Connection", "close");
    _handleRequest();
    release();
  }
public:
  explicit MobileWebServer(int port) : WebServer(port) {}
  char *mobileBody() { return body; }
  size_t mobileBodySize() const { return received; }
  const rescue_mobile::HttpHeaders &mobileHeaders() const { return incoming; }
  void handleClient() override {
    if (_currentStatus == HC_NONE) {
      _currentClient = _server.accept();
      if (!_currentClient) return;
      _currentStatus = HC_WAIT_READ; _statusChange = began = millis();
      readingBody = false; received = headerRemaining = 0;
    }
    if (_currentStatus != HC_WAIT_READ) { WebServer::handleClient(); return; }
    if (uint32_t(millis() - began) > 2000) { error(400, "request_timeout"); return; }
    if (!readingBody) {
      int count = recv(_currentClient.fd(), header, rescue_mobile::HEADER_LIMIT, MSG_PEEK | MSG_DONTWAIT);
      if (count == 0) { release(); return; }
      if (count < 0) return;
      // Embedded NUL must not hide a path/header. Body NUL is checked by JSON.
      header[count] = 0;
      char *firstEnd = strstr(header, "\r\n");
      if (!firstEnd) { if (count >= 256) error(400, "invalid_request_line"); return; }
      char *firstSpace = strchr(header, ' ');
      if (!firstSpace || firstSpace > firstEnd) { error(400, "invalid_request_line"); return; }
      char *target = firstSpace + 1;
      bool api = strncmp(target, "/api/", 5) == 0 || strncmp(target, "/api ", 5) == 0 || strncmp(target, "/api?", 5) == 0;
      if (!api) { WebServer::handleClient(); return; }
      char *end = strstr(header, "\r\n\r\n");
      if (!end) { if (size_t(count) == rescue_mobile::HEADER_LIMIT) error(400, "headers_too_large"); return; }
      size_t length = size_t(end - header) + 4;
      if (memchr(header, 0, length)) { error(400, "invalid_headers"); return; }
      header[length] = 0;
      auto result = rescue_mobile::parseHeaders(header, incoming);
      if (result.error) { error(result.code, result.error); return; }
      readingBody = true; headerRemaining = length; began = millis();
    }
    // Bounded nonblocking reads per loop: GPS, physical SOS and relay keep running
    // while a client slowly provides an API body.
    if (headerRemaining) {
      int count = recv(_currentClient.fd(), header, headerRemaining, MSG_DONTWAIT);
      if (count == 0) { release(); return; }
      if (count > 0) headerRemaining -= size_t(count);
      if (headerRemaining) return;
    }
    if (received < incoming.bodyLength) {
      int count = recv(_currentClient.fd(), body + received, incoming.bodyLength - received, MSG_DONTWAIT);
      if (count == 0) { release(); return; }
      if (count > 0) received += size_t(count);
      if (received < incoming.bodyLength) return;
    }
    dispatch();
  }
};
