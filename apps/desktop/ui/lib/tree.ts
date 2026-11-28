// Session-tree and mailbox-log models for the desktop viewer (issue #35).
//
// These are pure functions over what the runtime already returns: `terminal.list` gives each
// session's `parent` (or null), and `terminal.mailbox` gives sequenced messages. Keeping the shape
// logic here rather than inside a component means it can be tested without a browser — which is
// what lets the viewer make progress while the UI test tooling is still undecided.
//
// Plain TypeScript, no React: Node 24 strips the types, so `test/desktop-tree.test.js` imports this
// file directly.

export type SessionEntry = {
  sessionId: string;
  parent?: string | null;
  state?: string;
  pid?: number | null;
  /** Human label from the bridge, if it has one. */
  label?: string;
};

export type SessionTree = {
  /** Sessions with no parent, in the order the runtime listed them. */
  roots: SessionEntry[];
  /** parent session id -> its children, in listing order. */
  children: Map<string, SessionEntry[]>;
  /**
   * Entries whose `parent` names a session that is not in the list. The runtime clears the link
   * when an edge dies, so this should be empty; when it is not, the viewer shows the entry as a
   * root rather than hiding it, and this list is what makes the inconsistency reportable instead
   * of invisible.
   */
  orphans: SessionEntry[];
};

/** Builds the tree from `terminal.list` entries. Order is the runtime's, never re-sorted. */
export function buildSessionTree(entries: SessionEntry[]): SessionTree {
  const known = new Set(entries.map(entry => entry.sessionId));
  const children = new Map<string, SessionEntry[]>();
  const roots: SessionEntry[] = [];
  const orphans: SessionEntry[] = [];

  for (const entry of entries) {
    const parent = entry.parent ?? null;
    if (parent === null) {
      roots.push(entry);
      continue;
    }
    if (!known.has(parent)) {
      orphans.push(entry);
      roots.push(entry);
      continue;
    }
    const list = children.get(parent) ?? [];
    list.push(entry);
    children.set(parent, list);
  }

  return { roots, children, orphans };
}

/** Depth-first flattening for rendering: parents before their children, root depth 0. */
export function flattenSessionTree(tree: SessionTree): Array<{ entry: SessionEntry; depth: number }> {
  const flat: Array<{ entry: SessionEntry; depth: number }> = [];
  const visit = (entry: SessionEntry, depth: number): void => {
    flat.push({ entry, depth });
    for (const child of tree.children.get(entry.sessionId) ?? []) visit(child, depth + 1);
  };
  for (const root of tree.roots) visit(root, 0);
  return flat;
}

export type MailboxMessage = { sequence: number; payload: unknown };

export type MailboxLog = {
  messages: MailboxMessage[];
  nextSequence: number;
  dropped: number;
};

export function emptyMailboxLog(): MailboxLog {
  return { messages: [], nextSequence: 0, dropped: 0 };
}

/**
 * Merges one `terminal.mailbox` frame into the log.
 *
 * Deduplicates by sequence — a poll that overlaps a previous cursor must not show a message twice —
 * keeps the log ordered, and takes the high-water mark of `dropped` so a gap stays visible after
 * the frame that reported it has scrolled away. Payloads are kept opaque: the viewer displays them,
 * it does not interpret them.
 */
export function appendMailbox(frame: {
  messages?: MailboxMessage[];
  nextSequence?: number;
  dropped?: number;
} = {}, log: MailboxLog = emptyMailboxLog()): MailboxLog {
  const seen = new Set(log.messages.map(message => message.sequence));
  const fresh = (frame.messages ?? []).filter(
    message => Number.isFinite(message.sequence) && message.sequence > 0 && !seen.has(message.sequence),
  );
  const messages = [...log.messages, ...fresh].sort((a, b) => a.sequence - b.sequence);
  const highest = messages.length ? messages[messages.length - 1].sequence : 0;
  return {
    messages,
    nextSequence: Math.max(log.nextSequence, frame.nextSequence ?? 0, highest),
    dropped: Math.max(log.dropped, frame.dropped ?? 0),
  };
}
