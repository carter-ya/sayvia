// Public migrate PR #21, modules.go R10-R12, inspected 2026-11-03.
// Unified additions have an empty old-line cell, a numbered gutter and a code cell.
export const moduleComments = [
  '// ModuleContext locates an entry and the files available to its compiler.',
  '// Directory is the disk entry directory; FS and EntryPath describe a virtual entry.',
  '// DependencyDir explicitly enables installed-package lookup for virtual sources.',
];
export function moduleDiff() {
  return `<table role="grid" data-diff-anchor="diff-modules" aria-label="Diff for: internal/source/modules.go"><tbody>${moduleComments
    .map(
      (text, i) =>
        `<tr><td class="new-diff-line-number empty-diff-line"></td><td class="new-diff-line-number" data-diff-side="right" data-line-number="${10 + i}" id="number-${i}">${10 + i}</td><td data-diff-side="right" data-line-number="${10 + i}" data-line-anchor="diff-modulesR${10 + i}"><code class="diff-text syntax-highlighted-line addition"><span class="diff-text-marker">+</span><div class="diff-text-inner" id="line-${i}"><span class="pl-c">${text}</span></div></code></td></tr>`,
    )
    .join('')}</tbody></table>`;
}
