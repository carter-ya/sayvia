// Public migrate commit 1d52ac5, CHANGELOG R13-R14, inspected 2026-11-02.
// Commit cells expose data-line-anchor instead of PR-specific side/line attrs.
export const commitUrl =
  'https://github.com/exc-works/migrate/commit/1d52ac5b288bce5c070ef9407c3aff7fa7de565a';
export const commitAnchor = 'diff-06572a96a58dc510037d5efa622f9bec8519bc1beab13c9f251e97e657a9d4ed';
export const commitLines = [
  '<span class="pl-v">-</span> Accept <span class="pl-s">`</span><span class="pl-c1">.mjs</span><span class="pl-s">`</span> as a JavaScript migration alias in full builds; SQL-only builds',
  '  detect and reject it before migration writes. Support <span class="pl-s">`</span><span class="pl-c1">new version --format mjs</span><span class="pl-s">`</span>.',
];
export function commitDiff() {
  return `<table role="grid" data-diff-anchor="${commitAnchor}" aria-label="Diff for: CHANGELOG.md"><tbody>${commitLines.map((line, i) => `<tr><td data-line-anchor="${commitAnchor}L${11 + i}" role="gridcell"><code class="diff-text"><div class="diff-text-inner">UNSELECTED_LEFT</div></code></td><td data-grid-cell-id="${commitAnchor}-${11 + i}-${13 + i}-3" data-line-anchor="${commitAnchor}R${13 + i}" role="gridcell"><code class="diff-text syntax-highlighted-line"><div class="diff-text-inner" id="commit-line-${i}">${line}</div></code></td></tr>`).join('')}</tbody></table>`;
}
