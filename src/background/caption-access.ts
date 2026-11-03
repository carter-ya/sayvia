import type { TaskOwner } from './task-broker';
import { trackKey, type CaptionTrack } from '../captions/contract';
import { YOUTUBE_ORIGIN } from '../captions/player';

export const CAPTURE_SETTING_KEY = 'sayvia.youtube-captions-enabled';
export type CaptionOwner = TaskOwner & {
  kind: 'page';
  documentId: string;
  siteOrigin: typeof YOUTUBE_ORIGIN;
};
export type CaptionSession = {
  sessionId: string;
  generation: number;
  videoId: string;
  trackKey: string;
  captureGeneration: string;
};
export type CaptureSettings = {
  desiredEnabled: boolean;
  registered: boolean;
  unconfirmedDocuments: number;
  error: boolean;
};
export interface CaptionAccessPlatform {
  read(): Promise<unknown>;
  write(enabled: boolean): Promise<void>;
  register(enabled: boolean): Promise<void>;
  cleanup(enabled: boolean): Promise<number>;
  current(owner: CaptionOwner): Promise<string | undefined>;
  cancel(owner?: CaptionOwner): Promise<void>;
}
const sameOwner = (left: CaptionOwner, right: TaskOwner) =>
  right.kind === 'page' &&
  left.tabId === right.tabId &&
  left.documentId === right.documentId &&
  left.documentNonce === right.documentNonce &&
  right.siteOrigin === YOUTUBE_ORIGIN;
