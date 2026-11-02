// Rich editors can translate selected or full visible text without claiming a
// reliable write contract. Native controls remain handled by TextEditorSession.
export function previewEditor(element: Element | null): HTMLElement | undefined {
  if (!(element instanceof HTMLElement)) return;
  const root = element.closest<HTMLElement>('[contenteditable]:not([contenteditable="false"])');
  if (
    !root?.isContentEditable ||
    !root.isConnected ||
    !root.getClientRects().length ||
    root.closest(
      '[hidden],[inert],[aria-hidden="true"],[aria-disabled="true"],[aria-readonly="true"]',
    )
  )
    return;
  const style = getComputedStyle(root);
  if (style.display === 'none' || style.visibility === 'hidden') return;
  return root;
}
