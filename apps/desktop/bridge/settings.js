// Persistent settings for the Living Terminal UI (issue #7, U13).
//
// Stored as one JSON document written atomically, validated against a schema on
// every read, and merged over defaults so a file written by an older or newer
// build degrades instead of failing. A malformed file is quarantined and replaced
// with defaults rather than throwing at startup -- the app must still open.
//
// The animation section is plumbing only in PR1: it stores a preset id, the
// global off switch, an intensity multiplier and per-layer toggles, and nothing
// renders them yet. PR2 fills in the motion/Rive work behind exactly these keys.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { PRESET_IDS, PRESETS, ANIMATION_OFF } from '../theme/tokens.js';

export const SCHEMA_VERSION = 1;

export const THEME_SOURCES = ['system', 'light', 'dark'];
export const THEME_IDS = ['light', 'dark'];
export const SPLIT_DIRECTIONS = ['horizontal', 'vertical'];

export const DEFAULT_SETTINGS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  appearance: {
    // 'system' follows the OS colour scheme; 'light'/'dark' pin it.
    themeSource: 'system',
    fontSize: 13,
    fontFamily: 'Cascadia Mono, Menlo, Consolas, "DejaVu Sans Mono", monospace',
    lineHeight: 1.2,
    cursorBlink: true,
    // Renderer scrollback, distinct from the bridge's recovered scroll ring.
    scrollbackLines: 2000,
  },
  animation: {
    preset: 'professional',
    // The global animation-off switch required by #7. When false every layer is
    // off regardless of preset. Defaults to off: the Professional preset is the
    // accessible baseline and animation has to be opted into.
    enabled: false,
    // User multiplier on the preset's own intensity, not an absolute value.
    intensity: 1,
    respectSystemReducedMotion: true,
    layers: { mascot: false, particles: false, transitions: true },
  },
  shell: {
    // 'auto' resolves through shell-catalog.js; an explicit entry is used as-is.
    id: 'auto',
    command: null,
    args: [],
    cwd: null,
  },
  layout: {
    // Which tabs to reopen, not the split geometry: a split tree restored around
    // sessions that no longer exist is a worse first frame than a single pane.
    restoreTabs: true,
    tabs: [],
  },
  accessibility: {
    // xterm's screen-reader mode renders the viewport as an accessible tree instead of canvas-only
    // pixels. Off by default because it costs a DOM row per line; a screen-reader user turns it on.
    // The interaction tests drive this same switch rather than a test-only hook.
    screenReaderMode: false,
  },
  onboarding: { completed: false },
});

const TAB_ITEM = {
  type: 'object',
  shape: {
    id: { type: 'string', maxLength: 64 },
    title: { type: 'string', maxLength: 120 },
    shellId: { type: 'string', maxLength: 64 },
    splitDirection: { type: 'string', enum: SPLIT_DIRECTIONS },
  },
};

// Schema descriptors: {type} plus optional enum/min/max/maxLength/items.
// Anything not described is dropped and reported, so a stray key from a future
// build cannot silently reach the UI.
const SCHEMA = {
  schemaVersion: { type: 'integer', min: 1, max: 999 },
  appearance: {
    type: 'object',
    shape: {
      themeSource: { type: 'string', enum: THEME_SOURCES },
      fontSize: { type: 'number', min: 6, max: 72 },
      fontFamily: { type: 'string', maxLength: 200 },
      lineHeight: { type: 'number', min: 0.8, max: 3 },
      cursorBlink: { type: 'boolean' },
      scrollbackLines: { type: 'integer', min: 0, max: 100000 },
    },
  },
  animation: {
    type: 'object',
    shape: {
      preset: { type: 'string', enum: PRESET_IDS },
      enabled: { type: 'boolean' },
      intensity: { type: 'number', min: 0, max: 1 },
      respectSystemReducedMotion: { type: 'boolean' },
      layers: {
        type: 'object',
        shape: {
          mascot: { type: 'boolean' },
          particles: { type: 'boolean' },
          transitions: { type: 'boolean' },
        },
      },
    },
  },
  shell: {
    type: 'object',
    shape: {
      id: { type: 'string', maxLength: 64 },
      command: { type: 'string|null', maxLength: 1024 },
      args: { type: 'array', items: { type: 'string', maxLength: 1024 }, maxItems: 32 },
      cwd: { type: 'string|null', maxLength: 1024 },
    },
  },
  layout: {
    type: 'object',
    shape: {
      restoreTabs: { type: 'boolean' },
      tabs: { type: 'array', items: TAB_ITEM, maxItems: 64 },
    },
  },
  accessibility: {
    type: 'object',
    shape: { screenReaderMode: { type: 'boolean' } },
  },
  onboarding: { type: 'object', shape: { completed: { type: 'boolean' } } },
};

// Flattened defaults, so a partially valid nested object fills its missing leaves
// from DEFAULT_SETTINGS instead of from undefined. Object-valued paths are kept
// too, which is what makes a wholly missing section come back whole.
const DEFAULT_BY_PATH = (() => {
  const flat = {};
  const walk = (node, prefix) => {
    for (const [key, value] of Object.entries(node)) {
      const path = prefix ? `${prefix}.${key}` : key;
      flat[path] = value;
      if (value && typeof value === 'object' && !Array.isArray(value)) walk(value, path);
    }
  };
  walk(DEFAULT_SETTINGS, '');
  return flat;
})();

