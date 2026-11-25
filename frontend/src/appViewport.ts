// iOS standalone can report a visual viewport shorter than the app window even
// with the keyboard closed. Let CSS size that window, including its safe areas.
export function trackAppViewport() {
  const viewport = window.visualViewport;
  const standalone = window.matchMedia('(display-mode: standalone)');
  const resize = () => {
    if (viewport && viewport.scale !== 1) return;
    const installed = standalone.matches || (navigator as Navigator & { standalone?: boolean }).standalone;
    const editing = document.activeElement?.matches('input, textarea, [contenteditable="true"]');
    // A small difference can be system UI; a keyboard takes a substantial part
    // of the window. Keep external-keyboard focus from shortening the app.
    const keyboardOpen = editing && viewport && window.innerHeight - viewport.height > 150;
    document.documentElement.style.setProperty('--app-height', installed && !keyboardOpen
      ? '100dvh' : `${viewport?.height ?? window.innerHeight}px`);
  };
  resize();
  viewport?.addEventListener('resize', resize);
  window.addEventListener('resize', resize);
  window.addEventListener('pageshow', resize);
  standalone.addEventListener('change', resize);
  document.addEventListener('visibilitychange', resize);
  document.addEventListener('focusin', resize);
  document.addEventListener('focusout', resize);
  return () => {
    viewport?.removeEventListener('resize', resize);
    window.removeEventListener('resize', resize);
    window.removeEventListener('pageshow', resize);
    standalone.removeEventListener('change', resize);
    document.removeEventListener('visibilitychange', resize);
    document.removeEventListener('focusin', resize);
    document.removeEventListener('focusout', resize);
    document.documentElement.style.removeProperty('--app-height');
  };
}
