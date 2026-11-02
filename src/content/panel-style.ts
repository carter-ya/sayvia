export const panelStyle = `
:host { all: initial; position: fixed; z-index: 2147483647; top: 12px; right: 12px; width: min(var(--panel-width, 340px), calc(100vw - 16px)); color-scheme: light dark; }
* { box-sizing: border-box; }
section { --surface: light-dark(#fff,#1d2822); --field: light-dark(#f5f7f4,#26362c); --ink: light-dark(#273b32,#e6eee8); --muted: light-dark(#768178,#9faea4); --line: light-dark(#e1e7df,#3b4b41); --accent: light-dark(#286947,#a4d5b9); font: 13px/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 8px 32px #142b2526; padding: 12px; max-height: min(680px, var(--panel-max-height, calc(100dvh - var(--panel-top, 12px) - 8px))); overflow: auto; display: flex; flex-direction: column; }
section > * { flex-shrink: 0; }
.result-region { min-height: 0; overflow: auto; overscroll-behavior: contain; flex: 1 1 auto; margin: 12px 0; scrollbar-gutter: stable; }
.reading-preview { white-space: pre-wrap; font-size: 14px; line-height: 1.75; overflow-wrap: anywhere; user-select: text; }
.reading-preview p { margin: 0 0 12px; } .reading-preview > :last-child { margin-bottom: 0; }
.reading-preview code { font: .9em/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; padding: 2px 4px; background: var(--field); border-radius: 4px; white-space: pre-wrap; }
.reading-preview pre { margin: 10px 0; padding: 10px; background: var(--field); border-radius: 6px; white-space: pre-wrap; overflow-wrap: anywhere; } .reading-preview pre code { padding: 0; background: transparent; }
.reading-preview a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.reading-preview ul, .reading-preview ol { padding-left: 22px; } .reading-preview li { margin: 4px 0; } .reading-preview li input { display: inline; width: auto; }
.reading-preview blockquote { margin: 10px 0; padding-left: 10px; border-left: 3px solid var(--line); }
.preview-table { overflow-x: auto; } .reading-preview table { border-collapse: collapse; } .reading-preview td { border: 1px solid var(--line); padding: 4px 7px; }
.result-placeholder { color: var(--muted); min-height: 50px; }
@media (max-height: 400px) { section { overflow: auto; } .result-region { min-height: 70px; } }
section:focus { outline: none; } :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
header, .actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
header { justify-content: space-between; margin-bottom: 10px; } header strong { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; letter-spacing: -.2px; }
header button { background: transparent; border: 0; color: var(--muted); font-size: 20px; line-height: 1; padding: 0 3px; }
.mode-badge { color: var(--muted); font-size: 10px; font-weight: 400; }
.language-pair { display: grid; grid-template-columns: minmax(0,1fr) 12px minmax(0,1fr); align-items: start; gap: 6px; }
.language-pair .language-field > label:first-child { font-size: 0; margin: 0; }
.language-arrow { color: var(--muted); line-height: 30px; }
label { display: block; margin: 8px 0; font-size: 11px; color: var(--muted); }
input, select, textarea { display: block; font-family: inherit; font-size: 13px; font-weight: 400; line-height: 1.5; color: var(--ink); background: var(--field); border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; width: 100%; margin-top: 3px; }
.language-pair select { margin: 0; font-size: 12px; height: 30px; padding: 4px 6px; }
textarea { resize: none; min-height: 60px; max-height: 360px; } .result-label { margin: 6px 0 10px; min-height: 0; overflow: auto; flex: 1 1 auto; } textarea[aria-label='译文'] { min-height: 112px; border: 1px solid light-dark(#b7c8bc,#667d6d); background: var(--field); font-size: 14px; line-height: 1.75; padding: 10px 12px; box-shadow: inset 0 1px 2px #142b2508; }
textarea[aria-label='译文']:focus { border-color: var(--accent); outline: 2px solid color-mix(in srgb, var(--accent) 30%, transparent); outline-offset: 1px; }
button { font: inherit; cursor: pointer; color: var(--accent); background: var(--field); border: 1px solid var(--line); border-radius: 6px; padding: 5px 9px; font-size: 12px; }
button:hover:not(:disabled) { filter: brightness(.96); } button:disabled { opacity: .4; cursor: default; } button[aria-pressed='true'] { border-color: var(--accent); }
.primary-action { color: #fff; background: #286947; border-color: #286947; } .actions { margin-top: 6px; } .main-actions { margin-top: 0; }
p { margin: 6px 0 0; } .model-note { font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.source-details { margin: 8px 0 0; } .source-details textarea { max-height: 120px; } summary { cursor: pointer; color: var(--muted); font-size: 11px; } summary span { float: right; font-size: 10px; }
.panel-options { border-top: 1px solid var(--line); margin-top: 10px; padding-top: 7px; } .panel-status { font-size: 11px; color: var(--muted); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
`;
