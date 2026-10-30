import { defineContentScript } from 'wxt/utils/define-content-script';
import { EditorRegistry } from '../src/adapters/registry';

export default defineContentScript({
  registration: 'runtime',
  main(ctx) {
    const registry = new EditorRegistry();
    ctx.addEventListener(document, 'focusin', (event) => {
      if (event.target instanceof Element) registry.bind(event.target);
    });
    ctx.onInvalidated(() => registry.dispose());
    ctx.addEventListener(window, 'pagehide', () => registry.dispose());
  },
});
