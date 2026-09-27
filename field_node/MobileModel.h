#pragma once
// Checkpoint 2B: HTTP model only. No mobile LoRa encoder or transmitter.
#include <ArduinoJson.h>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <initializer_list>

namespace rescue_mobile {
constexpr size_t BODY_LIMIT = 1024;
constexpr size_t NAME_LIMIT = 240;
constexpr size_t SOS_CAPACITY = 8;
constexpr size_t LOCATION_CAPACITY = 16;
constexpr size_t LOCATION_HISTORY = 64;
constexpr size_t COMPLETED_SOS_CAPACITY = 32;
constexpr uint32_t HISTORY_AGE_MS = 30UL * 60UL * 1000UL;

struct Message {
  char requestId[41]{};
  char userId[41]{};
  char name[241]{};  // full HTTP name retained; 2C will encode <=48 UTF-8 bytes
  double lat = 0, lon = 0, accuracy = 0;
  uint32_t fixTime = 0, eventTime = 0;
  uint64_t bootSession = 0;
  uint32_t sequence = 0;
  uint8_t source = 0;
  char kind = 0;
  bool hasGps = false, accuracyKnown = false, nameTruncated = false;
  uint8_t digest[32]{};
};
struct Result {
  int code;
  const char *error;
  const char *state;
  bool duplicate;
  bool coalesced;
  Result(int c = 202, const char *e = nullptr, const char *s = "queued_for_lora", bool d = false, bool co = false)
      : code(c), error(e), state(s), duplicate(d), coalesced(co) {}
};

inline bool whitespace(uint32_t c) {
  return c == 0x20 || (c >= 9 && c <= 13) || c == 0xa0 || c == 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) || c == 0x2028 || c == 0x2029 ||
    c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
}
inline bool nextUtf8(const char *text, size_t size, size_t &at, uint32_t &cp) {
  if (at >= size) return false;
  uint8_t lead = uint8_t(text[at++]);
  if (lead < 128) { cp = lead; return true; }
  int count = lead >= 0xc2 && lead <= 0xdf ? 1 : lead >= 0xe0 && lead <= 0xef ? 2 : lead >= 0xf0 && lead <= 0xf4 ? 3 : -1;
  if (count < 0 || at + count > size) return false;
  cp = lead & (0x7f >> (count + 1));
  for (int i = 0; i < count; ++i) {
    uint8_t part = uint8_t(text[at++]);
    if ((part & 0xc0) != 0x80) return false;
    cp = (cp << 6) | (part & 0x3f);
  }
  return cp >= (count == 1 ? 0x80u : count == 2 ? 0x800u : 0x10000u) &&
    cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff);
}
inline bool normalizeName(const char *input, size_t size, char (&output)[241]) {
  size_t at = 0, length = 0, units = 0;
  bool space = false;
  while (at < size) {
    size_t start = at;
    uint32_t cp;
    if (!nextUtf8(input, size, at, cp)) return false;
    if (whitespace(cp)) { if (length) space = true; continue; }
    if (cp < 0x20 || (cp >= 0x7f && cp <= 0x9f)) return false;
    if (length + (space ? 1 : 0) + at - start > NAME_LIMIT) return false;
    if (space) { output[length++] = ' '; units++; space = false; }
    memcpy(output + length, input + start, at - start);
    length += at - start;
    units += cp > 0xffff ? 2 : 1;
    if (units > 60) return false;
  }
  output[length] = 0;
  return units >= 2;
}

// Check decimal integrality BEFORE double conversion can round a tiny fractional
// timestamp to an integer. Integer-valued forms such as 100.0 / 1e2 remain valid.
inline bool exactIntegerToken(const char *start, const char *end) {
  if (start < end && *start == '-') ++start;
  int fractional = 0, trailingZeros = 0, exponent = 0;
  bool point = false, nonzero = false, negativeExponent = false;
  while (start < end && *start != 'e' && *start != 'E') {
    char c = *start++;
    if (c == '.') { point = true; continue; }
    if (point) ++fractional;
    if (c != '0') nonzero = true;
    trailingZeros = c == '0' ? trailingZeros + 1 : 0;
  }
  if (start < end) {
    ++start;
    if (start < end && (*start == '+' || *start == '-')) negativeExponent = *start++ == '-';
    while (start < end) { int digit = *start++ - '0'; if (exponent < 10000) exponent = exponent * 10 + digit; }
  }
  if (negativeExponent) exponent = -exponent;
  return !nonzero || exponent >= fractional || trailingZeros >= fractional - exponent;
}

