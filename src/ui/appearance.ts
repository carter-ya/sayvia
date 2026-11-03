import type { ConfigSnapshot } from '../storage/schema';

export type Appearance = Pick<
  ConfigSnapshot['preferences'],
  'theme' | 'palette' | 'panelMaterial' | 'panelOpacity' | 'readingProtection'
>;

export const defaultAppearance: Appearance = {
  theme: 'system',
  palette: 'crystal',
  panelMaterial: 'liquid',
  panelOpacity: 14,
  readingProtection: true,
};

export function appearanceOf(preferences: Appearance): Appearance {
  const { theme, palette, panelMaterial, panelOpacity, readingProtection } = preferences;
  return { theme, palette, panelMaterial, panelOpacity, readingProtection };
}

export function applyAppearance(root: HTMLElement, appearance: Appearance) {
  root.style.colorScheme = appearance.theme === 'system' ? 'light dark' : appearance.theme;
  root.dataset.palette = appearance.palette;
  root.dataset.material = appearance.panelMaterial;
  root.dataset.readingProtection = String(appearance.readingProtection);
  root.style.setProperty('--glass-opacity', `${appearance.panelOpacity}%`);
}

// Shared by extension documents and the isolated content-script shadow root.
export const appearanceStyle = `
:root, :host {
  --bg: light-dark(#f5f7fa,#14181e); --surface: light-dark(#fff,#202329);
  --field: light-dark(#f5f7fa,#20272f); --ink: light-dark(#1e232b,#f1f3f7);
  --muted: light-dark(#616974,#c8d0dd); --line: light-dark(#dde2e9,#414953);
  --accent: light-dark(#0870e5,#72b6ff); --on-accent: light-dark(#fff,#102841);
  --tint: light-dark(#e9edf3,#303842); --glass-opacity: 14%;
  --glass-legibility: light-dark(transparent,color-mix(in srgb,var(--surface) 84%,transparent));
}
:root[data-palette='pearl'], :host([data-palette='pearl']) {
  --bg: light-dark(#faf6f1,#1c1917); --surface: light-dark(#fffdfa,#282421);
  --field: light-dark(#faf6f1,#2a241f); --ink: light-dark(#2d2927,#f5eee9);
  --muted: light-dark(#6f655e,#d7ccc4); --line: light-dark(#e7dfd8,#4c433d);
  --accent: light-dark(#cf4b3e,#ffad99); --on-accent: light-dark(#fff,#3d2019);
  --tint: light-dark(#f2eae4,#3a302a);
}
`;
