import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  badge: vi.fn(async () => undefined),
  title: vi.fn(async () => undefined),
  open: vi.fn(async () => ({ ok: true })),
  installed: vi.fn(),
  menu: vi.fn(),
  command: vi.fn(),
  remove: vi.fn(async () => undefined),
  create: vi.fn(),
}));
vi.mock('wxt/browser', () => ({
  browser: {
    action: { setBadgeText: mocks.badge, setTitle: mocks.title },
    runtime: { onInstalled: { addListener: mocks.installed } },
    contextMenus: {
      removeAll: mocks.remove,
      create: mocks.create,
      onClicked: { addListener: mocks.menu },
    },
    commands: { onCommand: { addListener: mocks.command } },
  },
}));
vi.mock('../../src/background/page-router', () => ({ openPage: mocks.open }));
import { installGestureEntries } from '../../src/background/gesture-entry';
beforeEach(() => {
  vi.clearAllMocks();
  installGestureEntries();
});
it('creates scoped context menus on install and does not access selected text', async () => {
  await mocks.installed.mock.calls[0]![0]();
  await vi.waitFor(() => expect(mocks.create).toHaveBeenCalledTimes(2));
  expect(mocks.create).toHaveBeenCalledWith(
    expect.objectContaining({
      id: 'sayvia-read-selection',
      contexts: ['selection'],
      documentUrlPatterns: ['https://*/*', 'http://localhost/*', 'http://127.0.0.1/*'],
    }),
  );
  const info = {
    menuItemId: 'sayvia-read-selection',
    frameId: 0,
    get selectionText() {
      throw new Error('must never read flattened text');
    },
  };
  mocks.menu.mock.calls[0]![0](info, { id: 12 });
  expect(mocks.open).toHaveBeenCalledWith(12, 'read', true);
});
it('ignores child frames, absent tabs and unrelated context menu IDs', () => {
  const click = mocks.menu.mock.calls[0]![0];
  click({ menuItemId: 'sayvia-read-selection', frameId: 1 }, { id: 12 });
  click({ menuItemId: 'sayvia-read-selection' }, undefined);
  click({ menuItemId: 'unrelated' }, { id: 12 });
  expect(mocks.open).not.toHaveBeenCalled();
});
it('uses the browser supplied command tab and keeps writing preview-only', () => {
  const command = mocks.command.mock.calls[0]![0];
  command('translate-selection', { id: 6 });
  command('translate-editor', { id: 7 });
  command('unrelated', { id: 8 });
  command('translate-selection', undefined);
  expect(mocks.open.mock.calls).toEqual([
    [6, 'read', true],
    [7, 'write', false],
  ]);
});

it('restricted pages show an actionable toolbar hint without retrying injection', async () => {
  mocks.open.mockResolvedValueOnce({ ok: false });
  mocks.command.mock.calls[0]![0]('translate-selection', { id: 9 });
  await vi.waitFor(() => expect(mocks.badge).toHaveBeenCalledWith({ tabId: 9, text: '!' }));
  expect(mocks.title).toHaveBeenCalledWith(
    expect.objectContaining({ tabId: 9, title: expect.stringContaining('当前页面无法开启翻译') }),
  );
  expect(mocks.open).toHaveBeenCalledTimes(1);
});
