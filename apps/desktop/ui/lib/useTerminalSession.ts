import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api, subscribeSession } from './api';
import { buildRepaint, normalizeLines } from './paint';
import { isAppShortcut } from './shortcuts';
import { xtermTheme, type ThemeId } from '../theme';
import type { ExitInfo, Frame, LifecycleState } from './types';

export interface PaneStatus {
  sessionId: string;
  connected: boolean;
  state: LifecycleState | null;
  cols: number;
  rows: number;
  revision: number;
  writeErrors: number;
  backendLost: string | null;
  exit: ExitInfo | null;
  coalesced: number;
  scrollbackLines: number;
  lastError: string | null;
  lastClampedResize: string | null;
}

export interface TerminalSessionOptions {
  sessionId: string;
  promptPattern: string | null;
  themeId: ThemeId;
  fontSize: number;
  fontFamily: string;
  lineHeight: number;
  cursorBlink: boolean;
  scrollbackLines: number;
  /** xterm's accessible tree; off unless the user asks, because it costs a DOM row per line. */
  screenReaderMode: boolean;
  onStatus?: (status: PaneStatus) => void;
}

const RESIZE_DEBOUNCE_MS = 80;

function initialStatus(sessionId: string): PaneStatus {
  return {
    sessionId,
    connected: false,
    state: null,
    cols: 0,
    rows: 0,
    revision: 0,
    writeErrors: 0,
    backendLost: null,
    exit: null,
    coalesced: 0,
    scrollbackLines: 0,
    lastError: null,
    lastClampedResize: null,
  };
}

/**
 * Owns one terminal pane: the xterm.js instance, its stream subscription, input
 * forwarding and independent resize.
 *
 * The bridge sends whole rendered screens, so nothing here is appended -- each
 * frame repaints the viewport by absolute cursor addressing. xterm.js scrollback
 * is disabled and recovered history is rendered separately, because the runtime
 * exposes only the visible viewport and the bridge's recovered ring is a
 * best-effort reconstruction of what scrolled past.
 */
