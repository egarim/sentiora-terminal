// Tests for the parts of the desktop app that need no process and no PTY:
// persistent settings (U13), theme contrast (U13), and shell selection (S1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDirectory, removeDirectory } from './helpers/desktop.mjs';
import {
  SettingsStore, validateSettings, resolveAnimation, DEFAULT_SETTINGS, SCHEMA_VERSION,
} from '../apps/desktop/bridge/settings.js';
import {
  THEMES, CONTRAST_REQUIREMENTS, ANSI_KEYS, ANSI_CONTRAST_MIN, ANSI_CONTRAST_EXEMPT,
  contrastRatio, themeToCssProperties, themeToXterm, PRESETS, PRESET_IDS,
} from '../apps/desktop/theme/tokens.js';
import {
  detectShells, defaultShell, validateCustomShell, resolveShell,
} from '../apps/desktop/bridge/shell-catalog.js';

const opts = { timeout: 30000 };

// --------------------------------------------------------------------- settings

test('settings round-trip through disk', opts, async () => {
  const dir = await temporaryDirectory();
  try {
    const path = join(dir, 'nested', 'settings.json');
    const store = new SettingsStore({ path });
    await store.load();
    assert.deepEqual(store.values, DEFAULT_SETTINGS, 'a missing file must yield the defaults');
    assert.equal(store.source, 'defaults');

    await store.updateAndSave({
      appearance: { themeSource: 'light', fontSize: 16 },
      animation: { preset: 'living', enabled: true, layers: { mascot: true } },
      shell: { id: 'cmd' },
      onboarding: { completed: true },
    });

    const reloaded = new SettingsStore({ path });
    await reloaded.load();
    assert.equal(reloaded.values.appearance.themeSource, 'light');
    assert.equal(reloaded.values.appearance.fontSize, 16);
    // Untouched leaves must survive a partial patch, which is what deep merge plus
    // per-leaf validation is for.
    assert.equal(reloaded.values.appearance.lineHeight, DEFAULT_SETTINGS.appearance.lineHeight);
    assert.equal(reloaded.values.animation.preset, 'living');
    assert.equal(reloaded.values.animation.enabled, true);
    assert.equal(reloaded.values.animation.layers.mascot, true);
    assert.equal(reloaded.values.animation.layers.transitions, DEFAULT_SETTINGS.animation.layers.transitions);
    assert.equal(reloaded.values.onboarding.completed, true);
    assert.equal(reloaded.source, path);
    assert.deepEqual(reloaded.warnings, [], `a clean round-trip must not warn: ${reloaded.warnings}`);
  } finally {
    await removeDirectory(dir);
  }
});

test('settings writes are atomic and leave no temporary files behind', opts, async () => {
  const dir = await temporaryDirectory();
  try {
    const path = join(dir, 'settings.json');
    const store = new SettingsStore({ path });
    await store.updateAndSave({ appearance: { fontSize: 18 } });
    const entries = await readFile(path, 'utf8');
    assert.equal(JSON.parse(entries).appearance.fontSize, 18);
    const { readdir } = await import('node:fs/promises');
    const leftovers = (await readdir(dir)).filter(name => name !== 'settings.json');
    assert.deepEqual(leftovers, [], `atomic write left debris: ${leftovers}`);
  } finally {
    await removeDirectory(dir);
  }
});

test('a corrupt settings file is quarantined, not deleted, and defaults are used', opts, async () => {
  const dir = await temporaryDirectory();
  try {
    const path = join(dir, 'settings.json');
    await writeFile(path, '{ this is not json', 'utf8');
    const store = new SettingsStore({ path });
    const values = await store.load();
    assert.deepEqual(values, DEFAULT_SETTINGS, 'a corrupt file must fall back to defaults');
    assert.equal(store.source, 'defaults');
    assert.ok(store.warnings.some(w => /not valid JSON/.test(w)), `expected a JSON warning, got ${store.warnings}`);
    const { readdir } = await import('node:fs/promises');
    const quarantined = (await readdir(dir)).filter(name => name.startsWith('settings.json.corrupt-'));
    assert.equal(quarantined.length, 1, 'the original must be kept for manual recovery');
    assert.equal(await readFile(join(dir, quarantined[0]), 'utf8'), '{ this is not json');
  } finally {
    await removeDirectory(dir);
  }
});

