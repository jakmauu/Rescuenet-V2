#pragma once
// Host-only SHA256 API shim. Actual ESP32 uses its installed mbedTLS library.
#include <windows.h>
#include <bcrypt.h>
#include <cstdint>
#include <cstddef>
inline int mbedtls_sha256(const uint8_t *input, size_t size, uint8_t *output, int is224) {
  if (is224) return -1;
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  if (BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) != 0) return -1;
  auto status = BCryptHash(algorithm, nullptr, 0, const_cast<PUCHAR>(input), ULONG(size), output, 32);
  BCryptCloseAlgorithmProvider(algorithm, 0);
  return status == 0 ? 0 : -1;
}