export function useTerminalSession(options: TerminalSessionOptions) {
  const { sessionId, promptPattern, themeId, fontSize, fontFamily, lineHeight, cursorBlink, scrollbackLines, screenReaderMode, onStatus } = options;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const paintedRef = useRef<string[] | null>(null);
  const sizeRef = useRef({ cols: 0, rows: 0 });
  const coalescedRef = useRef(0);
  const onStatusRef = useRef(onStatus);
  onStatusRef.current = onStatus;
  // Refs, not dependencies: the stream effect must not be torn down (and the
  // session's output interrupted) just because a setting changed.
  const scrollbackRef = useRef(scrollbackLines);
  scrollbackRef.current = scrollbackLines;

  const [status, setStatus] = useState<PaneStatus>(() => initialStatus(sessionId));
  const [history, setHistory] = useState<string[]>([]);

  const publish = useCallback((patch: Partial<PaneStatus>) => {
    setStatus(previous => {
      const next = { ...previous, ...patch };
      onStatusRef.current?.(next);
      return next;
    });
  }, []);

  const focus = useCallback(() => termRef.current?.focus(), []);

  const clearHistory = useCallback(() => setHistory([]), []);

  // Kept in a ref so the stream effect does not restart when settings change.
  const promptRef = useRef(promptPattern);
  promptRef.current = promptPattern;

  const applyFrame = useCallback((frame: Frame) => {
    const term = termRef.current;
    if (!term) return;

    if (frame.coalesced) coalescedRef.current += frame.coalesced;

    if (frame.kind === 'lost' || frame.backendLost) {
      publish({ backendLost: frame.backendLost ?? 'runtime host lost', connected: false });
      return;
    }

    // A geometry change invalidates every painted row, so it forces a full repaint.
    const resized = frame.cols !== sizeRef.current.cols || frame.rows !== sizeRef.current.rows;
    if (resized && frame.cols > 0 && frame.rows > 0) {
      sizeRef.current = { cols: frame.cols, rows: frame.rows };
      try {
        term.resize(frame.cols, frame.rows);
      } catch {
        /* a zero-size container cannot be resized; the next fit will fix it */
      }
      paintedRef.current = null;
    }

    const rows = frame.rows || sizeRef.current.rows || frame.lines.length;
    const cols = frame.cols || sizeRef.current.cols;
    const lines = normalizeLines(frame.lines, rows);
    const repaint = buildRepaint({
      lines,
      rows,
      cols,
      cursor: frame.cursor ?? null,
      previous: frame.resync ? null : paintedRef.current,
      resync: frame.resync,
    });
    if (frame.resync) term.clear();
    term.write(repaint);
    paintedRef.current = lines;

    if (frame.scrolledOff && frame.scrolledOff.length > 0) {
      const limit = scrollbackRef.current;
      setHistory(previous => {
        const next = previous.concat(frame.scrolledOff);
        return next.length > limit ? next.slice(next.length - limit) : next;
      });
    }

    publish({
      connected: true,
      state: frame.state,
      cols: frame.cols,
      rows: frame.rows,
      revision: frame.revision,
      writeErrors: frame.writeErrors,
      backendLost: frame.backendLost,
      exit: frame.exit,
      scrollbackLines: frame.scrollbackLength,
      coalesced: coalescedRef.current,
    });
  }, [publish]);

  // ------------------------------------------------------- terminal + stream
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      // The bridge owns history; xterm's own scrollback would hold a second,
      // divergent copy of a screen that is repainted wholesale every frame.
      scrollback: 0,
      cursorBlink,
      fontSize,
      fontFamily,
      lineHeight,
      allowProposedApi: true,
      // Screen-reader users get the rendered viewport announced; the visual rendering stays
      // authoritative. Read once at construction: a new value applies to panes opened afterwards
      // rather than rebuilding a live terminal mid-session.
      screenReaderMode,
      convertEol: false,
      theme: xtermTheme(themeId),
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    // Application chords must not be sent to the shell as input. Returning false
    // makes xterm ignore them while the event still bubbles to the window-level
    // handler that acts on them.
    term.attachCustomKeyEventHandler(event => !isAppShortcut(event));
    termRef.current = term;
    fitRef.current = fit;

    let resizeTimer = 0;
    const fitNow = () => {
      try {
        fit.fit();
      } catch {
        return; // container not laid out yet
      }
      const { cols, rows } = term;
      if (cols === sizeRef.current.cols && rows === sizeRef.current.rows) return;
      sizeRef.current = { cols, rows };
      paintedRef.current = null;
      // Independent per-pane resize: each pane fits itself and tells only its own
      // session. Clamped client-side so the server never sees 2..300 / 2..150
      // violations, and the applied size is reported back if it was clamped.
      const clampedCols = Math.min(300, Math.max(2, cols));
      const clampedRows = Math.min(150, Math.max(2, rows));
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(() => {
        api.resize(sessionId, clampedCols, clampedRows)
          .then(result => {
            publish({
              cols: result.cols,
              rows: result.rows,
              lastClampedResize: result.clamped
                ? `clamped to ${result.applied.cols}×${result.applied.rows}`
                : null,
            });
          })
          .catch(error => publish({ lastError: (error as Error).message }));
      }, RESIZE_DEBOUNCE_MS);
    };

    fitNow();
    const observer = new ResizeObserver(() => fitNow());
    observer.observe(container);

    // No local echo: every byte the user types goes to the child and comes back
    // through the stream, exactly as it would on a real terminal.
    const dataListener = term.onData(data => {
      if (data === '\x03') {
        // Ctrl+C is routed through the readiness gate rather than sent raw: byte
        // 0x03 arriving before the child configured its console terminates it
        // (0xC000013A) instead of interrupting it.
        api.interrupt(sessionId, { readyPattern: promptRef.current ?? undefined, timeoutMs: 3000 })
          .then(result => {
            if (!result.delivered) publish({ lastError: result.reason ?? 'Ctrl+C was refused' });
          })
          .catch(error => publish({ lastError: (error as Error).message }));
        return;
      }
      api.sendText(sessionId, data).catch(error => publish({ lastError: (error as Error).message }));
    });

    const unsubscribe = subscribeSession(
      sessionId,
      frame => {
        if (frame.kind === 'snapshot' && frame.resync) {
          coalescedRef.current = 0;
          setHistory(frame.scrollback ?? []);
          paintedRef.current = null;
        }
        applyFrame(frame);
      },
      {
        onError: error => publish({ lastError: (error as Error).message, connected: false }),
        onClose: () => publish({ connected: false }),
      },
    );

    return () => {
      clearTimeout(resizeTimer);
      observer.disconnect();
      unsubscribe();
      dataListener.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      paintedRef.current = null;
      sizeRef.current = { cols: 0, rows: 0 };
    };
    // The stream must not be torn down when cosmetic settings change; those are
    // applied by the effect below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, applyFrame, publish]);

  // ------------------------------------------------- appearance-only updates
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.theme = xtermTheme(themeId);
    term.options.fontSize = fontSize;
    term.options.fontFamily = fontFamily;
    term.options.lineHeight = lineHeight;
    term.options.cursorBlink = cursorBlink;
    // Metrics changed, so refit and repaint everything against the new geometry.
    try {
      fitRef.current?.fit();
    } catch {
      /* not laid out yet */
    }
    paintedRef.current = null;
  }, [themeId, fontSize, fontFamily, lineHeight, cursorBlink]);

  // Trim history if the configured bound shrank.
  useEffect(() => {
    setHistory(previous => (previous.length > scrollbackLines ? previous.slice(previous.length - scrollbackLines) : previous));
  }, [scrollbackLines]);

  return { containerRef, status, history, focus, clearHistory, publish };
}
