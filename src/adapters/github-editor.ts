// Shared by adapter detection and toolbar discovery so review drafts cannot be
// writable through one entry point but invisible through another.
export const GITHUB_COMMENT_SELECTOR = [
  'textarea[name="comment[body]"]',
  'textarea#new_comment_field',
  'textarea[name="review_comment[body]"]',
  'textarea[name="pull_request_review[body]"]',
  'textarea[data-testid="markdown-editor-textarea"]',
].join(', ');
