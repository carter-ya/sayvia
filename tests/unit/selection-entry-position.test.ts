// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SelectionEntry } from '../../src/content/selection-entry';

let entry: SelectionEntry;
beforeEach(() => {
  entry = new SelectionEntry(() => {});
});
afterEach(() => {
  entry.dispose();
  vi.restoreAllMocks();
});

it('puts the pointer action above the release and keeps it clear of a top-edge release', () => {
  entry.showRect(new DOMRect(0, 0, 300, 200), { x: 80, y: 125 });
  expect(entry.panelAnchor()!.bottom).toBeLessThan(125);
  entry.showRect(new DOMRect(0, 0, 300, 200), { x: innerWidth - 1, y: 4 });
  const box = entry.panelAnchor()!;
  expect(box.top).toBeGreaterThan(4);
  expect(box.right).toBeLessThanOrEqual(innerWidth);
});

it('tracks the active end of a backward DOM selection and uses the whole line height', () => {
  const text = document.createTextNode('first line and second line');
  document.body.append(text);
  const selected = window.getSelection()!;
  selected.setBaseAndExtent(text, text.length, text, 0);
  const lines = [new DOMRect(100, 200, 100, 40), new DOMRect(100, 240, 80, 40)];
  Object.defineProperty(selected.getRangeAt(0), 'getClientRects', { value: () => lines });
  entry.show(selected);
  expect(entry.panelAnchor()!.left).toBe(100);
  expect(entry.panelAnchor()!.bottom).toBeLessThan(200);
  entry.show(selected, { x: 130, y: 275 });
  expect(entry.panelAnchor()!.bottom).toBeLessThan(240);
  selected.removeAllRanges();
  text.remove();
});