function defaultFor(path) {
  return path in DEFAULT_BY_PATH ? structuredClone(DEFAULT_BY_PATH[path]) : undefined;
}

function checkValue(value, spec, path, warnings) {
  const [type] = spec.type.split('|');
  const nullable = spec.type.includes('null');
  if (value === null || value === undefined) {
    if (nullable) return null;
    warnings.push(`${path}: expected ${spec.type}, got ${value === null ? 'null' : 'missing'}`);
    return undefined;
  }
  switch (type) {
    case 'boolean':
      if (typeof value === 'boolean') return value;
      break;
    case 'integer':
      if (!Number.isSafeInteger(value)) break;
      if (spec.min !== undefined && value < spec.min) break;
      if (spec.max !== undefined && value > spec.max) break;
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) break;
      if (spec.min !== undefined && value < spec.min) break;
      if (spec.max !== undefined && value > spec.max) break;
      return value;
    case 'string':
      if (typeof value !== 'string') break;
      if (spec.maxLength !== undefined && value.length > spec.maxLength) break;
      if (spec.enum && !spec.enum.includes(value)) break;
      return value;
    case 'array': {
      if (!Array.isArray(value)) break;
      let items = value;
      if (spec.maxItems !== undefined && items.length > spec.maxItems) {
        warnings.push(`${path}: ${items.length} items exceeds maxItems ${spec.maxItems}; truncated`);
        items = items.slice(0, spec.maxItems);
      }
      if (!spec.items) return items;
      const kept = [];
      items.forEach((item, index) => {
        const checked = checkValue(item, spec.items, `${path}[${index}]`, warnings);
        if (checked !== undefined) kept.push(checked);
      });
      return kept;
    }
    case 'object':
      if (typeof value !== 'object' || Array.isArray(value)) break;
      return mergeShape(value, spec.shape, path, warnings);
    default:
      return undefined;
  }
  warnings.push(`${path}: ${truncate(value)} is not a valid ${spec.type}${spec.enum ? ` (${spec.enum.join('|')})` : ''}`);
  return undefined;
}

function truncate(value) {
  const text = JSON.stringify(value) ?? String(value);
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

function mergeShape(input, shape, basePath, warnings) {
  const out = {};
  for (const [key, spec] of Object.entries(shape)) {
    const path = basePath ? `${basePath}.${key}` : key;
    if (key in input) {
      const checked = checkValue(input[key], spec, path, warnings);
      if (checked !== undefined) { out[key] = checked; continue; }
    }
    const fallback = defaultFor(path);
    out[key] = fallback !== undefined ? fallback : checkValue(undefined, { ...spec, type: spec.type.includes('null') ? spec.type : `${spec.type}|null` }, path, []);
  }
  for (const key of Object.keys(input)) {
    if (!(key in shape)) warnings.push(`${basePath ? `${basePath}.` : ''}${key}: unknown setting; ignored`);
  }
  return out;
}

export function validateSettings(input) {
  const warnings = [];
  const isObject = input !== null && typeof input === 'object' && !Array.isArray(input);
  if (input !== undefined && !isObject) {
    warnings.push(`settings document was ${Array.isArray(input) ? 'an array' : typeof input}; replaced with defaults`);
  }
  const merged = mergeShape(isObject ? input : {}, SCHEMA, '', warnings);
  // Informational today; a future migration would branch on the stored value.
  merged.schemaVersion = SCHEMA_VERSION;
  return { settings: merged, warnings };
}

// Prunes a *patch* rather than filling it in. Loading a document substitutes
// defaults for anything invalid, but applying a patch must not: a typo in one
// field would otherwise silently reset unrelated settings the user had chosen.
// Invalid leaves are dropped and reported, leaving the stored value untouched.
function pruneValue(value, spec, path, warnings) {
  const [type] = spec.type.split('|');
  const nullable = spec.type.includes('null');
  const reject = detail => {
    warnings.push(`${path}: ${detail}; existing value kept`);
    return undefined;
  };
  if (value === undefined) return undefined;
  if (value === null) return nullable ? null : reject('expected a non-null value');
  if (type === 'object') {
    if (typeof value !== 'object' || Array.isArray(value)) return reject('expected an object');
    return pruneShape(value, spec.shape, path, warnings);
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return reject('expected an array');
    let items = value;
    if (spec.maxItems !== undefined && items.length > spec.maxItems) {
      warnings.push(`${path}: ${items.length} items exceeds maxItems ${spec.maxItems}; truncated`);
      items = items.slice(0, spec.maxItems);
    }
    if (!spec.items) return items;
    const kept = [];
    items.forEach((item, index) => {
      const pruned = pruneValue(item, spec.items, `${path}[${index}]`, warnings);
      if (pruned !== undefined) kept.push(pruned);
    });
    return kept;
  }
  // checkValue warns and returns undefined for anything out of range.
  return checkValue(value, spec, path, warnings);
}

function pruneShape(input, shape, basePath, warnings) {
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const path = basePath ? `${basePath}.${key}` : key;
    const spec = shape[key];
    if (!spec) {
      warnings.push(`${path}: unknown setting; ignored`);
      continue;
    }
    const pruned = pruneValue(value, spec, path, warnings);
    if (pruned !== undefined) out[key] = pruned;
  }
  return out;
}

