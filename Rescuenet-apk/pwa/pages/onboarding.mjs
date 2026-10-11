export function renderOnboarding({ state, elements, profile, renderConnection }) {
  const step = state.onboardingStep;
  const titles = ['Selamat datang di RescueNet', 'Daftarkan identitas', 'Hubungkan ke Field Node', 'Verifikasi koneksi', 'Aktifkan lokasi bila dibutuhkan'];
  const copies = [
    'Bantuan darurat dan koordinasi lapangan, tetap siap meski internet tidak tersedia.',
    'Nama dan peran membantu petugas memahami laporan. Identitas disimpan di perangkat ini.',
    'Sambungkan iPhone ke Wi-Fi RescueNet. Ikuti captive portal jika muncul.',
    'Pemeriksaan ini menguji API lokal. Status mesh dan Gateway ditampilkan terpisah.',
    'Lokasi hanya digunakan setelah izin dan persetujuan Anda.',
  ];
  elements['onboarding-step'].textContent = `LANGKAH ${step + 1} DARI 5`;
  elements['onboarding-title'].textContent = titles[step];
  elements['onboarding-copy'].textContent = copies[step];
  for (const [id, show] of [['onboarding-form', step === 1], ['wifi-guide', step === 2], ['verify-guide', step === 3], ['permission-guide', step === 4]]) {
    elements[id].hidden = !show;
  }
  elements['onboarding-back'].hidden = step === 0;
  elements['onboarding-skip'].hidden = ![2, 3, 4].includes(step);
  elements['onboarding-next'].textContent = ['Mulai', 'Simpan & lanjut', 'Saya sudah terhubung', 'Lanjutkan', 'Selesai'][step];
  elements['onboarding-next'].disabled = step === 3 && state.checking;
  if (step === 1 && !profile()) elements['name-input'].value = '';
  if (step === 3) renderConnection();
}

export function bindOnboardingPage({ elements, next, back, skip, requestLocation, onConsentChange }) {
  elements['onboarding-next'].addEventListener('click', next);
  elements['onboarding-back'].addEventListener('click', back);
  elements['onboarding-skip'].addEventListener('click', skip);
  elements['permission-button'].addEventListener('click', requestLocation);
  elements['onboarding-location-consent'].addEventListener('change', onConsentChange);
}

