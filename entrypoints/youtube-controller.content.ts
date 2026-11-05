import { browser } from 'wxt/browser';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { CaptionController } from '../src/captions/controller';
import { CaptionPlayerSession } from '../src/captions/player-session';
import { AppearanceSchema } from '../src/storage/schema';
import { mountCaptureStatus } from '../src/captions/status-panel';
import { LookupPopover } from '../src/content/lookup-panel';
import { defaultAppearance } from '../src/ui/appearance';

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
    const lookup = new LookupPopover(controller.documentNonce, defaultAppearance);
    const player = new CaptionPlayerSession(
      controller,
      (message) => browser.runtime.sendMessage(message),
      {
        open(text, anchor, language, root, focus) {
          lookup.open(text, anchor, {
            sourceLanguage: language,
            fullscreenRoot: root,
            focus,
            fallbackFocus: () =>
              document
                .querySelector('[data-sayvia-caption-status]')
                ?.shadowRoot?.querySelector<HTMLElement>('summary') ?? undefined,
          });
        },
        close: () => lookup.close(),
      },
    );
    const panel = mountCaptureStatus(controller, player);
    void browser.runtime
      .sendMessage({ protocolVersion: 1, requestId: crypto.randomUUID(), type: 'page.preferences' })
      .then(
        (reply) => {
          const parsed = AppearanceSchema.safeParse(reply?.data?.appearance);
          if (parsed.success) {
            panel.setAppearance(parsed.data);
            lookup.setAppearance(parsed.data);
          }
        },
        () => undefined,
      );
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
      if (value.type === 'captions.configuration-changed') {
        player.configurationChanged();
        return;
      }
      if (value.type === 'app.appearance-changed') {
        const parsed = AppearanceSchema.safeParse(value.appearance);
        if (parsed.success) {
          panel.setAppearance(parsed.data);
          lookup.setAppearance(parsed.data);
        }
        return;
      }
      if (
        value.type === 'learning.result' ||
        value.type === 'learning.state' ||
        value.type === 'learning.progress'
      ) {
        if (player.receive(value))
          respond({ taskId: value.taskId, documentNonce: controller.documentNonce });
        return;
      }
      if (value.type === 'captions.disabled' || value.type === 'page.reset') {
        controller.pause();
        respond({ ok: true });
      }
    };
    browser.runtime.onMessage.addListener(message);
    const dispose = () => {
      panel.dispose();
      player.dispose();
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
