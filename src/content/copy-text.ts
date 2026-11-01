export async function copyText(text: string, root: ShadowRoot) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  // HTTP pages lack the async Clipboard API. Use the user gesture in supported
  // Chrome versions; callers retain their existing manual-copy error fallback.
  const focused = root.activeElement;
  const field = document.createElement('textarea');
  field.value = text;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0;';
  field.addEventListener('copy', (event) => {
    event.clipboardData?.setData('text/plain', text);
    event.preventDefault();
    event.stopPropagation();
  });
  root.append(field);
  try {
    field.focus({ preventScroll: true });
    field.select();
    if (!document.execCommand('copy')) throw new Error('COPY_FAILED');
  } finally {
    field.remove();
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }
}
