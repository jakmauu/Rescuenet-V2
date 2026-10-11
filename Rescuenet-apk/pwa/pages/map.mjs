export function renderMap({ state, elements, ageText, locationAgeMs }) {
  const fix = state.fix;
  const age = locationAgeMs(fix);
  const valid = fix && age <= 120_000 && Number.isFinite(fix.lat) && Number.isFinite(fix.lon);
  elements['map-coordinate-title'].textContent = valid ? `${fix.lat.toFixed(6)}, ${fix.lon.toFixed(6)}` : 'Belum ada fix GPS terbaru';
  elements['map-coordinate-detail'].textContent = valid
    ? 'Posisi dari GPS perangkat. Tidak ada peta jalan offline.'
    : 'Aktifkan lokasi dan tunggu perangkat mendapatkan posisi GPS.';
  elements['map-accuracy'].textContent = valid && fix.accuracy != null ? `±${Math.round(fix.accuracy)} m` : 'Belum tersedia';
  elements['map-time'].textContent = valid ? new Date(fix.timestamp).toLocaleString('id-ID') : 'Belum tersedia';
  elements['map-age'].textContent = valid ? ageText(age) : 'Belum tersedia';
  elements['maps-link'].classList.toggle('hidden', !valid);
  if (valid) elements['maps-link'].href = `https://maps.apple.com/?ll=${encodeURIComponent(`${fix.lat},${fix.lon}`)}`;
}

export function bindMapPage({ elements, updateLocation }) {
  elements['map-update-button'].addEventListener('click', updateLocation);
}

