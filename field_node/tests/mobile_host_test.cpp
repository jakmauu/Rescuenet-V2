#include "../MobileQueue.h"
#include "../MobileHttpHeaders.h"
#include "../MobileJournal.h"
#include "../RescueNetWire.h"
#include <windows.h>
#include <bcrypt.h>
#include <iostream>
#include <string>
#include <vector>
#include <stdexcept>

using namespace rescue_mobile;
static unsigned checks = 0;
static void check(bool value, const char *label) {
  ++checks;
  if (!value) throw std::runtime_error(label);
}
static std::string location(const std::string &request = "LOC-1", const std::string &user = "USR-1", unsigned time = 100) {
  return "{\"request_id\":\"" + request + "\",\"user_id\":\"" + user + "\",\"name\":\"Riko Dharmawan\",\"has_gps\":true,\"lat\":-6.364821,\"lon\":106.828913,\"accuracy\":6.8,\"fix_timestamp\":" + std::to_string(time) + "}";
}
static std::string sos(const std::string &request = "SOS-1") {
  return "{\"request_id\":\"" + request + "\",\"user_id\":\"USR-1\",\"name\":\"Riko\",\"sos\":true,\"has_gps\":false,\"event_timestamp\":100}";
}
static std::string replace(std::string input, const std::string &from, const std::string &to) {
  auto at = input.find(from);
  if (at == std::string::npos) throw std::runtime_error("bad test replacement");
  input.replace(at, from.size(), to); return input;
}
static const char *parse(const std::string &input, bool emergency, Message &m) {
  std::vector<char> buffer(input.begin(), input.end()); buffer.push_back(0);
  return parseMessage(buffer.data(), input.size(), emergency, m);
}
static void digest(Message &m) {
  char text[1025]; size_t length = canonicalMessage(m, text, sizeof(text));
  check(length != 0, "canonical buffer");
  BCRYPT_ALG_HANDLE algorithm = nullptr;
  check(BCryptOpenAlgorithmProvider(&algorithm, BCRYPT_SHA256_ALGORITHM, nullptr, 0) == 0, "host SHA256 provider");
  auto status = BCryptHash(algorithm, nullptr, 0, reinterpret_cast<PUCHAR>(text), ULONG(length), m.digest, sizeof(m.digest));
  BCryptCloseAlgorithmProvider(algorithm, 0);
  check(status == 0, "host SHA256");
}
static Message message(const std::string &input, bool emergency = false) {
  Message result; check(parse(input, emergency, result) == nullptr, "valid fixture"); digest(result); return result;
}
static std::string canonical(const Message &m) {
  char out[1025]; size_t n = canonicalMessage(m, out, sizeof(out)); check(n > 0, "canonical serialization"); return {out, n};
}
struct FakeJournal : Journal {
  Message records[SOS_CAPACITY]{};
  bool used[SOS_CAPACITY]{};
  CompletedSos completed[COMPLETED_SOS_CAPACITY]{};
  uint8_t cursor = 0;
  unsigned writes = 0;
  bool available = true, corrupt = false, failSave = false, failCursor = false, commitDespiteFailure = false;
  bool begin(uint8_t) override { return available; }
  int load(size_t i, Message &m) override { if (corrupt) return -1; if (!used[i]) return 0; m = records[i]; return 1; }
  int loadCompleted(size_t i, CompletedSos &m) override { m = completed[i]; return m.requestId[0] ? 1 : 0; }
  bool save(size_t i, const Message &m) override {
    ++writes;
    if (!failSave || commitDespiteFailure) { records[i] = m; used[i] = true; }
    return !failSave;
  }
  bool saveCompleted(size_t i, const CompletedSos &m) override { completed[i] = m; return !failSave; }
  bool clear(size_t i) override { used[i] = false; records[i] = Message{}; return true; }
  int loadCursor() override { return cursor; }
  bool saveCursor(uint8_t next) override { if (failCursor) return false; cursor = next; return true; }
};
static Result headers(const std::string &input) {
  std::vector<char> text(input.begin(), input.end()); text.push_back(0); HttpHeaders out;
  return parseHeaders(text.data(), out);
}

