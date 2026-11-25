import { useEffect, useRef } from 'react';
import { SHORTCUTS } from '../lib/shortcuts';

interface Props {
  onClose: () => void;
}

/**
 * The shortcut list, and a focus trap while it is open.
 *
 * Listed here rather than only wired up, because a shortcut the user cannot find
 * is not a keyboard-accessible feature.
 */
export function ShortcutsDialog({ onClose }: Props) {
  const closeRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      // Two focusable elements only, so the trap is explicit rather than generic.
      const focusables = Array.from(
        document.querySelectorAll<HTMLElement>('#shortcuts-dialog button, #shortcuts-dialog [href], #shortcuts-dialog [tabindex]:not([tabindex="-1"])'),
      );
      if (focusables.length === 0) return;
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  return (
    <div className="modal__backdrop">
      <div className="modal" id="shortcuts-dialog" role="dialog" aria-modal="true" aria-labelledby="shortcuts-title">
        <h2 id="shortcuts-title">Keyboard shortcuts</h2>
        <table className="shortcuts">
          <caption className="visually-hidden">Application keyboard shortcuts</caption>
          <thead>
            <tr><th scope="col">Keys</th><th scope="col">Action</th></tr>
          </thead>
          <tbody>
            {SHORTCUTS.map(shortcut => (
              <tr key={shortcut.action}>
                <th scope="row"><kbd>{shortcut.keys}</kbd></th>
                <td>{shortcut.label}</td>
              </tr>
            ))}
            <tr><th scope="row"><kbd>Ctrl+C</kbd></th><td>Interrupt the foreground job (gated on observed readiness)</td></tr>
            <tr><th scope="row"><kbd>Esc</kbd></th><td>Close this dialog or the settings panel</td></tr>
          </tbody>
        </table>
        <p className="hint">
          These are Alt-based chords because browsers reserve most Ctrl+Shift combinations and cannot be
          told otherwise. Every action also has a button, so nothing depends on a shortcut surviving.
        </p>
        <button type="button" className="button button--primary" ref={closeRef} onClick={onClose}>Close</button>
      </div>
    </div>
  );
}
