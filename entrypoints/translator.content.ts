import { defineContentScript } from 'wxt/utils/define-content-script';

export default defineContentScript({
  registration: 'runtime',
  main() {
    // Page adapters will register this entrypoint only after a user grants access.
  },
});
