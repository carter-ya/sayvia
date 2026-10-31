export const panelStyle = `
:host { all: initial; position: fixed; z-index: 2147483647; top: 16px; right: 16px; width: min(420px, calc(100vw - 32px)); color-scheme: light dark; }
* { box-sizing: border-box; }
section { font: 14px/1.5 system-ui, sans-serif; color: #202124; background: #fff; border: 1px solid #d5dae1; border-radius: 12px; box-shadow: 0 8px 32px #0003; padding: 16px; max-height: calc(100vh - 32px); overflow: auto; }
header, .actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
header { justify-content: space-between; } strong { color: #256d55; font-size: 18px; }
h2 { font-size: 18px; margin: 12px 0; } label { display: block; margin: 10px 0; }
input, select, textarea { display: block; font: inherit; color: inherit; background: #f8f9fc; border: 1px solid #c7cdd8; border-radius: 6px; padding: 8px; width: 100%; margin-top: 4px; }
textarea { resize: vertical; min-height: 64px; } button { font: inherit; color: inherit; cursor: pointer; background: #edf5f0; border: 1px solid #c7cdd8; border-radius: 6px; padding: 6px 10px; }
button:disabled { opacity: .5; cursor: default; } p { min-height: 21px; margin-bottom: 0; }
@media (prefers-color-scheme: dark) { section { background: #1e2026; color: #f0f1f5; border-color: #555b68; } input, select, textarea, button { background: #2b303b; border-color: #555b68; } strong { color: #89c7aa; } }
`;
