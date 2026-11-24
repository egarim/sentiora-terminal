// Cooked-mode child used to prove Ctrl+C reaches the foreground process as a
// real SIGINT through ConPTY. Deliberately does NOT enable raw mode: with raw
// mode the console hands ^C to the application as byte 0x03 instead of
// raising CTRL_C_EVENT, so the two paths must be tested separately.

process.stdout.write(`WAITING-FOR-CTRL-C pid=${process.pid}\r\n`);

process.on('SIGINT', () => {
  process.stdout.write('GOT-SIGINT\r\n');
  process.exit(130);
});

setInterval(() => {}, 1000);
