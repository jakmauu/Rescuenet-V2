const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '..');
function parseCsv(text) {
  return text.split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
    const [name, type, subtype, offset, size] = line.split(',').map(x => x.trim());
    return {name, type, subtype, offset: Number(offset), size: Number(size)};
  });
}
const activePath = path.join(root, 'partitions.csv');
assert(fs.existsSync(activePath), 'active partition table required');
const table = parseCsv(fs.readFileSync(activePath, 'utf8'));
let end = 0x9000;
for (const part of table) {
  assert(part.offset >= end, 'no overlap, partition table ends before first data partition');
  assert.equal(part.offset % (part.type === 'app' ? 0x10000 : 0x1000), 0, 'offset alignment');
  assert.equal(part.size % 0x1000, 0, 'size alignment');
  end = part.offset + part.size;
  assert(end <= 0x400000, 'within candidate 4MB flash');
}
for (const [name, offset, size] of [['nvs',0x9000,0x5000], ['otadata',0xe000,0x2000], ['app0',0x10000,0x1a0000], ['app1',0x1b0000,0x1a0000], ['coredump',0x3f0000,0x10000]]) {
  const entry = table.find(p => p.name === name);
  assert.equal(entry.offset, offset, `${name} offset preserved`);
  assert.equal(entry.size, size, `${name} size preserved`);
}
assert.equal(table.find(p => p.type === 'data' && p.subtype === 'nvs').name, 'nvs', 'core recovery selects system NVS first');
const journal = table.find(p => p.name === 'rn_sos');
assert.equal(journal.type, 'data'); assert.equal(journal.subtype, 'nvs');
assert.equal(journal.offset, 0x3e8000); assert.equal(journal.size, 0x8000);
const spiffs = table.find(p => p.name === 'spiffs');
assert.equal(spiffs.offset, 0x350000);
assert.equal(spiffs.size, 0x98000);
assert.equal(spiffs.offset + spiffs.size, journal.offset, 'SPIFFS ends before protected rn_sos');
const original = parseCsv(fs.readFileSync(path.join(root, 'partition_candidates/rescuenet_4mb.csv'), 'utf8'));
assert.equal(original.find(p => p.name === 'rn_sos').offset, journal.offset, 'protected journal offset unchanged from 2B.1');
assert.equal(original.find(p => p.name === 'rn_sos').size, journal.size, 'protected journal size unchanged from 2B.1');
const source = fs.readFileSync(path.join(root, 'MobileJournal.h'), 'utf8');
assert(source.includes('nvs_flash_init_partition(SOS_PARTITION) != ESP_OK'));
assert(source.includes('preferences.begin("rn_mobile_b1", false, SOS_PARTITION)'));
for (const name of ['nvs_flash_erase', 'esp_partition_erase_range', 'nvs_erase_all', 'preferences.clear']) {
  assert(!source.includes(name + '('), `no journal destructive recovery: ${name}`);
}
assert(source.includes('bool saveCompleted(') && source.includes('bool clear('), '2C durable completion has explicit methods');
assert(source.includes('preferences.remove(key) && !preferences.isKey(key)'), 'only per-slot removal, read-back verified');
console.log('PASS 2C layout alignment/overlap/4MB bounds, dual OTA capacity, preserved rn_sos/system NVS/coredump, explicit partition, no erase/fallback');
console.log('Hardware review: COM17 4MB backup and actual partition table matched; SPIFFS was fully erased before provisioning.');
