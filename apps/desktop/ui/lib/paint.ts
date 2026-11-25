/**
 * Turns a rendered viewport from the bridge into a single xterm.js write.
 *
 * The bridge delivers whole screens, not bytes, so the terminal is repainted by
 * absolute cursor addressing rather than by appending. Only rows that changed are
 * rewritten, which keeps a busy session cheap; a `resync` frame rewrites all of
 * them, because after a gap the previous content cannot be trusted as a diff base.
 */

/**
 * Screen content is untrusted data (a program can print anything), and this text
 * is handed to a terminal emulator that will execute whatever escape sequences it
 * finds. The rendered cells should never contain control bytes, so stripping them
 * is defence in depth rather than a functional transformation.
 */
// Matches C0 and C1 control bytes, ESC (0x1b) included.
const CONTROL_BYTES = /[\u0000-\u001f\u007f-\u009f]/g;

export function sanitizeLine(line: string): string {
  return line.replace(CONTROL_BYTES, '');
}

export interface PaintInput {
  lines: string[];
  rows: number;
  cols: number;
  cursor?: { x: number; y: number } | null;
  /** Previously painted lines, or null to force a full repaint. */
  previous?: string[] | null;
  resync?: boolean;
}

export function buildRepaint({ lines, rows, cols, cursor, previous, resync }: PaintInput): string {
  const full = resync === true || !previous;
  const parts: string[] = [];
  const rowCount = Math.max(0, Math.min(rows, 4096));
  for (let row = 0; row < rowCount; row += 1) {
    const line = sanitizeLine(lines[row] ?? '').slice(0, cols);
    if (!full && previous?.[row] === line) continue;
    // Move to the row, write it, then clear to end of line so shrinking content
    // does not leave the previous row's tail behind.
    parts.push(`\u001b[${row + 1};1H${line}\u001b[K`);
  }
  if (cursor) {
    const x = Math.max(1, Math.min(cols, cursor.x + 1));
    const y = Math.max(1, Math.min(rowCount || 1, cursor.y + 1));
    parts.push(`\u001b[${y};${x}H`);
  }
  return parts.join('');
}

/** Normalises a frame's lines to exactly `rows` entries so painting never drifts. */
export function normalizeLines(lines: string[], rows: number): string[] {
  const out = lines.slice(0, rows);
  while (out.length < rows) out.push('');
  return out;
}
