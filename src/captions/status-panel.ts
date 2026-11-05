import type { CaptionController } from './controller';
import type { CaptionPlayerSession } from './player-session';
import { watchVideoId } from './player';
import { LANGUAGES, languageName } from '../ui/languages';
import {
  applyAppearance,
  appearanceStyle,
  defaultAppearance,
  type Appearance,
} from '../ui/appearance';

export function mountCaptureStatus(controller: CaptionController, session: CaptionPlayerSession) {
  const host = document.createElement('div');
  host.setAttribute('data-sayvia-caption-status', '');
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = `${appearanceStyle}
:host{all:initial;position:absolute;top:12px;left:12px;z-index:70;max-width:min(320px,calc(100% - 24px));font:13px/1.45 system-ui;color:var(--ink);color-scheme:light dark}:host([data-floating]){position:fixed;top:auto;bottom:16px;z-index:2147483646}:host([hidden]){display:none}details{background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:8px 10px;box-shadow:0 3px 15px #0003;max-height:calc(100vh - 40px);overflow:auto}summary{cursor:pointer;font-weight:600}p{margin:7px 0}.hint{font-size:12px;color:var(--muted)}label{display:block;margin:7px 0}select{display:block;width:100%;font:inherit;background:var(--field);color:var(--ink);border:1px solid var(--line);border-radius:5px;padding:4px}button{font:inherit;margin:4px 5px 0 0;padding:5px 9px;border:1px solid var(--line);border-radius:6px;background:var(--field);color:var(--ink);cursor:pointer}button:disabled{opacity:.55;cursor:default}button:focus-visible,select:focus-visible,summary:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}input[type=range]{width:100%}`;
  const details = document.createElement('details');
  details.open = false;
  const summary = document.createElement('summary');
  summary.textContent = 'Sayvia 字幕';
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Sayvia 字幕控制');
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const model = document.createElement('p');
  model.className = 'hint';
  const privacy = document.createElement('p');
  privacy.className = 'hint';
  privacy.textContent = '开启后，接下来需要的字幕会持续分批发送给当前模型。关闭或换视频后停止。';
  function button(text: string, run: () => void) {
    const element = document.createElement('button');
    element.type = 'button';
    element.textContent = text;
    element.addEventListener('click', (event) => {
      if (event.isTrusted) {
        event.stopPropagation();
        run();
      }
    });
    return element;
  }
  const refresh = button('刷新后读取字幕', () => {
    void controller.refresh();
  });
  const config = button('重新读取模型', () => {
    void session.loadConfiguration();
  });
  const start = button('开启双语字幕', () => {
    void session.start();
  });
  const stop = button('停止翻译', () => {
    if (session.snapshot().stopping) void session.confirmStop();
    else session.stop();
  });
  const retry = button('重试翻译', () => session.retry());
  const targetLabel = document.createElement('label');
  targetLabel.textContent = '字幕目标语言';
  const target = document.createElement('select');
  target.setAttribute('aria-label', '字幕目标语言');
  for (const language of LANGUAGES) {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = language.name;
    target.append(option);
  }
  target.addEventListener('change', (event) => {
    if (event.isTrusted) session.setTarget(target.value);
  });
  targetLabel.append(target);
  const modeLabel = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = '字幕显示方式';
  modeLabel.append(legend);
  const modes: HTMLInputElement[] = [];
  for (const [value, name] of [
    ['bilingual', '原文 + 译文'],
    ['translation', '仅译文'],
  ]) {
    const label = document.createElement('label');
    const input = document.createElement('input');
    input.type = 'radio';
    input.name = 'caption-display-mode';
    input.value = value!;
    input.addEventListener('change', (event) => {
      if (event.isTrusted && input.checked)
        session.setMode(input.value === 'translation' ? 'translation' : 'bilingual');
    });
    label.append(input, name!);
    modes.push(input);
    modeLabel.append(label);
  }
  function slider(name: string, min: string, max: string, value: string) {
    const label = document.createElement('label');
    label.textContent = name;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.value = value;
    input.setAttribute('aria-label', name);
    label.append(input);
    return { label, input };
  }
  const size = slider('字幕字号', '14', '48', '22');
  const bottom = slider('字幕距底部', '16', '200', '64');
  for (const input of [size.input, bottom.input])
    input.addEventListener('input', (event) => {
      if (event.isTrusted) session.appearance(Number(size.input.value), Number(bottom.input.value));
    });
  section.append(
    status,
    model,
    privacy,
    targetLabel,
    modeLabel,
    start,
    stop,
    retry,
    config,
    refresh,
    size.label,
    bottom.label,
  );
  details.append(summary, section);
  shadow.append(style, details);
  applyAppearance(host, defaultAppearance);
  // Only focused panel controls consume their keys. The player keeps its own
  // shortcuts and pointer controls outside this small surface.
  details.addEventListener('keydown', (event) => {
    event.stopPropagation();
    if (event.isTrusted && event.key === 'Escape') {
      details.open = false;
      summary.focus();
    }
  });
  details.addEventListener('click', (event) => event.stopPropagation());
  const mount = () => {
    const parent = document.getElementById('movie_player') ?? document.body;
    if (!parent) return;
    host.toggleAttribute('data-floating', parent === document.body);
    if (host.parentElement !== parent) parent.append(host);
  };
  document.addEventListener('DOMContentLoaded', mount, { once: true });
  mount();
  const unsubscribe = session.subscribe(() => {
    mount();
    const view = session.snapshot(),
      capture = view.capture;
    host.hidden = !capture.enabled || !watchVideoId(location.href);
    if (![...target.options].some((option) => option.value === view.target)) {
      const custom = document.createElement('option');
      custom.value = view.target;
      custom.textContent = languageName(view.target);
      target.append(custom);
    }
    target.value = view.target;
    for (const input of modes) input.checked = input.value === view.mode;
    target.disabled = view.starting || view.stopping;
    model.textContent = view.model ? `当前模型：${view.model}` : '尚未取得可用模型。';
    const reason = capture.capture?.reason;
    status.textContent =
      view.error ??
      (view.stopping
        ? '画面已恢复，上一批请求尚待确认停止。可点击重试停止。'
        : view.starting
          ? '正在开启当前视频翻译…'
          : view.active
            ? view.scheduler?.state === 'paused'
              ? '翻译已暂停，已保留原生字幕。点击重试可重新请求。'
              : view.scheduler?.needsRetry
                ? '这段翻译此前已取消，点击重试可重新翻译。'
                : view.scheduler?.state === 'waiting'
                  ? '正在等待当前查词或其他任务结束…'
                  : `双语字幕已开启 · ${view.scheduler?.translated ?? 0} 段已翻译${capture.capture?.track?.kind === 'asr' ? ' · 自动字幕' : ''}`
            : capture.error
              ? '字幕暂时无法读取，原生字幕仍可使用。'
              : capture.processing
                ? '正在整理字幕…'
                : capture.groups.length
                  ? `已读取 ${capture.groups.length} 段字幕，尚未发送给模型。`
                  : reason === 'platform-translated'
                    ? '请在 YouTube 字幕菜单选择原语言字幕。'
                    : reason === 'advertisement'
                      ? '广告期间暂停字幕。'
                      : reason === 'live'
                        ? '暂不支持直播字幕。'
                        : reason === 'track-unavailable'
                          ? '请先在 YouTube 中开启字幕。'
                          : '正在等待播放器加载字幕。已缓存的字幕可能需要刷新后读取。');
    start.hidden = view.active;
    start.disabled =
      !view.model ||
      !capture.groups.length ||
      !!capture.error ||
      capture.processing ||
      view.starting ||
      view.stopping;
    stop.hidden = !view.active && !view.starting && !view.stopping;
    stop.textContent = view.stopping ? '重试停止' : '停止翻译';
    retry.hidden =
      !view.active || !(view.scheduler?.state === 'paused' || view.scheduler?.needsRetry);
    config.hidden = !!view.model;
    refresh.hidden =
      capture.groups.length > 0 ||
      capture.processing ||
      ['advertisement', 'live', 'platform-translated'].includes(reason ?? '');
  });
  return {
    setAppearance(value: Appearance) {
      applyAppearance(host, value);
    },
    dispose() {
      unsubscribe();
      document.removeEventListener('DOMContentLoaded', mount);
      host.remove();
    },
  };
}