static void validationTests() {
  Message m;
  check(!parse(location(), false, m), "location valid");
  check(m.lat == -6.364821 && m.lon == 106.828913 && m.fixTime == 100 && m.eventTime == 100, "smartphone values preserved");
  const std::string pwaLocation = "{\"user_id\":\"USR-test\",\"name\":\"Riko Dharmawan\",\"request_id\":\"loc-123\",\"timestamp\":1000,\"has_gps\":true,\"lat\":-6.2088,\"lon\":106.8456,\"accuracy\":6.8}";
  check(!parse(pwaLocation, false, m) && m.fixTime == 1000 && m.lat == -6.2088, "PWA foreground tracking packet matches production Field API");
  check(!parse(sos(), true, m) && !m.hasGps && !m.fixTime, "SOS without GPS");
  auto gpsSos = replace(location(), "\"fix_timestamp\":100", "\"sos\":true,\"event_timestamp\":101,\"fix_timestamp\":100");
  check(!parse(gpsSos, true, m) && m.hasGps && m.eventTime == 101, "SOS with GPS");
  auto canonicalLoc = message(location());
  check(canonical(canonicalLoc) == canonical(message(replace(location(), "fix_timestamp", "timestamp"))), "Phase 1 location alias canonical");
  check(canonical(message(gpsSos, true)) == canonical(message(replace(replace(gpsSos, "event_timestamp", "timestamp"), "fix_timestamp", "gps_timestamp"), true)), "Phase 1 SOS aliases canonical");
  check(!parse(replace(location(), "\"fix_timestamp\":100", "\"timestamp\":100,\"fix_timestamp\":100"), false, m), "equal timestamp aliases");
  check(parse(replace(location(), "\"fix_timestamp\":100", "\"timestamp\":101,\"fix_timestamp\":100"), false, m) != nullptr, "conflicting timestamp aliases");
  std::vector<std::string> bad = {
    replace(location(), "-6.364821", "91"), replace(location(), "106.828913", "181"),
    replace(location(), "-6.364821", "true"), replace(location(), "-6.364821", "\"-6\""),
    replace(location(), "-6.364821", "1e999"), replace(location(), "-6.364821", "NaN"),
    replace(location(), "-6.364821", "01"), replace(location(), "-6.364821", "+1"),
    replace(location(), "\"accuracy\":6.8", "\"accuracy\":6553.5"), replace(location(), "\"accuracy\":6.8", "\"accuracy\":-1"),
    replace(location(), "100}", "100.5}"), replace(location(), "100}", "0}"),
    replace(location(), "100}", "4294967296}"), replace(location(), "100}", "true}"),
    replace(location(), "100}", "100.00000000000000001}"),
    replace(location(), "100}", "1789551200.00000001}"),
    replace(location(), "USR-1", "USR X"), replace(location(), "LOC-1", std::string(41, 'x')),
    replace(location(), "Riko Dharmawan", "x"), replace(location(), "Riko Dharmawan", std::string(61, 'x')),
    replace(location(), "Riko Dharmawan", "Riko\\u0001"), replace(location(), "Riko Dharmawan", "Riko\\u0000"),
    replace(location(), "Riko Dharmawan", "Riko\\ud800"), replace(location(), "Riko Dharmawan", "Riko\\udc00"),
    replace(location(), "Riko Dharmawan", std::string("Riko\xc0\xaf")),
    replace(location(), "\"has_gps\":true", "\"has_gps\":1"),
    replace(location(), "\"has_gps\":true", "\"has_gps\":false"),
    replace(location(), "\"accuracy\":6.8,", ""),
    location() + "garbage", "[]", "null", "{", "{'name':'Riko'}", "{name:1}",
    replace(location(), "100}", "100,}"), replace(location(), "100}", "100,\"extra\":1}"),
    replace(location(), "100}", "100,\"lat\":0}"),
    replace(location(), "100}", "100,\"l\\u0061t\":0}"),
    replace(location(), "100}", "100,\"event_timestamp\":100}"),
    replace(location(), "100}", "100,\"sos\":true}"), std::string(1025, ' ')
  };
  for (const auto &input : bad) check(parse(input, false, m) != nullptr, "invalid location rejected");
  check(parse(replace(sos(), "\"sos\":true", "\"sos\":false"), true, m) != nullptr, "SOS true required");
  check(parse(replace(sos(), "100}", "100,\"lat\":0}"), true, m) != nullptr, "no GPS cannot smuggle coordinates");
  check(!parse(replace(location(), "\"accuracy\":6.8", "\"accuracy\":null"), false, m) && !m.accuracyKnown, "unknown accuracy valid");
  check(!parse(replace(replace(location(), "-6.364821", "0"), "106.828913", "0"), false, m), "zero coordinates valid");
  check(!parse(replace(location(), "100}", "4294967295}"), false, m), "max timestamp");
  check(!parse(replace(location(), "100}", "100.0}"), false, m) && m.fixTime == 100, "integer-valued decimal timestamp");
  check(!parse(replace(location(), "100}", "1e2}"), false, m) && m.fixTime == 100, "integer-valued exponent timestamp");
  check(!parse(replace(location(), "Riko Dharmawan", "  Riko\\t Dharmawan  "), false, m) && !strcmp(m.name, "Riko Dharmawan"), "name whitespace normalization");
  check(!parse(replace(location(), "Riko Dharmawan", std::string(60, 'A')), false, m) && m.nameTruncated, "full name retained above 48 bytes");
  std::string emoji;
  for (int i = 0; i < 30; ++i) emoji += "\xf0\x9f\x98\x80";
  check(!parse(replace(location(), "Riko Dharmawan", emoji), false, m) && strlen(m.name) == 120, "UTF16 surrogate pair length");
  check(parse(replace(location(), "Riko Dharmawan", emoji + "A"), false, m) != nullptr, "UTF16 units limited");
  auto positive = message(replace(location(), "-6.364821", "0"));
  auto negative = message(replace(location(), "-6.364821", "-0"));
  check(canonical(positive) == canonical(negative), "negative zero canonicalized");
  check(canonical(message(replace(location(), "Riko Dharmawan", " Riko  Dharmawan "))) == canonical(canonicalLoc), "normalized names dedupe");
  auto subtlyChanged = message(replace(location(), "-6.364821", "-6.364821000001"));
  check(memcmp(canonicalLoc.digest, subtlyChanged.digest, 32) != 0, "digest includes unquantized coordinates");
}
static void queueTests() {
  FakeJournal store; MobileQueue q(store); check(q.begin(1, 123), "queue starts");
  auto first = message(location());
  check(q.accept(first, 0).code == 202 && q.pendingLocations() == 1, "location queued");
  check(q.accept(first, 1).duplicate && q.pendingLocations() == 1, "location duplicate no second slot");
  auto conflict = message(replace(location(), "Riko Dharmawan", "Other Name"));
  check(q.accept(conflict, 2).code == 409, "same ID different payload conflict");
  auto newer = message(location("LOC-2", "USR-1", 101));
  check(q.accept(newer, 3).coalesced && q.pendingLocations() == 1, "location coalesced by user");
  auto old = q.accept(first, 4);
  check(old.code == 200 && old.duplicate && !strcmp(old.state, "superseded"), "superseded retry ACK");
  check(q.accept(message(location("LOC-3", "USR-1", 100)), 5).code == 409, "older fix rejected");
  check(q.accept(message(location("LOC-4", "USR-1", 101)), 6).code == 409, "equal conflicting fix rejected");
  for (int i = 2; i <= 16; ++i) check(q.accept(message(location("L-" + std::to_string(i), "U-" + std::to_string(i))), i).code == 202, "fill location slots");
  check(q.pendingLocations() == LOCATION_CAPACITY, "location capacity");
  check(q.accept(message(location("EXTRA", "U-17")), 20).code == 503, "location queue full truthful");
  check(q.accept(message(location("NEWER", "USR-1", 102)), 21).code == 202, "coalesce when all slots occupied");
  auto emergency = message(sos(), true);
  check(q.accept(emergency, 22).code == 202 && store.writes == 1, "location pressure does not block durable SOS");
  check(q.nextPending()->kind == 'S', "SOS priority");
  check(q.accept(emergency, 23).duplicate && store.writes == 1, "SOS duplicate no write");
  check(q.accept(message(replace(sos(), "Riko", "Other"), true), 24).code == 409 && store.writes == 1, "SOS ID conflict no write");
  check(q.accept(message(location("SOS-1", "USR-1", 200)), 25).code == 409, "cross type ID conflict");
  for (int i = 2; i <= 8; ++i) check(q.accept(message(sos("S-" + std::to_string(i)), true), 30 + i).code == 202, "fill SOS slots");
  check(q.accept(message(sos("S-9"), true), 40).code == 503 && q.pendingSos() == 8 && store.writes == 8, "SOS full never ACK or overwrite");
  check(q.accept(emergency, 41).code == 200, "duplicate SOS succeeds at full capacity");
  MobileQueue rebooted(store); check(rebooted.begin(1, 456), "reboot recovers SOS");
  check(rebooted.pendingSos() == 8 && rebooted.pendingLocations() == 0, "SOS durable location RAM only");
  check(rebooted.accept(emergency, 0).duplicate && store.writes == 8, "SOS dedupe after reboot");
  check(rebooted.nextPending()->bootSession == 123, "pending identity preserved after reboot");
  FakeJournal failing; failing.failSave = true; MobileQueue f(failing); check(f.begin(1, 1), "fault test starts");
  check(f.accept(emergency, 0).code == 503 && f.pendingSos() == 0 && !f.ready(), "write failure fails closed before ACK");
  check(f.accept(first, 0).code == 503, "storage fault blocks later acceptance");
  FakeJournal cursorFault; cursorFault.failCursor = true; MobileQueue cursorQueue(cursorFault);
  check(cursorQueue.begin(1, 1) && cursorQueue.accept(emergency, 0).code == 503 && !cursorQueue.ready(), "cursor write failure fails closed");
  FakeJournal ambiguous; ambiguous.failSave = ambiguous.commitDespiteFailure = true; MobileQueue a(ambiguous); check(a.begin(1, 1), "ambiguous test starts");
  check(a.accept(emergency, 0).code == 503, "readback failure never ACK");
  ambiguous.failSave = false; MobileQueue recovered(ambiguous); check(recovered.begin(1, 2), "ambiguous write recovers on boot");
  check(recovered.accept(emergency, 0).duplicate && recovered.pendingSos() == 1, "retry after ambiguous commit no duplicate");
  FakeJournal broken; broken.corrupt = true; MobileQueue c(broken); check(!c.begin(1, 1) && !c.ready(), "corrupt journal fails closed");
  FakeJournal unavailable; unavailable.available = false; MobileQueue u(unavailable); check(!u.begin(1, 1), "storage unavailable boot");
  FakeJournal historyStore; MobileQueue h(historyStore); check(h.begin(1, 1), "history test starts");
  for (unsigned i = 0; i < 90; ++i) check(h.accept(message(location("H-" + std::to_string(i), "HUSER", 100 + i)), i).code == 202, "bounded history oldest eviction");
  check(h.pendingLocations() == 1 && historyStore.writes == 0, "tracking never writes flash");
  auto pinned = message(location("H-89", "HUSER", 189));
  check(h.accept(pinned, HISTORY_AGE_MS + 200).code == 200, "pending history pinned past max age");
  FakeJournal wrapStore; MobileQueue wrap(wrapStore); check(wrap.begin(1, 1), "wrap test starts");
  auto w1 = message(location("WRAP-1", "WRAP", 100));
  check(wrap.accept(w1, UINT32_MAX - 100).code == 202, "millis near wrap");
  check(wrap.accept(message(location("WRAP-2", "WRAP", 101)), UINT32_MAX - 50).code == 202, "coalesce near wrap");
  check(wrap.accept(w1, 100).duplicate, "history survives short millis wrap");
  check(wrap.accept(w1, HISTORY_AGE_MS + 100).code == 409, "expired old fix checked against pending newest");
  FakeJournal completedStore; strcpy(completedStore.completed[0].requestId, emergency.requestId); memcpy(completedStore.completed[0].digest, emergency.digest, 32);
  MobileQueue done(completedStore); check(done.begin(1, 1), "completed journal future seam");
  auto known = done.accept(emergency, 0); check(known.code == 200 && !strcmp(known.state, "lora_tx_completed") && done.pendingSos() == 0, "known completed state not pending");
}
static void headerTests() {
  std::string post = "POST /api/location HTTP/1.1\r\nHost: 192.168.4.1\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 250\r\n\r\n";
  check(!headers(post).error, "normal JSON headers");
  check(!headers("GET /api/status HTTP/1.1\r\nHost: 192.168.4.1\r\n\r\n").error, "status headers");
  check(headers(replace(post, "250", "1025")).code == 413, "oversized rejected before body");
  check(headers(replace(post, "250", "99999999999999999999999999")).code == 413, "length cannot overflow");
  check(headers(replace(post, "Content-Length: 250\r\n", "")).code == 400, "length required");
  check(headers(replace(post, "250", "0")).code == 400, "empty body");
  check(headers(replace(post, "Content-Length: 250\r\n", "Content-Length: 250\r\nContent-Length: 250\r\n")).code == 400, "duplicate lengths rejected");
  check(headers(replace(post, "application/json; charset=utf-8", "multipart/form-data; boundary=test")).code == 415, "multipart rejected before parsing");
  check(headers(replace(post, "application/json; charset=utf-8", "application/json; charset=latin1")).code == 415, "wrong charset");
  check(headers(replace(post, "Content-Length: 250", "Transfer-Encoding: chunked")).code == 415, "chunked rejected");
  check(headers(replace(post, "Host: 192.168.4.1", "Content-Encoding: gzip")).code == 415, "encoded rejected");
  check(headers(replace(post, "/api/location", "/api/does-not-exist")).code == 404, "unknown API JSON path");
  check(headers(replace(post, "POST", "GET")).code == 405, "wrong method");
  check(headers(replace(post, "Host: 192.168.4.1", "Idempotency-Key: " + std::string(41, 'x'))).code == 400, "bounded idempotency header");
  check(headers(replace(post, "Host: 192.168.4.1", "Idempotency-Key: LOC-1\r\nIdempotency-Key: LOC-1")).code == 400, "duplicate idempotency header");
  check(headers(replace(post, "Host: 192.168.4.1", "Expect: 100-continue")).code == 400, "no blocking expect");
  const std::string preflight = "OPTIONS /api/sos HTTP/1.1\r\nHost: 192.168.4.1\r\nOrigin: https://jakmauu.github.io\r\nAccess-Control-Request-Method: POST\r\nAccess-Control-Request-Headers: content-type,idempotency-key\r\nAccess-Control-Request-Private-Network: true\r\n\r\n";
  HttpHeaders parsedPreflight; auto preflightResult = [&]() { std::vector<char> b(preflight.begin(), preflight.end()); b.push_back(0); return parseHeaders(b.data(), parsedPreflight); }();
  check(!preflightResult.error && parsedPreflight.privateNetwork && !strcmp(parsedPreflight.origin, "https://jakmauu.github.io"), "PWA local-network CORS preflight accepted");
  check(allowedPwaOrigin(parsedPreflight), "configured PWA origin allowed");
  std::string otherOrigin = replace(preflight, "https://jakmauu.github.io", "https://evil.example");
  HttpHeaders parsedOther; auto otherResult = [&]() { std::vector<char> b(otherOrigin.begin(), otherOrigin.end()); b.push_back(0); return parseHeaders(b.data(), parsedOther); }();
  check(!otherResult.error && !allowedPwaOrigin(parsedOther), "untrusted PWA origin denied CORS");
  check(headers(replace(preflight, "content-type,idempotency-key", "x-evil-header")).code == 403, "unapproved browser header rejected");
  check(headers(replace(preflight, "Access-Control-Request-Method: POST", "Access-Control-Request-Method: DELETE")).code == 400, "unsupported preflight method rejected");
  check(headers(replace(preflight, "/api/sos", "/api/status")).code == 405, "preflight method must match endpoint");
  check(apiPath("/api") && apiPath("/api/foo") && !apiPath("/apiary"), "API boundary not portal lookalike");
}
static void journalTests() {
  Preferences::reset();
  NvsJournal journal; check(journal.begin(1), "actual journal schema init");
  auto m = message(sos(), true); m.source = 1; m.bootSession = 123; m.sequence = 1;
  check(digestMessage(m), "actual production digest API with host crypto shim");
  check(journal.save(0, m), "actual journal write and readback");
  Message loaded; check(journal.load(0, loaded) == 1 && loaded.bootSession == 123 && !memcmp(loaded.digest, m.digest, 32), "actual journal restore");
  check(journal.load(1, loaded) == 0, "absent journal slot");
  auto bytes = Preferences::data["s0"];
  Preferences::data["s0"][16] ^= 0x01;
  check(journal.load(0, loaded) == -1, "CRC corruption detected");
  Preferences::data["s0"] = bytes;
  Preferences::data["s0"][4] ^= 0x01;
  check(journal.load(0, loaded) == -1, "version mismatch detected");
  Preferences::data["s0"] = bytes; Preferences::data["s0"].pop_back();
  check(journal.load(0, loaded) == -1, "partial journal rejected");
  Preferences::data["s0"] = bytes;
  NvsJournal wrongNode; check(!wrongNode.begin(2), "changing NODE_ID fails closed with same journal");
  Preferences::failWrite = true; check(!journal.save(1, m), "NVS write failure truthful");
  Preferences::failWrite = false; Preferences::corruptReadback = true;
  check(!journal.save(1, m), "NVS readback corruption prevents ACK");
  Preferences::corruptReadback = false;
  check(journal.load(1, loaded) == 1, "ambiguous committed record recoverable");
  Preferences::data.erase("schema"); NvsJournal orphaned;
  check(!orphaned.begin(1) && Preferences::data.count("s0"), "orphan records never auto erased");
  Preferences::reset(); Preferences::available = false; NvsJournal unavailable;
  check(!unavailable.begin(1), "NVS unavailable detected");
  const char *vector = "123456789";
  check(journalCrc(reinterpret_cast<const uint8_t *>(vector), 9) == 0xcbf43926u, "standard CRC32 vector");
}
static void fuzzTests() {
  uint32_t random = 0x6e6574;
  auto next = [&]() { random ^= random << 13; random ^= random >> 17; random ^= random << 5; return random; };
  for (int i = 0; i < 10000; ++i) {
    std::string input = i % 2 ? location() : sos();
    for (unsigned j = 0, count = 1 + next() % 8; j < count; ++j) input[next() % input.size()] = char(next() & 255);
    Message m;
    auto error = parse(input, !(i % 2), m);
    if (!error) check(!canonical(m).empty(), "fuzz accepted message bounded");
  }
  check(true, "10000 deterministic mutated JSON inputs completed");
}
static void isolatedStorageTests() {
  const auto emergency = message(sos("ISOLATED"), true);
  for (int error : {ESP_ERR_NOT_FOUND, ESP_ERR_NVS_NO_FREE_PAGES, ESP_ERR_NVS_NEW_VERSION_FOUND, -1}) {
    Preferences::reset(); fake_nvs::initResult = error;
    Preferences::data["sentinel"] = {1, 2, 3};
    NvsJournal journal; MobileQueue q(journal);
    check(!q.begin(1, 1) && !q.ready(), "partition missing/init fault degrades queue");
    const auto result = q.accept(emergency, 0);
    check(result.code == 503 && !strcmp(result.error, "storage_unavailable"), "init failure cannot produce SOS202");
    check(Preferences::writes == 0 && Preferences::data["sentinel"] == std::vector<uint8_t>({1,2,3}), "init failure never writes/erases");
    check(fake_nvs::lastPartition == "rn_sos", "explicit init dedicated label");
  }
  Preferences::reset();
  NvsJournal journal; MobileQueue q(journal);
  check(q.begin(1, 1), "dedicated queue initializes");
  check(Preferences::lastPartition == "rn_sos", "Preferences explicitly selects dedicated partition");
  check(q.accept(emergency, 0).code == 202, "verified dedicated write permits202");
  const auto durable = Preferences::data;
  Preferences::defaultData["wifi"] = {7,8};
  Preferences::defaultData.clear(); // simulate core default-NVS recovery only
  check(Preferences::data == durable, "default recovery leaves dedicated bytes unchanged");
  NvsJournal restoredJournal; MobileQueue restored(restoredJournal);
  check(restored.begin(1, 2) && restored.pendingSos() == 1, "dedicated restore after reboot/default recovery");
  check(restored.accept(emergency, 0).duplicate && restored.pendingSos() == 1, "dedicated reboot dedupe");
  auto locationMessage = message(location());
  unsigned writes = Preferences::writes;
  check(restored.accept(locationMessage, 1).code == 202 && Preferences::writes == writes, "locations remain RAM only");
  for (int i=1; i<8; ++i) check(restored.accept(message(sos("ISOLATED-"+std::to_string(i)), true), i).code == 202, "dedicated fill pending capacity");
  check(restored.accept(message(sos("OVERFLOW"), true), 10).code == 503 && restored.pendingSos() == 8, "full dedicated journal truthful rejection");
  Preferences::reset(); NvsJournal failing; MobileQueue failed(failing); check(failed.begin(1, 1), "dedicated write fault setup");
  Preferences::corruptReadback = true;
  check(failed.accept(emergency, 0).code == 503 && failed.pendingSos() == 0, "dedicated readback fault never ACK");
}
static void storedAckCompletionTests() {
  Preferences::reset();
  NvsJournal store; MobileQueue queue(store);
  check(queue.begin(1, 111), "ACK test queue starts");
  auto emergency = message(sos("ACK-SOS"), true);
  check(queue.accept(emergency, 1).code == 202 && queue.pendingSos() == 1, "SOS saved before transmit");
  uint8_t wrong[16]{};
  check(!queue.completeStored(wrong) && queue.pendingSos() == 1, "wrong ACK cannot release SOS");
  check(queue.completeStored(emergency.digest) && queue.pendingSos() == 0, "STORED ACK releases SOS");
  check(Preferences::data.count("d0") && !Preferences::data.count("s0"), "DONE marker durable before slot removal");
  NvsJournal rebootStore; MobileQueue reboot(rebootStore);
  check(reboot.begin(1, 222) && reboot.pendingSos() == 0, "completed SOS stays completed after reboot");
  check(reboot.accept(emergency, 2).duplicate, "replayed HTTP request deduped after ACK");

  Preferences::reset(); NvsJournal crashStore; MobileQueue beforeCrash(crashStore);
  check(beforeCrash.begin(1, 333), "crash fixture starts");
  check(beforeCrash.accept(emergency, 1).code == 202, "crash fixture saved SOS");
  CompletedSos done{}; strcpy(done.requestId, emergency.requestId); memcpy(done.digest, emergency.digest, 32);
  check(crashStore.saveCompleted(0, done), "simulate crash after DONE before clear");
  NvsJournal afterCrashStore; MobileQueue afterCrash(afterCrashStore);
  check(afterCrash.begin(1, 444) && afterCrash.pendingSos() == 0, "boot reconciles DONE plus pending SOS");

  Preferences::reset(); NvsJournal failStore; MobileQueue failQueue(failStore);
  check(failQueue.begin(1, 555) && failQueue.accept(emergency, 1).code == 202, "failure fixture saved SOS");
  Preferences::failWrite = true;
  check(!failQueue.completeStored(emergency.digest) && failQueue.pendingSos() == 1, "DONE write failure cannot release SOS");
  Preferences::failWrite = false;

  Preferences::reset(); NvsJournal fifoStore; MobileQueue fifo(fifoStore);
  check(fifo.begin(1, 777), "FIFO fixture starts");
  auto a = message(sos("FIFO-A"), true), b = message(sos("FIFO-B"), true), c = message(sos("FIFO-C"), true);
  check(fifo.accept(a, 1).code == 202 && fifo.accept(b, 2).code == 202, "two durable SOS queued");
  for (size_t i = 2; i < SOS_CAPACITY; ++i)
    check(fifo.accept(message(sos("FIFO-" + std::to_string(i)), true), uint32_t(i + 1)).code == 202, "FIFO journal filled");
  check(fifo.completeStored(a.digest), "oldest SOS completed");
  check(fifo.accept(c, 3).code == 202, "freed slot reused");
  NvsJournal fifoRebootStore; MobileQueue fifoReboot(fifoRebootStore);
  check(fifoReboot.begin(1, 888) && fifoReboot.nextPending() && !strcmp(fifoReboot.nextPending()->requestId, "FIFO-B"), "FIFO survives slot reuse and reboot");
  check(fifoReboot.completeStored(b.digest) && fifoReboot.nextPending() && !strcmp(fifoReboot.nextPending()->requestId, "FIFO-2"), "FIFO advances after stored ACK");
  for (size_t i = 2; i < SOS_CAPACITY; ++i) {
    auto old = message(sos("FIFO-" + std::to_string(i)), true);
    check(fifoReboot.completeStored(old.digest), "old pending SOS completed in order");
  }
  check(fifoReboot.nextPending() && !strcmp(fifoReboot.nextPending()->requestId, "FIFO-C"), "reused slot is newest after reboot");
  Preferences::data["next_sos"] = {0xff, 0xff, 0xff, 0xff};
  NvsJournal corruptCursorStore; MobileQueue corruptCursor(corruptCursorStore);
  check(!corruptCursor.begin(1, 999), "corrupt FIFO cursor fails closed");
}
static void meshWireTests() {
  uint8_t packet[rnwire::MAX_PACKET]{};
  rnwire::Mobile event{}; event.kind = 1; event.flags = 3; event.node = 1;
  for (int i = 0; i < 16; ++i) event.key[i] = uint8_t(i * 0x11);
  const uint8_t user[8] = {1,0x23,0x45,0x67,0x89,0xab,0xcd,0xef};
  memcpy(event.user, user, 8); event.eventTime = 1700000000; event.fixTime = 1699999999;
  event.latE6 = -6364821; event.lonE6 = 106828913; event.accuracyDm = 68; strcpy(event.name, "Riko");
  size_t size = rnwire::encodeMobile(event, packet); char hex[201]; rnwire::hexBytes(packet, size, hex);
  check(std::string(hex) == "524e4d3101030100112233445566778899aabbccddeeff0123456789abcdef6553f1006553f0ffff9ee16b065e147100440452696b6fb4c2", "LOCATION GPS golden bytes");
  rnwire::Mobile decoded; check(rnwire::decodeMobile(packet, size, decoded) && decoded.latE6 == -6364821 && !strcmp(decoded.name,"Riko"), "mobile decode roundtrip");
  packet[4] = 3; check(!rnwire::decodeMobile(packet, size, decoded), "bad mobile type rejected"); packet[4] = 1;
  packet[size - 1] ^= 1; check(!rnwire::decodeMobile(packet, size, decoded), "bad CRC rejected"); packet[size - 1] ^= 1;
  check(!rnwire::decodeMobile(packet, size - 1, decoded), "truncated frame rejected");
  event.kind = 2; size = rnwire::encodeMobile(event, packet); rnwire::hexBytes(packet, size, hex);
  check(std::string(hex) == "524e4d3102030100112233445566778899aabbccddeeff0123456789abcdef6553f1006553f0ffff9ee16b065e147100440452696b6f8258", "SOS GPS golden bytes");
  event.flags = 0; event.fixTime = 0; event.latE6 = 0; event.lonE6 = 0; event.accuracyDm = 0xffff;
  size = rnwire::encodeMobile(event, packet); rnwire::hexBytes(packet, size, hex);
  check(std::string(hex) == "524e4d3102000100112233445566778899aabbccddeeff0123456789abcdef6553f100000000000000000000000000ffff0452696b6f7b18", "SOS no-GPS golden bytes");
  check(rnwire::utf8Prefix("Rik\xC3\xB3", 4) == 3, "UTF-8 boundary truncation");
  rnwire::Legacy legacy{}; legacy.packetId = 4097; legacy.node = 1; legacy.flags = 1; legacy.count = 1;
  legacy.latE6 = -6364821; legacy.lonE6 = 106828913; strcpy(legacy.condition,"SEDANG"); strcpy(legacy.message,"Riko|Gedung A");
  size = rnwire::encodeLegacy(legacy, packet); rnwire::hexBytes(packet, size, hex);
  check(std::string(hex) == "524e4c311001010101ff9ee16b065e1471060d534544414e4752696b6f7c476564756e6720416742", "legacy report golden bytes");
  rnwire::Legacy decodedLegacy; check(rnwire::decodeLegacy(packet, size, decodedLegacy) && !strcmp(decodedLegacy.condition,"SEDANG"), "legacy decode roundtrip");
  rnwire::Ack ack{}; memcpy(ack.key, event.key, 16); ack.status = 1;
  size = rnwire::encodeAck(ack, packet); rnwire::hexBytes(packet, size, hex);
  check(std::string(hex) == "524e41310100112233445566778899aabbccddeeff4e01", "STORED ACK golden bytes");
  rnwire::Ack decodedAck; check(rnwire::decodeAck(packet, size, decodedAck) && !memcmp(decodedAck.key, ack.key, 16), "ACK decode roundtrip");
}
int main(int argc, char **argv) {
  try {
    if (argc == 2 && std::string(argv[1]) == "--canonical") {
      std::string input;
      while (std::getline(std::cin, input)) {
        Message m; bool emergency = input.find("\"sos\"") != std::string::npos;
        const char *error = parse(input, emergency, m);
        if (error) throw std::runtime_error(error);
        check(digestMessage(m), "canonical vector digest");
        std::cout << canonical(m) << '\t';
        char hex[3];
        for (uint8_t byte : m.digest) { snprintf(hex, sizeof(hex), "%02x", byte); std::cout << hex; }
        std::cout << '\n';
      }
      return 0;
    }
    validationTests(); queueTests(); headerTests(); journalTests(); isolatedStorageTests(); storedAckCompletionTests(); meshWireTests(); fuzzTests();
    std::cout << "PASS " << checks << " assertions; sizeof(Message)=" << sizeof(Message) << "; sizeof(MobileQueue)=" << sizeof(MobileQueue) << '\n';
    return 0;
  } catch (const std::exception &e) { std::cerr << "FAIL: " << e.what() << '\n'; return 1; }
}
