"""The Gauntlet protocol client.

One :class:`GauntletClient` owns one server subprocess and one episode at a
time. The protocol is strictly sequential: send one request line, read one
response line. Every public method raises :class:`GauntletError` when the
server answers ``ok: false``.
"""

from __future__ import annotations

import json
import subprocess
from pathlib import Path
from types import TracebackType
from typing import Any, Dict, Optional

__all__ = ["GauntletClient", "GauntletError"]

# clients/python/playkit_gauntlet/client.py -> gauntlet/protocol/server.js
_DEFAULT_SERVER = Path(__file__).resolve().parents[3] / "protocol" / "server.js"


class GauntletError(RuntimeError):
    """An error response (or transport failure) from the protocol server."""

    def __init__(self, message: str, response: Optional[Dict[str, Any]] = None):
        super().__init__(message)
        self.response: Dict[str, Any] = response or {}


class GauntletClient:
    """A session with one PlayKit Gauntlet protocol server.

    The server runs the episode loop entirely in the core runner: after
    :meth:`reset` and after every :meth:`act`, the response carries either the
    next turn — ``{"turn": {"seat", "observation", "legalActions", "feedback"}}``
    where ``legalActions`` is null on the official track — or the finished
    episode, ``{"done": True, "end": {...}}``.

    Args:
        server_path: Path to the protocol server script. Defaults to the
            ``gauntlet/protocol/server.js`` next to this package.
        node_executable: Node binary used to run the server (default ``node``).
            Node 20 or later is required.
    """

    def __init__(self, server_path: Optional[str] = None, node_executable: str = "node"):
        resolved = Path(server_path) if server_path else _DEFAULT_SERVER
        if not resolved.is_file():
            raise FileNotFoundError(
                f"protocol server not found at {resolved}; pass server_path explicitly"
            )
        self.server_path = str(resolved)
        self._next_id = 1
        self._closed = False
        self.process: subprocess.Popen[str] = subprocess.Popen(
            [node_executable, self.server_path],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,  # line buffered, matching the JSON Lines protocol
        )

    # -- low-level request/response -----------------------------------------

    def _send(self, payload: Dict[str, Any]) -> None:
        if self.process.stdin is None:
            raise GauntletError("the protocol server has no stdin pipe")
        if self.process.poll() is not None:
            raise GauntletError(
                f"the protocol server exited with code {self.process.returncode}"
            )
        try:
            self.process.stdin.write(json.dumps(payload) + "\n")
            self.process.stdin.flush()
        except (BrokenPipeError, ValueError) as exc:
            raise GauntletError(f"failed writing to the protocol server: {exc}") from exc

    def _read(self) -> Dict[str, Any]:
        if self.process.stdout is None:
            raise GauntletError("the protocol server has no stdout pipe")
        line = self.process.stdout.readline()
        if line == "":
            stderr_tail = ""
            if self.process.stderr is not None:
                stderr_tail = self.process.stderr.read()[-2000:]
            raise GauntletError(
                "the protocol server closed its stdout before answering"
                + (f"; stderr tail: {stderr_tail}" if stderr_tail else "")
            )
        try:
            response = json.loads(line)
        except json.JSONDecodeError as exc:
            raise GauntletError(f"unparseable response line {line!r}: {exc}") from exc
        if not isinstance(response, dict):
            raise GauntletError(f"response is not a JSON object: {line!r}")
        return response

    def _request(self, op: str, **fields: Any) -> Dict[str, Any]:
        """Send one request and return the full response payload.

        Raises:
            GauntletError: when the server answers ``ok: false`` or the
                transport breaks.
        """
        request: Dict[str, Any] = {"id": self._next_id, "op": op, **fields}
        self._next_id += 1
        self._send(request)
        response = self._read()
        if not response.get("ok"):
            raise GauntletError(
                str(response.get("error") or "the server returned an error without a message"),
                response,
            )
        return response

    # -- public protocol operations ------------------------------------------

    def list_games(self) -> list[Dict[str, Any]]:
        """The registered games with their tiers."""
        return list(self._request(op="list")["games"])

    def reset(
        self,
        game: str,
        tier: Optional[str] = None,
        seed: Optional[str] = None,
        split: Optional[str] = None,
        agent_id: Optional[str] = None,
        track: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Start one episode; one episode per reset.

        Returns the response payload: ``{"turn": ...}`` for the first agent
        decision or ``{"done": True, "end": ...}`` if the episode ends
        immediately. ``turn["legalActions"]`` is null on the official track.

        Args:
            game: Registry id, e.g. ``"tictactoe"`` (see :meth:`list_games`).
            tier: Tier id; defaults to the game's first tier.
            seed: Episode seed; defaults to public seed 0 of the tier.
            split: ``"public"`` (default) or ``"eval"``.
            agent_id: The agent's id in the recorded trajectory.
            track: ``"official"`` (default), ``"community"``, or
                ``"baseline"``. Official-track turns hide ``legalActions``.
        """
        fields: Dict[str, Any] = {"game": game}
        if tier is not None:
            fields["tier"] = tier
        if seed is not None:
            fields["seed"] = seed
        if split is not None:
            fields["split"] = split
        if agent_id is not None:
            fields["agentId"] = agent_id
        if track is not None:
            fields["track"] = track
        return self._request(op="reset", **fields)

    def act(self, text: str, usage: Optional[Dict[str, Any]] = None, meta: Any = None) -> Dict[str, Any]:
        """Submit the agent reply for the current turn.

        The runner reads the action from the reply's last non-empty line, so
        ``text`` may be the bare action or a fuller reply. Invalid attempts
        come back as the next turn's ``feedback`` and consume the budget.

        Returns ``{"turn": ...}`` for the next decision or
        ``{"done": True, "end": ...}`` when the episode is over.
        """
        fields: Dict[str, Any] = {"text": text}
        if usage is not None:
            fields["usage"] = usage
        if meta is not None:
            fields["meta"] = meta
        return self._request(op="act", **fields)

    def trajectory(self) -> Dict[str, Any]:
        """The recorded trajectory of the finished episode.

        Replays cleanly through the core's ``verifyTrajectory``; use the CLI
        (``node gauntlet/cli/gauntlet.js verify <file>``) to verify it outside
        this process.
        """
        return dict(self._request(op="trajectory")["trajectory"])

    def close(self, timeout: float = 10.0) -> None:
        """Send close and wait for the server process to exit."""
        if self._closed:
            return
        self._closed = True
        try:
            if self.process.poll() is None:
                try:
                    self._request(op="close")
                except GauntletError:
                    pass  # the exit below is what matters
        finally:
            for stream in (self.process.stdin, self.process.stdout):
                if stream is not None:
                    try:
                        stream.close()
                    except OSError:
                        pass
            try:
                self.process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                self.process.kill()
                self.process.wait(timeout=timeout)

    def __enter__(self) -> "GauntletClient":
        return self

    def __exit__(
        self,
        exc_type: Optional[type[BaseException]],
        exc: Optional[BaseException],
        traceback: Optional[TracebackType],
    ) -> None:
        self.close()
