// Run after both Arduino CLI builds; verifies the exact binaries to upload.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const repo = path.resolve(__dirname, '../..');
const toolBuild = 'D:/RescueNET-tools';
const typeCode = {app: 0, data: 1};
const subtypeCode = {ota_0: 0x10, ota_1: 0x11, nvs: 2, ota: 0, spiffs: 0x82, coredump: 3};
function csv(file) {
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#')).map(line => {
    const [name, type, subtype, offset, size] = line.split(',').map(x => x.trim());
    return {name, type: typeCode[type], subtype: subtypeCode[subtype], offset: Number(offset), size: Number(size)};
  });
}
function binary(file) {
  const data = fs.readFileSync(file), parts = [];
  assert.equal(data.length, 0xc00, 'partition binary must be 0xc00 bytes');
  for (let i = 0; i + 32 <= data.length; i += 32) {
    const magic = data.readUInt16LE(i);
    if (magic === 0xebeb || magic === 0xffff) break;
    assert.equal(magic, 0x50aa, 'valid partition entry magic');
    parts.push({name: data.toString('ascii', i + 12, i + 28).split('\0')[0],
      type: data[i + 2], subtype: data[i + 3], offset: data.readUInt32LE(i + 4), size: data.readUInt32LE(i + 8)});
  }
  return parts;
}
for (const [name, sketch] of [['Field', 'field_node'], ['Gateway', 'gateway_node']]) {
  const expected = csv(path.join(repo, sketch, 'partitions.csv'));
  const actual = binary(path.join(toolBuild, `build-${name.toLowerCase()}-2c`, `${sketch}.ino.partitions.bin`));
  assert.deepEqual(actual, expected, `${name} generated binary must match sketch CSV exactly`);
  let end = 0x9000;
  for (const part of actual) {
    assert(part.offset >= end, `${name}: no overlap`);
    assert.equal(part.offset % (part.type === 0 ? 0x10000 : 0x1000), 0, `${name}: alignment`);
    end = part.offset + part.size;
    assert(end <= 0x400000, `${name}: within physical 4MB flash`);
  }
  for (const app of actual.filter(p => p.type === 0)) assert.equal(app.size, 0x1a0000, `${name}: 1.625MiB OTA slot`);
  assert.equal(actual[0].name, 'nvs', `${name}: default NVS remains first`);
  const journal = actual.find(p => p.name === 'rn_sos');
  if (name === 'Field') {
    assert(journal && journal.offset === 0x3e8000 && journal.size === 0x8000, 'Field: rn_sos unchanged');
  } else assert(!journal, 'Gateway must not claim Field journal');
  console.log(`PASS ${name}: generated partition binary matches CSV; bounds, alignment and dual OTA valid`);
}
