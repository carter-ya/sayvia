import { browser } from 'wxt/browser';
import { openPage } from './page-router';

const READ = 'sayvia-read-selection';
const WRITE = 'sayvia-write-editor';
async function showEntry(tabId: number, mode: 'read' | 'write', autoTranslate: boolean) {
  const result = (await openPage(tabId, mode, autoTranslate)) as { ok?: boolean } | undefined;
  await Promise.allSettled([
    browser.action.setBadgeText({ tabId, text: result?.ok ? '' : '!' }),
    browser.action.setTitle({
      tabId,
      title: result?.ok ? 'Sayvia' : 'Sayvia：当前页面无法开启翻译，请从工具栏手动粘贴文本。',
    }),
  ]);
}
export function installGestureEntries() {
  browser.runtime.onInstalled.addListener(() => {
    void browser.contextMenus
      .removeAll()
      .then(() => {
        const documentUrlPatterns = ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'];
        browser.contextMenus.create({
          id: READ,
          title: '使用 Sayvia 翻译选中文字',
          contexts: ['selection'],
          documentUrlPatterns,
        });
        browser.contextMenus.create({
          id: WRITE,
          title: '使用 Sayvia 翻译当前输入',
          contexts: ['editable'],
          documentUrlPatterns,
        });
      })
      .catch(() => undefined);
  });
  browser.contextMenus.onClicked.addListener((info, tab) => {
    // Preserve DOM semantics: never use info.selectionText as a source fallback.
    if (info.frameId && info.frameId !== 0) return;
    if (tab?.id === undefined || ![READ, WRITE].includes(String(info.menuItemId))) return;
    const read = info.menuItemId === READ;
    void showEntry(tab.id, read ? 'read' : 'write', read).catch(() => undefined);
  });
  browser.commands.onCommand.addListener((command, tab) => {
    if (!['translate-selection', 'translate-editor'].includes(command) || tab?.id === undefined)
      return;
    const read = command === 'translate-selection';
    void showEntry(tab.id, read ? 'read' : 'write', read).catch(() => undefined);
  });
}
