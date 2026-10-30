import { ReadingSelectionCache } from '../../src/adapters/selection-cache';

const cache = new ReadingSelectionCache();
function capture(range: Range) {
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return cache.capture(selection, document);
}
export const selectionHarness = {
  element(id: string) {
    const range = document.createRange();
    range.selectNodeContents(document.getElementById(id)!);
    return capture(range);
  },
  partialCode() {
    const text = document.getElementById('code')!.firstChild!;
    const range = document.createRange();
    range.setStart(text, 2);
    range.setEnd(text, 5);
    return capture(range);
  },
  crossLink() {
    const range = document.createRange();
    range.setStart(document.getElementById('intro')!.firstChild!, 0);
    range.setEnd(document.getElementById('link')!.firstChild!, 3);
    return capture(range);
  },
  read() {
    return cache.read(document);
  },
};
declare global {
  interface Window {
    selectionHarness: typeof selectionHarness;
  }
}
window.selectionHarness = selectionHarness;
