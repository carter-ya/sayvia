import { z } from 'zod';
import { LocaleSchema } from '../core/learning-contract';
import { CaptionProviderSchema } from '../runtime/caption-protocol';
import { CaptionScheduler, type SchedulerView } from './scheduler';
import { CaptionOverlay, type CaptionDisplayMode } from './overlay';
import { DisplayReplySchema } from './display-lease';
import { type CaptionController, type CaptionView } from './controller';
import { YOUTUBE_ORIGIN } from './player';
const ConfigurationSchema = z.object({
  ok: z.literal(true),
  provider: CaptionProviderSchema,
  targetLanguage: z.string().max(80),
});
type Configuration = z.infer<typeof ConfigurationSchema>;
export type CaptionPlayerView = {
  capture: CaptionView;
  model: string;
  target: string;
  mode: CaptionDisplayMode;
  starting: boolean;
  stopping: boolean;
  active: boolean;
  scheduler?: SchedulerView;
  error?: string;
};
type Active = {
  scheduler: CaptionScheduler;
  source: CaptionView;
  player: HTMLElement;
  video: HTMLVideoElement;
  overlay: CaptionOverlay;
  unsubscribe(): void;
  frame?: number;
  lastRenew: number;
  lastAck: number;
  firstRenew: number;
  wantsDisplay: boolean;
  renewId?: string;
};
export class CaptionPlayerSession {
  private capture: CaptionView;
  private configuration: Configuration | undefined;
  private configRequest: Promise<void> | undefined;
  private active: Active | undefined;
  private retiring: CaptionScheduler | undefined;
  private draining: Promise<boolean> | undefined;
  private readonly listeners = new Set<() => void>();
  private readonly unsubscribe: () => void;
  private readonly timer: ReturnType<typeof setInterval>;
  private version = 0;
  private disposed = false;
  private starting = false;
  private error: string | undefined;
  private target = 'zh-Hans';
  private targetChosen = false;
  private mode: CaptionDisplayMode = 'bilingual';
  private size = 22;
  private bottom = 64;
  constructor(
    readonly controller: CaptionController,
    private readonly request: (message: Record<string, unknown>) => Promise<unknown>,
  ) {
    this.capture = controller.snapshot();
    this.unsubscribe = controller.subscribe((view) => {
      this.capture = view;
      const active = this.active;
      if (
        active &&
        (!view.enabled ||
          view.error ||
          view.processing ||
          view.groups !== active.source.groups ||
          view.session !== active.source.session ||
          view.capture !== active.source.capture)
      )
        this.stop('字幕来源或授权已变化，请重新开启。', false);
      if (view.enabled && !this.configuration && !this.configRequest) void this.loadConfiguration();
      this.publish();
    });
    window.addEventListener('message', this.leaseReply);
    document.addEventListener('fullscreenchange', this.mediaChanged);
    this.timer = setInterval(this.tick, 250);
  }
  snapshot(): CaptionPlayerView {
    return {
      capture: this.capture,
      model: this.configuration?.provider.model ?? '',
      target: this.target,
      mode: this.mode,
      starting: this.starting,
      stopping: !!this.retiring,
      active: !!this.active,
      ...(this.active ? { scheduler: this.active.scheduler.snapshot() } : {}),
      ...(this.error ? { error: this.error } : {}),
    };
  }
  subscribe(listener: () => void) {
    this.listeners.add(listener);
    listener();
    return () => {
      this.listeners.delete(listener);
    };
  }
  private publish() {
    for (const listener of this.listeners) listener();
  }
  private async readConfiguration() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const reply = await Promise.race([
        this.request({
          protocolVersion: 1,
          requestId: crypto.randomUUID(),
          documentNonce: this.controller.documentNonce,
          type: 'captions.configuration',
        }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('CONFIG_UNAVAILABLE')), 3000);
        }),
      ]);
      return ConfigurationSchema.parse(reply);
    } finally {
      clearTimeout(timer);
    }
  }
  loadConfiguration(): Promise<void> {
    if (this.disposed || this.configRequest) return this.configRequest ?? Promise.resolve();
    const version = this.version;
    const pending = this.readConfiguration()
      .then(
        (config) => {
          if (this.disposed || version !== this.version) return;
          this.configuration = config;
          if (!this.targetChosen) {
            const language = LocaleSchema.safeParse(config.targetLanguage);
            this.target = language.success ? language.data : 'zh-Hans';
          }
          this.error = undefined;
          this.publish();
        },
        () => {
          if (version === this.version && !this.disposed) {
            this.error = '请先在 Sayvia 设置中配置可用模型。';
            this.publish();
          }
        },
      )
      .finally(() => {
        if (this.configRequest === pending) this.configRequest = undefined;
      });
    this.configRequest = pending;
    return pending;
  }
  configurationChanged() {
    this.stop('模型或语言设置已变化，请确认后重新开启。');
    this.configuration = undefined;
    this.configRequest = undefined;
    void this.loadConfiguration();
  }
  setTarget(value: string) {
    const parsed = LocaleSchema.safeParse(value);
    if (!parsed.success || parsed.data === this.target) return;
    this.stop();
    this.target = parsed.data;
    this.targetChosen = true;
    this.publish();
  }
  setMode(mode: CaptionDisplayMode) {
    this.mode = mode;
    this.render();
    this.publish();
  }
  appearance(size: number, bottom: number) {
    this.size = size;
    this.bottom = bottom;
    this.render();
  }
  async start() {
    if (this.disposed || this.active || this.starting || !this.configuration) return;
    this.starting = true;
    this.error = undefined;
    const version = ++this.version;
    const expected = this.configuration;
    const source = this.capture;
    this.publish();
    try {
      if (!(await this.drain())) throw new Error('上一批字幕尚未确认停止，请稍后重试。');
      if (version !== this.version || this.disposed) return;
      const current = await this.readConfiguration();
      if (version !== this.version || this.disposed) return;
      if (JSON.stringify(current) !== JSON.stringify(expected)) {
        this.configuration = current;
        throw new Error('当前模型已变化，请确认后重新开启。');
      }
      if (
        source.groups !== this.capture.groups ||
        source.capture !== this.capture.capture ||
        !source.groups.length ||
        !source.capture?.track ||
        source.capture.reason !== 'ready' ||
        source.error
      )
        throw new Error('请先读取当前视频的原语言字幕。');
      const player = document.getElementById('movie_player');
      const video = player?.querySelector('video');
      if (
        !player ||
        !video ||
        !Number.isFinite(video.currentTime) ||
        document.pictureInPictureElement
      )
        throw new Error('当前播放器暂不支持双语字幕。');
      await this.controller.enableTranslation();
      if (version !== this.version || this.disposed) return;
      const granted = this.controller.snapshot();
      if (
        !granted.session ||
        granted.groups !== source.groups ||
        granted.capture !== source.capture
      )
        throw new Error('字幕来源已变化，请重新开启。');
      // A grant can outlive a player replacement without a capture update yet.
      // Revalidate before constructing a scheduler that can dispatch paid work.
      if (
        !player.isConnected ||
        !video.isConnected ||
        document.getElementById('movie_player') !== player ||
        player.querySelector('video') !== video ||
        !Number.isFinite(video.currentTime) ||
        document.pictureInPictureElement
      )
        throw new Error('播放器已变化，请重新开启。');
      const scheduler = new CaptionScheduler(
        {
          session: granted.session,
          provider: expected.provider,
          documentNonce: this.controller.documentNonce,
          sourceLanguage: source.capture.track.lang,
          targetLanguage: this.target,
        },
        source.groups,
        { request: this.request },
      );
      const active: Active = {
        scheduler,
        source: granted,
        player,
        video,
        overlay: new CaptionOverlay(player, video),
        unsubscribe: () => {},
        lastRenew: 0,
        lastAck: 0,
        firstRenew: 0,
        wantsDisplay: false,
      };
      this.active = active;
      active.unsubscribe = scheduler.subscribe(() => {
        if (this.active === active) {
          this.render();
          this.publish();
        }
      });
      for (const name of [
        'play',
        'pause',
        'seeking',
        'seeked',
        'ratechange',
        'loadedmetadata',
        'emptied',
        'enterpictureinpicture',
        'leavepictureinpicture',
      ])
        video.addEventListener(name, this.mediaChanged);
      // Initialize the actual playback window before start can dispatch anything.
      scheduler.tick(video.currentTime * 1000, video.playbackRate);
      scheduler.start();
      this.frame(active);
      this.tick();
    } catch (error) {
      if (version === this.version && !this.disposed) {
        this.error = error instanceof Error ? error.message : '字幕暂不可用，请重试。';
        void this.controller.disableTranslation().catch(() => undefined);
      }
    } finally {
      if (version === this.version) {
        this.starting = false;
        this.publish();
      }
    }
  }
  retry() {
    const active = this.active;
    if (!active) {
      void this.start();
      return;
    }
    active.scheduler.retry();
    this.render();
    this.publish();
  }
  private release(active: Active) {
    active.overlay.clear();
    window.postMessage(
      JSON.stringify({
        channel: 'sayvia.caption.display.v1',
        type: 'stop',
        requestId: crypto.randomUUID(),
        owner: active.overlay.owner,
        generation: active.source.capture!.generation,
        trackKey: active.source.session!.trackKey,
      }),
      YOUTUBE_ORIGIN,
    );
    active.overlay.dispose();
    if (active.frame !== undefined) active.video.cancelVideoFrameCallback?.(active.frame);
    for (const name of [
      'play',
      'pause',
      'seeking',
      'seeked',
      'ratechange',
      'loadedmetadata',
      'emptied',
      'enterpictureinpicture',
      'leavepictureinpicture',
    ])
      active.video.removeEventListener(name, this.mediaChanged);
    active.unsubscribe();
  }
  stop(error?: string, revoke = true) {
    this.version++;
    this.starting = false;
    const active = this.active;
    this.active = undefined;
    if (active) {
      this.release(active);
      this.retiring = active.scheduler;
    }
    this.error = error;
    if (revoke) void this.controller.disableTranslation().catch(() => undefined);
    void this.drain();
    this.publish();
  }
  confirmStop() {
    return this.drain();
  }
  private drain(): Promise<boolean> {
    if (!this.retiring) return Promise.resolve(true);
    if (this.draining) return this.draining;
    const old = this.retiring;
    const pending = old
      .stop()
      .then((confirmed) => {
        if (confirmed && this.retiring === old) this.retiring = undefined;
        return confirmed;
      })
      .finally(() => {
        if (this.draining === pending) this.draining = undefined;
        this.publish();
      });
    this.draining = pending;
    return pending;
  }
  private tick = () => {
    if (this.disposed) return;
    // Failed stop attempts are only retried by an explicit start/retry action.
    const active = this.active;
    if (!active) return;
    if (
      !active.player.isConnected ||
      document.getElementById('movie_player') !== active.player ||
      active.player.querySelector('video') !== active.video ||
      !active.overlay.host.isConnected
    ) {
      this.stop('播放器已变化，请重新开启。');
      return;
    }
    if (document.pictureInPictureElement) {
      this.stop('画中画暂不支持双语字幕。');
      return;
    }
    active.scheduler.tick(active.video.currentTime * 1000, active.video.playbackRate);
    this.render();
    const now = Date.now();
    if (
      active.wantsDisplay &&
      active.firstRenew &&
      now - (active.lastAck || active.firstRenew) >= 2000
    )
      this.stop('字幕显示连接已中断，已恢复原生字幕。');
    this.publish();
  };
  private frame(active: Active) {
    if (this.active !== active || !active.video.requestVideoFrameCallback) return;
    active.frame = active.video.requestVideoFrameCallback(() => {
      if (this.active === active) {
        this.render();
        this.frame(active);
      }
    });
  }
  private mediaChanged = () => {
    this.tick();
  };
  private render() {
    const active = this.active;
    if (!active) return;
    const view = active.scheduler.snapshot();
    active.overlay.appearance(this.size, this.bottom);
    active.wantsDisplay =
      view.state !== 'paused' &&
      view.state !== 'stopped' &&
      active.overlay.render(active.scheduler.visible(active.video.currentTime * 1000), this.mode);
    if (!active.wantsDisplay) {
      active.overlay.clear();
      active.firstRenew = 0;
      active.lastAck = 0;
      delete active.renewId;
      active.lastRenew = 0;
      return;
    }
    const now = Date.now();
    if (active.renewId && now - active.lastRenew < 500) return;
    active.firstRenew ||= now;
    active.lastRenew = now;
    active.renewId = crypto.randomUUID();
    window.postMessage(
      JSON.stringify({
        channel: 'sayvia.caption.display.v1',
        type: 'renew',
        requestId: active.renewId,
        owner: active.overlay.owner,
        generation: active.source.capture!.generation,
        trackKey: active.source.session!.trackKey,
      }),
      YOUTUBE_ORIGIN,
    );
  }
  private leaseReply = (event: MessageEvent) => {
    const active = this.active;
    if (
      !active ||
      event.source !== window ||
      event.origin !== YOUTUBE_ORIGIN ||
      typeof event.data !== 'string' ||
      event.data.length > 1024 ||
      !event.data.startsWith('{"channel":"sayvia.caption.display.status.v1",')
    )
      return;
    let raw: unknown;
    try {
      raw = JSON.parse(event.data);
    } catch {
      return;
    }
    const reply = DisplayReplySchema.safeParse(raw);
    if (
      !reply.success ||
      reply.data.owner !== active.overlay.owner ||
      reply.data.requestId !== active.renewId ||
      reply.data.generation !== active.source.capture!.generation ||
      reply.data.trackKey !== active.source.session!.trackKey
    )
      return;
    if (reply.data.active) active.lastAck = Date.now();
    else if (active.wantsDisplay) this.stop('字幕显示暂不可用，已恢复原生字幕。');
  };
  receive(message: unknown): boolean {
    return this.active?.scheduler.receive(message) ?? false;
  }
  dispose() {
    if (this.disposed) return;
    this.stop();
    this.disposed = true;
    clearInterval(this.timer);
    this.unsubscribe();
    document.removeEventListener('fullscreenchange', this.mediaChanged);
    window.removeEventListener('message', this.leaseReply);
    this.listeners.clear();
  }
}
