import { detectAdapter, isTextControl } from './detect';
import { TextEditorSession } from './text-session';

export class EditorRegistry {
  readonly documentNonce = crypto.randomUUID();
  private readonly byElement = new WeakMap<Element, TextEditorSession>();
  private readonly sessions = new Set<TextEditorSession>();

  bind(element: Element) {
    const kind = detectAdapter(element);
    if (!kind || !isTextControl(element)) return undefined;
    const existing = this.byElement.get(element);
    if (existing) return existing;
    const session = new TextEditorSession(element, kind, this.documentNonce, () => {
      this.byElement.delete(element);
      this.sessions.delete(session);
    });
    this.byElement.set(element, session);
    this.sessions.add(session);
    return session;
  }

  dispose() {
    for (const session of [...this.sessions]) session.dispose();
    this.sessions.clear();
  }
}
