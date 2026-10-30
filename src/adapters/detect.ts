import type { AdapterKind, TextControl } from './types';

export function isTextControl(element: Element): element is TextControl {
  return (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement && ['text', 'search'].includes(element.type))
  );
}

export function isEligible(element: TextControl) {
  const autocomplete = element.autocomplete.toLowerCase();
  return (
    isTextControl(element) &&
    element.isConnected &&
    !element.disabled &&
    !element.matches(':disabled') &&
    element.getClientRects().length > 0 &&
    !element.readOnly &&
    !element.closest('[inert], [hidden], [aria-hidden="true"]') &&
    !/(?:^|\s)(?:cc-|current-password|new-password|one-time-code)/.test(autocomplete) &&
    element.ownerDocument.defaultView?.getComputedStyle(element).display !== 'none' &&
    element.ownerDocument.defaultView?.getComputedStyle(element).visibility !== 'hidden'
  );
}

export function detectAdapter(
  element: Element,
  url = new URL(element.ownerDocument.URL),
): AdapterKind | undefined {
  if (!isTextControl(element) || !isEligible(element)) return undefined;
  if (url.hostname === 'github.com') {
    const route = /^\/[^/]+\/[^/]+\/(?:issues|pull)\/\d+(?:\/|$)/.test(url.pathname);
    if (
      route &&
      element instanceof HTMLTextAreaElement &&
      element.matches('textarea[name="comment[body]"], textarea#new_comment_field')
    ) {
      return 'github-markdown';
    }
    return undefined;
  }
  return 'generic-text';
}
