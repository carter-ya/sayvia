export type TextControl = HTMLTextAreaElement | HTMLInputElement;
export type AdapterKind = 'github-markdown' | 'generic-text';

export interface EditorSnapshot {
  readonly editorSessionId: string;
  readonly documentNonce: string;
  readonly revision: number;
  readonly fullText: string;
  readonly range: Readonly<{ start: number; end: number }>;
  readonly scope: 'selection' | 'full';
  readonly format: 'markdown' | 'plain-text';
}

export type ApplyResult =
  | { ok: true }
  | {
      ok: false;
      reason:
        'SOURCE_CHANGED' | 'CONTEXT_LOST' | 'COMPOSING' | 'UNSUPPORTED' | 'WRITE_REJECTED' | 'BUSY';
    };

export interface RestoreRecord {
  before: string;
  after: string;
  revision: number;
}
