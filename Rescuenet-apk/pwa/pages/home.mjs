export function renderHome({ elements, profile }) {
  const user = profile();
  elements['welcome-user'].textContent = user
    ? `Halo, ${user.name}. Tetap terhubung di lapangan, bahkan tanpa internet.`
    : 'Bantuan saat dibutuhkan. Siapkan identitas dan koneksi RescueNet.';
  elements['sos-button'].disabled = state.sendingSosId !== null || !user;
  elements['sos-button-label'].textContent = state.sendingSosId ? 'MENGIRIM…' : state.nodeReady ? 'KIRIM SOS' : 'SIMPAN SOS';
}

export function bindHomePage({ elements, checkConnection, sendSos, showScreen, beginOnboarding }) {
  elements['home-check-button'].addEventListener('click', checkConnection);
  elements['sos-button'].addEventListener('click', sendSos);
  elements['home-map-button'].addEventListener('click', () => showScreen('map'));
  elements['home-status-button'].addEventListener('click', () => showScreen('status'));
  elements['home-wifi-button'].addEventListener('click', () => beginOnboarding(2));
}