export class CaptionAccess {
  readonly ready: Promise<void>;
  private queue: Promise<unknown> = Promise.resolve();
  private desired = false;
  private registered = false;
  private initialized = false;
  private issue = false;
  private unconfirmed = 0;
  private intent = 0;
  private revocation = 0;
  private disableVersion = 0;
  private cleanedVersion = 0;
  private readonly sessions = new Map<number, { owner: CaptionOwner; session: CaptionSession }>();
  constructor(private readonly platform: CaptionAccessPlatform) {
    this.ready = this.initialize();
  }
  private async initialize() {
    try {
      const saved = await this.platform.read();
      if (saved !== undefined && typeof saved !== 'boolean')
        throw new Error('INVALID_CAPTURE_SETTING');
      if (this.intent === 0) {
        this.desired = saved === true;
        await this.platform.register(this.desired);
        this.registered = this.desired && this.intent === 0;
        this.unconfirmed = await this.platform.cleanup(this.registered);
      }
      this.initialized = true;
    } catch {
      this.issue = true;
      this.registered = false;
      await this.platform.register(false).catch(() => undefined);
      await this.platform.cleanup(false).catch(() => undefined);
    }
  }
  status(): CaptureSettings {
    return {
      desiredEnabled: this.desired,
      registered: this.registered,
      unconfirmedDocuments: this.unconfirmed,
      error: this.issue,
    };
  }
  private serial<T>(run: () => Promise<T>) {
    const result = this.queue.then(async () => {
      await this.ready;
      return run();
    });
    this.queue = result.catch(() => undefined);
    return result;
  }
  setEnabled(enabled: boolean): Promise<CaptureSettings> {
    this.desired = enabled;
    this.intent++;
    // Revocation happens outside the queue: broker authorization must not wait
    // behind a reconcile operation that is itself waiting for broker.cancel.
    if (!enabled) {
      this.revocation++;
      this.disableVersion++;
      this.registered = false;
      this.sessions.clear();
    }
    return this.serial(async () => {
      this.issue = false;
      let applied: number;
      do {
        applied = this.intent;
        const wanted = this.desired;
        try {
          await this.stopPending();
          await this.platform.write(wanted);
          if (!wanted)
            await this.platform.cancel().catch(() => {
              this.issue = true;
            });
          await this.platform.register(wanted);
          this.registered = wanted && applied === this.intent;
          this.unconfirmed = await this.platform.cleanup(this.registered);
          this.initialized = true;
        } catch {
          this.issue = true;
          this.registered = false;
          this.sessions.clear();
          await this.platform.cancel().catch(() => undefined);
          await this.platform.register(false).catch(() => undefined);
          await this.platform.cleanup(false).catch(() => undefined);
        }
      } while (applied !== this.intent);
      return this.status();
    });
  }
  reconcile() {
    return this.serial(async () => {
      const intent = this.intent;
      const wanted = this.desired;
      try {
        await this.stopPending();
        await this.platform.register(wanted);
        this.registered = wanted && intent === this.intent;
        this.unconfirmed = await this.platform.cleanup(this.registered);
        this.issue = false;
        this.initialized = true;
      } catch {
        this.registered = false;
        this.issue = true;
        this.sessions.clear();
        await this.platform.cancel().catch(() => undefined);
        await this.platform.register(false).catch(() => undefined);
        await this.platform.cleanup(false).catch(() => undefined);
      }
      return this.status();
    });
  }
  private async stopPending() {
    while (this.cleanedVersion !== this.disableVersion) {
      const version = this.disableVersion;
      this.registered = false;
      this.sessions.clear();
      // A disable is an irreversible cancellation boundary, even when the user
      // immediately enables local capture again before the serial queue runs.
      await this.platform.write(false);
      await this.platform.cancel();
      await this.platform.register(false);
      this.unconfirmed = await this.platform.cleanup(false);
      this.cleanedVersion = version;
    }
  }
  async enabledFor(owner: CaptionOwner): Promise<boolean> {
    const intent = this.intent;
    if (!this.initialized || !this.desired || !this.registered || this.issue) return false;
    const video = await this.platform.current(owner).catch(() => undefined);
    return (
      !!video &&
      this.initialized &&
      this.desired &&
      this.registered &&
      !this.issue &&
      intent === this.intent
    );
  }
  grant(
    owner: CaptionOwner,
    track: CaptionTrack,
    captureGeneration: string,
    previousSessionId?: string,
  ): Promise<CaptionSession> {
    const revocation = this.revocation;
    return this.serial(async () => {
      const intent = this.intent;
      if (
        !this.initialized ||
        !this.desired ||
        !this.registered ||
        this.issue ||
        revocation !== this.revocation ||
        track.tlang ||
        owner.siteOrigin !== YOUTUBE_ORIGIN
      )
        throw new Error('CAPTION_NOT_AUTHORIZED');
      const existing = this.sessions.get(owner.tabId);
      if (
        previousSessionId &&
        (!existing ||
          !sameOwner(existing.owner, owner) ||
          existing.session.sessionId !== previousSessionId ||
          existing.session.videoId !== track.videoId)
      )
        throw new Error('CAPTION_NOT_AUTHORIZED');
      if (!existing && this.sessions.size >= 64) throw new Error('CAPTION_LIMIT');
      this.sessions.delete(owner.tabId);
      if (existing) await this.platform.cancel(existing.owner);
      const currentVideo = await this.platform.current(owner);
      if (
        intent !== this.intent ||
        revocation !== this.revocation ||
        !this.desired ||
        !this.registered ||
        currentVideo !== track.videoId
      )
        throw new Error('CAPTION_NOT_AUTHORIZED');
      const session: CaptionSession = {
        sessionId: previousSessionId ?? crypto.randomUUID(),
        generation: previousSessionId ? existing!.session.generation + 1 : 0,
        videoId: track.videoId,
        trackKey: trackKey(track),
        captureGeneration,
      };
      this.sessions.set(owner.tabId, { owner, session });
      return { ...session };
    });
  }
  revoke(owner?: CaptionOwner): Promise<void> {
    this.revocation++;
    if (!owner) this.sessions.clear();
    else {
      const current = this.sessions.get(owner.tabId);
      if (current && sameOwner(current.owner, owner)) this.sessions.delete(owner.tabId);
    }
    return this.platform.cancel(owner);
  }
  revokeTab(tabId: number) {
    this.revocation++;
    const current = this.sessions.get(tabId);
    if (!current) return Promise.resolve();
    this.sessions.delete(tabId);
    return this.platform.cancel(current.owner);
  }
  async authorized(
    owner: TaskOwner,
    identity: Pick<CaptionSession, 'sessionId' | 'generation' | 'videoId' | 'trackKey'>,
  ): Promise<boolean> {
    // Deliberately never await ready or our serial queue from the broker's lock.
    const current = this.sessions.get(owner.tabId);
    if (
      !this.initialized ||
      !this.desired ||
      !this.registered ||
      this.issue ||
      !current ||
      !sameOwner(current.owner, owner)
    )
      return false;
    if (
      ['sessionId', 'generation', 'videoId', 'trackKey'].some(
        (key) =>
          current.session[key as keyof typeof identity] !== identity[key as keyof typeof identity],
      )
    )
      return false;
    const video = await this.platform.current(current.owner).catch(() => undefined);
    return (
      this.sessions.get(owner.tabId) === current &&
      this.desired &&
      this.registered &&
      !this.issue &&
      video === identity.videoId
    );
  }
}
