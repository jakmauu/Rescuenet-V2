export function renderConnectionCard({ state, elements, statusLabel, meshText }) {
  const reached = Boolean(state.nodeDetails);
  const ready = state.nodeReady;
  const title = state.checking ? 'Memeriksa Field Node…'
    : reached ? `Terhubung ke Field Node ${state.nodeDetails.node_id}` : statusLabel();
  const help = reached
    ? (ready ? 'API Field Node dapat diakses. Mesh, Gateway, dan petugas memiliki status terpisah.'
      : 'API dapat diakses, tetapi Field Node belum siap menerima kiriman. Coba lagi sebentar.')
    : state.connectionError || 'Sambungkan ke Wi-Fi RescueNet, pilih tetap terhubung tanpa internet, lalu periksa koneksi.';

  for (const [id, value] of [
    ['connection-title', title], ['home-connection-title', title],
    ['connection-help', help], ['home-connection-help', help],
    ['api-state', reached ? 'Terhubung' : statusLabel()], ['home-api-state', reached ? 'Terhubung' : statusLabel()],
    ['mesh-state', meshText(state.nodeDetails)], ['home-mesh-state', meshText(state.nodeDetails)],
    ['status-api', reached ? 'Terhubung' : statusLabel()], ['status-mesh', meshText(state.nodeDetails)],
  ]) if (elements[id]) elements[id].textContent = value;

  for (const id of ['check-button', 'home-check-button']) {
    const button = elements[id];
    if (!button) continue;
    button.disabled = state.checking;
    button.textContent = state.checking ? 'Memeriksa…' : 'Cek koneksi';
  }
}

