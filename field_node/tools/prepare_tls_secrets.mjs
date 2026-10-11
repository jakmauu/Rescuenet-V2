import fs from 'node:fs';
import path from 'node:path';
import { createPrivateKey, createPublicKey, randomUUID, X509Certificate } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..', '..');
const certPath = path.resolve(process.argv[2] || 'C:/RescueNet/cert/192.168.4.1.pem');
const keyPath = path.resolve(process.argv[3] || 'C:/RescueNet/cert/192.168.4.1-key.pem');
const outputPath = path.resolve(process.argv[4] || path.join(repoRoot, 'field_node/tls_secrets.h'));
const rootPath = process.argv[5] ? path.resolve(process.argv[5]) : '';
const checkOnly = process.argv[6] === '--check-only';

function readUtf8Pem(file, label, expectedLabels) {
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(file));
  } catch (error) {
    throw new Error(`${label} tidak dapat dibaca sebagai UTF-8: ${file} (${error.message})`);
  }
  if (!text.trim() || text.includes('\0')) throw new Error(`${label} kosong atau berisi byte NUL.`);
  const blocks = [...text.matchAll(/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g)];
  const remainder = text.replace(/-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g, '').trim();
  if (blocks.length !== 1 || remainder || !expectedLabels.includes(blocks[0]?.[1])) {
    throw new Error(`${label} harus berisi tepat satu blok PEM ${expectedLabels.join(' atau ')} tanpa teks tambahan.`);
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}

function validateTlsMaterial({ certificatePem, privateKeyPem, rootPem, now = Date.now() }) {
  let certificate;
  let privateKey;
  try {
    certificate = new X509Certificate(certificatePem);
    privateKey = createPrivateKey(privateKeyPem);
  } catch (error) {
    throw new Error(`PEM sertifikat/private key tidak valid atau private key terenkripsi: ${error.message}`);
  }

  if (!certificate.checkIP('192.168.4.1')) {
    throw new Error('Sertifikat tidak memiliki Subject Alternative Name IP 192.168.4.1.');
  }
  if (Date.parse(certificate.validFrom) > now || Date.parse(certificate.validTo) <= now) {
    throw new Error(`Sertifikat tidak berlaku saat ini (masa berlaku ${certificate.validFrom} sampai ${certificate.validTo}).`);
  }
  const certPublicKey = certificate.publicKey.export({ type: 'spki', format: 'der' });
  const keyPublicKey = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (!certPublicKey.equals(keyPublicKey)) throw new Error('Sertifikat dan private key tidak berpasangan.');

  if (rootPem) {
    let root;
    try { root = new X509Certificate(rootPem); }
    catch (error) { throw new Error(`rootCA.pem tidak valid: ${error.message}`); }
    if (!root.ca) throw new Error('rootCA.pem bukan sertifikat CA.');
    if (certificate.issuer !== root.subject || !certificate.verify(root.publicKey)) {
      throw new Error('Sertifikat server tidak ditandatangani oleh rootCA.pem yang diberikan.');
    }
  }
  return { certificate, privateKey };
}

const certificatePem = readUtf8Pem(certPath, 'Sertifikat server', ['CERTIFICATE']);
const privateKeyPem = readUtf8Pem(keyPath, 'Private key server', ['PRIVATE KEY', 'RSA PRIVATE KEY', 'EC PRIVATE KEY']);
const rootPem = rootPath ? readUtf8Pem(rootPath, 'Root CA publik', ['CERTIFICATE']) : '';
const { certificate } = validateTlsMaterial({ certificatePem, privateKeyPem, rootPem });

if (certificatePem.includes('RN_FIELD_NODE_CERT') || privateKeyPem.includes('RN_FIELD_NODE_KEY')) {
  throw new Error('PEM mengandung delimiter header generator.');
}

if (checkOnly) {
  console.log('TLS inputs valid; header was not written (--check-only).');
  console.log(`SAN IP 192.168.4.1: valid; berlaku sampai: ${certificate.validTo}`);
  console.log(rootPem ? 'Rantai server diverifikasi dengan rootCA.pem publik.' : 'PERINGATAN: rootCA.pem tidak diberikan; verifikasi rantai trust belum dilakukan.');
  process.exit(0);
}

const header = [
  '#pragma once',
  '// Generated locally from mkcert PEM files. DO NOT COMMIT this file.',
  `static const char RN_FIELD_NODE_CERT_PEM[] PROGMEM = ${JSON.stringify(certificatePem)};`,
  `static const char RN_FIELD_NODE_KEY_PEM[] PROGMEM = ${JSON.stringify(privateKeyPem)};`,
  '',
].join('\n');
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
const temporaryPath = `${outputPath}.${randomUUID()}.tmp`;
try {
  fs.writeFileSync(temporaryPath, header, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  fs.renameSync(temporaryPath, outputPath);
} catch (error) {
  try { fs.rmSync(temporaryPath, { force: true }); } catch { /* preserve the original error */ }
  throw new Error(`Gagal menulis header TLS lokal: ${error.message}`);
}

console.log(`TLS asset siap: ${outputPath}`);
console.log(`SAN IP 192.168.4.1: valid; berlaku sampai: ${certificate.validTo}`);
console.log('Sertifikat dan private key berpasangan.');
console.log(rootPem ? 'Rantai server diverifikasi dengan rootCA.pem publik.' : 'PERINGATAN: rootCA.pem tidak diberikan; verifikasi rantai trust belum dilakukan.');
console.log('Root CA dan rootCA-key.pem tidak disalin ke firmware.');

export { validateTlsMaterial };
