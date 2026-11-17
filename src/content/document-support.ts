// Also serialized by scripting.executeScript: keep this function self-contained.
export function supportsWorkflowDocument() {
  return (
    document.documentElement instanceof HTMLElement &&
    document.createElement('div') instanceof HTMLElement
  );
}
