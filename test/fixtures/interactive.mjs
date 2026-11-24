// Deterministic interactive terminal fixture for the native Windows tests.
//
// Two modes, selected by argv:
//   (default)    line command protocol: each command produces exactly one
//                predictable reply, so a test can assert on an exact screen.
//   --raw-echo   every received byte chunk is echoed back as "RAW:<hex>",
//                which makes individual key presses directly observable.
//
// Every reply is framed by explicit markers so tests never have to guess where
// output ended. Output uses \r\n because the session runs on a real console.

const args = process.argv.slice(2);
const rawEcho = args.includes('--raw-echo');

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.resume();

const write = s => process.stdout.write(s);
const line = s => write(`${s}\r\n`);

write(`FIXTURE READY pid=${process.pid} raw=${rawEcho} ttyIn=${process.stdin.isTTY === true} ttyOut=${process.stdout.isTTY === true}\r\n`);

if (rawEcho) {
  process.stdin.on('data', chunk => line(`RAW:${chunk.toString('hex')}`));
  process.stdin.on('end', () => process.exit(0));
  process.on('SIGINT', () => { line('GOT-SIGINT'); process.exit(130); });
} else {
  let buffer = '';
  let redraws = 0;
  let cursors = 0;

  const commands = {
    echo: rest => line(`ECHO:${rest}`),
    pid: () => line(`PID:${process.pid}`),
    tty: () => line(`TTY:in=${process.stdin.isTTY === true},out=${process.stdout.isTTY === true},cols=${process.stdout.columns},rows=${process.stdout.rows}`),
    size: () => line(`SIZE:${process.stdout.columns}x${process.stdout.rows}`),
    ansi: () => write('\x1b[31mR\x1b[32mG\x1b[1;34mB\x1b[0mN\r\nANSI-DONE\r\n'),
    // Single write on purpose: Session flushes the emulator one PTY chunk at a
    // time, so a snapshot showing the marker proves the trailing CUP landed in
    // the same chunk and the reported cursor position is already final. The
    // marker carries a sequence number so a caller can wait for a specific
    // move instead of matching a stale one still on screen.
    cursor: rest => {
      const [row, col] = rest.split(' ').map(Number);
      cursors += 1;
      write(`\x1b[1;1HCURSOR-${cursors}\x1b[K\x1b[${row};${col}H`);
    },
    unicode: () => {
      line(`ES:cañón Ñandú ÄÖÜß\r\nRU:Съешь ещё этих булок\r\nZH:汉字终端测试\r\nUNICODE-DONE`);
    },
    bytes: rest => { write(Buffer.from(rest.replace(/\s/g, ''), 'hex')); line('BYTES-DONE'); },
    redraw: () => { redraws += 1; write(`\x1b[2J\x1b[HREDRAW-${redraws}\r\n`); },
    alt: () => {
      write('\x1b[?1049h\x1b[2J\x1b[H');
      line('┌──────────────┐');
      line('│ ALT-SCREEN   │');
      line('└──────────────┘');
    },
    unalt: () => { write('\x1b[?1049l'); line('ALT-SCREEN-EXITED'); },
    spin: () => { line('SPINNING'); setInterval(() => {}, 1000); },
    exit: rest => process.exit(Number.parseInt(rest, 10) || 0),
  };

  process.stdin.on('data', chunk => {
    buffer += chunk.toString('utf8');
    let newline;
    while ((newline = buffer.search(/[\r\n]/)) !== -1) {
      const raw = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      const [name, ...rest] = raw.split(' ');
      const command = commands[name];
      if (command) command(rest.join(' '));
      else if (name) line(`ERR:UNKNOWN-COMMAND:${name}`);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
