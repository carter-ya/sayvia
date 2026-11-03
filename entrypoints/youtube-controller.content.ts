import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { CaptionController } from '../src/captions/controller';
import { mountCaptureStatus } from '../src/captions/status-panel';

export default defineContentScript({
  registration: 'runtime',
  main(ctx) {
    const global = globalThis as typeof globalThis & {
      __sayviaCaptionController?: {
        controller: CaptionController;
        alive(): boolean;
        dispose(): void;
      };
    };
    const alive = () => {
      try {
        return !!browser.runtime.id;
      } catch {
        return false;
      }
    };
    const previous = global.__sayviaCaptionController;
    if (previous?.alive()) {
      void previous.controller.confirm();
      return;
    }
    previous?.dispose();
    const controller = new CaptionController({
      alive,
      request: (message) => browser.runtime.sendMessage(message),
    });
    const panel = mountCaptureStatus(controller);
    const message: Parameters<typeof browser.runtime.onMessage.addListener>[0] = (
      value,
      sender,
      respond,
    ) => {
      if (
        sender.id !== browser.runtime.id ||
        sender.url !== browser.runtime.getURL('/background.js') ||
        value?.protocolVersion !== 1
      )
        return;
      if (value.type === 'captions.disabled') {
        controller.pause();
        respond({ ok: true });
      }
    };
    browser.runtime.onMessage.addListener(message);
    const dispose = () => {
      panel();
      controller.dispose();
      browser.runtime.onMessage.removeListener(message);
      if (global.__sayviaCaptionController?.controller === controller)
        delete global.__sayviaCaptionController;
    };
    global.__sayviaCaptionController = { controller, alive, dispose };
    ctx.onInvalidated(() => {
      if (!alive()) dispose();
    });
  },
});
