export function renderProfile({ elements, profile }) {
  const current = profile();
  elements['profile-name-input'].value = current?.name || '';
  elements['profile-role-input'].value = current?.role || 'survivor';
  elements['profile-team-input'].value = current?.team || '';
  elements['profile-summary'].textContent = current
    ? `${current.name} · ${current.role === 'rescuer' ? 'Tim Penyelamat' : 'Penyintas'}${current.team ? ` · ${current.team}` : ''} · ID ${current.user_id}`
    : 'Identitas belum didaftarkan di perangkat ini.';
  elements['profile-edit-label'].textContent = current ? 'Edit identitas' : 'Daftarkan identitas';
  elements['reset-profile-button'].hidden = !current;
}

export function bindProfilePage({ elements, saveProfile, resetData, saveNodeAddress, requestLocation, toggleTracking, onConsentChange, onIntervalChange }) {
  elements['save-name-button'].addEventListener('click', saveProfile);
  elements['reset-profile-button'].addEventListener('click', resetData);
  elements['privacy-delete-button'].addEventListener('click', resetData);
  elements['save-node-url-button'].addEventListener('click', saveNodeAddress);
  elements['location-button'].addEventListener('click', requestLocation);
  elements['tracking-button'].addEventListener('click', toggleTracking);
  elements['location-consent'].addEventListener('change', onConsentChange);
  elements['tracking-interval-input'].addEventListener('change', onIntervalChange);
}

