"""Sentiora runtime client for Python.

Issue #4 (M4), slice 4. The same surface as `Sentiora.Client` in .NET and `agent-client` in
JavaScript, against the same stdio transport, with **no third-party dependency**: this module is
`json`, `subprocess`, `threading` and the standard library, so a host that cannot install packages
can still drive a real terminal.

    with SentioraClient.start(r"C:\\repo\\src\\server.js") as client:
        session = client.create(command=sys.executable, args=["-i"])
        client.send_line(session, "print('hello')")
        observation = client.wait_for_text(session, "hello")
        client.close(session)

The owner token lives on the `SessionHandle` and is never printed by anything here; the mailbox
capability is a separate field for the same reason it is separate in the protocol — it authorises
messages, not keystrokes.
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
import time
from dataclasses import dataclass, replace
from typing import Any, Iterable, Optional

DEFAULT_SERVER = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..", "src", "server.js")
DEFAULT_TIMEOUT_S = 30.0


class SentioraError(Exception):
    """A JSON-RPC error returned by the runtime, with the method that produced it."""

    def __init__(self, message: str, method: Optional[str] = None):
        super().__init__(message)
        self.method = method


@dataclass(frozen=True)
class SessionHandle:
    """A live session. `owner` is the capability for type/resize/close; never log it."""

    session_id: str
    owner: str
    pid: Optional[int] = None
    cols: int = 0
    rows: int = 0
    mailbox: Optional[str] = None
    child_mailbox: Optional[str] = None


class _Channel:
    """Reads stdout lines on a thread and hands each reply to the request waiting for it.

    A blocking readline in the caller would deadlock on the first request the runtime does not
    answer, which is exactly what a failing spawn looks like; a reader thread keeps a timeout
    possible without depending on `select`, which does not work on Windows pipes.
    """

    def __init__(self, stream):
        self._stream = stream
        self._lock = threading.Condition()
        self._replies: dict[Any, dict] = {}
        self._error: Optional[BaseException] = None
        self.closed = False
        self._thread = threading.Thread(target=self._read, daemon=True)
        self._thread.start()

    def _read(self) -> None:
        try:
            for line in self._stream:
                line = line.strip()
                if not line:
                    continue
                try:
                    message = json.loads(line)
                except json.JSONDecodeError:
                    continue
                with self._lock:
                    self._replies[message.get("id")] = message
                    self._lock.notify_all()
        except BaseException as error:  # noqa: BLE001 - surfaced to the waiter
            with self._lock:
                self._error = error
                self._lock.notify_all()
        finally:
            with self._lock:
                self.closed = True
                self._lock.notify_all()

    def take(self, request_id: int, timeout: float) -> dict:
        deadline = time.monotonic() + timeout
        with self._lock:
            while request_id not in self._replies:
                if self._error is not None:
                    raise SentioraError(f"the runtime's stdout failed: {self._error}")
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise SentioraError(f"no answer within {timeout * 1000:.0f}ms")
                if self.closed:
                    raise SentioraError("the runtime closed its stdout")
                self._lock.wait(min(remaining, 0.5))
            return self._replies.pop(request_id)


class SentioraClient:
    """A runtime subprocess and its JSON-RPC session."""

    def __init__(self, process: subprocess.Popen, channel: _Channel, timeout: float):
        self._process = process
        self._channel = channel
        self._timeout = timeout
        self._next_id = 0
        self.info: dict = {}

    @classmethod
    def start(
        cls,
        server_path: Optional[str] = None,
        node: Optional[str] = None,
        cwd: Optional[str] = None,
        timeout: float = DEFAULT_TIMEOUT_S,
    ) -> "SentioraClient":
        server = os.path.abspath(server_path or DEFAULT_SERVER)
        if not os.path.isfile(server):
            raise SentioraError(f"runtime not found at {server}")
        process = subprocess.Popen(
            [node or "node", server],
            cwd=cwd or os.path.dirname(os.path.dirname(server)),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )
        client = cls(process, _Channel(process.stdout), timeout)
        client.info = client.request("initialize", {})
        return client

    # -- transport -------------------------------------------------------------------------------

    def request(self, method: str, params: Optional[dict] = None, timeout: Optional[float] = None) -> Any:
        if self._process.poll() is not None:
            raise SentioraError(f"the runtime had exited ({self._process.returncode})", method)
        self._next_id += 1
        request_id = self._next_id
        payload = json.dumps({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params or {}})
        self._process.stdin.write(payload + "\n")
        self._process.stdin.flush()
        reply = self._channel.take(request_id, timeout if timeout is not None else self._timeout)
        if "error" in reply:
            raise SentioraError(reply["error"].get("message", "unknown error"), method)
        return reply.get("result")

    # -- sessions --------------------------------------------------------------------------------

    def create(
        self,
        command: str,
        args: Optional[Iterable[str]] = None,
        cols: int = 120,
        rows: int = 40,
        cwd: Optional[str] = None,
        env: Optional[dict] = None,
        parent: Optional[str] = None,
        close_children: Optional[bool] = None,
    ) -> SessionHandle:
        params: dict[str, Any] = {"command": command, "args": list(args or []), "cols": cols, "rows": rows}
        if cwd is not None:
            params["cwd"] = cwd
        if env is not None:
            params["env"] = env
        if parent is not None:
            params["parent"] = parent
        if close_children is not None:
            params["closeChildren"] = close_children
        observation = self.request("terminal.create", params)
        return SessionHandle(
            session_id=observation["sessionId"],
            owner=observation["owner"],
            pid=observation.get("pid"),
            cols=observation.get("cols", cols),
            rows=observation.get("rows", rows),
            mailbox=observation.get("mailbox"),
            child_mailbox=observation.get("childMailbox"),
        )

    def observe(self, session: SessionHandle) -> dict:
        return self.request("terminal.observe", {"sessionId": session.session_id})

    def type(self, session: SessionHandle, text: str, attempts: int = 3) -> dict:
        """Revision-armed input, retried on a stale revision exactly as the other clients do."""
        last: Optional[SentioraError] = None
        for _ in range(attempts):
            observation = self.observe(session)
            try:
                return self.request("terminal.type", {
                    "sessionId": session.session_id,
                    "owner": session.owner,
                    "revision": observation["revision"],
                    "text": text,
                })
            except SentioraError as error:
                last = error
                if "stale" not in str(error).lower():
                    raise
        raise last if last is not None else SentioraError("type failed", "terminal.type")

    def send_line(self, session: SessionHandle, line: str) -> dict:
        return self.type(session, line + "\r")

    def wait_for_text(self, session: SessionHandle, needle: str, timeout: float = 20.0, interval: float = 0.1) -> dict:
        """Polls `observe` until the needle appears. Simple and deterministic: no cursor bookkeeping
        for a caller who only wants to know when a command has printed something."""
        deadline = time.monotonic() + timeout
        observation = self.observe(session)
        while needle not in (observation.get("screen") or ""):
            if time.monotonic() > deadline:
                raise SentioraError(
                    f"'{needle}' did not appear within {timeout}s; screen:\n{observation.get('screen')}",
                    "terminal.observe",
                )
            time.sleep(interval)
            observation = self.observe(session)
        return observation

    def list(self) -> list:
        return self.request("terminal.list", {})

    def close(self, session: SessionHandle) -> bool:
        return bool(self.request("terminal.close", {"sessionId": session.session_id, "owner": session.owner}))

    # -- messaging -------------------------------------------------------------------------------

    def post(self, session: SessionHandle, payload: Any) -> dict:
        if not session.mailbox:
            raise SentioraError("this session has no mailbox capability", "terminal.post")
        return self.request("terminal.post", {
            "sessionId": session.session_id,
            "capability": session.mailbox,
            "payload": payload,
        })

    def mailbox(self, session: SessionHandle, after_sequence: int = 0, timeout_ms: int = 1000) -> dict:
        if not session.mailbox:
            raise SentioraError("this session has no mailbox capability", "terminal.mailbox")
        return self.request(
            "terminal.mailbox",
            {
                "sessionId": session.session_id,
                "capability": session.mailbox,
                "afterSequence": after_sequence,
                "timeoutMs": timeout_ms,
            },
            # The poll may legitimately outlast the default request timeout.
            timeout=(timeout_ms / 1000.0) + self._timeout,
        )

    # -- ownership -------------------------------------------------------------------------------

    def handover(self, session: SessionHandle) -> SessionHandle:
        result = self.request("terminal.handover", {"sessionId": session.session_id, "owner": session.owner})
        return replace(session, owner=result["owner"])

    # -- lifecycle -------------------------------------------------------------------------------

    def stop(self, timeout: float = 20.0) -> None:
        """Ends the runtime's stdin and waits for it to exit; kills it only after the cap."""
        if self._process.poll() is not None:
            return
        try:
            self._process.stdin.close()
        except Exception:  # noqa: BLE001 - already closed
            pass
        try:
            self._process.wait(timeout=timeout)
        except subprocess.TimeoutExpired:
            self._process.kill()

    def __enter__(self) -> "SentioraClient":
        return self

    def __exit__(self, *_: Any) -> None:
        self.stop()
