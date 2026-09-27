#pragma once
#include "MobileQueue.h"
#include <Preferences.h>
#include <nvs_flash.h>
#include <mbedtls/sha256.h>

namespace rescue_mobile {
constexpr const char *SOS_PARTITION = "rn_sos";
inline bool digestMessage(Message &message) {
  char canonical[1025];
  size_t size = canonicalMessage(message, canonical, sizeof(canonical));
  return size && mbedtls_sha256(reinterpret_cast<const uint8_t *>(canonical), size, message.digest, 0) == 0;
}
inline uint32_t journalCrc(const uint8_t *data, size_t size) {
  uint32_t crc = UINT32_MAX;
  for (size_t i = 0; i < size; ++i) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; ++bit) crc = (crc >> 1) ^ (0xedb88320u & (0u - (crc & 1u)));
  }
  return ~crc;
}
class NvsJournal final : public Journal {
  // This is a versioned LOCAL journal record, not a LoRa packet. ABI changes
  // require migration; never erase an unknown/corrupt record automatically.
  struct Record {
    uint32_t magic;
    uint16_t version, bytes;
    Message message;
    uint32_t crc;
  };
  struct DoneRecord {
    uint32_t magic;
    uint16_t version, bytes;
    CompletedSos entry;
    uint32_t crc;
  };
  Preferences preferences;
  uint8_t node = 0;
  static constexpr uint32_t MAGIC = 0x524e4231;
  template<typename T> int read(const char *key, T &record) {
    if (!preferences.isKey(key)) return 0;
    if (preferences.getBytesLength(key) != sizeof(record) || preferences.getBytes(key, &record, sizeof(record)) != sizeof(record)) return -1;
    if (record.magic != MAGIC || record.version != 1 || record.bytes != sizeof(record) ||
        record.crc != journalCrc(reinterpret_cast<const uint8_t *>(&record), offsetof(T, crc))) return -1;
    return 1;
  }
public:
  bool begin(uint8_t id) override {
    node = id;
    // Never fall back to default NVS and never erase on an initialization error.
    // Core 3.3.3 may erase its default NVS before setup(); rn_sos is independent.
    if (nvs_flash_init_partition(SOS_PARTITION) != ESP_OK) return false;
    // Installed Preferences::begin(name, readOnly, partition_label) opens this
    // partition explicitly; its repeated successful init is supported by IDF.
    if (!preferences.begin("rn_mobile_b1", false, SOS_PARTITION)) return false;
    if (!preferences.isKey("schema")) {
      // Marker absent with remaining records is corruption, not a new empty queue.
      for (size_t i = 0; i < SOS_CAPACITY; ++i) { char key[8]; snprintf(key, sizeof(key), "s%u", unsigned(i)); if (preferences.isKey(key)) return false; }
      for (size_t i = 0; i < COMPLETED_SOS_CAPACITY; ++i) { char key[8]; snprintf(key, sizeof(key), "d%u", unsigned(i)); if (preferences.isKey(key)) return false; }
      if (preferences.isKey("next_sos")) return false;
      return preferences.putUInt("schema", MAGIC ^ id) == sizeof(uint32_t);
    }
    return preferences.getUInt("schema", 0) == (MAGIC ^ id);
  }
  int load(size_t slot, Message &message) override {
    char key[8]; snprintf(key, sizeof(key), "s%u", unsigned(slot));
    Record record{};
    int result = read(key, record);
    if (result != 1) return result;
    message = record.message;
    // All stored text must terminate before any strcmp/serialization.
    if (!memchr(message.requestId, 0, sizeof(message.requestId)) || !memchr(message.userId, 0, sizeof(message.userId)) ||
        !memchr(message.name, 0, sizeof(message.name)) || message.kind != 'S' || message.source != node ||
        !message.bootSession || !message.sequence || !message.eventTime) return -1;
    uint8_t original[32]; memcpy(original, message.digest, 32);
    if (!digestMessage(message) || memcmp(original, message.digest, 32)) return -1;
    return 1;
  }
  int loadCompleted(size_t slot, CompletedSos &entry) override {
    char key[8]; snprintf(key, sizeof(key), "d%u", unsigned(slot));
    DoneRecord record{};
    int result = read(key, record);
    if (result == 1) {
      if (!memchr(record.entry.requestId, 0, sizeof(record.entry.requestId)) || !record.entry.requestId[0]) return -1;
      entry = record.entry;
    }
    return result;
  }
  bool save(size_t slot, const Message &message) override {
    Record record;
    memset(&record, 0, sizeof(record));
    record.magic = MAGIC; record.version = 1; record.bytes = sizeof(record); record.message = message;
    record.crc = journalCrc(reinterpret_cast<const uint8_t *>(&record), offsetof(Record, crc));
    char key[8]; snprintf(key, sizeof(key), "s%u", unsigned(slot));
    if (preferences.putBytes(key, &record, sizeof(record)) != sizeof(record)) return false;
    Record verified{};
    if (read(key, verified) != 1 || memcmp(&record, &verified, sizeof(record))) return false;
    Message checked = verified.message;
    return digestMessage(checked) && memcmp(checked.digest, verified.message.digest, 32) == 0;
  }
  bool saveCompleted(size_t slot, const CompletedSos &entry) override {
    DoneRecord record{};
    record.magic = MAGIC; record.version = 1; record.bytes = sizeof(record); record.entry = entry;
    record.crc = journalCrc(reinterpret_cast<const uint8_t *>(&record), offsetof(DoneRecord, crc));
    char key[8]; snprintf(key, sizeof(key), "d%u", unsigned(slot));
    if (preferences.putBytes(key, &record, sizeof(record)) != sizeof(record)) return false;
    DoneRecord verified{};
    return read(key, verified) == 1 && memcmp(&record, &verified, sizeof(record)) == 0;
  }
  bool clear(size_t slot) override {
    char key[8]; snprintf(key, sizeof(key), "s%u", unsigned(slot));
    if (!preferences.isKey(key)) return true;
    return preferences.remove(key) && !preferences.isKey(key);
  }
  int loadCursor() override {
    if (!preferences.isKey("next_sos")) return 0; // Existing 2B.1 journals lack this key.
    uint32_t value = preferences.getUInt("next_sos", UINT32_MAX);
    return value < SOS_CAPACITY ? int(value) : -1;
  }
  bool saveCursor(uint8_t nextSlot) override {
    if (nextSlot >= SOS_CAPACITY || preferences.putUInt("next_sos", nextSlot) != sizeof(uint32_t)) return false;
    return preferences.getUInt("next_sos", UINT32_MAX) == nextSlot;
  }
};
} // namespace rescue_mobile
