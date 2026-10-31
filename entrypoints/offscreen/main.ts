import { startOffscreenRuntime } from '../../src/executor/offscreen-runtime';

const worker = new Worker(new URL('../../src/executor/bootstrap.worker.ts', import.meta.url), {
  type: 'module',
});

worker.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (
    typeof event.data === 'object' &&
    event.data !== null &&
    'type' in event.data &&
    event.data.type === 'runtime.ready'
  ) {
    document.body.dataset.workerReady = 'true';
    worker.terminate();
  }
});

worker.postMessage({ type: 'runtime.check' });

startOffscreenRuntime();
