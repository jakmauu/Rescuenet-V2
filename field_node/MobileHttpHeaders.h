#pragma once
#include "MobileModel.h"
#include <cctype>
#include <cstdlib>

namespace rescue_mobile {
constexpr size_t HEADER_LIMIT = 1536;
struct HttpHeaders {
  char path[129]{};
  char method[12]{};
  char idempotencyKey[41]{};
  size_t bodyLength = 0;
  bool hasIdempotencyKey = false;
};
inline char *trim(char *text) {
  while (*text == ' ' || *text == '\t') ++text;
  size_t n = strlen(text);
  while (n && (text[n - 1] == ' ' || text[n - 1] == '\t')) text[--n] = 0;
  return text;
}
inline bool equalIgnoreCase(const char *a, const char *b) {
  while (*a && *b) { if (std::tolower(uint8_t(*a++)) != std::tolower(uint8_t(*b++))) return false; }
  return *a == *b;
}
inline bool apiPath(const char *path) { return strcmp(path, "/api") == 0 || strncmp(path, "/api/", 5) == 0; }
inline Result parseHeaders(char *header, HttpHeaders &out) {
  out = HttpHeaders{};
  char *lineEnd = strstr(header, "\r\n");
  if (!lineEnd) return Result(400, "invalid_headers");
  *lineEnd = 0;
  char *space = strchr(header, ' ');
  if (!space || size_t(space - header) >= sizeof(out.method)) return Result(400, "invalid_method");
  memcpy(out.method, header, size_t(space - header));
  char *target = space + 1;
  char *version = strchr(target, ' ');
  if (!version || size_t(version - target) >= sizeof(out.path) ||
      (strcmp(version + 1, "HTTP/1.1") && strcmp(version + 1, "HTTP/1.0"))) return Result(400, "invalid_request_target");
  memcpy(out.path, target, size_t(version - target));
  if (char *query = strchr(out.path, '?')) *query = 0;
  bool lengthFound = false, typeFound = false;
  int knownHeaders = 0;
  char *line = lineEnd + 2;
  while (*line) {
    lineEnd = strstr(line, "\r\n");
    if (!lineEnd) return Result(400, "invalid_headers");
    if (lineEnd == line) break;
    *lineEnd = 0;
    char *colon = strchr(line, ':');
    if (!colon || line == colon) return Result(400, "invalid_headers");
    *colon = 0;
    for (char *c = line; *c; ++c) if (!(std::isalnum(uint8_t(*c)) || *c == '-')) return Result(400, "invalid_headers");
    char *value = trim(colon + 1);
    for (char *c = value; *c; ++c) if (uint8_t(*c) < 32 && *c != '\t') return Result(400, "invalid_headers");
    if (equalIgnoreCase(line, "Content-Length")) {
      if (lengthFound || !*value) return Result(400, "invalid_content_length");
      lengthFound = true;
      size_t n = 0;
      for (char *c = value; *c; ++c) {
        if (*c < '0' || *c > '9') return Result(400, "invalid_content_length");
        if (n > BODY_LIMIT) return Result(413, "payload_too_large");
        n = n * 10 + size_t(*c - '0');
      }
      if (n > BODY_LIMIT) return Result(413, "payload_too_large");
      out.bodyLength = n;
    } else if (equalIgnoreCase(line, "Content-Type")) {
      if (typeFound) return Result(400, "duplicate_content_type");
      typeFound = true;
      char *semicolon = strchr(value, ';');
      if (semicolon) *semicolon++ = 0;
      if (!equalIgnoreCase(trim(value), "application/json")) return Result(415, "unsupported_media_type");
      if (semicolon && !equalIgnoreCase(trim(semicolon), "charset=utf-8") && !equalIgnoreCase(trim(semicolon), "charset=\"utf-8\"")) return Result(415, "unsupported_charset");
    } else if (equalIgnoreCase(line, "Transfer-Encoding") || equalIgnoreCase(line, "Content-Encoding")) {
      return Result(415, "unsupported_encoding");
    } else if (equalIgnoreCase(line, "Idempotency-Key")) {
      if (out.hasIdempotencyKey || !*value || strlen(value) > 40) return Result(400, "invalid_idempotency_key");
      out.hasIdempotencyKey = true; strcpy(out.idempotencyKey, value);
    } else if (equalIgnoreCase(line, "Expect")) return Result(400, "unsupported_expectation");
    if (++knownHeaders > 32) return Result(400, "too_many_headers");
    line = lineEnd + 2;
  }
  bool status = strcmp(out.path, "/api/status") == 0;
  bool post = strcmp(out.path, "/api/location") == 0 || strcmp(out.path, "/api/sos") == 0;
  if (!status && !post) return Result(404, "api_not_found");
  bool isOptions = strcmp(out.method, "OPTIONS") == 0;
  if (isOptions) return Result{};
  if ((status && strcmp(out.method, "GET")) || (post && strcmp(out.method, "POST"))) return Result(405, "method_not_allowed");
  if (post && !lengthFound) return Result(400, "missing_content_length");
  if (post && !typeFound) return Result(415, "unsupported_media_type");
  if (post && !out.bodyLength) return Result(400, "empty_body");
  if (status && out.bodyLength) return Result(400, "unexpected_body");
  return Result{};
}
} // namespace rescue_mobile