export function pruneSettingsPatch(patch) {
  const warnings = [];
  const pruned = pruneShape(patch, SCHEMA, '', warnings);
  return { patch: pruned, warnings };
}

export function defaultSettingsPath() {
  if (process.env.SENTIORA_DESKTOP_SETTINGS) return process.env.SENTIORA_DESKTOP_SETTINGS;
  const home = homedir();
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'sentiora-terminal', 'settings.json');
  }
  if (process.platform === 'darwin') {
    return join(home, 'Library', 'Application Support', 'sentiora-terminal', 'settings.json');
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(home, '.config'), 'sentiora-terminal', 'settings.json');
}

export class SettingsStore {
  #path;
  #settings;
  #listeners = new Set();

  constructor({ path = defaultSettingsPath() } = {}) {
    this.#path = path;
    this.#settings = structuredClone(DEFAULT_SETTINGS);
    this.warnings = [];
    this.source = 'defaults';
  }

  get path() {
    return this.#path;
  }

  // Copy on the way out so a caller cannot mutate the store behind its back.
  get values() {
    return structuredClone(this.#settings);
  }

  async load() {
    this.warnings = [];
    let raw;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') this.warnings.push(`could not read ${this.#path}: ${error.message}`);
      this.source = 'defaults';
      return this.values;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      // Quarantine rather than delete: the user's settings may be recoverable by
      // hand, and silently discarding them would be worse than a warning.
      const quarantined = `${this.#path}.corrupt-${Date.now()}`;
      try {
        await rename(this.#path, quarantined);
        this.warnings.push(`settings were not valid JSON (${error.message}); moved to ${quarantined} and replaced with defaults`);
      } catch {
        this.warnings.push(`settings were not valid JSON (${error.message}); replaced with defaults`);
      }
      this.#settings = structuredClone(DEFAULT_SETTINGS);
      this.source = 'defaults';
      return this.values;
    }
    const { settings, warnings } = validateSettings(parsed);
    this.warnings = warnings;
    this.#settings = settings;
    this.source = this.#path;
    return this.values;
  }

  // Partial deep update. Invalid leaves are dropped rather than defaulted, so a
  // bad patch can neither corrupt the stored document nor reset unrelated
  // settings; the result is re-validated so it always loads cleanly next time.
  update(patch) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new Error('settings patch must be a plain object');
    }
    const { patch: cleaned, warnings } = pruneSettingsPatch(patch);
    const { settings, warnings: mergeWarnings } = validateSettings(deepMerge(this.#settings, cleaned));
    this.#settings = settings;
    this.warnings = [...warnings, ...mergeWarnings];
    for (const listener of this.#listeners) listener(this.values);
    return { values: this.values, warnings: this.warnings };
  }

  async save() {
    await mkdir(dirname(this.#path), { recursive: true });
    // Atomic: a crash mid-write must not leave a truncated document that the next
    // launch quarantines as corrupt.
    const temporary = `${this.#path}.${process.pid}-${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#settings, null, 2)}\n`, 'utf8');
    await rename(temporary, this.#path);
    this.source = this.#path;
    return this.#path;
  }

  async updateAndSave(patch) {
    const result = this.update(patch);
    await this.save();
    return result;
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const isNestedObject = value && typeof value === 'object' && !Array.isArray(value);
    const baseIsObject = base && typeof base[key] === 'object' && base[key] !== null && !Array.isArray(base[key]);
    out[key] = isNestedObject && baseIsObject ? deepMerge(base[key], value) : value;
  }
  return out;
}

// Applies a preset, then the user's switches. The global off switch and the OS
// reduced-motion preference both win over the preset: turning animation off must
// never be undone by choosing a preset afterwards, and #7 requires respecting
// reduced motion.
export function resolveAnimation(settings, { systemReducedMotion = false } = {}) {
  const preset = PRESETS[settings.animation.preset] ?? PRESETS.professional;
  const reduced = settings.animation.respectSystemReducedMotion && systemReducedMotion;
  if (!settings.animation.enabled || reduced) {
    return {
      ...ANIMATION_OFF,
      preset: preset.id,
      effectivePreset: 'professional',
      reason: settings.animation.enabled ? 'system-reduced-motion' : 'disabled',
    };
  }
  return {
    preset: preset.id,
    effectivePreset: preset.id,
    reason: 'enabled',
    enabled: true,
    intensity: preset.animation.intensity * settings.animation.intensity,
    mascot: preset.animation.mascot && settings.animation.layers.mascot,
    particles: preset.animation.particles && settings.animation.layers.particles,
    transitions: preset.animation.transitions && settings.animation.layers.transitions,
  };
}
