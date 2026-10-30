interface Tracker {
  flush(): void;
  subscribe(callback: (records: MutationRecord[]) => void): () => void;
}
const trackers = new WeakMap<Document, Tracker>();

export function trackDocument(document: Document, callback: (records: MutationRecord[]) => void) {
  let tracker = trackers.get(document);
  if (!tracker) {
    const callbacks = new Set<(records: MutationRecord[]) => void>();
    const notify = (records: MutationRecord[]) => {
      for (const listener of [...callbacks]) listener(records);
    };
    const observer = new MutationObserver(notify);
    observer.observe(document.documentElement, { subtree: true, childList: true });
    tracker = {
      flush: () => notify(observer.takeRecords()),
      subscribe(listener) {
        callbacks.add(listener);
        return () => {
          callbacks.delete(listener);
          if (!callbacks.size) {
            observer.disconnect();
            trackers.delete(document);
          }
        };
      },
    };
    trackers.set(document, tracker);
  }
  return { flush: tracker.flush, unsubscribe: tracker.subscribe(callback) };
}
