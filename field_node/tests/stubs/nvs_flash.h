#pragma once
#include <string>
using esp_err_t = int;
constexpr esp_err_t ESP_OK = 0;
constexpr esp_err_t ESP_ERR_NOT_FOUND = 0x105;
constexpr esp_err_t ESP_ERR_NVS_NO_FREE_PAGES = 0x110d;
constexpr esp_err_t ESP_ERR_NVS_NEW_VERSION_FOUND = 0x1110;
namespace fake_nvs {
inline esp_err_t initResult = ESP_OK;
inline unsigned initCalls = 0;
inline std::string lastPartition;
inline void reset() { initResult = ESP_OK; initCalls = 0; lastPartition.clear(); }
}
inline esp_err_t nvs_flash_init_partition(const char *partition) {
  ++fake_nvs::initCalls; fake_nvs::lastPartition = partition;
  return fake_nvs::initResult;
}
// No erase symbol provided: adding destructive recovery breaks the host build.
