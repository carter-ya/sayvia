import { defineContentScript } from 'wxt/utils/define-content-script';
import { mountWorkflow } from '../src/content/workflow';

export default defineContentScript({
  registration: 'runtime',
  main(ctx) {
    const global = globalThis as typeof globalThis & { __sayviaWorkflow?: string };
    if (global.__sayviaWorkflow) return;
    const token = crypto.randomUUID();
    global.__sayviaWorkflow = token;
    const clear = () => {
      if (global.__sayviaWorkflow === token) delete global.__sayviaWorkflow;
    };
    const workflow = mountWorkflow(clear);
    const dispose = () => {
      workflow.dispose();
      clear();
    };
    ctx.onInvalidated(dispose);
    ctx.addEventListener(window, 'pagehide', dispose);
  },
});
