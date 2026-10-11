export function createToast(element) {
  let timer = null;
  return message => {
    if (!element) return;
    element.textContent = message;
    element.classList.add('visible');
    clearTimeout(timer);
    timer = setTimeout(() => element.classList.remove('visible'), 5200);
  };
}

