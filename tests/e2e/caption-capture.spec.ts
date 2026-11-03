import { expect, test, type Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { workflowFixture } from '../fixtures/core-workflow-extension';

type Chrome = { chrome: typeof browser };
type Fixture = Awaited<ReturnType<typeof workflowFixture>>;
type Snapshot = {
  enabled: boolean;
  groups: Array<{ text: string }>;
  capture?: {
    generation: string;
    reason: string;
    track?: { kind: string | null };
    videoId: string;
  };
  session?: object;
};
const html = `<!doctype html><html><body><div id="movie_player"><video></video></div><script>
window.selected={languageCode:'en'};
const player=document.getElementById('movie_player');
player.getVideoData=()=>({video_id:new URL(location.href).searchParams.get('v')});
player.getOption=()=>window.selected;
window.siteLoad=()=>new Promise(resolve=>{ const xhr=new XMLHttpRequest(); const video=new URL(location.href).searchParams.get('v'); xhr.open('GET','/api/timedtext?v='+video+'&lang=en'+(window.selected.kind?'&kind='+window.selected.kind:'')); xhr.onload=()=>resolve(xhr.responseText); xhr.send(); });
</script></body></html>`;
async function youtube(f: Fixture) {
  let loads = 0;
  await f.context.route('https://www.youtube.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/timedtext') {
      loads++;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          wireMagic: 'pb3',
          events: [
            {
              tStartMs: 0,
              dDurationMs: 1000,
              segs: [{ utf8: 'Caption ' + url.searchParams.get('v') }],
            },
          ],
        }),
      });
    } else await route.fulfill({ contentType: 'text/html', body: html });
  });
  const page = await f.context.newPage();
  await page.goto('https://www.youtube.com/watch?v=example');
  return { page, loads: () => loads };
}
async function setting(f: Fixture, enabled: boolean) {
  const more = f.settings.getByRole('button', { name: '更多设置', exact: true });
  if (await more.isVisible()) await more.click();
  const toggle = f.settings.getByRole('checkbox', { name: '允许在 YouTube 读取字幕' });
  await expect(toggle).toBeEnabled();
  await toggle.setChecked(enabled);
  await expect(toggle).toBeEnabled();
  await expect(
    f.settings.getByText(
      enabled ? '字幕读取已开启。已打开的视频可能需要刷新后读取。' : '字幕读取已关闭。',
      { exact: true },
    ),
  ).toBeVisible();
}
async function snapshot(f: Fixture, page: Page): Promise<Snapshot | undefined> {
  return f.settings.evaluate(async (url) => {
    const api = (globalThis as unknown as Chrome).chrome;
    const tab = (await api.tabs.query({})).find((item) => item.url === url)!;
    const result = await api.scripting.executeScript({
      target: { tabId: tab.id!, frameIds: [0] },
      func: () =>
        (
          globalThis as typeof globalThis & {
            __sayviaCaptionController?: { controller: { snapshot(): Snapshot } };
          }
        ).__sayviaCaptionController?.controller.snapshot(),
    });
    return result[0]?.result ?? undefined;
  }, page.url());
}
async function load(page: Page) {
  return page.evaluate(() =>
    (window as typeof window & { siteLoad(): Promise<string> }).siteLoad(),
  );
}

