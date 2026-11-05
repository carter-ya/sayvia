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
async function youtube(
  f: Fixture,
  events?: Array<{ tStartMs: number; dDurationMs: number; segs: Array<{ utf8: string }> }>,
) {
  let loads = 0;
  await f.context.route('https://www.youtube.com/**', async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === '/api/timedtext') {
      loads++;
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          wireMagic: 'pb3',
          events: events ?? [
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

test('empty responses and unavailable tracks have distinct conservative guidance and cannot start translation', async () => {
  const f = await workflowFixture();
  try {
    const { page } = await youtube(f, []);
    await setting(f, true);
    await expect.poll(async () => (await snapshot(f, page))?.capture?.reason).toBe('ready');
    await load(page);
    const panel = page.locator('[data-sayvia-caption-status]');
    await panel.locator('summary').click();
    await expect(panel.getByRole('status')).toHaveText(
      '这次字幕响应没有可显示内容，请检查 YouTube 字幕菜单或选择其他视频。',
    );
    await expect(panel.getByRole('button', { name: '开启双语字幕', exact: true })).toBeDisabled();
    await page.evaluate(() => {
      (window as typeof window & { selected: null }).selected = null;
    });
    await expect(panel.getByRole('status')).toHaveText(
      '当前未取得可用原文轨：可能尚未开启，或视频未提供字幕。请检查 YouTube 字幕菜单。',
    );
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});

test('caption word lookup keeps source language, preempts safely, speaks locally and follows fullscreen and source lifetime', async () => {
  const f = await workflowFixture({ speech: true });
  const speech = () =>
    f.settings.evaluate(() =>
      (globalThis as unknown as Chrome).chrome.runtime.sendMessage({
        type: 'fixture.speech.inspect',
      }),
    ) as Promise<{ spoken: Array<{ text: string; lang: string; rate: number }>; stops: number }>;
  try {
    const { page } = await youtube(f, [
      { tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: 'Hello PRIVATE_SENTENCE_CONTEXT.' }] },
    ]);
    await setting(f, true);
    await expect.poll(async () => (await snapshot(f, page))?.capture?.reason).toBe('ready');
    await load(page);
    await expect.poll(async () => (await snapshot(f, page))?.groups.length).toBe(1);
    // Keep the existing translator listener in the same document to exercise ACK coexistence.
    await f.open('read', page);
    await page.getByRole('button', { name: '关闭翻译面板', exact: true }).click();
    await page.evaluate(() => {
      const player = document.getElementById('movie_player')!;
      player.style.cssText =
        'position:relative;width:960px;height:640px;overflow:hidden;background:#333';
      player.querySelector('video')!.style.cssText = 'width:100%;height:100%';
      const full = document.createElement('button');
      full.textContent = 'Fixture fullscreen';
      full.style.cssText = 'position:absolute;right:0;top:0';
      full.onclick = () => {
        void player.requestFullscreen();
      };
      player.append(full);
    });
    const controls = page.locator('[data-sayvia-caption-status]');
    await controls.locator('summary').click();
    const release = f.hold();
    await controls.getByRole('button', { name: '开启双语字幕', exact: true }).click();
    await expect.poll(() => f.count()).toBe(1);
    await controls.locator('summary').click();
    const word = page.getByRole('button', { name: '查词：Hello', exact: true });
    await expect(word).toBeVisible();
    await word.evaluate((el) => (el as HTMLElement).click());
    expect(f.count()).toBe(1);
    await word.focus();
    await word.press('Enter');
    const card = page.getByRole('dialog', { name: '查词', exact: true });
    await expect(card).toBeVisible();
    await expect(card.getByLabel('源语言', { exact: true })).toBeDisabled();
    expect(await card.evaluate((el) => getComputedStyle(el).backgroundImage)).toBe('none');
    expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/^rgb\(/);
    await expect.poll(() => f.count()).toBe(2);
    const lookup = JSON.parse(JSON.parse(f.requestBodies[1]!).messages[1].content);
    expect(lookup).toEqual({ text: 'Hello', sourceLanguage: 'en', explanationLanguage: 'zh-Hans' });
    expect(f.requestBodies[1]).not.toContain('PRIVATE_SENTENCE_CONTEXT');
    expect((await speech()).spoken).toHaveLength(0);
    release();
    await expect(card.getByLabel('AI 释义')).toContainText('词语：Hello');
    await expect.poll(() => f.count()).toBe(3);
    await expect(page.locator('[data-sayvia-caption-overlay] .translation')).toContainText(
      '译文：Hello',
    );
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: '按英语慢速朗读', exact: true }).click();
    await expect
      .poll(async () => (await speech()).spoken)
      .toEqual([{ text: 'Hello', lang: 'en-US', rate: 0.75 }]);
    await page.evaluate(() => {
      const v = document.querySelector('video')!;
      v.currentTime = 10;
      v.dispatchEvent(new Event('seeked'));
    });
    await expect(word).toHaveCount(0);
    await expect(card.locator('.lookup-word')).toHaveText('Hello');
    await card.getByRole('button', { name: '关闭查词', exact: true }).click();
    await expect(controls.locator('summary')).toBeFocused();
    await expect.poll(async () => (await speech()).stops).toBe(1);
    await page.evaluate(() => {
      const v = document.querySelector('video')!;
      v.currentTime = 0;
      v.dispatchEvent(new Event('seeked'));
    });
    await expect(word).toBeVisible();
    await page.getByRole('button', { name: 'Fixture fullscreen', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement?.id))
      .toBe('movie_player');
    await word.focus();
    await word.press('Space');
    await expect(card.getByLabel('AI 释义')).toContainText('词语：Hello');
    expect(f.count()).toBe(4);
    expect(
      await page
        .locator('[data-sayvia-lookup]')
        .evaluate((el) => document.fullscreenElement?.contains(el)),
    ).toBe(true);
    await page.screenshot({ path: '/tmp/sayvia-caption-lookup-fullscreen.png' });
    await card.getByRole('button', { name: '关闭查词', exact: true }).focus();
    await card.press('Escape');
    await expect(card).toHaveCount(0);
    await expect(word).toBeFocused();
    await page.evaluate(() => document.exitFullscreen());
    await page.setViewportSize({ width: 375, height: 720 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.evaluate(() => {
      document.getElementById('movie_player')!.style.width = '100%';
    });
    await word.click();
    await expect(card.getByLabel('AI 释义')).toBeVisible();
    expect(f.count()).toBe(5);
    await expect
      .poll(async () => {
        const box = await card.boundingBox();
        return !!box && box.x >= 0 && box.x + box.width <= 375;
      })
      .toBe(true);
    await page.screenshot({ path: '/tmp/sayvia-caption-lookup-narrow.png' });
    await card.getByRole('button', { name: '按英语朗读', exact: true }).click();
    await expect.poll(async () => (await speech()).spoken.length).toBe(2);
    await page.evaluate(() => {
      (window as typeof window & { selected: object }).selected = { languageCode: 'fr' };
    });
    await expect(card).toHaveCount(0);
    await expect.poll(async () => (await speech()).stops).toBe(2);
    await expect(controls.locator('summary')).toBeFocused();
    expect(f.count()).toBe(5);
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
      full.style.cssText = 'position:absolute;right:0;bottom:0';
      full.onclick = () => {
        void player.requestFullscreen();
      };
      player.append(full);
      const videoFull = document.createElement('button');
      videoFull.id = 'fixture-video-fullscreen';
      videoFull.textContent = 'Video fullscreen';
      videoFull.style.cssText = 'position:absolute;right:0;bottom:30px';
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
          const requestId = crypto.randomUUID();
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
                  reply.generation === generation &&
                  reply.requestId === requestId
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
                requestId,
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

test('explicit player entry translates the current window, preserves native while waiting and restores on stop or config change', async () => {
  const f = await workflowFixture();
  try {
    const { page } = await youtube(
      f,
      [0, 300_000, 320_000, 600_000].map((time) => ({
        tStartMs: time,
        dDurationMs: 5000,
        segs: [{ utf8: `Caption at ${time}` }],
      })),
    );
    await setting(f, true);
    await expect.poll(async () => (await snapshot(f, page))?.capture?.reason).toBe('ready');
    await load(page);
    await expect.poll(async () => (await snapshot(f, page))?.groups.length).toBe(4);
    // Controlled media clock, not evidence of real YouTube playback timing.
    await page.evaluate(() => {
      const player = document.getElementById('movie_player')!;
      player.style.cssText =
        'position:relative;width:960px;height:640px;overflow:hidden;background:#333';
      const video = player.querySelector('video')!;
      video.style.cssText = 'width:100%;height:100%';
      video.currentTime = 300;
      const native = document.createElement('div');
      native.className = 'ytp-caption-window-container';
      native.style.cssText = 'position:absolute;bottom:20px;color:white';
      native.textContent = 'Native subtitle';
      player.append(native);
    });
    const panel = page.locator('[data-sayvia-caption-status]');
    await panel.locator('summary').click();
    await expect(panel.getByText('当前模型：fixture-model', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: '开启双语字幕', exact: true })).toBeEnabled();
    expect(f.count()).toBe(0);
    await panel.getByRole('radio', { name: '仅译文', exact: true }).check();
    const release = f.hold();
    await panel.getByRole('button', { name: '开启双语字幕', exact: true }).click();
    await expect.poll(() => f.count()).toBe(1);
    const payload = JSON.parse(JSON.parse(f.requestBodies[0]!).messages[1].content);
    expect(payload.cues.map((cue: { text: string }) => cue.text)).toEqual([
      'Caption at 300000',
      'Caption at 320000',
    ]);
    const native = page.locator('.ytp-caption-window-container');
    await expect(native).toHaveCSS('visibility', 'visible');
    await expect(page.locator('[data-sayvia-caption-overlay]')).toBeHidden();
    await expect(panel.getByRole('status')).toHaveText('译文准备中，暂时显示原生字幕。');
    await expect(panel.locator('summary')).toContainText('译文准备中');
    release();
    await expect(panel.getByRole('status')).toContainText('2 段已翻译');
    await panel.locator('summary').click();
    await expect(native).toHaveCSS('visibility', 'hidden');
    await expect(page.locator('[data-sayvia-caption-overlay]')).toBeVisible();
    await page.evaluate(() => {
      const v = document.querySelector('video')!;
      v.currentTime = 310;
      v.dispatchEvent(new Event('seeked'));
    });
    await expect(native).toHaveCSS('visibility', 'visible');
    await page.evaluate(() => {
      const v = document.querySelector('video')!;
      v.currentTime = 320;
      v.dispatchEvent(new Event('seeked'));
    });
    await expect(native).toHaveCSS('visibility', 'hidden');
    expect(f.count()).toBe(1);
    await panel.locator('summary').click();
    await panel.getByRole('button', { name: '停止翻译', exact: true }).click();
    await expect(native).toHaveCSS('visibility', 'visible');
    await expect(panel.getByRole('button', { name: '开启双语字幕', exact: true })).toBeEnabled();
    expect(f.count()).toBe(1);
    await panel.getByRole('button', { name: '开启双语字幕', exact: true }).click();
    await expect.poll(() => f.count()).toBe(2);
    await expect(native).toHaveCSS('visibility', 'hidden');
    await f.settings.getByRole('button', { name: '返回模型设置', exact: true }).click();
    await f.settings.getByLabel('模型名称').fill('changed-model');
    await f.settings.getByRole('button', { name: '保存配置' }).click();
    await expect(f.settings.getByRole('status')).toHaveText('已保存配置。');
    await expect(native).toHaveCSS('visibility', 'visible');
    await expect(panel.getByText('当前模型：changed-model', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: '开启双语字幕', exact: true })).toBeEnabled();
    expect(f.count()).toBe(2);
    await page.evaluate(() => history.pushState({}, '', '/watch?v=second'));
    await expect.poll(async () => (await snapshot(f, page))?.capture?.videoId).toBe('second');
    expect((await snapshot(f, page))?.session).toBeUndefined();
    await expect(panel.getByRole('button', { name: '开启双语字幕', exact: true })).toBeDisabled();
  } finally {
    await f.close();
  }
});
