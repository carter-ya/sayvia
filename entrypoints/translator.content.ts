import { defineContentScript } from 'wxt/utils/define-content-script';
import { EditorRegistry } from '../src/adapters/registry';
import { ReadingSelectionCache } from '../src/adapters/selection-cache';

export default defineContentScript({
  registration: 'runtime',
  main(ctx) {
    const registry = new EditorRegistry();
    const selection = new ReadingSelectionCache();
    const clearSelection = () => selection.clear();
    const dispose = () => {
      registry.dispose();
      selection.clear();
    };
    ctx.addEventListener(document, 'focusin', (event) => {
      if (event.target instanceof Element) registry.bind(event.target);
    });
    ctx.addEventListener(document, 'contextmenu', (event) => {
      if (!event.isTrusted) return;
      try {
        selection.capture(window.getSelection(), document);
      } catch {
        /* The next read returns a sanitized source error. */
      }
    });
    ctx.onInvalidated(dispose);
    ctx.addEventListener(window, 'pagehide', dispose);
    ctx.addEventListener(window, 'popstate', clearSelection);
    ctx.addEventListener(window, 'hashchange', clearSelection);
    const navigation = (window as unknown as { navigation?: EventTarget }).navigation;
    if (navigation) ctx.addEventListener(navigation, 'navigate', clearSelection);
  },
});
