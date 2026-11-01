import { newId } from '../src/runtime/uuid';
import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { mountWorkflow } from '../src/content/workflow';

type Controller = { token: string; workflow: ReturnType<typeof mountWorkflow>; alive(): boolean };
export default defineContentScript({
  registration: 'runtime',
  main(ctx) {
    const global = globalThis as typeof globalThis & { __sayviaWorkflow?: Controller };
    let controller = global.__sayviaWorkflow;
    if (controller && !controller.alive()) {
      controller.workflow.dispose();
      controller = undefined;
    }
    if (!controller) {
      const token = newId();
      const clear = () => {
        if (global.__sayviaWorkflow?.token === token) delete global.__sayviaWorkflow;
      };
      controller = {
        token,
        workflow: mountWorkflow(clear),
        alive: () => {
          try {
            return Boolean(browser.runtime.id);
          } catch {
            return false;
          }
        },
      };
      global.__sayviaWorkflow = controller;
    }
    const current = controller;
    // WXT invalidates the previous context before main() on duplicate injection.
    // Preserve its live workflow; the latest context now owns update cleanup.
    ctx.onInvalidated(() => {
      if (!current.alive()) current.workflow.dispose();
    });
  },
});
