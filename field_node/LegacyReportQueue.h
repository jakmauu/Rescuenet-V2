#pragma once

#include <Preferences.h>
#include <nvs_flash.h>
#include <mbedtls/sha256.h>
#include <stdio.h>
#include <stddef.h>
#include "RescueNetWire.h"

// Persistent outbox for reports created by the captive portal and physical SOS.
// Records share the existing protected rn_sos NVS partition in a new namespace;
// no partition offsets or existing rn_mobile_b1 keys are changed.
namespace rescue_legacy {
constexpr const char *PARTITION = "rn_sos";
constexpr size_t NORMAL_CAPACITY = 8;
constexpr size_t SOS_CAPACITY = 2;
constexpr size_t TOTAL_CAPACITY = NORMAL_CAPACITY + SOS_CAPACITY;
constexpr uint32_t MAGIC = 0x524e4c51;
constexpr uint16_t VERSION = 1;

inline uint32_t crc32(const uint8_t *data, size_t size) {
  uint32_t crc = UINT32_MAX;
  for (size_t i = 0; i < size; ++i) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; ++bit)
      crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
  }
  return ~crc;
}

struct DiskRecord {
  uint32_t magic;
  uint16_t version, bytes;
  uint32_t order;
  uint8_t size;
  uint8_t data[rnwire::MAX_PACKET];
  uint8_t key[16];
  uint32_t crc;
};

struct Pending {
  uint8_t data[rnwire::MAX_PACKET]{};
  uint8_t size = 0;
  uint8_t key[16]{};
  uint8_t slot = 0;
  bool sos = false;
};

class ReportQueue {
  struct Slot {
    DiskRecord record{};
    bool used = false;
    uint32_t lastAttempt = 0;
    uint32_t retryAfter = 0;
    bool acceptedByMesh = false;
  } slots[TOTAL_CAPACITY]{};
  Preferences preferences;
  uint8_t node = 0;
  uint32_t nextOrder = 1;
  uint8_t consecutiveSos = 0;
  bool healthy = false;

