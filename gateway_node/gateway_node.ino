/* RescueNet 2C Gateway. LoRaMesher owns SX1276; no direct LoRa driver. */
#include <Arduino.h>
#include <Wire.h>
#include <XPowersLib.h>
#include <loramesher.hpp>
#include <memory>
#include <vector>
#include "RescueNetWire.h"
using namespace loramesher;
XPowersAXP2101 PMU;
std::unique_ptr<LoraMesher> mesh;
struct Rx { AddressType source; uint8_t size; uint8_t data[rnwire::MAX_PACKET]; };
QueueHandle_t incoming;
struct PendingAck { uint8_t key[16]; AddressType source; uint32_t seenMs; bool used; };
PendingAck pending[24]{};
char serialLine[80]{};
size_t serialLength = 0;
void onData(AddressType source, const std::vector<uint8_t> &data) {
  if (!incoming || data.empty() || data.size() > rnwire::MAX_PACKET) return;
  Rx item{}; item.source = source; item.size = uint8_t(data.size());
  memcpy(item.data, data.data(), data.size()); xQueueSend(incoming, &item, 0);
}
int routeHops(AddressType source) {
  for (const auto &route : mesh->GetRoutingTable())
    if (route.destination == source && route.is_valid && route.hop_count > 0) return route.hop_count;
  return -1;
}
void remember(const uint8_t key[16], AddressType source) {
  size_t slot = 0;
  for (size_t i = 0; i < 24; ++i) {
    if (pending[i].used && !memcmp(pending[i].key, key, 16)) { slot = i; break; }
    if (!pending[i].used || uint32_t(millis() - pending[i].seenMs) > uint32_t(millis() - pending[slot].seenMs)) slot = i;
  }
  memcpy(pending[slot].key, key, 16); pending[slot].source = source; pending[slot].seenMs = millis(); pending[slot].used = true;
}
void processReceived(const Rx &item) {
  rnwire::Mobile mobile;
  if (rnwire::decodeMobile(item.data, item.size, mobile)) {
    remember(mobile.key, item.source);
    char key[33], hex[rnwire::MAX_PACKET * 2 + 1];
    rnwire::hexKey(mobile.key, key); rnwire::hexBytes(item.data, item.size, hex);
    int hops = routeHops(item.source);
    Serial.printf("[MESH RX] src=%u bytes=%u\n", unsigned(item.source), unsigned(item.size));
    Serial.printf("RNM1,%s,%u,", key, unsigned(item.source));
    if (hops < 0) Serial.print('-'); else Serial.print(hops);
    Serial.print(','); Serial.println(hex);
    Serial.printf("[RNM1] request=%s forwarded_to_serial\n", key);
    return;
  }
  rnwire::Legacy legacy;
  if (rnwire::decodeLegacy(item.data, item.size, legacy)) {
    int hops = routeHops(item.source);
    int hopDisplay = (hops > 0) ? (hops - 1) : 0;
    // LoRaMesher's application callback provides no measured RSSI/SNR.
    Serial.printf("-,-,%u,%u,%d,5,%.6f,%.6f,%u,%s,%u,%u,%s\n",
      unsigned(legacy.packetId), unsigned(legacy.node), hopDisplay,
      (legacy.flags & 1) ? legacy.latE6 / 1000000.0 : 0.0,
      (legacy.flags & 1) ? legacy.lonE6 / 1000000.0 : 0.0,
      unsigned(legacy.flags & 1), legacy.condition, unsigned(legacy.count), unsigned((legacy.flags >> 1) & 1), legacy.message);
    return;
  }
  Serial.println("[DROP] invalid application frame");
}
void processAckLine() {
  if (!mesh) return;
  if (strncmp(serialLine, "RNACK1,", 7)) return;
  char *comma = strchr(serialLine + 7, ',');
  if (!comma || strcmp(comma + 1, "STORED")) return;
  *comma = 0; uint8_t key[16];
  if (!rnwire::keyHex(serialLine + 7, key)) return;
  Serial.printf("[SERVER ACK RX] request=%s\n", serialLine + 7);
  for (auto &entry : pending) {
    if (!entry.used || memcmp(entry.key, key, 16)) continue;
    rnwire::Ack ack{}; memcpy(ack.key, key, 16); ack.status = 1;
    uint8_t packet[rnwire::MAX_PACKET]; size_t n = rnwire::encodeAck(ack, packet);
    if (!mesh->IsReadyToSend(entry.source)) return;
    Result result = mesh->Send(entry.source, std::vector<uint8_t>(packet, packet + n));
    if (result) Serial.printf("[MESH ACK TX] request=%s dst=%u\n", serialLine + 7, unsigned(entry.source));
    return;
  }
  Serial.println("[SERVER ACK RX] mapping unavailable; field retry will restore it");
}
void readSerial() {
  while (Serial.available()) {
    char c = char(Serial.read()); if (c == '\r') continue;
    if (c == '\n') { serialLine[serialLength] = 0; processAckLine(); serialLength = 0; continue; }
    if (serialLength + 1 < sizeof(serialLine)) serialLine[serialLength++] = c; else serialLength = 0;
  }
}
void setup() {
  Serial.begin(115200); Wire.begin(21, 22); pinMode(4, OUTPUT);
  if (!PMU.begin(Wire, AXP2101_SLAVE_ADDRESS, 21, 22)) { Serial.println("[MESH] PMU failure"); return; }
  PMU.setALDO2Voltage(3300); PMU.enableALDO2();
  if (!PMU.isEnableALDO2()) { Serial.println("[MESH] ALDO2 unavailable"); return; }
  incoming = xQueueCreate(12, sizeof(Rx));
  if (!incoming) { Serial.println("[MESH] RX queue unavailable"); return; }
  RadioConfig radio(RadioType::kSx1276, 923.0F, 9, 125.0F, 5, 17, 0xF3, true, 8);
  PinConfig pins(18, 23, 26, 33, 5, 19, 27);
  LoRaMeshProtocolConfig protocol; protocol.setNodeRole(NodeRole::NETWORK_MANAGER); protocol.setMaxPacketSize(115);
  mesh = LoraMesher::Builder().withRadioConfig(radio).withPinConfig(pins)
    .withLoRaMeshProtocol(protocol).withNodeCapabilities(NodeCapabilities::GATEWAY).Build();
  mesh->SetDataCallback(onData);
  Result started = mesh->Start();
  if (!started) { Serial.printf("[MESH] start failed: %s\n", started.GetErrorMessage().c_str()); mesh.reset(); return; }
  Serial.printf("[MESH] NETWORK_MANAGER ready address=%u\n", unsigned(mesh->GetNodeAddress()));
  Serial.println("GATEWAY_READY");
}
void loop() {
  readSerial();
  if (mesh && incoming) { Rx item; for (int i = 0; i < 4 && xQueueReceive(incoming, &item, 0) == pdTRUE; ++i) processReceived(item); }
  delay(10);
}
