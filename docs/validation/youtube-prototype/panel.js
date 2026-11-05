// Local, user-visible diagnosis. Not a production parser or trust boundary.
(() => {
  const marker = 'sayvia-subtitle-research-v1';
  const records = [];
  let cues = [];
  let selected = null;
  let enabled = true;
  let repaint = false;
  let player = null;
  let layer = null;
  let panel = null;
  let summary = null;
  let lastCue = '';
  let requests = 0;
  let playerTrack = null;
  let rawSource = null;
  const style = document.createElement('style');
  style.textContent =
    '#movie_player.sayvia-probe-repainting .ytp-caption-window-container { visibility: hidden !important; }';
  const parse = (body) => {
    if (!body.trim()) return { format: 'empty', cues: [] };
    if (body.trim().startsWith('{')) {
      const data = JSON.parse(body);
      return {
        format: 'json3',
        cues: (data.events || []).flatMap((event, i) => {
          const text = (event.segs || [])
            .map((segment) => segment.utf8 || '')
            .join('')
            .trim();
          const start = Number(event.tStartMs);
          const end = start + Number(event.dDurationMs);
          return text && Number.isFinite(start) && end > start
            ? [
                {
                  id: i,
                  start,
                  end,
                  text,
                  append: event.aAppend === 1,
                  windowId: event.wWinId ?? null,
                },
              ]
            : [];
        }),
      };
    }
    const doc = new DOMParser().parseFromString(body, 'text/xml');
    if (doc.querySelector('parsererror')) return { format: 'unknown', cues: [] };
    const nodes = [...doc.querySelectorAll('p[t], text[start]')];
    return {
      format: 'xml',
      cues: nodes.flatMap((node, i) => {
        const legacy = node.localName === 'text';
        const start = Number(node.getAttribute(legacy ? 'start' : 't')) * (legacy ? 1000 : 1);
        const end = start + Number(node.getAttribute(legacy ? 'dur' : 'd')) * (legacy ? 1000 : 1);
        const text = node.textContent.trim();
        return text && Number.isFinite(start) && end > start ? [{ id: i, start, end, text }] : [];
      }),
    };
  };
  const currentId = () => new URL(location.href).searchParams.get('v');
  const restore = () => {
    player?.classList.remove('sayvia-probe-repainting');
    layer?.remove();
    layer = null;
  };
  const render = () => {
    const next = document.getElementById('movie_player');
    if (next !== player) {
      restore();
      player = next;
    }
    const video = player?.querySelector('video');
    const ad =
      player?.classList.contains('ad-showing') || player?.classList.contains('ad-interrupting');
    const current = (video?.currentTime ?? 0) * 1000;
    const active = cues.filter((cue) => cue.start <= current && current < cue.end);
    const text = active.map((cue) => cue.text).join('\n');
    if (!repaint || !text || !player || ad || selected?.v !== currentId()) restore();
    else {
      if (!layer) {
        layer = document.createElement('div');
        layer.id = 'sayvia-research-caption';
        layer.style.cssText =
          'position:absolute;bottom:15%;left:8%;width:84%;z-index:60;pointer-events:none;text-align:center;white-space:pre-line;color:#fff;background:rgba(0,0,0,.8);font:24px/1.5 sans-serif;padding:8px;';
        player.append(layer);
      }
      layer.textContent = 'Sayvia 原文重绘验证\n' + text;
      player.classList.add('sayvia-probe-repainting');
    }
    lastCue = text;
    if (summary)
      summary.textContent = JSON.stringify(
        {
          enabled,
          requests,
          responses: records.length,
          playerTrack,
          selected,
          cueCount: cues.length,
          futureUntilMs: cues.length ? Math.max(...cues.map((c) => c.end)) : 0,
          currentMs: Math.round(current),
          textTracks: video?.textTracks.length ?? null,
          repaint: !!layer,
          nativeHidden: !!player?.classList.contains('sayvia-probe-repainting'),
          fullscreen: document.fullscreenElement?.id ?? null,
          ad: !!ad,
          latest: records.at(-1),
          activeText: lastCue.slice(0, 240),
        },
        null,
        2,
      );
  };
  window.addEventListener('message', (event) => {
    if (
      event.source !== window ||
      event.origin !== location.origin ||
      event.data?.marker !== marker
    )
      return;
    const data = event.data;
    if (data.type === 'player.track') {
      playerTrack = data.state;
      render();
    }
    if (data.type === 'request') requests++;
    if (
      data.type !== 'response' ||
      typeof data.body !== 'string' ||
      data.body.length > 4 * 1024 * 1024
    )
      return;
    let parsed;
    try {
      parsed = parse(data.body);
    } catch {
      parsed = { format: 'parse-error', cues: [] };
    }
    records.push({
      meta: data.meta,
      transport: data.transport,
      status: data.status,
      bytes: data.bytes,
      elapsedMs: data.elapsedMs,
      format: parsed.format,
      cueCount: parsed.cues.length,
      first: parsed.cues[0] ?? null,
      last: parsed.cues.at(-1) ?? null,
    });
    if (records.length > 20) records.shift();
    if (data.meta.v === currentId() && parsed.cues.length) {
      cues = parsed.cues;
      selected = data.meta;
      rawSource = data.body;
    }
    render();
  });
  const mount = () => {
    if (!document.body || panel) return;
    document.documentElement.append(style);
    panel = document.createElement('aside');
    panel.id = 'sayvia-research-panel';
    panel.style.cssText =
      'position:fixed;top:70px;right:8px;width:380px;max-height:70vh;overflow:auto;z-index:2147483647;background:#fff;color:#111;padding:10px;border:2px solid #08a;font:12px monospace;';
    const title = document.createElement('strong');
    title.textContent = 'Sayvia 字幕研究探针（本地，无模型调用）';
    panel.append(title);
    const button = (label, action) => {
      const node = document.createElement('button');
      node.textContent = label;
      node.addEventListener('click', action);
      panel.append(node);
    };
    button('切换捕获', () => {
      enabled = !enabled;
      window.postMessage({ marker, type: 'capture.toggle', enabled }, location.origin);
      render();
    });
    button('重绘原文', () => {
      repaint = true;
      render();
    });
    button('恢复原生', () => {
      repaint = false;
      restore();
      render();
    });
    button('导出诊断', () => {
      const data = {
        capturedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        records,
        currentVideo: currentId(),
        selected,
        playerTrack,
        cues,
        rawSource,
        activeText: lastCue,
      };
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sayvia-youtube-probe.json';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    summary = document.createElement('pre');
    summary.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere';
    panel.append(summary);
    document.body.append(panel);
    render();
  };
  document.addEventListener('DOMContentLoaded', mount, { once: true });
  if (document.readyState !== 'loading') mount();
  // Diagnostic poll only; production requires media-frame scheduling and teardown.
  setInterval(() => {
    mount();
    render();
  }, 250);
})();
