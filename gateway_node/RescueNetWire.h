#pragma once
// RescueNet 2C application frames. Explicit big-endian bytes; no struct memcpy.
#include <stdint.h>
#include <stddef.h>
#include <string.h>
#include <math.h>

namespace rnwire {
constexpr size_t MAX_PACKET = 100;
constexpr size_t MAX_NAME = 48;
struct Mobile {
  uint8_t kind = 0, flags = 0, node = 0;
  uint8_t key[16]{}, user[8]{};
  uint32_t eventTime = 0, fixTime = 0;
  int32_t latE6 = 0, lonE6 = 0;
  uint16_t accuracyDm = 0xffff;
  char name[MAX_NAME + 1]{};
};
struct Legacy {
  uint16_t packetId = 0;
  uint8_t node = 0, flags = 0, count = 0;
  int32_t latE6 = 0, lonE6 = 0;
  char condition[11]{};
  char message[71]{};
};
struct Ack { uint8_t key[16]{}; uint8_t status = 0; };
inline uint16_t crc16(const uint8_t *data, size_t n) {
  uint16_t c = 0xffff;
  for (size_t i = 0; i < n; ++i) {
    c ^= uint16_t(data[i]) << 8;
    for (int b = 0; b < 8; ++b) c = c & 0x8000 ? uint16_t((c << 1) ^ 0x1021) : uint16_t(c << 1);
  }
  return c;
}
inline void u16(uint8_t *p, uint16_t v) { p[0] = v >> 8; p[1] = v; }
inline void u32(uint8_t *p, uint32_t v) { p[0] = v >> 24; p[1] = v >> 16; p[2] = v >> 8; p[3] = v; }
inline uint16_t r16(const uint8_t *p) { return uint16_t(p[0]) << 8 | p[1]; }
inline uint32_t r32(const uint8_t *p) { return uint32_t(p[0]) << 24 | uint32_t(p[1]) << 16 | uint32_t(p[2]) << 8 | p[3]; }
inline bool validCrc(const uint8_t *p, size_t n) { return n >= 6 && crc16(p, n - 2) == r16(p + n - 2); }
inline bool keyHex(const char *s, uint8_t out[16]) {
  if (!s || strlen(s) != 32) return false;
  for (int i = 0; i < 16; ++i) {
    auto nibble = [](char c) -> int { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1; };
    int a = nibble(s[i * 2]), b = nibble(s[i * 2 + 1]);
    if (a < 0 || b < 0) return false;
    out[i] = uint8_t(a * 16 + b);
  }
  return true;
}
inline void hexKey(const uint8_t key[16], char out[33]) {
  static const char *digits = "0123456789abcdef";
  for (int i = 0; i < 16; ++i) { out[i * 2] = digits[key[i] >> 4]; out[i * 2 + 1] = digits[key[i] & 15]; }
  out[32] = 0;
}
inline void hexBytes(const uint8_t *data, size_t n, char *out) {
  static const char *digits = "0123456789abcdef";
  for (size_t i = 0; i < n; ++i) { out[i * 2] = digits[data[i] >> 4]; out[i * 2 + 1] = digits[data[i] & 15]; }
  out[n * 2] = 0;
}
inline size_t utf8Prefix(const char *s, size_t limit) {
  size_t n = strlen(s), i = 0, last = 0;
  while (i < n && i < limit) {
    uint8_t c = uint8_t(s[i]);
    size_t width = c < 0x80 ? 1 : c >= 0xc2 && c <= 0xdf ? 2 : c >= 0xe0 && c <= 0xef ? 3 : c >= 0xf0 && c <= 0xf4 ? 4 : 0;
    if (!width || i + width > n || i + width > limit) break;
    bool good = true;
    for (size_t j = 1; j < width; ++j) if ((uint8_t(s[i + j]) & 0xc0) != 0x80) good = false;
    if (!good) break;
    i += width; last = i;
  }
  return last;
}
inline size_t encodeMobile(const Mobile &m, uint8_t out[MAX_PACKET]) {
  size_t n = strlen(m.name);
  if ((m.kind != 1 && m.kind != 2) || m.flags & ~7 || m.node < 1 || m.node > 15 || n < 1 || n > MAX_NAME || !m.eventTime ||
      (m.kind == 1 && !(m.flags & 1)) || (!(m.flags & 1) && ((m.flags & 2) || m.fixTime || m.latE6 || m.lonE6 || m.accuracyDm != 0xffff)) ||
      ((m.flags & 1) && (!m.fixTime || m.latE6 < -90000000 || m.latE6 > 90000000 || m.lonE6 < -180000000 || m.lonE6 > 180000000)) ||
      (!(m.flags & 2) && m.accuracyDm != 0xffff) || ((m.flags & 2) && m.accuracyDm == 0xffff)) return 0;
  memcpy(out, "RNM1", 4); out[4] = m.kind; out[5] = m.flags; out[6] = m.node;
  memcpy(out + 7, m.key, 16); memcpy(out + 23, m.user, 8);
  u32(out + 31, m.eventTime); u32(out + 35, m.fixTime);
  u32(out + 39, uint32_t(m.latE6)); u32(out + 43, uint32_t(m.lonE6));
  u16(out + 47, m.accuracyDm); out[49] = uint8_t(n); memcpy(out + 50, m.name, n);
  u16(out + 50 + n, crc16(out, 50 + n)); return 52 + n;
}
inline bool decodeMobile(const uint8_t *p, size_t n, Mobile &m) {
  if (n < 53 || n > MAX_PACKET || memcmp(p, "RNM1", 4) || !validCrc(p, n)) return false;
  if (p[4] < 1 || p[4] > 2 || p[5] & ~7 || p[6] < 1 || p[6] > 15 || p[49] < 1 || p[49] > MAX_NAME || n != 52 + p[49]) return false;
  m = Mobile{}; m.kind = p[4]; m.flags = p[5]; m.node = p[6];
  memcpy(m.key, p + 7, 16); memcpy(m.user, p + 23, 8);
  m.eventTime = r32(p + 31); m.fixTime = r32(p + 35); m.latE6 = int32_t(r32(p + 39)); m.lonE6 = int32_t(r32(p + 43)); m.accuracyDm = r16(p + 47);
  memcpy(m.name, p + 50, p[49]); m.name[p[49]] = 0;
  return m.eventTime && !(m.kind == 1 && !(m.flags & 1)) &&
    ((m.flags & 1) ? (m.fixTime && m.latE6 >= -90000000 && m.latE6 <= 90000000 && m.lonE6 >= -180000000 && m.lonE6 <= 180000000) :
     (!m.fixTime && !m.latE6 && !m.lonE6 && m.accuracyDm == 0xffff && !(m.flags & 2))) &&
    ((m.flags & 2) ? m.accuracyDm != 0xffff : m.accuracyDm == 0xffff);
}
inline size_t encodeLegacy(const Legacy &m, uint8_t out[MAX_PACKET]) {
  size_t c = strlen(m.condition), n = strlen(m.message);
  if (!m.packetId || m.node < 1 || m.node > 15 || !c || c > 10 || n > 70 || m.flags & ~3 || !m.count) return 0;
  if (c + n > 79) n = utf8Prefix(m.message, 79 - c);
  memcpy(out, "RNL1", 4); u16(out + 4, m.packetId); out[6] = m.node; out[7] = m.flags; out[8] = m.count;
  u32(out + 9, uint32_t(m.latE6)); u32(out + 13, uint32_t(m.lonE6));
  out[17] = uint8_t(c); out[18] = uint8_t(n); memcpy(out + 19, m.condition, c); memcpy(out + 19 + c, m.message, n);
  u16(out + 19 + c + n, crc16(out, 19 + c + n)); return 21 + c + n;
}
inline bool decodeLegacy(const uint8_t *p, size_t n, Legacy &m) {
  if (n < 22 || n > MAX_PACKET || memcmp(p, "RNL1", 4) || !validCrc(p, n) || !p[17] || p[17] > 10 || p[18] > 70 || n != 21 + p[17] + p[18] || !r16(p + 4) || !p[6] || p[6] > 15 || p[7] & ~3 || !p[8]) return false;
  m = Legacy{}; m.packetId = r16(p + 4); m.node = p[6]; m.flags = p[7]; m.count = p[8];
  m.latE6 = int32_t(r32(p + 9)); m.lonE6 = int32_t(r32(p + 13));
  memcpy(m.condition, p + 19, p[17]); m.condition[p[17]] = 0;
  memcpy(m.message, p + 19 + p[17], p[18]); m.message[p[18]] = 0;
  for (size_t i = 0; i < p[17]; ++i) if (m.condition[i] == ',' || m.condition[i] == '\r' || m.condition[i] == '\n') return false;
  return !(m.flags & 1) || (m.latE6 >= -90000000 && m.latE6 <= 90000000 && m.lonE6 >= -180000000 && m.lonE6 <= 180000000);
}
inline size_t encodeAck(const Ack &ack, uint8_t out[MAX_PACKET]) {
  if (ack.status != 1) return 0;
  memcpy(out, "RNA1", 4); out[4] = ack.status; memcpy(out + 5, ack.key, 16); u16(out + 21, crc16(out, 21)); return 23;
}
inline bool decodeAck(const uint8_t *p, size_t n, Ack &ack) {
  if (n != 23 || memcmp(p, "RNA1", 4) || p[4] != 1 || !validCrc(p, n)) return false;
  ack.status = 1; memcpy(ack.key, p + 5, 16); return true;
}
static_assert(52 + MAX_NAME <= MAX_PACKET, "mobile frame exceeds LoRaMesher application limit");
static_assert(21 + 10 + 69 <= MAX_PACKET, "legacy frame exceeds LoRaMesher application limit");
} // namespace rnwire
