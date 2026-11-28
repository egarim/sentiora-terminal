import { parseError, readSse, type SseEvent } from './sse';
import type { Frame, Info, Observation, ResolvedAnimation, SessionDescriptor, Settings, Shell } from './types';

/**
 * Client for the loopback bridge API.
 *
 * The bearer token is held in a module-scoped variable and read from the URL
 * fragment, which browsers never transmit and servers never log. It is never
 * written to localStorage, sessionStorage, a cookie or the query string.
 */
let token: string | null = null;
let baseUrl = '';

export function bootstrapFromLocation(): { token: string | null; baseUrl: string } {
  const hash = window.location.hash;
  const match = /(?:^|#|&)token=([^&]+)/.exec(hash);
  if (match) {
    token = decodeURIComponent(match[1]!);
    // Strip it from the address bar so it cannot be copied, bookmarked or leaked
    // through a screenshot or a screen share.
    window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }
  const override = new URLSearchParams(window.location.search).get('bridge');
  baseUrl = override ? override.replace(/\/$/, '') : '';
  return { token, baseUrl };
}

export function hasToken(): boolean {
  return token !== null && token.length > 0;
}

export function apiBase(): string {
  return `${baseUrl}/api`;
}

function headers(extra: Record<string, string> = {}): Record<string, string> {
  return { ...(token ? { authorization: `Bearer ${token}` } : {}), ...extra };
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${apiBase()}${path}`, {
    ...init,
    headers: headers({ 'content-type': 'application/json', ...(init.headers as Record<string, string> | undefined) }),
  });
  if (!response.ok) throw await parseError(response);
  const text = await response.text();
  return (text ? JSON.parse(text) : {}) as T;
}

export const api = {
  health: () => request<{ ok: boolean; sessions: number }>('/health'),
  info: () => request<Info>('/info'),
  shells: () => request<{ shells: Shell[] }>('/shells').then(r => r.shells),
  animation: (reducedMotion = false) =>
    request<ResolvedAnimation>(`/animation${reducedMotion ? '?reducedMotion=1' : ''}`),

  getSettings: () => request<{ settings: Settings; warnings: string[]; path: string }>('/settings'),
  putSettings: (patch: Partial<Settings>) =>
    request<{ settings: Settings; warnings: string[] }>('/settings', {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),

  listSessions: () => request<{ sessions: SessionDescriptor[] }>('/sessions').then(r => r.sessions),
  /**
   * Only a catalogued shellId or a validated absolute customPath is accepted.
   * The server refuses `command`/`args` outright: the frontend must not be able
   * to turn into an arbitrary process launcher.
   */
  createSession: (body: { shellId?: string; customPath?: string; cols?: number; rows?: number; label?: string }) =>
    request<{ session: SessionDescriptor }>('/sessions', { method: 'POST', body: JSON.stringify(body) }).then(r => r.session),
  /** Enqueues a message through the bridge; the UI never holds the mailbox capability itself. */
  postMessage: (sessionId: string, payload: unknown) =>
    request<{ posted: { sequence: number; dropped: number } }>(
      `/sessions/${encodeURIComponent(sessionId)}/messages`,
      { method: 'POST', body: JSON.stringify({ payload }) },
    ).then(r => r.posted),
  /** Drains messages after a cursor. `timeoutMs: 0` returns immediately, for a polling loop. */
  mailbox: (sessionId: string, afterSequence = 0, timeoutMs = 0) =>
    request<{ messages: Array<{ sequence: number; payload: unknown }>; nextSequence: number; dropped: number }>(
      `/sessions/${encodeURIComponent(sessionId)}/messages?after=${afterSequence}&timeoutMs=${timeoutMs}`,
    ),
  closeSession: (sessionId: string) =>
    request<{ closed: boolean }>(`/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
  observe: (sessionId: string) =>
    request<{ session: Observation }>(`/sessions/${encodeURIComponent(sessionId)}`).then(r => r.session),
  sendText: (sessionId: string, text: string) =>
    request<{ revision: number; writeErrors: number }>(`/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: 'POST',
      body: JSON.stringify({ text }),
    }),
  sendKey: (sessionId: string, key: string) =>
    request<{ revision: number; writeErrors: number }>(`/sessions/${encodeURIComponent(sessionId)}/input`, {
      method: 'POST',
      body: JSON.stringify({ key }),
    }),
  /**
   * Ctrl+C goes through here rather than as a raw 0x03 byte: sent before the child
   * has configured its console it terminates the process instead of interrupting
   * it, so the bridge gates it on an observed readiness condition.
   */
  interrupt: (sessionId: string, body: { readyPattern?: string; timeoutMs?: number }) =>
    request<{ delivered: boolean; reason: string | null }>(`/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  resize: (sessionId: string, cols: number, rows: number) =>
    request<Observation & { requested: { cols: number; rows: number }; applied: { cols: number; rows: number }; clamped: boolean }>(
      `/sessions/${encodeURIComponent(sessionId)}/resize`,
      { method: 'POST', body: JSON.stringify({ cols, rows }) },
    ),
};

/** Subscribes to a stream and calls `onEvent` for each event. Returns a disposer. */
export function subscribe(
  path: string,
  onEvent: (event: SseEvent) => void,
  options: { onError?: (error: unknown) => void; onClose?: () => void } = {},
): () => void {
  const controller = new AbortController();
  let stopped = false;
  (async () => {
    try {
      const response = await fetch(`${apiBase()}${path}`, {
        headers: headers({ accept: 'text/event-stream' }),
        signal: controller.signal,
      });
      if (!response.ok) throw await parseError(response);
      for await (const event of readSse(response)) {
        if (stopped) break;
        onEvent(event);
      }
    } catch (error) {
      if (!stopped && (error as Error)?.name !== 'AbortError') options.onError?.(error);
    } finally {
      if (!stopped) options.onClose?.();
    }
  })();
  return () => {
    stopped = true;
    controller.abort();
  };
}

export function subscribeSession(sessionId: string, onFrame: (frame: Frame) => void, options?: { onError?: (e: unknown) => void; onClose?: () => void }): () => void {
  return subscribe(
    `/sessions/${encodeURIComponent(sessionId)}/stream`,
    event => {
      if (event.name === 'snapshot' || event.name === 'frame') onFrame(event.data as Frame);
    },
    options,
  );
}

export function subscribeEvents(onEvent: (name: string, data: unknown) => void, options?: { onError?: (e: unknown) => void; onClose?: () => void }): () => void {
  return subscribe('/events', event => onEvent(event.name, event.data), options);
}
