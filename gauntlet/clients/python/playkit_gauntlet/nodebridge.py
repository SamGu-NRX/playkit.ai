"""Small Node helpers the Inspect adapter runs against the Gauntlet sources.

Everything here shells out to the repository's own Node code instead of
reimplementing it in Python: registry metadata and suite manifests come from
the authoritative sources (``games/index.js`` and ``cli/gauntlet.js suite
build``), so seed lists cannot drift from what the CLI scores, and the
byte-identity tests can compare the Python turn-message rebuild against
``harness/official.js``. Requires Node 20+ on the PATH.

Every helper is stdlib-only; ``inspect_task`` is the only runtime caller and
the tests call the byte helpers directly.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

__all__ = [
    "NodeBridgeError",
    "node_registry",
    "build_suite_manifest",
    "node_official_system_prompt",
    "node_official_turn_message",
]


class NodeBridgeError(RuntimeError):
    """A Node helper subprocess failed."""


# Dumps the game registry (spec metadata incl. rulesText) as one JSON object.
_REGISTRY_SCRIPT = """\
import { pathToFileURL } from 'node:url';
const { GAMES } = await import(pathToFileURL(process.env.GAUNTLET_DIR + '/games/index.js').href);
const out = {};
for (const [id, game] of Object.entries(GAMES)) {
  out[id] = {
    id: game.spec.id,
    version: game.spec.version,
    title: game.spec.title,
    benchmark: game.spec.benchmark,
    rulesText: game.spec.rulesText,
    tiers: game.spec.tiers.map((t) => ({
      id: t.id,
      rank: t.rank,
      scoring: t.scoring,
      maxActions: t.maxActions,
    })),
  };
}
process.stdout.write(JSON.stringify(out));
"""

# Builds one official-track turn message with the real harness code. The
# payload {ctx, previousReply} arrives on stdin; the message is written
# without a trailing newline so Python can compare bytes exactly.
_MESSAGE_SCRIPT = """\
import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
const mod = await import(
  pathToFileURL(process.env.GAUNTLET_DIR + '/harness/official.js').href
);
const payload = JSON.parse(readFileSync(0, 'utf8'));
process.stdout.write(mod.buildOfficialTurnMessage(payload.ctx, payload.previousReply));
"""

# Dumps OFFICIAL_SYSTEM_PROMPT verbatim (no trailing newline).
_SYSTEM_SCRIPT = """\
import { pathToFileURL } from 'node:url';
const mod = await import(
  pathToFileURL(process.env.GAUNTLET_DIR + '/harness/official.js').href
);
process.stdout.write(mod.OFFICIAL_SYSTEM_PROMPT);
"""


def _run_node_script(gauntlet_dir: Path, script: str, stdin_bytes: Optional[bytes] = None) -> bytes:
    """Run one helper script with GAUNTLET_DIR set; return exact stdout bytes."""
    env = {**os.environ, "GAUNTLET_DIR": str(gauntlet_dir)}
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script],
        input=stdin_bytes,
        env=env,
        capture_output=True,
    )
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", "replace")[-2000:]
        raise NodeBridgeError(f"node helper failed (exit {proc.returncode}): {stderr}")
    return proc.stdout


def _check_gauntlet_dir(gauntlet_dir: Path) -> Path:
    resolved = Path(gauntlet_dir).resolve()
    if not (resolved / "cli" / "gauntlet.js").is_file():
        raise NodeBridgeError(
            f'"{resolved}" is not a gauntlet directory (no cli/gauntlet.js); '
            "pass gauntlet_dir explicitly"
        )
    return resolved


_REGISTRY_CACHE: Dict[str, Dict[str, Any]] = {}


def node_registry(gauntlet_dir: Path) -> Dict[str, Any]:
    """The game registry as Node sees it: spec metadata incl. rulesText.

    Cached per resolved directory — the registry is immutable once the Node
    process would have loaded it, and an eval run spawns this once per sample
    otherwise.
    """
    resolved = _check_gauntlet_dir(Path(gauntlet_dir))
    key = str(resolved)
    if key not in _REGISTRY_CACHE:
        _REGISTRY_CACHE[key] = json.loads(_run_node_script(resolved, _REGISTRY_SCRIPT))
    return _REGISTRY_CACHE[key]


def build_suite_manifest(
    gauntlet_dir: Path, split: str = "public", games: Optional[List[str]] = None
) -> Dict[str, Any]:
    """Build a suite manifest with the CLI (``suite build``), parsed.

    The manifest pins the exact (game, tier, seed) episodes an entry must
    cover; building it through the CLI keeps the adapter on the same seed
    scheme the leaderboard scores. Public split only — eval seeds need the
    salt file and are not part of the Inspect adapter.
    """
    resolved = _check_gauntlet_dir(Path(gauntlet_dir))
    if split != "public":
        raise NodeBridgeError(
            f'split must be "public" (eval seeds need a salt file and are '
            f"reserved for the graded split), got {split!r}"
        )
    cmd = ["node", str(resolved / "cli" / "gauntlet.js"), "suite", "build", "--split", split]
    if games:
        cmd += ["--games", ",".join(games)]
    proc = subprocess.run(cmd, capture_output=True)
    if proc.returncode != 0:
        stderr = proc.stderr.decode("utf-8", "replace")[-2000:]
        raise NodeBridgeError(
            f"suite build failed (exit {proc.returncode}): {stderr}"
        )
    manifest = json.loads(proc.stdout)
    if manifest.get("format") != "playkit-gauntlet-suite/1":
        raise NodeBridgeError(
            f"suite build produced format {manifest.get('format')!r}; expected "
            '"playkit-gauntlet-suite/1"'
        )
    return manifest


def node_official_system_prompt(gauntlet_dir: Path) -> bytes:
    """OFFICIAL_SYSTEM_PROMPT exactly as the Node harness defines it."""
    resolved = _check_gauntlet_dir(Path(gauntlet_dir))
    return _run_node_script(resolved, _SYSTEM_SCRIPT)


def node_official_turn_message(
    gauntlet_dir: Path, ctx: Dict[str, Any], previous_reply: Optional[str]
) -> bytes:
    """buildOfficialTurnMessage(ctx, previousReply) exactly as Node writes it."""
    resolved = _check_gauntlet_dir(Path(gauntlet_dir))
    payload = json.dumps(
        {"ctx": ctx, "previousReply": previous_reply}, ensure_ascii=False
    ).encode("utf-8")
    return _run_node_script(resolved, _MESSAGE_SCRIPT, stdin_bytes=payload)