test('local capture is off by default, follows real bundle registration and stops without model traffic', async () => {
  const f = await workflowFixture();
  try {
    const video = await youtube(f);
    await load(video.page);
    expect(await snapshot(f, video.page)).toBeUndefined();
    await setting(f, true);
    await expect.poll(async () => (await snapshot(f, video.page))?.enabled).toBe(true);
    expect((await snapshot(f, video.page))?.groups).toEqual([]);
    expect(await load(video.page)).toContain('Caption example');
    await expect.poll(async () => (await snapshot(f, video.page))?.groups.length).toBe(1);
    expect(video.loads()).toBe(2);
    expect(f.count()).toBe(0);
    expect((await snapshot(f, video.page))?.session).toBeUndefined();
    await setting(f, false);
    await expect.poll(async () => (await snapshot(f, video.page))?.enabled).toBe(false);
    expect((await snapshot(f, video.page))?.groups).toEqual([]);
    await load(video.page);
    expect((await snapshot(f, video.page))?.groups).toEqual([]);
    const scripts = await f.settings.evaluate(() =>
      (globalThis as unknown as Chrome).chrome.scripting.getRegisteredContentScripts(),
    );
    expect(scripts.filter((script) => script.id.startsWith('sayvia-youtube-'))).toEqual([]);
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});

test('new documents, source switches and SPA video navigation retain only their exact current source', async () => {
  const f = await workflowFixture();
  try {
    const video = await youtube(f);
    await setting(f, true);
    await video.page.reload();
    await expect.poll(async () => (await snapshot(f, video.page))?.capture?.reason).toBe('ready');
    await load(video.page);
    await expect.poll(async () => (await snapshot(f, video.page))?.groups.length).toBe(1);
    await video.page.evaluate(() => {
      (window as typeof window & { selected: object }).selected = {
        languageCode: 'en',
        kind: 'asr',
      };
    });
    await expect
      .poll(async () => (await snapshot(f, video.page))?.capture?.track?.kind)
      .toBe('asr');
    expect((await snapshot(f, video.page))?.groups).toEqual([]);
    await load(video.page);
    await expect.poll(async () => (await snapshot(f, video.page))?.groups.length).toBe(1);
    await video.page.evaluate(() => history.pushState({}, '', '/watch?v=second'));
    await expect.poll(async () => (await snapshot(f, video.page))?.capture?.videoId).toBe('second');
    expect((await snapshot(f, video.page))?.groups).toEqual([]);
    await load(video.page);
    await expect
      .poll(async () => (await snapshot(f, video.page))?.groups[0]?.text)
      .toBe('Caption second');
    expect(f.count()).toBe(0);
    expect(video.loads()).toBe(3);
  } finally {
    await f.close();
  }
});

test('production MAIN display lease hides only native appearance and restores after loss, fullscreen changes and capture stop', async () => {
  const f = await workflowFixture();
  try {
    const { page } = await youtube(f);
    await setting(f, true);
    await expect.poll(async () => (await snapshot(f, page))?.capture?.reason).toBe('ready');
    const capture = (await snapshot(f, page))!.capture!;
    const owner = await page.evaluate(() => {
      const player = document.getElementById('movie_player')!;
      player.style.cssText = 'position:relative;width:640px;height:360px;overflow:hidden';
      player.querySelector('video')!.style.cssText = 'width:100%;height:100%';
      const native = document.createElement('div');
      native.className = 'ytp-caption-window-container';
      native.style.cssText = 'position:absolute;bottom:5px';
      native.textContent = 'Unmodified native captions';
      player.append(native);
      const overlay = document.createElement('div');
      const owner = crypto.randomUUID();
      overlay.setAttribute('data-sayvia-caption-overlay', owner);
      overlay.setAttribute('data-sayvia-caption-ready', 'true');
      overlay.style.cssText =
        'position:absolute;top:40px;left:20px;width:240px;height:60px;background:black;color:white';
      overlay.textContent = 'Original / 译文';
      player.append(overlay);
      const full = document.createElement('button');
      full.id = 'fixture-fullscreen';
      full.textContent = 'Player fullscreen';
      full.onclick = () => {
        void player.requestFullscreen();
      };
      player.append(full);
      const videoFull = document.createElement('button');
      videoFull.id = 'fixture-video-fullscreen';
      videoFull.textContent = 'Video fullscreen';
      videoFull.onclick = () => {
        void player.querySelector('video')!.requestFullscreen();
      };
      player.append(videoFull);
      return owner;
    });
    const renew = async (currentOwner = owner) =>
      page.evaluate(
        ({ owner, generation }) => {
          const overlay = document.querySelector('[data-sayvia-caption-overlay]')!;
          overlay.setAttribute('data-sayvia-caption-overlay', owner);
          return new Promise<boolean | undefined>((resolve) => {
            const finish = (value?: boolean) => {
              clearTimeout(timer);
              window.removeEventListener('message', receive);
              resolve(value);
            };
            const receive = (event: MessageEvent) => {
              if (typeof event.data !== 'string') return;
              try {
                const reply = JSON.parse(event.data);
                if (
                  reply.channel === 'sayvia.caption.display.status.v1' &&
                  reply.owner === owner &&
                  reply.generation === generation
                )
                  finish(reply.active);
              } catch {
                /* Ignore unrelated page data. */
              }
            };
            const timer = setTimeout(() => finish(), 1500);
            window.addEventListener('message', receive);
            window.postMessage(
              JSON.stringify({
                channel: 'sayvia.caption.display.v1',
                type: 'renew',
                owner,
                generation,
                trackKey: JSON.stringify(['example', 'en', null, null, null]),
              }),
              location.origin,
            );
          });
        },
        { owner: currentOwner, generation: capture.generation },
      );
    const native = page.locator('.ytp-caption-window-container');
    await renew();
    await expect(native).toHaveCSS('visibility', 'hidden');
    await expect(native).toHaveText('Unmodified native captions');
    await expect(native).toHaveCSS('visibility', 'visible', { timeout: 4000 });
    await renew();
    await expect(native).toHaveCSS('visibility', 'visible');
    const second = crypto.randomUUID();
    await page.evaluate(() => {
      const player = document.getElementById('movie_player')!;
      player.style.height = '180px';
      const overlay = player.querySelector<HTMLElement>('[data-sayvia-caption-overlay]')!;
      overlay.style.top = 'auto';
      overlay.style.bottom = '200px';
    });
    expect(await renew(second)).toBe(false);
    await expect(native).toHaveCSS('visibility', 'visible');
    expect(
      await page.evaluate(() => {
        const player = document.getElementById('movie_player')!;
        return (
          player.querySelector('[data-sayvia-caption-overlay]')!.getBoundingClientRect().bottom <
          player.getBoundingClientRect().top
        );
      }),
    ).toBe(true);
    await page.evaluate(() => {
      document.querySelector<HTMLElement>('[data-sayvia-caption-overlay]')!.style.bottom = '64px';
    });
    await renew(second);
    await expect(native).toHaveCSS('visibility', 'hidden');
    await page.getByRole('button', { name: 'Player fullscreen', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.id))
      .toBe('movie_player');
    await renew(second);
    await expect(native).toHaveCSS('visibility', 'hidden');
    await page.evaluate(() => document.exitFullscreen());
    await page.getByRole('button', { name: 'Video fullscreen', exact: true }).click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName)).toBe('VIDEO');
    await expect(native).toHaveCSS('visibility', 'visible');
    await page.evaluate(() => document.exitFullscreen());
    await renew(second);
    await expect(native).toHaveCSS('visibility', 'hidden');
    await setting(f, false);
    await expect(native).toHaveCSS('visibility', 'visible');
    await renew(second);
    await expect(native).toHaveCSS('visibility', 'visible');
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});
