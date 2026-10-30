self.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (
    typeof event.data === 'object' &&
    event.data !== null &&
    'type' in event.data &&
    event.data.type === 'runtime.check'
  ) {
    self.postMessage({ type: 'runtime.ready' });
  }
});
