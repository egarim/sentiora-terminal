import { useEffect, useRef } from 'react';

interface Props {
  lines: string[];
  label: string;
  onClose: () => void;
}

/**
 * Recovered scrollback.
 *
 * The runtime exposes a rendered viewport, not a byte stream, so lines that
 * scroll off the top are gone from the protocol. The bridge recovers what it can
 * by exact pure-shift matching and streams it here. It is a reconstruction, not a
 * transcript, and the heading says so rather than implying completeness.
 */
export function HistoryPanel({ lines, label, onClose }: Props) {
  const listRef = useRef<HTMLDivElement | null>(null);

  // Keep the newest line in view; the panel is a tail, not a document to read up.
  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [lines.length]);

  return (
    <div className="history" role="region" aria-label={label}>
      <div className="history__head">
        <span className="history__title">
          Recovered history
          <span className="history__count">{lines.length} lines</span>
        </span>
        <span className="history__note">
          Reconstructed from screen snapshots; lines that scrolled past between observations cannot be recovered.
        </span>
        <button type="button" className="button button--ghost" onClick={onClose}>
          Close history
        </button>
      </div>
      <div className="history__body" ref={listRef} role="log" aria-live="off" tabIndex={0}>
        {lines.length === 0
          ? <p className="history__empty">Nothing has scrolled off the viewport yet.</p>
          : lines.map((line, index) => (
            // The panel is an append-only tail whose entries have no identity of
            // their own, so the index is the stable key here.
            <div className="history__line" key={index}>{line === '' ? '\u00a0' : line}</div>
          ))}
      </div>
    </div>
  );
}
