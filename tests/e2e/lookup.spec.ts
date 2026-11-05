import { expect, test, type Page } from '@playwright/test';
import type { browser } from 'wxt/browser';
import { workflowFixture } from '../fixtures/core-workflow-extension';
import { chooseLanguage } from '../fixtures/choose-language';
type Chrome = { chrome: typeof browser };
type Fixture = Awaited<ReturnType<typeof workflowFixture>>;
async function speech(f: Fixture) {
  return f.settings.evaluate(() =>
    (globalThis as unknown as Chrome).chrome.runtime.sendMessage({
      type: 'fixture.speech.inspect',
    }),
  ) as Promise<{ spoken: Array<{ text: string; lang: string; rate: number }>; stops: number }>;
}
async function selectWord(page: Page, text = 'bank') {
  await page.evaluate((text) => {
    const paragraph = document.createElement('p');
    paragraph.id = 'lookup-word';
    paragraph.textContent = text;
    paragraph.style.cssText = 'font-size:24px;margin:90px 30px';
    document.body.prepend(paragraph);
    const range = document.createRange();
    range.selectNodeContents(paragraph);
    window.getSelection()!.removeAllRanges();
    window.getSelection()!.addRange(range);
  }, text);
  await page.keyboard.press('Shift');
}
async function popup(f: Fixture) {
  const page = await f.context.newPage();
  await f.page.bringToFront();
  await page.goto(f.popup.url());
  await expect(page.getByRole('tab', { name: '查词', exact: true })).toBeEnabled();
  return page;
}