test('invalid and unknown settings values fall back to defaults with a warning', opts, async () => {
  const dir = await temporaryDirectory();
  try {
    const path = join(dir, 'settings.json');
    await writeFile(path, JSON.stringify({
      appearance: { themeSource: 'neon', fontSize: 9999, fontFamily: 42, lineHeight: 1.2 },
      animation: { preset: 'does-not-exist', enabled: 'yes', intensity: 4 },
      layout: { tabs: 'not-an-array' },
      fromTheFuture: { whatever: true },
      shell: { id: 'x'.repeat(500) },
    }), 'utf8');
    const store = new SettingsStore({ path });
    const values = await store.load();

    assert.equal(values.appearance.themeSource, DEFAULT_SETTINGS.appearance.themeSource);
    assert.equal(values.appearance.fontSize, DEFAULT_SETTINGS.appearance.fontSize);
    assert.equal(values.appearance.fontFamily, DEFAULT_SETTINGS.appearance.fontFamily);
    // A valid sibling in the same object must survive its neighbours' invalidity.
    assert.equal(values.appearance.lineHeight, 1.2);
    assert.equal(values.animation.preset, DEFAULT_SETTINGS.animation.preset);
    assert.equal(values.animation.enabled, false);
    assert.equal(values.animation.intensity, DEFAULT_SETTINGS.animation.intensity);
    assert.deepEqual(values.layout.tabs, []);
    assert.equal(values.shell.id, DEFAULT_SETTINGS.shell.id, 'an over-long shell id must be rejected, not truncated');
    assert.ok(!('fromTheFuture' in values), 'unknown top-level keys must be dropped');
    assert.ok(store.warnings.some(w => /fromTheFuture/.test(w)), 'dropped keys must be reported');
    assert.equal(values.schemaVersion, SCHEMA_VERSION);
  } finally {
    await removeDirectory(dir);
  }
});

test('a non-object settings document is replaced wholesale', opts, async () => {
  for (const bad of [42, 'nope', null, [1, 2, 3]]) {
    const { settings, warnings } = validateSettings(bad);
    assert.deepEqual(settings, DEFAULT_SETTINGS, `${JSON.stringify(bad)} should reset to defaults`);
    assert.ok(warnings.length > 0 || bad === null, `${JSON.stringify(bad)} should warn`);
  }
});

test('a bad patch cannot put the store into an unloadable state', opts, async () => {
  const dir = await temporaryDirectory();
  try {
    const path = join(dir, 'settings.json');
    const store = new SettingsStore({ path });
    store.update({ appearance: { fontSize: 18, themeSource: 'light' } });
    // An invalid leaf must be dropped, not defaulted: resetting themeSource to
    // 'system' because fontSize was bad would be a much worse failure than
    // ignoring the typo.
    const result = await store.updateAndSave({ appearance: { fontSize: -5 }, animation: { preset: 'bogus' } });
    assert.equal(result.values.appearance.fontSize, 18, 'an invalid patch value must leave the stored one alone');
    assert.equal(result.values.appearance.themeSource, 'light');
    assert.equal(result.values.animation.preset, DEFAULT_SETTINGS.animation.preset);
    assert.ok(result.warnings.some(w => /fontSize/.test(w)), `expected a fontSize warning, got ${result.warnings}`);
    assert.ok(result.warnings.some(w => /preset/.test(w)), `expected a preset warning, got ${result.warnings}`);

    const reloaded = new SettingsStore({ path });
    await reloaded.load();
    assert.equal(reloaded.values.appearance.fontSize, 18);
    assert.throws(() => store.update('not-an-object'), /plain object/);
  } finally {
    await removeDirectory(dir);
  }
});

