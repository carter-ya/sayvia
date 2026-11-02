// Shared by adapter detection and toolbar discovery so review drafts cannot be
// writable through one entry point but invisible through another.
const legacySelector = [
  'textarea[name="comment[body]"]',
  'textarea#new_comment_field',
  'textarea[name="review_comment[body]"]',
  'textarea[name="pull_request_review[body]"]',
  'textarea[data-testid="markdown-editor-textarea"]',
].join(', ');

// Current GitHub review editors omit name/testid. The hidden markdown-toolbar
// still explicitly identifies the field even though formatting uses an ActionBar.
const reviewSelector = 'fieldset textarea[data-component="Textarea"][id]';
export const GITHUB_COMMENT_SELECTOR = `${legacySelector}, ${reviewSelector}`;
export function isGitHubCommentEditor(element: HTMLTextAreaElement) {
  if (element.matches(legacySelector)) return true;
  if (!element.matches(reviewSelector) || !element.id) return false;
  const document = element.ownerDocument;
  if (document.getElementById(element.id) !== element) return false;
  const fieldset = element.closest('fieldset')!;
  return [...fieldset.querySelectorAll('markdown-toolbar')].some(
    (toolbar) =>
      toolbar.closest('fieldset') === fieldset && toolbar.getAttribute('for') === element.id,
  );
}
