"""Run PlayKit Gauntlet episodes as Inspect AI tasks.

Researchers evaluate any Inspect model — a hosted provider or a local server
— on Gauntlet without writing a client:

.. code-block:: sh

    cd gauntlet/clients/python
    inspect eval playkit_gauntlet/inspect_task.py -T game=connect4 -T tier=ladder-1 \\
        --model <any Inspect model>

Every episode is still played and refereed by the Gauntlet engine: the solver
starts ``node cli/gauntlet.js serve`` (the JSON-Lines wire protocol) and plays
the episode turn by turn through the stdlib :class:`GauntletClient`, on the
official track — the one fixed system prompt and the one rebuilt turn message
(``official.py``, byte-tested against ``gauntlet/harness/official.js``). Each
finished episode's trajectory is written into a run directory so
``node cli/gauntlet.js verify <run-dir>`` replays it, and the scorer returns
the episode's normalized score for the agent's seat with the trajectory path
in metadata.

Dataset: the (game, tier, seed) episodes of a suite manifest built by
``cli/gauntlet.js suite build --split public`` — the same seed scheme the
leaderboard scores. Token usage recorded by Inspect is written to each
trajectory step; ``costUsd`` stays null unless Inspect's model reports a
price (unknown stays unknown).
"""

from __future__ import annotations

import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

# The task file is loaded by `inspect eval <path>` — make the sibling package
# importable in both that context (loaded as a bare file) and a normal
# package import.
_CLIENTS_PYTHON_DIR = Path(__file__).resolve().parents[1]
if str(_CLIENTS_PYTHON_DIR) not in sys.path:
    sys.path.insert(0, str(_CLIENTS_PYTHON_DIR))

from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.model import (
    ChatMessageSystem,
    ChatMessageUser,
    ModelOutput,
    get_model,
)
from inspect_ai.scorer import Scorer, Score, Target, mean, scorer, stderr
from inspect_ai.solver import Generate, Solver, TaskState, solver

from playkit_gauntlet.client import GauntletClient
from playkit_gauntlet.nodebridge import build_suite_manifest, node_registry
from playkit_gauntlet.official import OFFICIAL_SYSTEM_PROMPT, build_official_turn_message

__all__ = ["playkit_gauntlet", "gauntlet_solver", "gauntlet_score"]

# clients/python/playkit_gauntlet/inspect_task.py -> the gauntlet/ tree.
_DEFAULT_GAUNTLET_DIR = _CLIENTS_PYTHON_DIR.parents[1]

# Sample store keys the solver hands to the scorer.
_STORE_TRAJECTORY = "gauntlet:trajectory"
_STORE_TRAJECTORY_PATH = "gauntlet:trajectory_path"

_DEFAULT_RUN_ROOT = "gauntlet-runs"


def _resolve_gauntlet_dir(value: Optional[str]) -> Path:
    resolved = Path(value).resolve() if value else _DEFAULT_GAUNTLET_DIR
    if not (resolved / "cli" / "gauntlet.js").is_file():
        raise ValueError(
            f'"{resolved}" is not a gauntlet directory (no cli/gauntlet.js); '
            "pass -T gauntlet_dir=<path to the repository's gauntlet/>"
        )
    return resolved


def _episodes(
    gauntlet_dir: Path,
    split: str,
    game: str,
    tier: Optional[str],
    seeds: Optional[int],
) -> List[Dict[str, str]]:
    """The manifest's (game, tier, seed) episodes for one game/tier filter."""
    manifest = build_suite_manifest(gauntlet_dir, split=split, games=[game])
    games = {entry["id"]: entry for entry in manifest["games"]}
    if game not in games:
        raise ValueError(f'unknown game "{game}": the suite manifest lists none')
    entry = games[game]
    tiers = [t for t in entry["tiers"] if tier is None or t["id"] == tier]
    if not tiers:
        tier_ids = ", ".join(t["id"] for t in entry["tiers"])
        raise ValueError(f'game "{game}" has no tier "{tier}" (tiers: {tier_ids})')
    episodes: List[Dict[str, str]] = []
    for t in tiers:
        for seed in (t["seeds"][:seeds] if seeds else t["seeds"]):
            episodes.append({"game": game, "tier": t["id"], "seed": seed, "split": split})
    return episodes