test('settings changes notify subscribers with a copy, not a live reference', opts, async () => {
  const dir = await temporaryDirectory();
  try {
    const store = new SettingsStore({ path: join(dir, 'settings.json') });
    const seen = [];
    const unsubscribe = store.subscribe(values => seen.push(values));
    store.update({ appearance: { fontSize: 20 } });
    assert.equal(seen.length, 1);
    assert.equal(seen[0].appearance.fontSize, 20);
    // Mutating a handed-out copy must not reach the store.
    seen[0].appearance.fontSize = 99;
    assert.equal(store.values.appearance.fontSize, 20);
    unsubscribe();
    store.update({ appearance: { fontSize: 21 } });
    assert.equal(seen.length, 1, 'an unsubscribed listener must stop being called');
  } finally {
    await removeDirectory(dir);
  }
});

// -------------------------------------------------------------------- animation

test('the animation off switch beats every preset', opts, () => {
  for (const preset of PRESET_IDS) {
    const resolved = resolveAnimation({
      animation: {
        preset, enabled: false, intensity: 1, respectSystemReducedMotion: false,
        layers: { mascot: true, particles: true, transitions: true },
      },
    });
    assert.equal(resolved.enabled, false, `${preset} must stay off when the switch is off`);
    assert.equal(resolved.mascot, false);
    assert.equal(resolved.particles, false);
    assert.equal(resolved.transitions, false);
    assert.equal(resolved.reason, 'disabled');
    assert.equal(resolved.effectivePreset, 'professional');
  }
});

test('the system reduced-motion preference beats an enabled preset', opts, () => {
  const settings = {
    animation: {
      preset: 'immersive', enabled: true, intensity: 1, respectSystemReducedMotion: true,
      layers: { mascot: true, particles: true, transitions: true },
    },
  };
  const reduced = resolveAnimation(settings, { systemReducedMotion: true });
  assert.equal(reduced.enabled, false);
  assert.equal(reduced.reason, 'system-reduced-motion');

  // Opting out of respecting the OS preference is an explicit user choice.
  const ignoring = resolveAnimation(
    { ...settings, animation: { ...settings.animation, respectSystemReducedMotion: false } },
    { systemReducedMotion: true },
  );
  assert.equal(ignoring.enabled, true);
  assert.equal(ignoring.effectivePreset, 'immersive');
});

test('preset layers are intersected with the user layer toggles', opts, () => {
  const base = { enabled: true, intensity: 1, respectSystemReducedMotion: false, preset: 'immersive' };
  const noParticles = resolveAnimation({
    animation: { ...base, layers: { mascot: true, particles: false, transitions: true } },
  });
  assert.equal(noParticles.particles, false, 'immersive must not force particles on');
  assert.equal(noParticles.mascot, true);

  const scaled = resolveAnimation({ animation: { ...base, intensity: 0.5, layers: { mascot: true, particles: true, transitions: true } } });
  assert.equal(scaled.intensity, PRESETS.immersive.animation.intensity * 0.5);

  // An unknown preset must fall back rather than throw: #7 requires a safe
  // fallback for anything malformed.
  const unknown = resolveAnimation({ animation: { ...base, preset: 'nope', layers: { mascot: true, particles: true, transitions: true } } });
  assert.equal(unknown.preset, 'professional');
});

// ------------------------------------------------------------------- contrast

test('both themes meet WCAG AA for UI text and 3:1 for component boundaries (U13)', opts, () => {
  const failures = [];
  for (const themeId of Object.keys(THEMES)) {
    const theme = THEMES[themeId];
    for (const requirement of CONTRAST_REQUIREMENTS) {
      const ratio = contrastRatio(theme[requirement.fg], theme[requirement.bg]);
      if (ratio < requirement.min) {
        failures.push(`${themeId}: ${requirement.name} = ${ratio.toFixed(2)}, needs ${requirement.min}`);
      }
    }
  }
  assert.deepEqual(failures, [], `contrast requirements failed:\n${failures.join('\n')}`);
});

