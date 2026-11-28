// The session tree and per-edge message log (issue #35), as a pure presentational component.
//
// Deliberately built with createElement rather than JSX: a .tsx file cannot be imported by Node
// without a build step, and this way the component's *structure* is testable in the same `node --test`
// run as the models. Interaction ("clicking a row selects the session") still needs a browser —
// that is #19 — but what the tree renders for a given state does not.
//
// No hooks and no state: this renders what it is given. The polling/selection container belongs to
// the layer above, which is also the layer Playwright would drive.
import { createElement, type ReactElement } from 'react';
import {
  buildSessionTree, flattenSessionTree, type MailboxLog, type SessionEntry,
} from '../lib/tree.ts';

export type SessionTreeProps = {
  sessions: SessionEntry[];
  /** Bridge session id currently shown in the terminal pane. */
  selectedId?: string | null;
  /** The selected session's mailbox log, already merged by appendMailbox. */
  log?: MailboxLog;
  onSelect?: (sessionId: string) => void;
};

/** What a payload looks like in the log: text as-is, anything else as JSON. */
export function describePayload(payload: unknown): string {
  if (typeof payload === 'string') return payload;
  try {
    return JSON.stringify(payload) ?? String(payload);
  } catch {
    return String(payload);
  }
}

export function SessionTree(props: SessionTreeProps): ReactElement {
  const tree = buildSessionTree(props.sessions ?? []);
  const rows = flattenSessionTree(tree).map(({ entry, depth }) => createElement(
    'li',
    {
      key: entry.sessionId,
      'data-testid': 'session-row',
      'data-session-id': entry.sessionId,
      'data-depth': String(depth),
      'data-state': entry.state ?? 'unknown',
      // aria-current rather than a class: the selected row must be announced, not only coloured.
      'aria-current': entry.sessionId === props.selectedId ? 'true' : undefined,
      onClick: props.onSelect ? () => props.onSelect?.(entry.sessionId) : undefined,
    },
    createElement('span', { key: 'label', 'data-testid': 'session-label' }, entry.label ?? entry.sessionId),
    createElement('span', { key: 'state', 'data-testid': 'session-state' }, entry.state ?? 'unknown'),
  ));

  const log = props.log;
  const messages = (log?.messages ?? []).map(message => createElement(
    'li',
    {
      key: message.sequence,
      'data-testid': 'log-message',
      'data-sequence': String(message.sequence),
        // No gap check per message: appendMailbox already guarantees ordering and dedupe.
    },
    describePayload(message.payload),
  ));

  const sections: Array<ReactElement | null> = [
    createElement('ul', { key: 'rows', 'data-testid': 'session-rows' }, rows),
    createElement(
      'section',
      { key: 'log', 'data-testid': 'session-log' },
      // A gap is permanent information: the frame that reported it may be long gone.
      log && log.dropped > 0
        ? createElement('p', { key: 'gap', 'data-testid': 'log-gap', 'data-dropped': String(log.dropped) },
          `${log.dropped} message(s) dropped`)
        : null,
      createElement('ol', { key: 'messages', 'data-testid': 'log-messages' }, messages),
    ),
  ];

  // An orphan means the runtime reported a parent that is not in the list; showing it as a root is
  // the model's choice, and saying so here is the difference between a visible bug and a mystery.
  if (tree.orphans.length) {
    sections.push(createElement(
      'p',
      { key: 'orphans', 'data-testid': 'tree-orphans', 'data-count': String(tree.orphans.length) },
      `${tree.orphans.length} session(s) reference a missing parent`,
    ));
  }

  return createElement('section', { 'data-testid': 'session-tree' }, ...sections);
}
