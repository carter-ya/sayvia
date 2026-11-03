export const commentUrl = 'https://github.com/exc-works/migrate/pull/14/changes';
export const commentAnchor =
  'diff-1869dcb1c8a41c4befecdcfc9bce497f0f9bdd8aea7506cc3d8b1ef2fa21795c';
export const commentLines = [
  '// DriverDSN keeps Oracle reconnections on the full authentication path. go-ora',
  "// v3.0.1's default fast-login cookie path fails on subsequent Oracle Free logins.",
  "// An explicit driver option remains the operator's choice.",
];
export function sourceCommentDiff(name = 'internal/config/driver.go') {
  return `<table role="grid" data-diff-anchor="${commentAnchor}" aria-label="Diff for: ${name}"><tbody>${commentLines.map((line, i) => `<tr><td data-line-anchor="${commentAnchor}L${11 + i}"><code class="diff-text"><div class="diff-text-inner">UNSELECTED_OPPOSITE</div></code></td><td data-line-anchor="${commentAnchor}R${11 + i}" data-diff-side="right" data-line-number="${11 + i}"><code class="diff-text"><span class="diff-text-marker">+</span><div class="diff-text-inner" id="comment-${i}"><span class="pl-c">${line}</span></div></code><button hidden>UNSELECTED_CONTROL</button></td></tr>`).join('')}</tbody></table>`;
}
