import { appearanceStyle } from '../ui/appearance';

export const panelStyle =
  appearanceStyle +
  `
:host { all: initial; position: fixed; z-index: 2147483647; top: 12px; right: 12px; width: min(var(--panel-width, 420px), calc(100vw - 16px)); color-scheme: light dark; }
* { box-sizing: border-box; }
section { position: relative; isolation: isolate; font: 13px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC',sans-serif; color: var(--ink); background: var(--surface); border: 1px solid var(--line); border-radius: 24px; box-shadow: 0 24px 64px -22px light-dark(#302d2a45,#000000b3),0 7px 18px -7px light-dark(#292b3038,#0000008c); padding: 14px 18px; max-height: min(680px,var(--panel-max-height,calc(100dvh - var(--panel-top,12px) - 8px))); overflow: auto; display: flex; flex-direction: column; }
section > * { flex-shrink: 0; position: relative; z-index: 1; }
:host([data-material='liquid']) section { background: linear-gradient(var(--glass-legibility),var(--glass-legibility)),linear-gradient(130deg,light-dark(#ffffff36,#ffffff09),transparent 55%),color-mix(in srgb,var(--surface) var(--glass-opacity),transparent); backdrop-filter: blur(10px) saturate(145%); border-color: light-dark(#ffffff96,#d9e7e83d); box-shadow: 0 24px 64px -22px light-dark(#302d2a45,#000000b3),0 7px 18px -7px light-dark(#292b3038,#0000008c),inset 0 1px 1px light-dark(#ffffffed,#ffffff4d),inset 1px 0 1px light-dark(#ffffff80,#ffffff1a),inset 0 -1px 1px light-dark(#41403d33,#00000080); }
:host([data-material='liquid']) section::before { content: ''; position: absolute; z-index: 0; inset: 0; border-radius: inherit; padding: 1.4px; pointer-events: none; background: linear-gradient(135deg,light-dark(#ffffffed,#ffffff88),transparent 49%,light-dark(#9a96915c,#c0b8b02e) 63%,light-dark(#ffffffb3,#ffffff59) 83%,transparent); mask: linear-gradient(#fff 0 0) content-box,linear-gradient(#fff 0 0); mask-composite: exclude; }
:host([data-material='liquid']) section::after { content: ''; position: absolute; z-index: 0; inset: 2px; border-radius: inherit; pointer-events: none; background: radial-gradient(ellipse 74% 42% at var(--glass-light-x,24%) 0%,light-dark(#ffffff3d,#ffffff12),transparent 80%); }
:host([data-material='glass']) section { background: linear-gradient(var(--glass-legibility),var(--glass-legibility)),color-mix(in srgb,var(--surface) var(--glass-opacity),transparent); backdrop-filter: blur(18px) saturate(125%); }
:host([data-material='transparent']) section { background: linear-gradient(var(--glass-legibility),var(--glass-legibility)),color-mix(in srgb,var(--surface) var(--glass-opacity),transparent); }
section[data-collapsed='true'] > :not(header) { display: none; }
section[data-collapsed='true'] header { margin-bottom: 0; padding-bottom: 0; border: 0; }
section:focus { outline: none; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
header { display: flex; align-items: center; gap: 6px; margin: -3px -5px 8px; padding-bottom: 8px; border-bottom: 1px solid color-mix(in srgb,var(--line) 65%,transparent); cursor: grab; touch-action: none; user-select: none; }
header:active { cursor: grabbing; }
header strong { display: flex; align-items: center; gap: 7px; font-weight: 650; font-size: 15px; letter-spacing: -.3px; flex: 1; }
.panel-brand-mark { display: grid; place-items: center; width: 23px; height: 25px; border-radius: 7px 7px 7px 2px; color: var(--ink); background: linear-gradient(145deg,light-dark(#ffffffbd,#ffffff23),transparent); border: 1px solid light-dark(#ffffffd9,#ffffff30); font: italic 19px Georgia,serif; box-shadow: 0 1px 3px light-dark(#23304417,#00000026); }
.mode-badge { color: var(--muted); font-size: 11px; font-weight: 400; letter-spacing: 0; }
button { font: inherit; cursor: pointer; display: inline-flex; align-items: center; justify-content: center; gap: 6px; color: var(--ink); background: var(--field); border: 1px solid var(--line); border-radius: 20px; padding: 7px 10px; font-size: 12px; }
button svg { flex-shrink: 0; }
button:hover:not(:disabled) { background: var(--tint); }
button:disabled { opacity: .45; cursor: default; }
button[aria-pressed='true'] { border-color: var(--accent); }
header button { width: 27px; height: 30px; padding: 4px; border: 0; color: var(--muted); background: transparent; }
header .move-handle { cursor: grab; width: 16px; padding: 0; }
.language-pair { display: grid; grid-template-columns: minmax(0,1fr) 16px minmax(0,1fr); align-items: center; gap: 8px; }
.language-pair .language-field > label:first-child { font-size: 0; margin: 0; }
.language-pair .language-field .language-control { margin-top: 0; }
.language-pair .language-field .language-input { border-color: transparent; background: transparent; border-radius: 20px; }
.language-arrow { color: var(--muted); line-height: 1; }
label { display: block; margin: 8px 0; font-size: 12px; color: var(--muted); }
input,select,textarea { display: block; font-family: inherit; font-size: 13px; font-weight: 400; line-height: 1.6; color: var(--ink); background: var(--field); border: 1px solid var(--line); border-radius: 9px; padding: 8px 10px; width: 100%; min-width: 0; margin-top: 4px; }
textarea { resize: none; min-height: 60px; max-height: 360px; }
.source-details { margin: 8px 0 0; }
summary { cursor: pointer; color: var(--muted); font-size: 12px; }
summary span { float: right; font-size: 11px; }
.source-details textarea { position: relative; color: var(--ink); background: var(--field); font-size: 14px; line-height: 1.8; padding: 13px 14px; max-height: 170px; opacity: 1; text-shadow: none; }
.result-region { min-height: 0; overflow: auto; overscroll-behavior: contain; flex: 1 1 auto; margin: 12px 0; padding: 0; scrollbar-gutter: stable; border-radius: 12px; }
:host([data-reading-protection='true']) .result-region { background: radial-gradient(ellipse,color-mix(in srgb,var(--surface) 54%,transparent) 35%,transparent 100%); }
.reading-preview,.streaming-preview { white-space: pre-wrap; font-size: 15px; line-height: 1.8; overflow-wrap: anywhere; user-select: text; }
.streaming-preview { min-height: 60px; }
.reading-preview p { margin: 0 0 14px; }
.reading-preview > :last-child { margin-bottom: 0; }
.reading-preview code { font: .9em/1.6 ui-monospace,SFMono-Regular,Menlo,monospace; padding: 2px 4px; background: var(--field); color: var(--ink); border-radius: 4px; white-space: pre-wrap; }
.reading-preview pre { margin: 10px 0; padding: 12px; background: var(--field); border-radius: 9px; white-space: pre-wrap; overflow-wrap: anywhere; }
.reading-preview pre code { padding: 0; background: transparent; }
.reading-preview a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
.reading-preview ul,.reading-preview ol { padding-left: 22px; }
.reading-preview li { margin: 4px 0; }
.reading-preview li input { display: inline; width: auto; }
.reading-preview blockquote { margin: 10px 0; padding-left: 10px; border-left: 3px solid var(--line); }
.preview-table { overflow-x: auto; }
.reading-preview table { border-collapse: collapse; }
.reading-preview td { border: 1px solid var(--line); padding: 4px 7px; }
.translation-metrics { font-size: 11px; color: var(--muted); margin: 0 0 6px; font-variant-numeric: tabular-nums; }
.result-placeholder { color: var(--muted); min-height: 50px; }
.result-label { margin: 14px 0 10px; min-height: 0; overflow: auto; flex: 1 1 auto; }
textarea[aria-label='译文'] { min-height: 112px; background: var(--field); font-size: 14px; line-height: 1.85; padding: 10px 12px; }
.actions { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin-top: 8px; }
.main-actions { margin-top: 0; border-top: 1px solid color-mix(in srgb,var(--line) 70%,transparent); padding-top: 10px; }
.primary-action { color: var(--on-accent); background: var(--accent); border-color: transparent; margin-inline-start: auto; box-shadow: inset 0 1px 1px #ffffff52,0 2px 5px light-dark(#28272429,#00000033); }
.primary-action:hover:not(:disabled) { background: var(--accent); filter: brightness(.96); }
p { margin: 6px 0 0; }
.model-note,.panel-status,.appearance-note { font-size: 11px; color: var(--muted); overflow-wrap: anywhere; }
.panel-options { border-top: 1px solid var(--line); margin-top: 10px; padding-top: 7px; }
.appearance-options { margin: 0 0 14px; border: 1px solid var(--line); background: var(--surface); border-radius: 14px; padding: 10px 14px; min-width: 0; }
.appearance-options label { margin: 8px 0; }
.material-choices { display: grid; grid-template-columns: repeat(4,minmax(0,1fr)); gap: 5px; margin: 4px 0 12px; }
.material-choices button { padding: 7px 4px; }
.material-choices button[aria-pressed='true'] { background: var(--tint); color: var(--accent); }
input[type='range'] { padding: 0; accent-color: var(--accent); }
.panel-check { display: flex; align-items: center; gap: 8px; }
.panel-check input { width: 16px; height: 16px; margin: 0; accent-color: var(--accent); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
@supports not (backdrop-filter: blur(1px)) { :host([data-material='liquid']) section,:host([data-material='glass']) section { background: var(--surface); } }
@media (prefers-reduced-transparency: reduce), (prefers-contrast: more) { :host section { background: var(--surface) !important; backdrop-filter: none !important; } }
@media (max-height: 400px) { section { overflow: auto; padding: 12px 16px; } .result-region { min-height: 70px; } }
@media (pointer: coarse) { button { min-height: 44px; } header button { min-width: 44px; } header { gap: 4px; } header .mode-badge { display: none; } }
`;