// ArduinoJson deliberately accepts some extensions and collapses duplicate keys.
// This bounded lexical pass enforces strict, flat JSON BEFORE deserialization.
struct ExactNumbers {
  double values[12]{};
  uint16_t present = 0;
};
inline const char *fieldKey(size_t index) {
  static const char *keys[] = {"request_id", "user_id", "name", "has_gps", "lat", "lon", "accuracy", "fix_timestamp", "event_timestamp", "sos", "timestamp", "gps_timestamp"};
  return keys[index];
}
class StrictObject {
  const char *p;
  const char *end;
  ExactNumbers *numbers;
  static int hex(char c) {
    return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : c >= 'A' && c <= 'F' ? c - 'A' + 10 : -1;
  }
  void ws() { while (p < end && (*p == ' ' || *p == '\r' || *p == '\n' || *p == '\t')) ++p; }
  bool code(uint32_t &c) {
    c = 0;
    for (int i = 0; i < 4; ++i) { if (p == end || hex(*p) < 0) return false; c = c * 16 + hex(*p++); }
    return true;
  }
  bool string() {
    if (p == end || *p++ != '"') return false;
    while (p < end) {
      unsigned char c = *p++;
      if (c == '"') return true;
      if (c < 32) return false;
      if (c == '\\') {
        if (p == end) return false;
        char esc = *p++;
        if (!esc) return false;
        if (esc == 'u') {
          uint32_t value;
          if (!code(value) || value == 0 || (value >= 0xdc00 && value <= 0xdfff)) return false;
          if (value >= 0xd800 && value <= 0xdbff) {
            if (end - p < 6 || *p++ != '\\' || *p++ != 'u' || !code(value) || value < 0xdc00 || value > 0xdfff) return false;
          }
        } else if (!strchr("\"\\/bfnrt", esc)) return false;
      }
    }
    return false;
  }
  bool value() {
    if (p == end) return false;
    if (*p == '"') return string();
    for (const char *literal : {"true", "false", "null"}) {
      size_t n = strlen(literal);
      if (size_t(end - p) >= n && memcmp(p, literal, n) == 0) { p += n; return true; }
    }
    if (*p == '-') ++p;
    if (p == end || *p < '0' || *p > '9') return false;
    if (*p == '0') ++p;
    else while (p < end && *p >= '0' && *p <= '9') ++p;
    if (p < end && *p == '.') {
      ++p;
      if (p == end || *p < '0' || *p > '9') return false;
      while (p < end && *p >= '0' && *p <= '9') ++p;
    }
    if (p < end && (*p == 'e' || *p == 'E')) {
      ++p;
      if (p < end && (*p == '+' || *p == '-')) ++p;
      if (p == end || *p < '0' || *p > '9') return false;
      while (p < end && *p >= '0' && *p <= '9') ++p;
    }
    return true;
  }
public:
  StrictObject(const char *body, size_t size, ExactNumbers *exact = nullptr) : p(body), end(body + size), numbers(exact) {}
  const char *validate() {
    uint16_t seen = 0;
    ws();
    if (p == end || *p++ != '{') return "invalid_json";
    ws();
    if (p < end && *p == '}') { ++p; ws(); return p == end ? nullptr : "invalid_json"; }
    while (p < end) {
      const char *start = p;
      if (!string() || p - start > 96) return "invalid_json";
      StaticJsonDocument<128> keyDoc;
      if (deserializeJson(keyDoc, start, size_t(p - start))) return "invalid_json";
      const char *key = keyDoc.as<const char *>();
      int index = -1;
      for (int i = 0; i < 12; ++i) if (key && strcmp(key, fieldKey(i)) == 0) index = i;
      if (index < 0) return "unknown_field";
      if (seen & (1u << index)) return "duplicate_field";
      seen |= 1u << index;
      ws(); if (p == end || *p++ != ':') return "invalid_json";
      ws(); const char *valueStart = p;
      if (!value()) return "invalid_json";
      if ((index == 7 || index == 8 || index == 10 || index == 11) &&
          (*valueStart == '-' || (*valueStart >= '0' && *valueStart <= '9')) &&
          !exactIntegerToken(valueStart, p)) return "invalid_timestamp";
      if (numbers && (*valueStart == '-' || (*valueStart >= '0' && *valueStart <= '9'))) {
        char *after = nullptr;
        // Caller provides a NUL-terminated, BODY_LIMIT-bounded input. strtod
        // correctly rounds IEEE754; ArduinoJson6's fast decimal parser can be
        // a few ulps off, breaking range boundaries and cross-language dedupe.
        numbers->values[index] = std::strtod(valueStart, &after);
        if (after != p) return "invalid_json";
        numbers->present |= 1u << index;
      }
      ws(); if (p == end) return "invalid_json";
      if (*p == '}') { ++p; ws(); return p == end ? nullptr : "invalid_json"; }
      if (*p++ != ',') return "invalid_json";
      ws();
    }
    return "invalid_json";
  }
};
inline bool id(JsonVariantConst value, char (&out)[41]) {
  if (!value.is<const char *>()) return false;
  JsonString s = value.as<JsonString>();
  if (!s.size() || s.size() > 40) return false;
  for (size_t i = 0; i < s.size(); ++i) {
    char c = s.c_str()[i];
    if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-' || c == '_')) return false;
  }
  memcpy(out, s.c_str(), s.size()); out[s.size()] = 0;
  return true;
}
inline bool number(JsonVariantConst v, double min, double max, double &out) {
  if (v.is<bool>() || !v.is<double>()) return false;
  out = v.as<double>();
  if (!std::isfinite(out) || out < min || out > max) return false;
  if (out == 0) out = 0; // canonical positive zero
  return true;
}
inline bool timestamp(JsonObjectConst obj, const char *primary, const char *alias, uint32_t &out) {
  bool hasPrimary = obj.containsKey(primary), hasAlias = obj.containsKey(alias);
  if (!hasPrimary && !hasAlias) return false;
  double a = 0, b = 0;
  if (hasPrimary && (!number(obj[primary], 1, 4294967295.0, a) || std::floor(a) != a)) return false;
  if (hasAlias && (!number(obj[alias], 1, 4294967295.0, b) || std::floor(b) != b)) return false;
  if (hasPrimary && hasAlias && a != b) return false;
  out = uint32_t(hasPrimary ? a : b);
  return true;
}
inline const char *parseMessage(char *body, size_t size, bool sos, Message &out) {
  if (size == 0 || size > BODY_LIMIT) return "invalid_size";
  // Mutable input must have size+1 bytes available, as mobileBody()/host tests do.
  body[size] = 0;
  ExactNumbers exact;
  const char *error = StrictObject(body, size, &exact).validate();
  if (error) return error;
  StaticJsonDocument<1536> document;
  if (deserializeJson(document, body, size, DeserializationOption::NestingLimit(2))) return "invalid_json";
  for (size_t i = 0; i < 12; ++i) if (exact.present & (1u << i)) document[fieldKey(i)] = exact.values[i];
  JsonObjectConst obj = document.as<JsonObjectConst>();
  out = Message{};
  out.kind = sos ? 'S' : 'L';
  if (!id(obj["request_id"], out.requestId)) return "invalid_request_id";
  if (!id(obj["user_id"], out.userId)) return "invalid_user_id";
  if (!obj["name"].is<const char *>()) return "invalid_name";
  JsonString name = obj["name"].as<JsonString>();
  if (!normalizeName(name.c_str(), name.size(), out.name)) return "invalid_name";
  out.nameTruncated = strlen(out.name) > 48;
  if (!obj["has_gps"].is<bool>()) return "invalid_has_gps";
  out.hasGps = obj["has_gps"].as<bool>();
  if (sos) {
    if (!obj["sos"].is<bool>() || !obj["sos"].as<bool>()) return "invalid_sos";
    if (!timestamp(obj, "event_timestamp", "timestamp", out.eventTime)) return "invalid_event_timestamp";
  } else if (obj.containsKey("sos") || obj.containsKey("event_timestamp") || obj.containsKey("gps_timestamp")) return "unexpected_field";
  if (!sos && !out.hasGps) return "location_requires_gps";
  if (out.hasGps) {
    if (!number(obj["lat"], -90, 90, out.lat)) return "invalid_latitude";
    if (!number(obj["lon"], -180, 180, out.lon)) return "invalid_longitude";
    if (!obj.containsKey("accuracy")) return "missing_accuracy";
    out.accuracyKnown = !obj["accuracy"].isNull();
    if (out.accuracyKnown && !number(obj["accuracy"], 0, 6553.4, out.accuracy)) return "invalid_accuracy";
    if (!timestamp(obj, "fix_timestamp", sos ? "gps_timestamp" : "timestamp", out.fixTime)) return "invalid_fix_timestamp";
    if (!sos) out.eventTime = out.fixTime;
  } else if (obj.containsKey("lat") || obj.containsKey("lon") || obj.containsKey("accuracy") ||
             obj.containsKey("fix_timestamp") || obj.containsKey("gps_timestamp")) return "unexpected_gps_fields";
  return nullptr;
}

