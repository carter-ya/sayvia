import type { CaptionController } from './controller';
import { watchVideoId } from './player';

// The next layer adds translation controls to this local capture status surface.
export function mountCaptureStatus(controller: CaptionController) {
  const host = document.createElement('div');
  host.setAttribute('data-sayvia-caption-status', '');
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent =
    ':host{all:initial;position:fixed;bottom:16px;left:16px;z-index:2147483646;max-width:min(360px,calc(100vw - 32px));font:13px/1.5 system-ui;color:#182532}section{background:#fff;border:1px solid #dce2e7;border-radius:12px;padding:12px;box-shadow:0 4px 20px #0002}p{margin:4px 0}button{font:inherit;margin-top:8px;padding:5px 9px;border:1px solid #a6b5c1;border-radius:6px;background:#f6f9fc;color:#182532;cursor:pointer}button:focus-visible{outline:2px solid #2456bd;outline-offset:2px}:host([hidden]){display:none}';
  const section = document.createElement('section');
  section.setAttribute('aria-label', 'Sayvia 字幕读取');
  const heading = document.createElement('strong');
  heading.textContent = 'Sayvia 字幕';
  const status = document.createElement('p');
  status.setAttribute('role', 'status');
  const refresh = document.createElement('button');
  refresh.textContent = '刷新后读取字幕';
  refresh.addEventListener('click', () => {
    refresh.disabled = true;
    void controller.refresh().finally(() => {
      refresh.disabled = false;
    });
  });
  section.append(heading, status, refresh);
  shadow.append(style, section);
  const mount = () => {
    if (!host.isConnected) document.body?.append(host);
  };
  document.addEventListener('DOMContentLoaded', mount, { once: true });
  mount();
  const unsubscribe = controller.subscribe((view) => {
    host.hidden = !view.enabled || !watchVideoId(location.href);
    const reason = view.capture?.reason;
    status.textContent = view.error
      ? '字幕暂时无法读取，原生字幕仍可使用。'
      : view.processing
        ? '正在整理字幕…'
        : view.groups.length
          ? `已在本页读取 ${view.groups.length} 段字幕，尚未发送给模型。`
          : reason === 'platform-translated'
            ? '请在 YouTube 字幕菜单选择原语言字幕。'
            : reason === 'advertisement'
              ? '广告期间暂停读取字幕。'
              : reason === 'live'
                ? '暂不支持直播字幕。'
                : reason === 'track-unavailable'
                  ? '请先在 YouTube 中开启字幕。'
                  : '正在等待播放器加载字幕。已加载的字幕可能需要刷新后读取。';
    refresh.hidden =
      view.groups.length > 0 ||
      view.processing ||
      ['advertisement', 'live', 'platform-translated'].includes(reason ?? '');
  });
  return () => {
    unsubscribe();
    document.removeEventListener('DOMContentLoaded', mount);
    host.remove();
  };
}
