import { createElement, Fragment, useState, type ChangeEvent, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorRegistry } from '../../src/adapters/registry';
import type { EditorSnapshot } from '../../src/adapters/types';
import type { TextEditorSession } from '../../src/adapters/text-session';

function ControlledForm() {
  const [text, setText] = useState('前缀 中文 后缀');
  const [submitted, setSubmitted] = useState('');
  return createElement(
    Fragment,
    null,
    createElement(
      'form',
      {
        onSubmit(event: FormEvent<HTMLFormElement>) {
          event.preventDefault();
          setSubmitted(text);
        },
      },
      createElement('textarea', {
        id: 'editor',
        value: text,
        onChange(event: ChangeEvent<HTMLTextAreaElement>) {
          setText(event.currentTarget.value);
        },
      }),
      createElement('button', { type: 'submit' }, '模拟用户提交'),
      createElement('output', { 'data-testid': 'submitted' }, submitted),
    ),
    createElement('textarea', { id: 'other', defaultValue: '另一份草稿' }),
  );
}
createRoot(document.getElementById('root')!).render(createElement(ControlledForm));

const registry = new EditorRegistry();
let session: TextEditorSession;
let snapshot: EditorSnapshot;

// This fixture-only handle is never part of a WXT entrypoint or the shipped extension.
export const harness = {
  capture() {
    const element = document.getElementById('editor')!;
    session = registry.bind(element)!;
    snapshot = session.capture();
    return { scope: snapshot.scope, source: snapshot.fullText };
  },
  apply(text: string) {
    return session.apply(snapshot, text);
  },
  restore() {
    return session.restore();
  },
  removeAndReinsert() {
    const element = document.getElementById('editor')!;
    const parent = element.parentNode!;
    element.remove();
    parent.appendChild(element);
  },
};
export type EditorHarness = typeof harness;
declare global {
  interface Window {
    editorHarness: EditorHarness;
  }
}
window.editorHarness = harness;
