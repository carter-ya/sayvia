const style = `
.translation-loading { min-height: 70px; display: flex; align-items: center; justify-content: center; }
.translation-loading .loading-spinner { display: block; width: 20px; height: 20px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: sayvia-loading 800ms linear infinite; }
@keyframes sayvia-loading { to { transform: rotate(360deg); } }
@media(prefers-reduced-motion: reduce) { .translation-loading .loading-spinner { animation: none; } }
`;
export function TranslationLoading({ label = '正在翻译' }: { label?: string }) {
  return (
    <div className="translation-loading" role="progressbar" aria-label={label}>
      <style>{style}</style>
      <span className="loading-spinner" aria-hidden="true" />
    </div>
  );
}