  static void keyName(size_t slot, char (&key)[4]) {
    if (slot < NORMAL_CAPACITY) snprintf(key, sizeof(key), "ln%u", unsigned(slot));
    else snprintf(key, sizeof(key), "ls%u", unsigned(slot - NORMAL_CAPACITY));
  }
  static uint32_t recordCrc(const DiskRecord &record) {
    return crc32(reinterpret_cast<const uint8_t *>(&record), offsetof(DiskRecord, crc));
  }
  int readSlot(size_t slot, DiskRecord &record) {
    char key[4]; keyName(slot, key);
    if (!preferences.isKey(key)) return 0;
    if (preferences.getBytesLength(key) != sizeof(record) ||
        preferences.getBytes(key, &record, sizeof(record)) != sizeof(record)) return -1;
    if (record.magic != MAGIC || record.version != VERSION || record.bytes != sizeof(record) ||
        !record.order || !record.size || record.size > rnwire::MAX_PACKET ||
        record.crc != recordCrc(record)) return -1;
    rnwire::Legacy report{};
    uint8_t digest[32];
    if (!rnwire::decodeLegacy(record.data, record.size, report) || report.node != node ||
        mbedtls_sha256(record.data, record.size, digest, 0) != 0 ||
        memcmp(digest, record.key, sizeof(record.key)) != 0 ||
        ((slot >= NORMAL_CAPACITY) != bool(report.flags & 2))) return -1;
    return 1;
  }
  bool saveSlot(size_t slot, DiskRecord &record) {
    char key[4]; keyName(slot, key);
    record.magic = MAGIC; record.version = VERSION; record.bytes = sizeof(record);
    record.crc = recordCrc(record);
    if (preferences.putBytes(key, &record, sizeof(record)) != sizeof(record)) return false;
    DiskRecord verified{};
    return readSlot(slot, verified) == 1 && memcmp(&record, &verified, sizeof(record)) == 0;
  }
  size_t chooseSlot(bool sos) const {
    const size_t begin = sos ? NORMAL_CAPACITY : 0;
    const size_t end = sos ? TOTAL_CAPACITY : NORMAL_CAPACITY;
    for (size_t i = begin; i < end; ++i) if (!slots[i].used) return i;
    return TOTAL_CAPACITY;
  }
  size_t oldest(bool sos) const {
    size_t selected = TOTAL_CAPACITY;
    for (size_t i = 0; i < TOTAL_CAPACITY; ++i) {
      if (!slots[i].used || ((i >= NORMAL_CAPACITY) != sos)) continue;
      if (selected == TOTAL_CAPACITY || slots[i].record.order < slots[selected].record.order) selected = i;
    }
    return selected;
  }
  size_t pendingCount(bool sos) const {
    size_t count = 0;
    for (size_t i = 0; i < TOTAL_CAPACITY; ++i)
      if (slots[i].used && ((i >= NORMAL_CAPACITY) == sos)) ++count;
    return count;
  }
public:
  bool begin(uint8_t nodeId) {
    healthy = false; node = nodeId; nextOrder = 1; consecutiveSos = 0;
    memset(slots, 0, sizeof(slots));
    if (!node || node > 15 || nvs_flash_init_partition(PARTITION) != ESP_OK ||
        !preferences.begin("rn_legacy_b1", false, PARTITION)) return false;
    const uint32_t schema = MAGIC ^ node;
    if (!preferences.isKey("l_schema")) {
      for (size_t i = 0; i < TOTAL_CAPACITY; ++i) {
        char key[4]; keyName(i, key);
        if (preferences.isKey(key)) return false;
      }
      if (preferences.isKey("l_next")) return false;
      if (preferences.putUInt("l_schema", schema) != sizeof(uint32_t)) return false;
    } else if (preferences.getUInt("l_schema", 0) != schema) return false;

    uint32_t greatest = 0;
    for (size_t i = 0; i < TOTAL_CAPACITY; ++i) {
      DiskRecord record{};
      int result = readSlot(i, record);
      if (result < 0) return false; // Preserve the corrupt record for recovery.
      if (result == 1) {
        for (size_t j = 0; j < i; ++j)
          if (slots[j].used && !memcmp(slots[j].record.key, record.key, sizeof(record.key))) return false;
        slots[i].record = record; slots[i].used = true;
        if (record.order > greatest) greatest = record.order;
      }
    }
    if (greatest == UINT32_MAX) return false;
    uint32_t savedNext = preferences.getUInt("l_next", 1);
    nextOrder = (savedNext > greatest) ? savedNext : greatest + 1;
    if (nextOrder == UINT32_MAX) return false;
    if (preferences.putUInt("l_next", nextOrder) != sizeof(uint32_t) ||
        preferences.getUInt("l_next", 0) != nextOrder) return false;
    healthy = true;
    return true;
  }
  bool ready() const { return healthy; }
  size_t pendingNormal() const { return pendingCount(false); }
  size_t pendingSos() const { return pendingCount(true); }

  bool enqueue(const rnwire::Legacy &report) {
    if (!healthy) return false;
    uint8_t packet[rnwire::MAX_PACKET];
    size_t size = rnwire::encodeLegacy(report, packet);
    if (!size || report.node != node) return false;
    uint8_t digest[32];
    if (mbedtls_sha256(packet, size, digest, 0) != 0) return false;
    for (const auto &slot : slots)
      if (slot.used && !memcmp(slot.record.key, digest, 16)) return true;
    if (nextOrder == UINT32_MAX) return false;
    const size_t index = chooseSlot(report.flags & 2);
    if (index == TOTAL_CAPACITY) return false;
    DiskRecord record{};
    record.order = nextOrder; record.size = uint8_t(size);
    memcpy(record.data, packet, size); memcpy(record.key, digest, sizeof(record.key));
    if (!saveSlot(index, record)) { healthy = false; return false; }
    slots[index].record = record; slots[index].used = true;
    ++nextOrder;
    // The record commits first. Boot recovery derives next order from records
    // if the following counter write is interrupted.
    // Recovery derives the next sequence from committed records if this
    // advisory cursor update is interrupted or fails.
    preferences.putUInt("l_next", nextOrder);
    return true;
  }

