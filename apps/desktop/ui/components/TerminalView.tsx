import { useCallback } from 'react';
import { useTerminalSession, type PaneStatus } from '../lib/useTerminalSession';
import { HistoryPanel } from './HistoryPanel';
import type { Settings } from '../lib/types';
import type { ThemeId } from '../theme';

interface Props {
  leafId: string;
  sessionId: string;
  label: string;
  promptPattern: string | null;
  settings: Settings;
  themeId: ThemeId;
  active: boolean;
  showHistory: boolean;
  onStatus: (leafId: string, status: PaneStatus) => void;
  onFocusPane: (leafId: string) => void;
  onToggleHistory: (leafId: string) => void;
  onClosePane: (leafId: string) => void;
}

/** One terminal pane: the xterm.js viewport, its recovered history and its state banners. */
export function TerminalView(props: Props) {
  const {
    leafId, sessionId, label, promptPattern, settings, themeId,
    active, showHistory, onStatus, onFocusPane, onToggleHistory, onClosePane,
  } = props;

  const report = useCallback(
    (status: PaneStatus) => onStatus(leafId, status),
    [leafId, onStatus],
  );

  const { containerRef, status, history, focus } = useTerminalSession({
    sessionId,
    promptPattern,
    themeId,
    fontSize: settings.appearance.fontSize,
    fontFamily: settings.appearance.fontFamily,
    lineHeight: settings.appearance.lineHeight,
    cursorBlink: settings.appearance.cursorBlink,
    scrollbackLines: settings.appearance.scrollbackLines,
    onStatus: report,
  });

  const exited = status.state === 'exited' || status.state === 'released';
  const ariaLabel = `${label}${status.state ? `, ${status.state}` : ''}${status.backendLost ? ', backend lost' : ''}`;

  return (
    <section
      className={`pane${active ? ' pane--active' : ''}`}
      data-leaf-id={leafId}
      role="group"
      aria-label={ariaLabel}
      onFocus={() => onFocusPane(leafId)}
      onClick={() => onFocusPane(leafId)}
    >
      <header className="pane__bar">
        <button type="button" className="pane__focus" onClick={focus} title="Focus this terminal">
          <span className="pane__label">{label}</span>
          <StateBadge status={status} />
        </button>
        <span className="pane__size">{status.cols > 0 ? `${status.cols}×${status.rows}` : '—'}</span>
        <button
          type="button"
          className="button button--icon"
          aria-pressed={showHistory}
          aria-label={showHistory ? 'Hide recovered history' : 'Show recovered history'}
          title="Recovered history (Alt+H)"
          onClick={() => onToggleHistory(leafId)}
        >
          {showHistory ? '▾' : '▴'}
        </button>
        <button
          type="button"
          className="button button--icon button--danger"
          aria-label={`Close ${label}`}
          title="Close pane (Alt+W)"
          onClick={() => onClosePane(leafId)}
        >
          ×
        </button>
      </header>

      {status.backendLost ? (
        <p className="banner banner--fatal" role="alert">
          <strong>Backend lost.</strong> {status.backendLost}
          <span className="banner__note">
            Every session on that runtime host is invalid. It is not retried, because retrying would attach
            this pane to a different process.
          </span>
        </p>
      ) : null}

      {exited && !status.backendLost ? (
        <p className="banner" role="status">
          Process exited
          {status.exit ? ` with code ${status.exit.exitCode}` : ''}
          . The pane keeps its last screen.
        </p>
      ) : null}

      {status.writeErrors > 0 ? (
        <p className="banner banner--warn" role="status">
          {status.writeErrors} input write{status.writeErrors === 1 ? '' : 's'} failed — that keystroke
          did not reach the child.
        </p>
      ) : null}

      {status.lastError ? (
        <p className="banner banner--warn" role="status">{status.lastError}</p>
      ) : null}

      {showHistory ? (
        <HistoryPanel
          lines={history}
          label={`Recovered history for ${label}`}
          onClose={() => onToggleHistory(leafId)}
        />
      ) : null}

      <div className="pane__terminal" ref={containerRef} />
    </section>
  );
}

function StateBadge({ status }: { status: PaneStatus }) {
  if (status.backendLost) return <span className="badge badge--fatal">lost</span>;
  if (status.state === 'exited' || status.state === 'released') return <span className="badge badge--muted">{status.state}</span>;
  if (status.state === 'spawned') return <span className="badge badge--warn">spawned</span>;
  if (!status.connected) return <span className="badge badge--muted">connecting</span>;
  return <span className="badge badge--ok">live</span>;
}
