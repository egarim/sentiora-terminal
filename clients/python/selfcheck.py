#!/usr/bin/env python3
"""Self-check for the Python client (issue #4, M4 slice 4).

Runs the real runtime over the real subprocess transport and a real PTY, and prints PASS/FAIL lines
so a caller can assert on the output and the exit code. No test framework: the whole point of this
client is that a host with only the standard library can use it, and that should include checking it.
"""

from __future__ import annotations

import os
import shutil
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from sentiora_client import SentioraClient, SentioraError  # noqa: E402


def main(argv: list[str]) -> int:
    repo = os.path.abspath(argv[1]) if len(argv) > 1 else os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    server = os.path.join(repo, "src", "server.js")
    fixture = os.path.join(repo, "test", "fixtures", "interactive.mjs")
    if not os.path.isfile(server) or not os.path.isfile(fixture):
        print(f"usage: python selfcheck.py <repo-root>  (expected {server} and {fixture})")
        return 2

    checks = 0
    failures = 0

    def check(ok: bool, name: str, detail: object = "") -> None:
        nonlocal checks, failures
        checks += 1
        if ok:
            print(f"PASS {name}")
        else:
            failures += 1
            print(f"FAIL {name}: {detail}")

    try:
        client_cm = SentioraClient.start(server, cwd=repo)
    except Exception as error:
        print(f"FAIL the runtime could not be started: {error}")
        return 1

    with client_cm as client:
        check(client.info.get("protocolVersion") == 1, "initialize reports protocol version 1", client.info)

        node = shutil.which("node") or "node"  # node-pty needs an absolute program path, not a PATH name
        session = client.create(command=node, args=[fixture], cols=80, rows=20)
        check(bool(session.pid) and session.pid > 0, "create returns a real child pid", session.pid)
        check(bool(session.mailbox), "create returns a mailbox capability")
        check(session.mailbox != session.owner, "the mailbox capability is not the owner token")

        client.wait_for_text(session, "FIXTURE READY")
        client.send_line(session, "echo PY-OK")
        observed = client.wait_for_text(session, "ECHO:PY-OK")
        check("ECHO:PY-OK" in observed["screen"], "a command round-trips through the Python client")
        check(observed["state"] in ("operational", "spawned"), "observe reports an objective state", observed["state"])

        posted = client.post(session, {"kind": "task", "text": "ping"})
        check(posted.get("sequence") == 1, "a message is posted with a sequence", posted)
        frame = client.mailbox(session, after_sequence=0, timeout_ms=500)
        delivered = frame.get("messages") or []
        check(
            len(delivered) == 1 and delivered[0].get("payload", {}).get("text") == "ping",
            "the mailbox returns the posted message",
            frame,
        )

        handed = client.handover(session)
        check(handed.owner != session.owner, "handover issues a new owner token")
        try:
            client.close(session)
            check(False, "the old token is refused after a handover", "close succeeded with the stale token")
        except SentioraError:
            check(True, "the old token is refused after a handover")

        check(client.close(handed) is True, "the new owner can close the session")
        check(client.list() == [], "a closed session leaves the registry", client.list())

    print(f"PYTHON CLIENT SELF-CHECK {'PASSED' if failures == 0 else 'FAILED'}: {checks} checks, {failures} failure(s)")
    return 0 if failures == 0 else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
