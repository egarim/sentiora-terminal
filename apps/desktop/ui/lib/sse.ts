import type { ApiErrorBody } from './types';
import { ApiError } from './types';

/**
 * Server-sent events over fetch().
 *
 * EventSource is deliberately not used: it cannot send an Authorization header,
 * and the whole API is behind a per-launch bearer token. Parsing the stream by
 * hand is ~40 lines and keeps the token out of the URL.
 */
export interface SseEvent {
  name: string;
  data: unknown;
}

export async function* readSse(response: Response): AsyncGenerator<SseEvent> {
  if (!response.body) throw new ApiError(0, 'no-body', 'the event stream had no body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary: number;
      // Events are separated by a blank line. A single event can arrive split
      // across any number of chunks, so only complete blocks are emitted.
      while ((boundary = buffer.indexOf('\n\n')) !== -1) {
        const block = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        let name = 'message';
        const dataLines: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue; // comment / heartbeat
          if (line.startsWith('event:')) name = line.slice(6).trim();
          else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        if (dataLines.length === 0) continue;
        const raw = dataLines.join('\n');
        try {
          yield { name, data: JSON.parse(raw) };
        } catch {
          yield { name: 'parse-error', data: raw };
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function parseError(response: Response): Promise<ApiError> {
  const kind = 'http-error';
  let message = `${response.status} ${response.statusText}`;
  // Read the body once: a Response cannot be consumed twice, so trying json()
  // first and text() on failure would silently lose the server's message.
  const text = await response.text().catch(() => '');
  if (text) {
    try {
      const body = JSON.parse(text) as ApiErrorBody;
      if (body?.error) message = body.error;
      return new ApiError(response.status, body?.kind ?? kind, message);
    } catch {
      message = text.slice(0, 300);
    }
  }
  return new ApiError(response.status, kind, message);
}
