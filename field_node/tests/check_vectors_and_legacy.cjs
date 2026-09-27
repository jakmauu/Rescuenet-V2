// Independent JavaScript canonicalization and byte-for-byte legacy regression.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const {spawnSync, execFileSync} = require('node:child_process');
const {createHash} = require('node:crypto');
const root = path.resolve(__dirname, '../..');
const vectors = JSON.parse(fs.readFileSync(path.join(__dirname, 'canonical_vectors.json'), 'utf8'));
const frozenHashes = [
  'c97ed0a84df6cff60eabb5355f5334853f980711ae1c366cbce92b522808b700',
  'c97ed0a84df6cff60eabb5355f5334853f980711ae1c366cbce92b522808b700',
  'c862737db8c8b224060111605a816acc4e31bd28584f0174aa2b28d44ce8ba8f',
  'c862737db8c8b224060111605a816acc4e31bd28584f0174aa2b28d44ce8ba8f',
  '966e4cdfdcff462669090cb506ef55fc4d031d9d9f9f6465e5c2ef22a60bb8e9',
  '966e4cdfdcff462669090cb506ef55fc4d031d9d9f9f6465e5c2ef22a60bb8e9',
  'c97eb2b433afccee80210f200318167fe13ac13cdc79873b452a21b91b9f70c0',
  '44ede728a25d49130f3a646adee15d4bef9de78b051e2127f81aac57941f52c9'
];
function f64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeDoubleBE(value === 0 ? 0 : value); return buffer.toString('hex');
}
function canonical(m) {
  const emergency = m.sos === true;
  const fix = m.has_gps ? (m.fix_timestamp ?? (emergency ? m.gps_timestamp : m.timestamp)) : 0;
  return JSON.stringify({
    kind: emergency ? 'S' : 'L', request_id: m.request_id, user_id: m.user_id,
    name: m.name.trim().replace(/\s+/g, ' '), has_gps: m.has_gps,
    lat_f64: m.has_gps ? f64(m.lat) : null,
    lon_f64: m.has_gps ? f64(m.lon) : null,
    accuracy_f64: m.has_gps && m.accuracy !== null ? f64(m.accuracy) : null,
    fix_timestamp: fix, event_timestamp: emergency ? (m.event_timestamp ?? m.timestamp) : fix
  });
}
if (process.argv.includes('--print-golden')) {
  console.log(JSON.stringify(vectors.map(m => ({canonical: canonical(m), sha256: createHash('sha256').update(canonical(m)).digest('hex')})), null, 2));
  process.exit(0);
}
if (!process.argv.includes('--legacy-only')) {
const result = spawnSync(path.join(__dirname, '.build/mobile_host_test.exe'), ['--canonical'], {
  input: vectors.map(m => JSON.stringify(m)).join('\n') + '\n', encoding: 'utf8'
});
if (result.error) throw result.error;
assert.equal(result.status, 0, result.stderr);
const actual = result.stdout.trimEnd().split(/\r?\n/).map(line => line.split('\t'));
assert.equal(actual.length, vectors.length);
for (let i = 0; i < vectors.length; i++) {
  const expected = canonical(vectors[i]);
  const hash = createHash('sha256').update(expected).digest('hex');
  assert.equal(hash, frozenHashes[i], `frozen canonical vector ${i}`);
  assert.equal(actual[i][0], expected, `C++/JS canonical vector ${i}`);
  assert.equal(actual[i][1], hash, `C++/JS SHA256 vector ${i}`);
  console.log(`vector ${i}: sha256=${hash}`);
}
for (const [a, b] of [[0, 1], [2, 3], [4, 5]]) assert.deepEqual(actual[a], actual[b], 'aliases/normalization preserve identity');
}

const old = execFileSync('git', ['show', 'HEAD:field_node/field_node.ino'], {cwd: root, encoding: 'utf8'}).replace(/\r\n/g, '\n');
const current = fs.readFileSync(path.join(root, 'field_node/field_node.ino'), 'utf8').replace(/\r\n/g, '\n');
function functionSlice(source, name) {
  const functions = [...source.matchAll(/^(?:void|bool|String|int|uint16_t)\s+(\w+)\s*\(/gm)];
  const index = functions.findIndex(m => m[1] === name);
  assert.notEqual(index, -1, `function exists: ${name}`);
  return source.slice(functions[index].index, functions[index + 1]?.index ?? source.length);
}
// Radio TX/relay/setup intentionally change in 2C. Preserve GPS/PMU/UI and
// portal handling where byte-for-byte comparison is still meaningful.
const names = ['hasFreshNodeGps', 'getCsvField', 'parseGpsSentence', 'readNodeGps',
  'getNodeLocation', 'initPMU', 'updateOLED', 'handleRoot'];
for (const name of names) assert.equal(functionSlice(current, name), functionSlice(old, name), `legacy function unchanged: ${name}`);
for (const define of ['LORA_FREQ', 'LORA_SF', 'LORA_BW', 'LORA_CR', 'LORA_SYNC_WORD', 'MAX_HOP']) {
  const regex = new RegExp(`^#define\\s+${define}\\s+[^\\n]+`, 'm');
  const before = old.match(regex), after = current.match(regex);
  if (before) assert.equal(after?.[0], before[0], `radio constant ${define}`);
}
const portal = /const char PORTAL_HTML\[\] PROGMEM = R"rawliteral\([\s\S]*?\)rawliteral";/;
assert.equal(current.match(portal)?.[0], old.match(portal)?.[0], 'legacy portal HTML unchanged');
assert(!current.includes('#include <LoRa.h>'), 'old direct radio driver removed');
assert(current.includes('meshTransport.enqueueLegacy(report)'), 'portal reports use mesh transport');
assert(current.includes('Antrean jaringan penuh; coba kembali.'), 'portal reports failure instead of claiming delivery');
assert(current.includes('SOS belum terkirim. Coba kembali.'), 'portal SOS failure is visible');
console.log(`PASS ${process.argv.includes('--legacy-only') ? '' : `${vectors.length} cross-language vectors and `}${names.length} preserved legacy functions + portal and mesh migration`);
