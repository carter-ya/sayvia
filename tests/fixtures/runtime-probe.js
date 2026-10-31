/* global chrome */
// This script is installed only into a temporary test copy of the extension.
const documentNonce = crypto.randomUUID();
const editorSessionId = crypto.randomUUID();
let last;
const body = document.body;
chrome.storage.session.get('sayvia.tasks').then(
  () => {
    body.dataset.sessionAccess = 'readable';
  },
  () => {
    body.dataset.sessionAccess = 'blocked';
  },
);
function send(type, payload) {
  return chrome.runtime.sendMessage({
    protocolVersion: 1,
    requestId: crypto.randomUUID(),
    type,
    payload,
  });
}
function reflect(value) {
  body.dataset.reply = JSON.stringify(value);
}
document.querySelector('#start')?.addEventListener('click', (event) => {
  if (!event.isTrusted) return;
  last = {
    clientTaskId: crypto.randomUUID(),
    documentNonce,
    editorSessionId,
    sourceRevision: 0,
    mode: 'write',
    scope: 'full',
    source: { kind: 'plain-text', text: document.querySelector('textarea').value },
    sourceLanguage: 'auto',
    targetLanguage: 'en',
  };
  body.dataset.result = '';
  void send('translation.start', last).then(reflect);
});
document.querySelector('#retry')?.addEventListener('click', (event) => {
  if (event.isTrusted && last) void send('translation.start', last).then(reflect);
});
document.querySelector('#cancel')?.addEventListener('click', (event) => {
  if (event.isTrusted && last)
    void send('translation.cancel', { clientTaskId: last.clientTaskId, documentNonce }).then(
      reflect,
    );
});
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (
    message?.type === 'translation.state' &&
    message.documentNonce === documentNonce &&
    message.clientTaskId === last?.clientTaskId
  ) {
    body.dataset.state = message.state;
    body.dataset.error = message.error ?? '';
    sendResponse({ taskId: message.taskId, documentNonce });
    return;
  }
  if (
    message?.type !== 'translation.result' ||
    message.documentNonce !== documentNonce ||
    message.clientTaskId !== last?.clientTaskId
  )
    return;
  body.dataset.result = message.result.text;
  body.dataset.canApply = String(message.canApply);
  sendResponse({ taskId: message.taskId, documentNonce });
});
