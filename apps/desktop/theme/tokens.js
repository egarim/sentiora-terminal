// Design tokens for the Living Terminal UI.
//
// Single source of truth on purpose: the React app turns this object into CSS
// custom properties at runtime, and the Node test suite imports the very same
// object to compute WCAG contrast ratios. A theme that is only asserted in a
// stylesheet cannot be tested, and issue #7 asks for "theme contrast" (U13) and
// "design tokens" as deliverables.
//
// Zero dependencies and no JSX, so it loads in Node and in the browser alike.

export const SETTINGS_SCHEMA_VERSION = 1;

// --- colour maths (WCAG 2.1 relative luminance and contrast ratio) ---

function channel(value) {
  const v = value / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(hex) {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function parseHex(hex) {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.split('').map(c => c + c).join('') : value;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) throw new Error(`not a hex colour: ${hex}`);
  return [0, 2, 4].map(i => Number.parseInt(full.slice(i, i + 2), 16));
}

// Contrast ratio 1..21. AA body text needs 4.5, large text and non-text UI
// components need 3.
export function contrastRatio(a, b) {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// --- themes ---

// "black" in the dark palette is a visible grey rather than near-black: an ANSI
// black drawn darker than the terminal background is unreadable, and every
// programme that emits `\x1b[30m` on a dark theme hits exactly that. Both
// palettes are chosen so the chromatic ANSI colours clear 3:1 against their
// background; see ANSI_CONTRAST_EXEMPT for the light-theme white exception.
const ansi = {
  dark: {
    black: '#5c6370', red: '#f07178', green: '#9ece6a', yellow: '#e0af68',
    blue: '#7aa2f7', magenta: '#bb9af7', cyan: '#7dcfff', white: '#c8ccd4',
    brightBlack: '#8b93a1', brightRed: '#ff8f96', brightGreen: '#b5e88a',
    brightYellow: '#f2c98a', brightBlue: '#9db8ff', brightMagenta: '#d3b8ff',
    brightCyan: '#a3e0ff', brightWhite: '#f2f4f8',
  },
  light: {
    black: '#3d4351', red: '#b4232a', green: '#2c6e2f', yellow: '#7a5b00',
    blue: '#26539c', magenta: '#7a3b8f', cyan: '#166a75', white: '#e8eaf0',
    brightBlack: '#5a6070', brightRed: '#d13b43', brightGreen: '#3f8a43',
    brightYellow: '#9a7400', brightBlue: '#3a6bc4', brightMagenta: '#9a55b0',
    brightCyan: '#218a96', brightWhite: '#f7f8fb',
  },
};

export const THEMES = {
  dark: {
    id: 'dark',
    label: 'Dark',
    // Compact Ghostty-inspired: near-neutral background, terminal content the
    // highest-contrast element on screen, chrome receding behind it.
    background: '#101216',
    surface: '#171a20',
    surfaceRaised: '#1e222a',
    surfaceSunken: '#0b0d10',
    border: '#2a2f39',
    borderStrong: '#727b8b',
    foreground: '#e6e8ec',
    muted: '#9aa2af',
    subtle: '#8a92a2',
    accent: '#7aa2f7',
    accentForeground: '#0b0d10',
    success: '#9ece6a',
    warning: '#e0af68',
    danger: '#f07178',
    focusRing: '#9db8ff',
    selectionBackground: '#2f3a4d',
    cursor: '#e6e8ec',
    cursorAccent: '#101216',
    scrollbarThumb: '#333a45',
    ansi: ansi.dark,
  },
  light: {
    id: 'light',
    label: 'Light',
    background: '#fbfbfd',
    surface: '#f2f3f6',
    surfaceRaised: '#ffffff',
    surfaceSunken: '#e9ebf0',
    border: '#d6d9e0',
    borderStrong: '#7e8797',
    foreground: '#16181d',
    muted: '#4f5665',
    subtle: '#5f6673',
    accent: '#26539c',
    accentForeground: '#ffffff',
    success: '#2c6e2f',
    warning: '#7a5b00',
    danger: '#b4232a',
    focusRing: '#3a6bc4',
    selectionBackground: '#c9d7f0',
    cursor: '#16181d',
    cursorAccent: '#fbfbfd',
    scrollbarThumb: '#c2c6d0',
    ansi: ansi.light,
  },
};

// Every UI text/background pair that must clear AA (4.5:1), and every
// component-boundary pair that must clear 3:1. Asserted against these exact
// values by test/desktop-tokens.test.js.
//
// `border` is deliberately absent: it is decorative (a pane divider, which is
// also cued by the step between surface colours) and must never be the only way
// to identify a control. Interactive outlines use `borderStrong`, which is held
// to the 3:1 non-text threshold against every surface it can sit on.
export const CONTRAST_REQUIREMENTS = [
  { name: 'foreground on background', fg: 'foreground', bg: 'background', min: 4.5 },
  { name: 'foreground on surface', fg: 'foreground', bg: 'surface', min: 4.5 },
  { name: 'foreground on surfaceRaised', fg: 'foreground', bg: 'surfaceRaised', min: 4.5 },
  { name: 'muted on background', fg: 'muted', bg: 'background', min: 4.5 },
  { name: 'muted on surface', fg: 'muted', bg: 'surface', min: 4.5 },
  { name: 'muted on surfaceRaised', fg: 'muted', bg: 'surfaceRaised', min: 4.5 },
  { name: 'subtle on background', fg: 'subtle', bg: 'background', min: 4.5 },
  { name: 'subtle on surface', fg: 'subtle', bg: 'surface', min: 4.5 },
  { name: 'subtle on surfaceRaised', fg: 'subtle', bg: 'surfaceRaised', min: 4.5 },
  { name: 'accent on background', fg: 'accent', bg: 'background', min: 4.5 },
  { name: 'accent on surface', fg: 'accent', bg: 'surface', min: 4.5 },
  { name: 'accentForeground on accent', fg: 'accentForeground', bg: 'accent', min: 4.5 },
  { name: 'danger on background', fg: 'danger', bg: 'background', min: 4.5 },
  { name: 'danger on surface', fg: 'danger', bg: 'surface', min: 4.5 },
  { name: 'success on background', fg: 'success', bg: 'background', min: 4.5 },
  { name: 'warning on background', fg: 'warning', bg: 'background', min: 4.5 },
  // Non-text UI components: focus ring and interactive outlines convey state.
  { name: 'focusRing on background', fg: 'focusRing', bg: 'background', min: 3 },
  { name: 'focusRing on surface', fg: 'focusRing', bg: 'surface', min: 3 },
  { name: 'focusRing on surfaceRaised', fg: 'focusRing', bg: 'surfaceRaised', min: 3 },
  { name: 'borderStrong on background', fg: 'borderStrong', bg: 'background', min: 3 },
  { name: 'borderStrong on surface', fg: 'borderStrong', bg: 'surface', min: 3 },
  { name: 'borderStrong on surfaceRaised', fg: 'borderStrong', bg: 'surfaceRaised', min: 3 },
  { name: 'cursor on background', fg: 'cursor', bg: 'background', min: 3 },
];

// ANSI colours are terminal *content* rather than chrome, and the programme
// picks them without knowing the theme. 3:1 (the non-text / large-text
// threshold) is what they are held to.
//
// The light theme exempts white and brightWhite, and only there. A literal
// white foreground is invisible on a light background, but remapping it to a
// dark grey would break the far more common case of a programme that sets its
// own coloured background and then draws white text on it -- which is exactly
// what every light terminal theme in practice does too. This is a real
// readability hole for a light-theme programme that emits bare SGR 37/97 and
// sets no background; it is recorded as a known limitation rather than papered
// over by remapping the palette.
export const ANSI_CONTRAST_MIN = 3;
export const ANSI_CONTRAST_EXEMPT = Object.freeze({ light: ['white', 'brightWhite'] });

export const ANSI_KEYS = [
  'black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow',
  'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite',
];

export const PRESETS = Object.freeze({
  professional: {
    id: 'professional',
    label: 'Professional',
    description: 'Minimal chrome, transitions only. No mascot, no particles.',
    // Declared here so PR2 has a schema to fill in; PR1 stores and applies only
    // the switches below and renders no animation of its own.
    animation: { enabled: false, intensity: 0, mascot: false, particles: false, transitions: true },
  },
  living: {
    id: 'living',
    label: 'Living',
    description: 'Reactive mascot driven by session events. UI transitions on.',
    animation: { enabled: true, intensity: 0.6, mascot: true, particles: false, transitions: true },
  },
  immersive: {
    id: 'immersive',
    label: 'Immersive',
    description: 'Mascot plus optional particle effects. Heaviest preset.',
    animation: { enabled: true, intensity: 1, mascot: true, particles: true, transitions: true },
  },
});

export const PRESET_IDS = Object.freeze(Object.keys(PRESETS));

// Issue #7: "no essential status conveyed by animation alone". Every animated
// state also has a text label and an icon in the status bar, so animationOff is
// a presentation choice and never a loss of information.
export const ANIMATION_OFF = Object.freeze({
  enabled: false, intensity: 0, mascot: false, particles: false, transitions: false,
});

export function themeById(id) {
  return THEMES[id] ?? THEMES.dark;
}

// Flattens a theme into CSS custom properties. The UI applies exactly this map,
// so what the contrast test measured is what the browser renders.
export function themeToCssProperties(theme) {
  const properties = {};
  for (const [key, value] of Object.entries(theme)) {
    if (key === 'ansi' || key === 'label' || key === 'id') continue;
    properties[`--st-${kebab(key)}`] = value;
  }
  for (const [key, value] of Object.entries(theme.ansi)) {
    properties[`--st-ansi-${kebab(key)}`] = value;
  }
  return properties;
}

function kebab(name) {
  return name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`);
}

// xterm.js wants a flat theme object with camelCase ANSI names.
export function themeToXterm(theme) {
  return {
    background: theme.background,
    foreground: theme.foreground,
    cursor: theme.cursor,
    cursorAccent: theme.cursorAccent,
    selectionBackground: theme.selectionBackground,
    ...theme.ansi,
  };
}
