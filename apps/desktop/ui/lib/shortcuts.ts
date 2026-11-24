/**
 * Keyboard shortcuts.
 *
 * Chosen as Alt-based chords on purpose. Ctrl+Shift+T, Ctrl+Shift+W, Ctrl+Tab,
 * Ctrl+1..9 and Alt+Left/Right are reserved by browsers and cannot be intercepted
 * by a page, which matters because the browser is the documented fallback for the
 * missing Tauri toolchain. Inside a packaged webview these would all be ours, but
 * a shortcut set that only works after packaging would be untestable today.
 *
 * Every action also has a focusable button in the UI, so keyboard-only operation
 * (U07) does not depend on a shortcut surviving the browser's own bindings.
 */

export type ShortcutAction =
  | 'newTab'
  | 'closePane'
  | 'prevTab'
  | 'nextTab'
  | 'splitRight'
  | 'splitDown'
  | 'focusUp'
  | 'focusDown'
  | 'focusLeft'
  | 'focusRight'
  | 'toggleHistory'
  | 'toggleSettings'
  | 'showShortcuts';

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

export interface Shortcut {
  action: ShortcutAction;
  label: string;
  /** Human-readable chord, for the shortcuts dialog. */
  keys: string;
  match(event: KeyLike): boolean;
}

/** Alt + a physical key, with no other modifier held. `code` keeps it layout-independent. */
function alt(code: string, key: string): (event: KeyLike) => boolean {
  return event => event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    && ((event.code ?? '') === code || event.key.toLowerCase() === key.toLowerCase());
}

/** Alt + Shift + an arrow key, for spatial movement between panes. */
function altShiftArrow(key: string): (event: KeyLike) => boolean {
  return event => event.altKey && event.shiftKey && !event.ctrlKey && !event.metaKey && event.key === key;
}

export const SHORTCUTS: Shortcut[] = [
  { action: 'newTab', label: 'New tab', keys: 'Alt+T', match: alt('KeyT', 't') },
  { action: 'closePane', label: 'Close pane (or tab when only one pane)', keys: 'Alt+W', match: alt('KeyW', 'w') },
  { action: 'prevTab', label: 'Previous tab', keys: 'Alt+[', match: event => event.altKey && !event.ctrlKey && !event.metaKey && event.key === '[' },
  { action: 'nextTab', label: 'Next tab', keys: 'Alt+]', match: event => event.altKey && !event.ctrlKey && !event.metaKey && event.key === ']' },
  { action: 'splitRight', label: 'Split pane right', keys: 'Alt+D', match: alt('KeyD', 'd') },
  { action: 'splitDown', label: 'Split pane down', keys: 'Alt+E', match: alt('KeyE', 'e') },
  { action: 'focusLeft', label: 'Focus pane to the left', keys: 'Alt+Shift+Left', match: altShiftArrow('ArrowLeft') },
  { action: 'focusRight', label: 'Focus pane to the right', keys: 'Alt+Shift+Right', match: altShiftArrow('ArrowRight') },
  { action: 'focusUp', label: 'Focus pane above', keys: 'Alt+Shift+Up', match: altShiftArrow('ArrowUp') },
  { action: 'focusDown', label: 'Focus pane below', keys: 'Alt+Shift+Down', match: altShiftArrow('ArrowDown') },
  { action: 'toggleHistory', label: 'Toggle recovered history panel', keys: 'Alt+H', match: alt('KeyH', 'h') },
  { action: 'toggleSettings', label: 'Toggle settings panel', keys: 'Alt+S', match: alt('KeyS', 's') },
  { action: 'showShortcuts', label: 'Keyboard shortcuts', keys: 'F1', match: event => event.key === 'F1' && !event.ctrlKey && !event.altKey && !event.metaKey },
];

export function matchShortcut(event: KeyLike): Shortcut | null {
  for (const shortcut of SHORTCUTS) {
    if (shortcut.match(event)) return shortcut;
  }
  return null;
}

/**
 * Used as xterm.js's custom key event handler. Returning false stops the terminal
 * from treating the chord as input, which is what keeps Alt+T from reaching the
 * shell as an escape sequence.
 */
export function isAppShortcut(event: KeyboardEvent): boolean {
  return matchShortcut(event) !== null;
}