// Canonical digest input: fixed key order, UTF-8 strings escaped by JSON,
// exact IEEE754 binary64 values rendered as 16 lowercase hex digits (no decimal
// formatter differences). This is LOCAL dedupe serialization, NOT a radio frame.
inline size_t canonicalMessage(const Message &m, char *output, size_t capacity) {
  StaticJsonDocument<1536> doc;
  char kind[2] = {m.kind, 0};
  doc["kind"] = kind;
  doc["request_id"] = m.requestId; doc["user_id"] = m.userId; doc["name"] = m.name;
  doc["has_gps"] = m.hasGps;
  char numbers[3][17]{};
  const double values[3] = {m.lat, m.lon, m.accuracy};
  const char *keys[3] = {"lat_f64", "lon_f64", "accuracy_f64"};
  for (int i = 0; i < 3; ++i) {
    if (!m.hasGps || (i == 2 && !m.accuracyKnown)) { doc[keys[i]] = nullptr; continue; }
    uint64_t bits = 0;
    double value = values[i] == 0 ? 0.0 : values[i];
    static_assert(sizeof(bits) == sizeof(value), "binary64 double required");
    memcpy(&bits, &value, sizeof(bits));
    snprintf(numbers[i], sizeof(numbers[i]), "%016llx", (unsigned long long)bits);
    doc[keys[i]] = numbers[i];
  }
  doc["fix_timestamp"] = m.fixTime; doc["event_timestamp"] = m.eventTime;
  if (doc.overflowed() || measureJson(doc) + 1 > capacity) return 0;
  return serializeJson(doc, output, capacity);
}
} // namespace rescue_mobile
