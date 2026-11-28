// Session-tree + message-log polling for the viewer (#35).
//
// One timer, not two: the tree and the selected session's log are read on the same tick so a node
// cannot appear in the list with a log that belongs to the previous selection. The mailbox cursor is
// held in a ref because it must advance without re-rendering; the rendered log is appended through
// appendMailbox, which deduplicates if a poll overlaps.
import { useEffect, useRef, useState } from 'react';
import { api } from './api';
import { appendMailbox, emptyMailboxLog, type MailboxLog, type MailboxMessage } from './tree';
import type { SessionDescriptor } from './types';

export type SessionTreeState = {
  sessions: SessionDescriptor[];
  selectedId: string | null;
  log: MailboxLog;
  /** Messages the selected session sent to its children, gathered from their inboxes. */
  sent: MailboxMessage[];
  /** session id -> label, so a `from` id is shown as something a person recognises. */
  labels: Record<string, string>;
  error: string | null;
  select: (sessionId: string) => void;
};

export function useSessionTree({ intervalMs = 1500, enabled = true } = {}): SessionTreeState {
  const [sessions, setSessions] = useState<SessionDescriptor[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [log, setLog] = useState<MailboxLog>(emptyMailboxLog);
  const [error, setError] = useState<string | null>(null);
  // What the selected session sent to its children, gathered from their inboxes: the mailbox is
  // per-recipient, so outbound messages only exist there. Filtered by "from", which the runtime
  // attributes through the pair's edge capability.
  const [sent, setSent] = useState<MailboxMessage[]>([]);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const selectedRef = useRef<string | null>(null);
  const cursor = useRef(0);

  const select = (sessionId: string) => {
    if (sessionId === selectedRef.current) return;
    selectedRef.current = sessionId;
    setSelectedId(sessionId);
    // A different session has a different sequence space; carrying the old cursor would silently
    // drop its first messages.
    cursor.current = 0;
    setLog(emptyMailboxLog());
  };

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      try {
        const next = await api.listSessions();
        if (cancelled) return;
        setSessions(next);

        // Follow the first session until the user picks one, and fall back to it if the selected
        // session disappears -- an empty log with no explanation is worse than following the tree.
        const chosen = selectedRef.current && next.some(entry => entry.sessionId === selectedRef.current)
          ? selectedRef.current
          : next[0]?.sessionId ?? null;
        if (chosen !== selectedRef.current) {
          // Follow, or fall back: inline rather than through select() so a null choice stays null.
          selectedRef.current = chosen;
          setSelectedId(chosen);
          cursor.current = 0;
          setLog(emptyMailboxLog());
        }
        if (chosen) {
          // Outbound: messages the selected session sent to each of its children. Reading the
          // children's inboxes and filtering by sender is the only way to see this direction -- the
          // mailbox belongs to the recipient.
          const children = next.filter(entry => entry.parent === chosen).slice(0, 8);
          const outbound: MailboxMessage[] = [];
          for (const child of children) {
            const frame = await api.mailbox(child.sessionId, 0, 0);
            if (cancelled) return;
            outbound.push(...frame.messages.filter(message => message.from === chosen));
          }
          setSent(outbound);
          setLabels(Object.fromEntries(next.map(entry => [entry.sessionId, entry.label])));
          const frame = await api.mailbox(chosen, cursor.current, 0);
          if (cancelled) return;
          cursor.current = frame.nextSequence;
          setLog(current => appendMailbox(frame, current));
        }
        setError(null);
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : String(failure));
      } finally {
        if (!cancelled) timer = setTimeout(() => { void tick(); }, intervalMs);
      }
    };

    void tick();
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [enabled, intervalMs]);

  return { sessions, selectedId, log, sent, labels, error, select };
}
