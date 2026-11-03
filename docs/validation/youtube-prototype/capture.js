// Diagnostic prototype only. Installing it explicitly enables local capture.
// No requests are initiated here; no credentials or full request URLs leave this scope.
(() => {
  const marker = 'sayvia-subtitle-research-v1';
  const maxBytes = 4 * 1024 * 1024;
  let enabled = true;
  const send = (data) => window.postMessage({ marker, ...data }, location.origin);
  let previousTrack = '';
  setInterval(() => {
    const player = document.getElementById('movie_player');
    try {
      const track = player?.getOption?.('captions', 'track');
      const state = {
        available: typeof player?.getOption === 'function',
        videoId: player?.getVideoData?.()?.video_id ?? null,
        track: track
          ? {
              languageCode: track.languageCode ?? null,
              kind: track.kind ?? null,
              vssId: track.vssId ?? null,
              name: typeof track.name === 'string' ? track.name : null,
            }
          : null,
      };
      const encoded = JSON.stringify(state);
      if (encoded !== previousTrack) {
        previousTrack = encoded;
        send({ type: 'player.track', state });
      }
    } catch {
      /* Private API unavailable is an observed failure, never a reason to fetch. */
    }
  }, 250);
  window.addEventListener('message', (event) => {
    if (
      event.source === window &&
      event.origin === location.origin &&
      event.data?.marker === marker &&
      event.data?.type === 'capture.toggle'
    ) {
      enabled = event.data.enabled === true;
    }
  });
  const metadata = (input) => {
    try {
      const url = new URL(input, location.href);
      if (url.origin !== 'https://www.youtube.com' || url.pathname !== '/api/timedtext')
        return null;
      const keys = ['v', 'lang', 'kind', 'name', 'vssId', 'fmt', 'tlang'];
      return Object.fromEntries(keys.map((key) => [key, url.searchParams.get(key)]));
    } catch {
      return null;
    }
  };
  const fetchOriginal = window.fetch;
  window.fetch = function (...args) {
    const meta = metadata(
      typeof args[0] === 'string' || args[0] instanceof URL ? args[0] : args[0]?.url,
    );
    const active = enabled;
    const pending = fetchOriginal.apply(this, args);
    if (active && meta) {
      const startedAt = Date.now();
      send({ type: 'request', transport: 'fetch', meta });
      void pending
        .then(async (response) => {
          if (!enabled || !metadata(response.url)) return;
          const copy = response.clone();
          const reader = copy.body?.getReader();
          if (!reader) return;
          let total = 0;
          const parts = [];
          const decoder = new TextDecoder();
          const timer = setTimeout(() => {
            void reader.cancel();
          }, 10000);
          try {
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              total += value.byteLength;
              if (!enabled || total > maxBytes) {
                void reader.cancel();
                return;
              }
              parts.push(decoder.decode(value, { stream: true }));
            }
            parts.push(decoder.decode());
            if (enabled)
              send({
                type: 'response',
                transport: 'fetch',
                meta,
                status: response.status,
                bytes: total,
                elapsedMs: Date.now() - startedAt,
                body: parts.join(''),
              });
          } finally {
            clearTimeout(timer);
            reader.releaseLock();
          }
        })
        .catch(() => send({ type: 'capture.error', transport: 'fetch', meta }));
    }
    return pending;
  };
  const openOriginal = XMLHttpRequest.prototype.open;
  const sendOriginal = XMLHttpRequest.prototype.send;
  const requests = new WeakMap();
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    const result = openOriginal.call(this, method, url, ...rest);
    requests.set(this, { meta: metadata(url) });
    return result;
  };
  XMLHttpRequest.prototype.send = function (...args) {
    const meta = requests.get(this)?.meta;
    if (enabled && meta) {
      const startedAt = Date.now();
      send({ type: 'request', transport: 'xhr', meta });
      this.addEventListener(
        'loadend',
        () => {
          if (!enabled || !metadata(this.responseURL)) return;
          try {
            const body =
              this.responseType === 'json'
                ? JSON.stringify(this.response)
                : this.responseType === '' || this.responseType === 'text'
                  ? this.responseText
                  : null;
            if (body === null || body.length > maxBytes) return;
            const bytes = new TextEncoder().encode(body).length;
            if (bytes > maxBytes) return;
            send({
              type: 'response',
              transport: 'xhr',
              meta,
              status: this.status,
              bytes,
              elapsedMs: Date.now() - startedAt,
              body,
            });
          } catch {
            send({ type: 'capture.error', transport: 'xhr', meta });
          }
        },
        { once: true },
      );
    }
    return sendOriginal.apply(this, args);
  };
})();