def _write_trajectory(run_dir: Path, trajectory: Dict[str, Any]) -> Path:
    """Write one trajectory JSON file; never overwrite an existing one."""
    run_dir.mkdir(parents=True, exist_ok=True)
    stem = "__".join(
        [
            trajectory["game"]["id"],
            trajectory["tier"],
            trajectory["seed"].replace("/", "-"),
        ]
    )
    path = run_dir / f"{stem}.json"
    suffix = 2
    while path.exists():
        path = run_dir / f"{stem}-{suffix}.json"
        suffix += 1
    path.write_text(
        json.dumps(trajectory, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return path


def _usage_dict(output: ModelOutput) -> Optional[Dict[str, Any]]:
    """Map Inspect's usage to the protocol's usage token.

    ``total_cost`` stays None when Inspect's model reports no price — the
    trajectory's usage semantics are "unknown", never "zero".
    """
    usage = output.usage
    if usage is None:
        return None
    return {
        "inputTokens": usage.input_tokens,
        "outputTokens": usage.output_tokens,
        "costUsd": usage.total_cost,
    }


@solver
def gauntlet_solver(
    gauntlet_dir: Optional[str] = None, run_dir: Optional[str] = None
) -> Solver:
    """Play each sample's Gauntlet episode against the active Inspect model.

    One protocol server per episode. Nothing carries over between turns —
    the official-track message is rebuilt every turn from the rules text,
    the previous reply, the feedback, and the current observation, exactly
    as ``harness/official.js`` does it.
    """

    async def solve(state: TaskState, generate: Generate) -> TaskState:
        metadata = state.metadata
        game, tier, seed = metadata["game"], metadata["tier"], metadata["seed"]
        split = metadata.get("split", "public")
        resolved_dir = _resolve_gauntlet_dir(gauntlet_dir)
        registry = node_registry(resolved_dir)
        if game not in registry:
            raise ValueError(f'unknown game "{game}" (not in the gauntlet registry)')
        rules_text = registry[game]["rulesText"]

        model = get_model()
        agent_id = f"inspect-{model.name}"

        with GauntletClient(
            server_path=str(resolved_dir / "cli" / "gauntlet.js"),
            server_args=["serve"],
        ) as client:
            response = client.reset(
                game=game,
                tier=tier,
                seed=seed,
                split=split,
                agent_id=agent_id,
                track="official",
            )
            previous_reply: Optional[str] = None
            while "turn" in response:
                turn = response["turn"]
                message = build_official_turn_message(
                    {
                        "spec": {"rulesText": rules_text},
                        "observation": turn["observation"],
                        "feedback": turn["feedback"],
                    },
                    previous_reply,
                )
                state.messages = [
                    ChatMessageSystem(content=OFFICIAL_SYSTEM_PROMPT),
                    ChatMessageUser(content=message),
                ]
                output = await model.generate(state.messages)
                state.messages.append(output.message)
                previous_reply = output.completion
                response = client.act(
                    previous_reply,
                    usage=_usage_dict(output),
                )
            trajectory = client.trajectory()

        path = _write_trajectory(
            Path(run_dir) if run_dir else Path(_DEFAULT_RUN_ROOT), trajectory
        )
        state.store.set(_STORE_TRAJECTORY, trajectory)
        state.store.set(_STORE_TRAJECTORY_PATH, str(path))
        return state

    return solve


@scorer(metrics=[mean(), stderr()])
def gauntlet_score() -> Scorer:
    """The episode's normalized score for the agent's seat, in [0, 1].

    Metadata carries the trajectory path (verify it with
    ``node cli/gauntlet.js verify <dir>``), the end reason, and the action
    counts.
    """

    async def score(state: TaskState, target: Target) -> Score:
        trajectory = state.store.get(_STORE_TRAJECTORY)
        path = state.store.get(_STORE_TRAJECTORY_PATH)
        if trajectory is None:
            return Score(value=0.0, answer="no trajectory recorded")
        end = trajectory["end"]
        outcome = end["outcome"]
        seat = trajectory["agent"]["seat"]
        common_metadata = {
            "trajectoryPath": str(path),
            "game": trajectory["game"]["id"],
            "tier": trajectory["tier"],
            "seed": trajectory["seed"],
            "agentSeat": seat,
            "agentId": trajectory["agent"]["id"],
            "endReason": end["reason"],
            "agentActions": end["agentActions"],
            "invalidActions": end["invalidActions"],
        }
        if outcome is None:
            return Score(value=0.0, answer=end["reason"], metadata=common_metadata)
        return Score(
            value=float(outcome["normalized"][seat]),
            answer=str(outcome["reason"]),
            metadata=common_metadata,
        )

    return score


@task
def playkit_gauntlet(
    game: str = "tictactoe",
    tier: Optional[str] = None,
    split: str = "public",
    seeds: Optional[int] = None,
    run_dir: Optional[str] = None,
    gauntlet_dir: Optional[str] = None,
) -> Task:
    """Gauntlet episodes as an Inspect task.

    Args:
        game: Registry id, e.g. ``tictactoe`` or ``connect4``.
        tier: Tier id (default: every tier of the game).
        split: ``public`` only — eval seeds need the salt file and are not
            part of this adapter.
        seeds: Cap the seed count per tier (default: all public seeds).
        run_dir: Directory for the episodes' trajectories (default:
            ``gauntlet-runs/<UTC timestamp>``, one per eval).
        gauntlet_dir: The repository's ``gauntlet/`` tree (default: the one
            this package lives in).
    """
    if split != "public":
        raise ValueError(f'split must be "public", got {split!r}')
    resolved_dir = _resolve_gauntlet_dir(gauntlet_dir)
    episodes = _episodes(resolved_dir, split, game, tier, seeds)
    if not episodes:
        raise ValueError("the suite manifest lists no episodes for that filter")
    final_run_dir = run_dir or (
        f"{_DEFAULT_RUN_ROOT}/{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}"
    )
    dataset = [
        Sample(
            id=f"{episode['game']}/{episode['tier']}/{episode['seed']}",
            input=(
                f"Play the Gauntlet episode {episode['seed']} on the official "
                "track: choose the winning action each turn. The solver drives "
                "the Gauntlet protocol server and rebuilds the official turn "
                "message from the engine's observation every turn."
            ),
            metadata=episode,
        )
        for episode in episodes
    ]
    return Task(
        dataset=dataset,
        solver=gauntlet_solver(gauntlet_dir=str(resolved_dir), run_dir=final_run_dir),
        scorer=gauntlet_score(),
    )