test('switching to lookup invalidates the pending automatic translation preferences', async () => {
  const f = await workflowFixture();
  try {
    await selectWord(f.page);
    await f.page.locator('#lookup-word').evaluate((paragraph) => (paragraph.tabIndex = -1));
    const translate = f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字', exact: true });
    await expect(translate).toBeVisible();
    await f.settings.evaluate(async (url) => {
      const api = (globalThis as unknown as Chrome).chrome;
      const tab = (await api.tabs.query({})).find((item) => item.url === url)!;
      await api.scripting.executeScript({
        target: { tabId: tab.id!, frameIds: [0] },
        func: () => {
          const runtime = (globalThis as unknown as Chrome).chrome.runtime;
          const send = runtime.sendMessage.bind(runtime);
          // Mutating an ancestor of the selected text would invalidate its reading snapshot.
          const probe = document.createElement('output');
          probe.id = 'fixture-lookup-probe';
          probe.hidden = true;
          document.body.append(probe);
          const log = probe.dataset;
          let holdNextPreferences = true;
          const starts: string[] = [];
          runtime.sendMessage = ((message: { type: string }) => {
            if (message.type === 'translation.start' || message.type === 'learning.start') {
              starts.push(message.type);
              log.fixtureStarts = starts.join(',');
            }
            const reply = send(message);
            if (message.type !== 'page.preferences' || !holdNextPreferences) return reply;
            holdNextPreferences = false;
            return reply.then(
              (value) =>
                new Promise((resolve) => {
                  log.fixturePreferences = 'held';
                  document.addEventListener(
                    'fixture-release-preferences',
                    () => {
                      resolve(value);
                      setTimeout(() => {
                        log.fixturePreferences = 'released';
                      }, 0);
                    },
                    { once: true },
                  );
                }),
            );
          }) as typeof runtime.sendMessage;
        },
      });
    }, f.page.url());
    await translate.click();
    const probe = f.page.locator('#fixture-lookup-probe');
    await expect(probe).toHaveAttribute('data-fixture-preferences', 'held');
    // Re-select the exact same range so selection validation does not mask an obsolete start.
    await f.page.locator('#lookup-word').evaluate((paragraph) => {
      paragraph.focus();
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await f.page.keyboard.press('Shift');
    await f.page.getByRole('button', { name: '使用 Sayvia 查词', exact: true }).click();
    const card = f.page.getByRole('dialog', { name: '查词', exact: true });
    await expect(card.getByLabel('AI 释义')).toContainText('词语：bank');
    await f.page.evaluate(() => document.dispatchEvent(new Event('fixture-release-preferences')));
    await expect(probe).toHaveAttribute('data-fixture-preferences', 'released');
    await expect(probe).toHaveAttribute('data-fixture-starts', 'learning.start');
    await expect(card).toBeVisible();
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});

test('a trusted word lookup freezes only that selection, renders read-only meanings and confirms audio language', async () => {
  const f = await workflowFixture({ speech: true });
  try {
    await selectWord(f.page);
    const entry = f.page.getByRole('button', { name: '使用 Sayvia 查词', exact: true });
    await expect(entry).toBeVisible();
    await entry.evaluate((button) => (button as HTMLButtonElement).click());
    expect(f.count()).toBe(0);
    await f.page.evaluate(() => {
      const text = document.createElement('p');
      text.textContent = 'PRIVATE_OUTSIDE_SELECTION';
      document.body.append(text);
      const range = document.createRange();
      range.selectNodeContents(text);
      window.getSelection()!.removeAllRanges();
      window.getSelection()!.addRange(range);
    });
    await entry.click();
    const panel = f.page.getByRole('dialog', { name: '查词', exact: true });
    await expect(panel.getByLabel('AI 释义')).toContainText('词语：bank');
    expect(JSON.parse(JSON.parse(f.requestBodies[0]!).messages[1].content).text).toBe('bank');
    expect(f.requestBodies[0]).not.toContain('PRIVATE_OUTSIDE_SELECTION');
    expect((await speech(f)).spoken).toHaveLength(0);
    await expect(
      panel.getByText('识别为英语。点击朗读即确认此语言；不正确时请修改源语言。'),
    ).toBeVisible();
    await panel.getByRole('button', { name: '按英语朗读', exact: true }).click();
    await expect
      .poll(async () => (await speech(f)).spoken)
      .toEqual([{ text: 'bank', lang: 'en-US', rate: 1 }]);
    await expect(panel.getByRole('button', { name: /替换|原处显示/ })).toHaveCount(0);
    await expect(f.page.locator('#lookup-word')).toHaveText('bank');
    await f.page.setViewportSize({ width: 375, height: 720 });
    await expect
      .poll(async () => {
        const rect = await panel.boundingBox();
        return rect && rect.x >= 0 && rect.x + rect.width <= 375;
      })
      .toBe(true);
    await f.page.screenshot({ path: '/tmp/sayvia-lookup-page.png' });
    await chooseLanguage(panel.getByLabel('源语言', { exact: true }), 'fr');
    await expect.poll(async () => (await speech(f)).stops).toBe(1);
    await expect(panel.getByLabel('AI 释义')).toHaveCount(0);
    await panel.getByRole('button', { name: '重新查词', exact: true }).click();
    await expect(panel.getByLabel('AI 释义')).toBeVisible();
    await panel.getByRole('button', { name: '按法语慢速朗读', exact: true }).click();
    await expect.poll(async () => (await speech(f)).spoken.length).toBe(2);
    await panel.getByRole('button', { name: '关闭查词', exact: true }).click();
    await expect(panel).toHaveCount(0);
    await expect.poll(async () => (await speech(f)).stops).toBe(2);
    expect(f.count()).toBe(2);
  } finally {
    await f.close();
  }
});

test('manual lookup restores its typed card and switching to translation cannot reuse it as editable output', async () => {
  const f = await workflowFixture({ speech: true });
  try {
    let p = await popup(f);
    await p.getByRole('tab', { name: '查词', exact: true }).click();
    await p.getByLabel('单词或短语', { exact: true }).fill('bank');
    await p.getByRole('button', { name: '查词', exact: true }).click();
    await expect(p.getByLabel('AI 释义')).toContainText('词语：bank');
    await p.setViewportSize({ width: 380, height: 720 });
    await p.screenshot({ path: '/tmp/sayvia-lookup-popup.png' });
    await expect(p.getByLabel('手动译文', { exact: true })).toHaveCount(0);
    await p.close();
    p = await popup(f);
    await expect(p.getByRole('tab', { name: '查词', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await expect(p.getByLabel('单词或短语', { exact: true })).toHaveValue('bank');
    await expect(p.getByLabel('AI 释义')).toContainText('词语：bank');
    expect(f.count()).toBe(1);
    expect((await speech(f)).spoken).toHaveLength(0);
    await p.getByRole('tab', { name: '手动翻译', exact: true }).click();
    await expect(p.getByLabel('待翻译文本', { exact: true })).toHaveValue('bank');
    await expect(p.getByLabel('手动译文', { exact: true })).toHaveValue('');
    await p.getByRole('button', { name: '翻译文本', exact: true }).click();
    await expect(p.getByLabel('手动译文', { exact: true })).toHaveValue('bank');
    await p.getByRole('tab', { name: '查词', exact: true }).click();
    await expect(p.getByLabel('AI 释义')).toHaveCount(0);
    await expect(p.getByRole('tab', { name: '查词', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(f.count()).toBe(2);
  } finally {
    await f.close();
  }
});

test('keyboard tabs and moving a dark narrow lookup card remain usable', async () => {
  const f = await workflowFixture({ speech: true });
  try {
    const p = await popup(f);
    await p.getByRole('tab', { name: '当前页面', exact: true }).focus();
    await p.keyboard.press('End');
    await expect(p.getByRole('tab', { name: '查词', exact: true })).toBeFocused();
    await expect(p.getByRole('tab', { name: '查词', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await p.keyboard.press('ArrowLeft');
    await expect(p.getByRole('tab', { name: '手动翻译', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await f.page.emulateMedia({ colorScheme: 'dark' });
    await f.page.setViewportSize({ width: 375, height: 720 });
    await selectWord(f.page);
    await f.page.getByRole('button', { name: '使用 Sayvia 查词', exact: true }).click();
    const panel = f.page.getByRole('dialog', { name: '查词', exact: true });
    await expect(panel.getByLabel('AI 释义')).toBeVisible();
    await panel.getByRole('button', { name: '移动查词浮窗', exact: true }).focus();
    await f.page.keyboard.press('ArrowUp');
    await f.page.screenshot({ path: '/tmp/sayvia-lookup-dark.png' });
    await f.page.keyboard.press('Escape');
    await expect(panel).toHaveCount(0);
  } finally {
    await f.close();
  }
});

const speechSamples = [
  ['zh-Hans', '你好', 'zh-CN'],
  ['en', 'hello', 'en-US'],
  ['ja', 'こんにちは', 'ja-JP'],
  ['ko', '안녕하세요', 'ko-KR'],
  ['fr', 'bonjour', 'fr-FR'],
  ['de', 'hallo', 'de-DE'],
  ['es', 'hola', 'es-ES'],
] as const;
for (const [language, text, voice] of speechSamples) {
  test(`explicit ${language} can speak without a model call`, async () => {
    const f = await workflowFixture({ speech: true });
    try {
      const p = await popup(f);
      await p.getByRole('tab', { name: '查词', exact: true }).click();
      await p.getByLabel('单词或短语', { exact: true }).fill(text!);
      await chooseLanguage(p.getByLabel('源语言', { exact: true }), language!);
      await p.getByRole('button', { name: /^按.+慢速朗读$/ }).click();
      await expect
        .poll(async () => (await speech(f)).spoken.at(-1))
        .toEqual({ text, lang: voice, rate: 0.75 });
      await p.getByRole('button', { name: '停止朗读', exact: true }).click();
      await expect.poll(async () => (await speech(f)).stops).toBe(1);
      expect(f.count()).toBe(0);
    } finally {
      await f.close();
    }
  });
}

test('missing local voices do not erase the word or use a remote voice', async () => {
  const f = await workflowFixture({ speech: true });
  try {
    const p = await popup(f);
    await p.getByRole('tab', { name: '查词', exact: true }).click();
    await p.getByLabel('单词或短语', { exact: true }).fill('hola');
    await chooseLanguage(p.getByLabel('源语言', { exact: true }), 'es');
    expect(f.count()).toBe(0);
    await f.settings.evaluate(() =>
      (globalThis as unknown as Chrome).chrome.runtime.sendMessage({
        type: 'fixture.speech.mode',
        mode: 'remote',
      }),
    );
    await p.getByRole('button', { name: /^按.+慢速朗读$/ }).click();
    await expect(
      p.getByText(
        '设备没有匹配的本地声线，仍可查看释义。请在系统设置安装对应语言的语音，再点击朗读重新检测。',
      ),
    ).toBeVisible();
    await expect(p.getByLabel('单词或短语', { exact: true })).toHaveValue('hola');
    expect((await speech(f)).spoken).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test('manual lookup preserves an oversized Unicode paste and offers ordinary translation without a lookup request', async () => {
  const f = await workflowFixture();
  try {
    const p = await popup(f);
    await p.getByRole('tab', { name: '查词', exact: true }).click();
    const text = '𠮷'.repeat(81) + ' original tail';
    const input = p.getByLabel('单词或短语', { exact: true });
    await input.focus();
    await p.keyboard.insertText(text);
    await expect(input).toHaveValue(text);
    await expect(p.getByRole('button', { name: '查词', exact: true })).toBeDisabled();
    await expect(p.getByRole('status').filter({ hasText: '已保留完整输入' })).toContainText(
      '手动翻译',
    );
    expect(f.count()).toBe(0);
    await p.getByRole('tab', { name: '手动翻译', exact: true }).click();
    await expect(p.getByLabel('待翻译文本', { exact: true })).toHaveValue(text);
    expect(f.count()).toBe(0);
  } finally {
    await f.close();
  }
});

test('closing a pending page lookup cancels its network and overlong selections have no lookup entry', async () => {
  const f = await workflowFixture({ speech: true });
  try {
    f.delay(30_000);
    await selectWord(f.page);
    await f.page.getByRole('button', { name: '使用 Sayvia 查词', exact: true }).click();
    await expect.poll(f.pending).toBe(1);
    await f.page.keyboard.press('Escape');
    await expect(f.page.getByRole('dialog', { name: '查词', exact: true })).toHaveCount(0);
    await expect.poll(f.pending).toBe(0);
    await f.page.locator('#lookup-word').evaluate((element) => element.remove());
    await selectWord(f.page, 'x'.repeat(81));
    await expect(
      f.page.getByRole('button', { name: '使用 Sayvia 查词', exact: true }),
    ).toBeHidden();
    await expect(
      f.page.getByRole('button', { name: '使用 Sayvia 翻译选中文字', exact: true }),
    ).toBeVisible();
    expect(f.count()).toBe(1);
  } finally {
    await f.close();
  }
});
