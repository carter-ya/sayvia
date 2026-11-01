export const panelStyle = `
:host { all: initial; position: fixed; z-index: 2147483647; top: 16px; right: 16px; width: min(410px, calc(100vw - 24px)); color-scheme: light dark; }
* { box-sizing: border-box; }
section { --surface: light-dark(#fffefa,#1b2421); --field: light-dark(#f6f7f3,#232e29); --ink: light-dark(#273b32,#e6eee8); --muted: light-dark(#768178,#9faea4); --line: light-dark(#dfe5dc,#3b4b41); --accent: light-dark(#24634f,#a4d5b9); font: 14px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 20px; box-shadow: 0 12px 52px #142b2530, 0 2px 8px #142b2510; padding: 20px; max-height: calc(100dvh - var(--panel-top, 16px) - 12px); overflow: auto; }
section:focus { outline: none; } :focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
header, .actions, .panel-heading { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
header, .panel-heading { justify-content: space-between; } strong { display: flex; align-items: center; gap: 8px; font-weight: 600; letter-spacing: -.4px; font-size: 19px; }
.brand-mark { display: grid; place-items: center; width: 26px; height: 28px; border-radius: 8px; color: #fff; background: #24634f; font-size: 17px; }
header button { background: transparent; border: 0; color: var(--muted); font-size: 24px; line-height: 1; padding: 4px 6px; }
h2 { font-size: 17px; font-weight: 550; margin: 18px 0 8px; letter-spacing: -.3px; }
.mode-badge { color: var(--accent); background: var(--field); font-size: 11px; padding: 2px 8px; border-radius: 20px; margin-top: 10px; }
.language-pair { display: grid; grid-template-columns: repeat(2, minmax(0,1fr)); gap: 10px; }
label { display: block; margin: 12px 0; font-size: 12px; color: var(--muted); }
input, select, textarea { display: block; font-family: inherit; font-size: 14px; font-weight: 400; line-height: 1.6; color: var(--ink); background: var(--field); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; width: 100%; margin-top: 5px; }
textarea { resize: vertical; min-height: 72px; } textarea[aria-label='译文'] { min-height: 126px; background: transparent; font-size: 15px; line-height: 1.8; }
button { font: inherit; cursor: pointer; color: var(--accent); background: var(--field); border: 1px solid var(--line); border-radius: 9px; padding: 7px 12px; font-size: 12px; }
button:hover:not(:disabled) { filter: brightness(.96); } button:disabled { opacity: .45; cursor: default; } button[aria-pressed='true'] { border-color: var(--accent); }
.primary-action { color: #fff; background: #24634f; border-color: #24634f; } .actions { margin-top: 10px; } .actions button:last-child:not(:first-child) { margin-left: auto; }
p { min-height: 20px; margin: 8px 0 0; } .model-note { font-size: 11px; color: var(--muted); margin: 0 0 12px; overflow-wrap: anywhere; }
.source-details { margin: 14px 0 12px; padding: 10px 0; border-block: 1px solid var(--line); }
summary { cursor: pointer; color: var(--muted); font-size: 12px; } summary span { float: right; font-size: 11px; } .panel-status { font-size: 12px; color: var(--muted); padding-top: 6px; }
@media (max-width: 420px) { section { padding: 16px; border-radius: 16px; } }
`;
