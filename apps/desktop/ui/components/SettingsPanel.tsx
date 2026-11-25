import { useId, useState } from 'react';
import type { ResolvedAnimation, Settings, Shell } from '../lib/types';

interface Props {
  settings: Settings;
  warnings: string[];
  path: string;
  shells: Shell[];
  animation: ResolvedAnimation | null;
  onChange: (patch: Partial<Settings>) => void;
  onClose: () => void;
}

/**
 * Settings panel (issue #7 S6 plumbing, persisted for U13).
 *
 * The animation controls are real and persisted, but nothing animates in PR1: the
 * preset, the global off switch and the per-layer toggles are the contract PR2
 * fills in. The resolved values are shown so it is obvious what the backend
 * actually decided, including when the OS reduced-motion preference overrides it.
 */
export function SettingsPanel({ settings, warnings, path, shells, animation, onChange, onClose }: Props) {
  const id = useId();
  const [customShell, setCustomShell] = useState('');

  const patchAppearance = (patch: Partial<Settings['appearance']>) => onChange({ appearance: { ...settings.appearance, ...patch } });
  const patchAnimation = (patch: Partial<Settings['animation']>) => onChange({ animation: { ...settings.animation, ...patch } });
  const patchLayers = (patch: Partial<Settings['animation']['layers']>) =>
    onChange({ animation: { ...settings.animation, layers: { ...settings.animation.layers, ...patch } } });

  return (
    <aside className="settings" role="complementary" aria-label="Settings">
      <header className="settings__head">
        <h2 id={`${id}-title`}>Settings</h2>
        <button type="button" className="button button--ghost" onClick={onClose}>Close settings</button>
      </header>

      {warnings.length > 0 ? (
        <div className="banner banner--warn" role="status">
          <strong>Some saved values were reset.</strong>
          <ul>{warnings.map(warning => <li key={warning}>{warning}</li>)}</ul>
        </div>
      ) : null}

      <fieldset>
        <legend>Appearance</legend>
        <label className="field">
          <span className="field__label">Theme</span>
          <select
            value={settings.appearance.themeSource}
            onChange={event => patchAppearance({ themeSource: event.target.value as Settings['appearance']['themeSource'] })}
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Font size</span>
          <input
            type="number" min={6} max={72} step={1}
            value={settings.appearance.fontSize}
            onChange={event => patchAppearance({ fontSize: Number(event.target.value) })}
          />
        </label>
        <label className="field field--wide">
          <span className="field__label">Font family</span>
          <input
            type="text" maxLength={200}
            value={settings.appearance.fontFamily}
            onChange={event => patchAppearance({ fontFamily: event.target.value })}
          />
        </label>
        <label className="field">
          <span className="field__label">Line height</span>
          <input
            type="number" min={0.8} max={3} step={0.05}
            value={settings.appearance.lineHeight}
            onChange={event => patchAppearance({ lineHeight: Number(event.target.value) })}
          />
        </label>
        <label className="field">
          <span className="field__label">History lines</span>
          <input
            type="number" min={0} max={100000} step={100}
            value={settings.appearance.scrollbackLines}
            onChange={event => patchAppearance({ scrollbackLines: Number(event.target.value) })}
          />
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.appearance.cursorBlink}
            onChange={event => patchAppearance({ cursorBlink: event.target.checked })}
          />
          <span>Blinking cursor</span>
        </label>
      </fieldset>

      <fieldset>
        <legend>Animation</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.animation.enabled}
            onChange={event => patchAnimation({ enabled: event.target.checked })}
          />
          <span>Enable animation</span>
        </label>
        <p className="hint">
          Turning this off disables every animated layer. No status is conveyed by animation alone, so
          nothing is lost except motion.
        </p>
        <label className="field">
          <span className="field__label">Preset</span>
          <select
            value={settings.animation.preset}
            onChange={event => patchAnimation({ preset: event.target.value as Settings['animation']['preset'] })}
          >
            <option value="professional">Professional — minimal</option>
            <option value="living">Living — reactive mascot</option>
            <option value="immersive">Immersive — mascot and particles</option>
          </select>
        </label>
        <label className="field">
          <span className="field__label">Intensity</span>
          <input
            type="range" min={0} max={1} step={0.05}
            value={settings.animation.intensity}
            onChange={event => patchAnimation({ intensity: Number(event.target.value) })}
          />
          <output>{Math.round(settings.animation.intensity * 100)}%</output>
        </label>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.animation.respectSystemReducedMotion}
            onChange={event => patchAnimation({ respectSystemReducedMotion: event.target.checked })}
          />
          <span>Respect the system reduced-motion preference</span>
        </label>
        <div className="field field--wide">
          <span className="field__label">Layers</span>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.animation.layers.mascot}
              onChange={event => patchLayers({ mascot: event.target.checked })}
            />
            <span>Mascot</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.animation.layers.particles}
              onChange={event => patchLayers({ particles: event.target.checked })}
            />
            <span>Particles</span>
          </label>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.animation.layers.transitions}
              onChange={event => patchLayers({ transitions: event.target.checked })}
            />
            <span>UI transitions</span>
          </label>
        </div>
        {animation ? (
          <p className="hint">
            Resolved now: <strong>{animation.enabled ? animation.effectivePreset : 'off'}</strong>
            {' '}({animation.reason})
            {animation.enabled ? `, intensity ${Math.round(animation.intensity * 100)}%` : ''}.
            PR1 stores and resolves these values; PR2 renders them.
          </p>
        ) : null}
      </fieldset>

      <fieldset>
        <legend>Shell</legend>
        <label className="field field--wide">
          <span className="field__label">Shell for new tabs</span>
          <select
            value={settings.shell.id}
            onChange={event => onChange({ shell: { ...settings.shell, id: event.target.value, command: null, args: [] } })}
          >
            <option value="auto">Auto (detected default)</option>
            {shells.map(shell => <option key={shell.id} value={shell.id}>{shell.label}</option>)}
          </select>
        </label>
        <label className="field field--wide">
          <span className="field__label">Custom shell path</span>
          <input
            type="text"
            value={customShell}
            placeholder="absolute path to an executable"
            onChange={event => setCustomShell(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button"
          disabled={customShell.trim() === ''}
          onClick={() => {
            onChange({ shell: { ...settings.shell, id: 'custom', command: customShell.trim(), args: [] } });
            setCustomShell('');
          }}
        >
          Use this shell
        </button>
        <p className="hint">
          Only an absolute path to an existing file is accepted. The backend refuses command lines from the
          UI, so this panel cannot be used to launch an arbitrary process.
        </p>
      </fieldset>

      <fieldset>
        <legend>Layout</legend>
        <label className="check">
          <input
            type="checkbox"
            checked={settings.layout.restoreTabs}
            onChange={event => onChange({ layout: { ...settings.layout, restoreTabs: event.target.checked } })}
          />
          <span>Reopen tabs on launch</span>
        </label>
        <p className="hint">
          Tab shells are restored; split geometry is not, because a restored split around sessions that no
          longer exist is a worse first frame than a single pane.
        </p>
      </fieldset>

      <p className="hint settings__path">Stored at <code>{path}</code></p>
    </aside>
  );
}
