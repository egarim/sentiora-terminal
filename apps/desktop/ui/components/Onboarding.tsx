import { useState } from 'react';
import type { Shell } from '../lib/types';

interface Props {
  shells: Shell[];
  defaultShellId: string | null;
  busy: boolean;
  error: string | null;
  onLaunch: (choice: { shellId?: string; customPath?: string }) => void;
}

/**
 * S1, minimal: enough to pick a real shell and launch it.
 *
 * The choice is restricted to shells the backend detected plus an absolute path.
 * A free-form command line is deliberately not offered — the backend refuses one,
 * because accepting it would make the frontend an arbitrary process launcher.
 */
export function Onboarding({ shells, defaultShellId, busy, error, onLaunch }: Props) {
  const initial = defaultShellId && shells.some(shell => shell.id === defaultShellId) ? defaultShellId : (shells[0]?.id ?? '');
  const [choice, setChoice] = useState<string>(initial);
  const [customPath, setCustomPath] = useState('');
  const useCustom = choice === 'custom';

  return (
    <div className="onboarding" role="dialog" aria-labelledby="onboarding-title" aria-modal="true">
      <h1 id="onboarding-title">Sentiora Living Terminal</h1>
      <p className="onboarding__lede">
        A terminal for people and agents, built on the Sentiora runtime. Sessions are owned by a local
        backend process; this window attaches to them and can reattach later without losing output.
      </p>

      <form
        className="onboarding__form"
        onSubmit={event => {
          event.preventDefault();
          if (useCustom) onLaunch({ customPath: customPath.trim() });
          else onLaunch({ shellId: choice });
        }}
      >
        <fieldset>
          <legend>Choose a shell</legend>
          {shells.length === 0 ? (
            <p className="banner banner--warn" role="status">
              No shell was detected on this machine. Enter an absolute path below.
            </p>
          ) : (
            <div className="onboarding__shells" role="radiogroup" aria-label="Detected shells">
              {shells.map(shell => (
                <label key={shell.id} className={`choice${choice === shell.id ? ' choice--selected' : ''}`}>
                  <input
                    type="radio"
                    name="shell"
                    value={shell.id}
                    checked={choice === shell.id}
                    onChange={() => setChoice(shell.id)}
                  />
                  <span className="choice__label">{shell.label}</span>
                  <code className="choice__command">{shell.command}</code>
                </label>
              ))}
              <label className={`choice${useCustom ? ' choice--selected' : ''}`}>
                <input
                  type="radio"
                  name="shell"
                  value="custom"
                  checked={useCustom}
                  onChange={() => setChoice('custom')}
                />
                <span className="choice__label">Custom path</span>
                <input
                  type="text"
                  className="choice__input"
                  value={customPath}
                  placeholder="/absolute/path/to/shell"
                  aria-label="Custom shell path"
                  onChange={event => { setCustomPath(event.target.value); setChoice('custom'); }}
                />
              </label>
            </div>
          )}
        </fieldset>

        {error ? <p className="banner banner--fatal" role="alert">{error}</p> : null}

        <div className="onboarding__actions">
          <button
            type="submit"
            className="button button--primary"
            disabled={busy || (useCustom ? customPath.trim() === '' : choice === '')}
          >
            {busy ? 'Starting…' : 'Launch terminal'}
          </button>
          <span className="hint">Sessions persist while the backend runs. Closing this window does not kill them.</span>
        </div>
      </form>
    </div>
  );
}
