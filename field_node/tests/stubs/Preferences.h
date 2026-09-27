#pragma once
// Host-only NVS fault injection. Never included by the Arduino firmware build.
#include <map>
#include <string>
#include <vector>
#include <cstring>
#include <cstdint>
#include "nvs_flash.h"

class Preferences {
  bool dedicated = false;
  std::map<std::string, std::vector<uint8_t>> &records() { return dedicated ? data : defaultData; }
public:
  inline static std::map<std::string, std::vector<uint8_t>> data;
  inline static std::map<std::string, std::vector<uint8_t>> defaultData;
  inline static std::string lastPartition;
  inline static unsigned writes = 0;
  inline static bool available = true, failWrite = false, corruptReadback = false;
  static void reset() { data.clear(); defaultData.clear(); lastPartition.clear(); fake_nvs::reset(); writes = 0; available = true; failWrite = corruptReadback = false; }
  bool begin(const char *, bool, const char *partition = nullptr) {
    lastPartition = partition ? partition : "nvs";
    dedicated = lastPartition == "rn_sos";
    return available && (!partition || nvs_flash_init_partition(partition) == ESP_OK);
  }
  bool isKey(const char *key) { return records().count(key) != 0; }
  size_t getBytesLength(const char *key) { return isKey(key) ? records()[key].size() : 0; }
  size_t getBytes(const char *key, void *out, size_t capacity) {
    if (!isKey(key) || records()[key].size() > capacity) return 0;
    auto &bytes = records()[key]; memcpy(out, bytes.data(), bytes.size());
    if (corruptReadback && !bytes.empty()) static_cast<uint8_t *>(out)[0] ^= 1;
    return bytes.size();
  }
  size_t putBytes(const char *key, const void *bytes, size_t length) {
    ++writes; if (failWrite) return 0;
    auto start = static_cast<const uint8_t *>(bytes); records()[key] = {start, start + length}; return length;
  }
  size_t putUInt(const char *key, uint32_t value) { return putBytes(key, &value, sizeof(value)); }
  bool remove(const char *key) { return records().erase(key) != 0; }
  uint32_t getUInt(const char *key, uint32_t fallback) {
    uint32_t result; return getBytes(key, &result, sizeof(result)) == sizeof(result) ? result : fallback;
  }
};
