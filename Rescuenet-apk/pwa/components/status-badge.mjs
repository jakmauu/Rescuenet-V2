const TONES = new Set(['online', 'offline', 'checking', 'warning']);

export function setStatusBadge(element, label, tone = 'offline') {
  if (!element) return;
  const safeTone = TONES.has(tone) ? tone : 'offline';
  element.className = `status-pill status-${safeTone}`;
  element.textContent = label;
}

