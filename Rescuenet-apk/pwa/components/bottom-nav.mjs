export function bindBottomNav(nav, onNavigate) {
  nav?.querySelectorAll('button[data-screen]').forEach(button => {
    button.addEventListener('click', () => onNavigate(button.dataset.screen));
  });
}

export function renderBottomNav(nav, screen) {
  nav?.querySelectorAll('button[data-screen]').forEach(button => {
    if (button.dataset.screen === screen) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

