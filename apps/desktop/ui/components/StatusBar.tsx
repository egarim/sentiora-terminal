import type { PaneStatus } from '../lib/useTerminalSession';
import type { Info, ResolvedAnimation, SessionDescriptor } from '../lib/types';

interface Props {
  pane: PaneStatus | null;
  descriptor: SessionDescriptor | null;
  info: Info | null;
  animation: ResolvedAnimation | null;
}

/**
 * One line of ground truth about the focused pane and the backend.
 *
 * Every state here is also expressed in words: issue #7 requires that no essential
 * status be conveyed by animation or colour alone, and the status bar is where a
 * screen-reader user gets what a sighted user gets from a badge.
 */
export function StatusBar({ pane, descriptor, info, animation }: Props) {
  const healthy = (info?.hosts ?? []).filter(host => host.alive && !host.dead).length;
  const draining = (info?.hosts ?? []).filter(host => host.draining).length;

  return (
    <footer className="statusbar" role="status" aria-live="polite">
      <span className="statusbar__group">
        <strong className="statusbar__pane">{descriptor?.label ?? 'no pane'}</strong>
        {pane?.state ? <span className="chip">{pane.state}</span> : null}
        {pane?.backendLost ? <span className="chip chip--fatal">backend lost</span> : null}
        {pane && pane.writeErrors > 0 ? <span className="chip chip--warn">{pane.writeErrors} input write(s) lost</span> : null}
        {pane && pane.exit ? <span className="chip chip--muted">exit {pane.exit.exitCode}</span> : null}
      </span>

      <span className="statusbar__group statusbar__metrics">
        {pane && pane.cols > 0 ? <span className="chip">{pane.cols}×{pane.rows}</span> : null}
        {pane?.lastClampedResize ? <span className="chip chip--warn">{pane.lastClampedResize}</span> : null}
        {pane && pane.revision > 0 ? <span className="chip">rev {pane.revision}</span> : null}
        {pane && pane.coalesced > 0 ? <span className="chip">{pane.coalesced} frame(s) coalesced</span> : null}
        {pane && pane.scrollbackLines > 0 ? <span className="chip">{pane.scrollbackLines} history</span> : null}
      </span>

      <span className="statusbar__group">
        {animation ? (
          <span className="chip">{animation.enabled ? `animation: ${animation.effectivePreset}` : `animation off (${animation.reason})`}</span>
        ) : null}
        {info ? (
          <>
            <span className="chip">output: {info.outputMode}</span>
            <span className="chip">
              hosts {healthy}/{info.limits.maxHosts}
              {draining > 0 ? ` (${draining} recycling)` : ''}
            </span>
            {descriptor ? <span className="chip">{descriptor.hostId}</span> : null}
            {info.runtime ? <span className="chip">{info.runtime.platform}/{info.runtime.arch}</span> : null}
          </>
        ) : null}
      </span>
    </footer>
  );
}