test('ANSI colours clear 3:1 against the terminal background', opts, () => {
  const failures = [];
  const report = [];
  for (const themeId of Object.keys(THEMES)) {
    const theme = THEMES[themeId];
    const exempt = ANSI_CONTRAST_EXEMPT[themeId] ?? [];
    for (const key of ANSI_KEYS) {
      const ratio = contrastRatio(theme.ansi[key], theme.background);
      report.push(`${themeId} ${key} ${ratio.toFixed(2)}`);
      // The light-theme white exemption is documented in tokens.js: a literal
      // white is invisible on a light background, and remapping it would break
      // programmes that set their own background and then draw white on it.
      if (exempt.includes(key)) continue;
      if (ratio < ANSI_CONTRAST_MIN) {
        failures.push(`${themeId} ansi.${key} = ${ratio.toFixed(2)}, needs ${ANSI_CONTRAST_MIN}`);
      }
    }
  }
  assert.deepEqual(failures, [], `ANSI contrast failed:\n${failures.join('\n')}\nall: ${report.join(', ')}`);
});

test('theme tokens flatten into CSS custom properties the UI actually applies', opts, () => {
  for (const themeId of Object.keys(THEMES)) {
    const properties = themeToCssProperties(THEMES[themeId]);
    assert.ok(Object.keys(properties).length > 15, 'a theme must produce a real set of properties');
    assert.ok('--st-background' in properties);
    assert.ok('--st-foreground' in properties);
    assert.ok('--st-focus-ring' in properties, 'camelCase must become kebab-case');
    assert.ok('--st-ansi-bright-black' in properties);
    for (const [name, value] of Object.entries(properties)) {
      assert.match(name, /^--st-[a-z0-9-]+$/, `bad property name ${name}`);
      assert.match(value, /^#[0-9a-f]{6}$/i, `${name} is not a hex colour: ${value}`);
    }
    // The xterm.js theme must cover the 16 ANSI colours plus the basics.
    const xterm = themeToXterm(THEMES[themeId]);
    for (const key of ['background', 'foreground', 'cursor', 'selectionBackground', ...ANSI_KEYS]) {
      assert.match(xterm[key], /^#[0-9a-f]{6}$/i, `xterm theme is missing ${key}`);
    }
  }
});

test('contrastRatio and relativeLuminance behave on known values', opts, () => {
  assert.equal(contrastRatio('#000000', '#ffffff'), 21, 'black on white is the maximum ratio');
  assert.equal(Number(contrastRatio('#ffffff', '#ffffff').toFixed(3)), 1);
  assert.equal(Number(contrastRatio('#777777', '#777777').toFixed(3)), 1);
  // Order must not matter.
  assert.equal(contrastRatio('#101216', '#e6e8ec'), contrastRatio('#e6e8ec', '#101216'));
  assert.throws(() => contrastRatio('not-a-colour', '#ffffff'), /not a hex colour/);
});

// --------------------------------------------------------------- shell catalog

test('the shell catalog only reports shells that exist', opts, () => {
  const shells = detectShells();
  assert.ok(shells.length > 0, 'every CI platform must have at least one usable shell');
  for (const shell of shells) {
    assert.equal(shell.available, true);
    assert.ok(shell.command.length > 0);
    assert.ok(shell.probe?.command, `${shell.id} must declare a probe so U01 can drive it`);
    assert.ok(shell.probe.expect.length > 0);
    assert.ok(['powershell', 'cmd', 'bash', 'zsh', 'sh', 'fish', 'wsl'].includes(shell.family), `unexpected family ${shell.family}`);
    assert.ok(Array.isArray(shell.args));
  }
  const chosen = defaultShell(shells);
  assert.ok(chosen, 'a default shell must be resolvable');
  assert.ok(shells.includes(chosen));
});

test('a custom shell must be an absolute path to an existing file', opts, async () => {
  assert.equal(validateCustomShell('').ok, false);
  assert.equal(validateCustomShell(null).ok, false);
  assert.equal(validateCustomShell(42).ok, false);
  // Relative names are refused: they would be resolved against whatever PATH the
  // runtime host happens to have, which is not what the user picked.
  const relative = validateCustomShell('cmd.exe');
  assert.equal(relative.ok, false);
  assert.match(relative.reason, /absolute/);

  const missing = validateCustomShell(process.platform === 'win32' ? 'C:\\definitely\\not\\here.exe' : '/definitely/not/here');
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /no such file/);

  const dir = await temporaryDirectory();
  try {
    const asDirectory = validateCustomShell(dir);
    assert.equal(asDirectory.ok, false);
    assert.match(asDirectory.reason, /not a regular file/);

    const file = join(dir, 'shell.exe');
    await writeFile(file, 'not really a shell', 'utf8');
    const ok = validateCustomShell(file);
    assert.equal(ok.ok, true, ok.reason ?? 'an existing absolute file must be accepted');
    assert.equal(ok.shell.command, file);
    assert.equal(ok.shell.custom, true);

    // On Windows a non-executable extension fails deep inside CreateProcess as
    // "error code: 193", which tells the user nothing. Refuse it up front instead.
    const script = join(dir, 'shell.mjs');
    await writeFile(script, 'not an executable', 'utf8');
    const scriptResult = validateCustomShell(script);
    if (process.platform === 'win32') {
      assert.equal(scriptResult.ok, false, 'a .mjs file is not spawnable on Windows');
      assert.match(scriptResult.reason, /not an executable type on Windows/);
    }

    // An extensionless file may still be a valid executable on every platform, so
    // it must not be rejected on extension grounds.
    const extensionless = join(dir, 'shell');
    await writeFile(extensionless, 'x', 'utf8');
    const bare = validateCustomShell(extensionless);
    assert.equal(bare.ok, true, bare.reason ?? 'an extensionless executable must be accepted');
  } finally {
    await removeDirectory(dir);
  }
});

test('a persisted shell selection that has gone away falls back to detection', opts, () => {
  const shells = detectShells();
  const byId = resolveShell({ shell: { id: shells[0].id } }, shells);
  assert.equal(byId.resolvedBy, 'id');
  assert.equal(byId.shell.id, shells[0].id);

  const vanished = resolveShell({ shell: { id: 'uninstalled-shell' } }, shells);
  assert.equal(vanished.resolvedBy, 'default', 'a missing shell must not fail the launch');
  assert.ok(vanished.shell);

  const auto = resolveShell({ shell: { id: 'auto' } }, shells);
  assert.equal(auto.resolvedBy, 'default');

  const none = resolveShell({ shell: { id: 'auto' } }, []);
  assert.equal(none.resolvedBy, 'none');
  assert.equal(none.shell, null);
});

test('a stored custom command is re-validated on every launch', opts, async () => {
  const dir = await temporaryDirectory();
  try {
    const file = join(dir, 'custom-shell');
    await writeFile(file, 'x', 'utf8');
    const good = resolveShell({ shell: { id: 'custom', command: file, args: ['--login'] } }, []);
    assert.equal(good.resolvedBy, 'command');
    assert.deepEqual(good.shell.args, ['--login']);

    await writeFile(file, '', 'utf8');
    const { rm } = await import('node:fs/promises');
    await rm(file);
    // The path was valid when saved and is not now: fall back instead of spawning
    // something that does not exist.
    const bad = resolveShell({ shell: { id: 'custom', command: file } }, detectShells());
    assert.notEqual(bad.resolvedBy, 'command');
  } finally {
    await removeDirectory(dir);
  }
});

test('the settings directory is created on first save', opts, async () => {
  const dir = await temporaryDirectory();
  try {
    const deep = join(dir, 'a', 'b', 'c', 'settings.json');
    const store = new SettingsStore({ path: deep });
    await store.save();
    assert.ok(existsSync(deep), 'save() must create the settings directory');
    assert.deepEqual(JSON.parse(await readFile(deep, 'utf8')).schemaVersion, SCHEMA_VERSION);
  } finally {
    await removeDirectory(dir);
  }
});