  bool next(uint32_t now, size_t meshQueueDepth, size_t maxInFlight, Pending &out) {
    if (!healthy || meshQueueDepth >= 8) return false;
    // A Send() success means only that LoRaMesher accepted the frame. Once a
    // bounded ACK wait expires and its own queue has drained, release the
    // in-flight reservation so the same stable-key frame can be retried.
    if (meshQueueDepth <= 2) {
      for (auto &slot : slots) {
        if (slot.used && slot.acceptedByMesh &&
            uint32_t(now - slot.lastAttempt) >= slot.retryAfter)
          slot.acceptedByMesh = false;
      }
    }
    size_t accepted = 0;
    for (const auto &slot : slots) if (slot.used && slot.acceptedByMesh) ++accepted;
    // maxInFlight normally bounds unconfirmed frames to two. The scheduler
    // may temporarily raise it to three when an urgent portal SOS must bypass
    // a normal frame and a slot reserved for mobile LOCATION traffic.
    if (accepted >= maxInFlight) return false;
    auto eligible = [&](size_t index) {
      const Slot &slot = slots[index];
      if (!slot.used || slot.acceptedByMesh) return false;
      return !slot.lastAttempt || uint32_t(now - slot.lastAttempt) >= slot.retryAfter;
    };
    auto oldestEligible = [&](bool sos) {
      size_t selected = TOTAL_CAPACITY;
      for (size_t i = 0; i < TOTAL_CAPACITY; ++i) {
        if (((i >= NORMAL_CAPACITY) != sos) || !eligible(i)) continue;
        if (selected == TOTAL_CAPACITY || slots[i].record.order < slots[selected].record.order)
          selected = i;
      }
      return selected;
    };
    const size_t normal = oldestEligible(false);
    const size_t sos = oldestEligible(true);
    const bool haveNormal = normal != TOTAL_CAPACITY;
    size_t selected = TOTAL_CAPACITY;
    if (sos != TOTAL_CAPACITY && (consecutiveSos < 3 || !haveNormal)) selected = sos;
    else if (haveNormal) selected = normal;
    else if (sos != TOTAL_CAPACITY) selected = sos;
    if (selected == TOTAL_CAPACITY) return false;
    Slot &slot = slots[selected];
    out = Pending{}; out.size = slot.record.size; out.slot = uint8_t(selected);
    out.sos = selected >= NORMAL_CAPACITY;
    memcpy(out.data, slot.record.data, out.size); memcpy(out.key, slot.record.key, sizeof(out.key));
    return true;
  }

  void attempted(const Pending &pending, bool accepted, uint32_t now) {
    if (pending.slot >= TOTAL_CAPACITY || !slots[pending.slot].used ||
        memcmp(slots[pending.slot].record.key, pending.key, sizeof(pending.key))) return;
    Slot &slot = slots[pending.slot];
    slot.lastAttempt = now;
    if (accepted) {
      slot.acceptedByMesh = true; slot.retryAfter = pending.sos ? 15000U : 60000U;
      if (pending.sos) ++consecutiveSos; else consecutiveSos = 0;
    } else {
      slot.acceptedByMesh = false;
      uint8_t exponent = slot.retryAfter >= 40000U ? 3 : uint8_t(slot.retryAfter / 5000U);
      slot.retryAfter = uint32_t(5000U << exponent);
      if (slot.retryAfter > 40000U) slot.retryAfter = 40000U;
    }
  }

  bool confirm(const uint8_t key[16]) {
    if (!healthy) return false;
    for (size_t i = 0; i < TOTAL_CAPACITY; ++i) {
      if (!slots[i].used || memcmp(slots[i].record.key, key, 16)) continue;
      char name[4]; keyName(i, name);
      if (!preferences.remove(name) || preferences.isKey(name)) return false;
      slots[i] = Slot{};
      return true;
    }
    return false;
  }
};
} // namespace rescue_legacy
