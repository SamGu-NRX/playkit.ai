"""End-to-end Inspect adapter tests: mockllm over real Gauntlet episodes.

Every test runs the actual Inspect eval loop in-process with the ``mockllm``
provider (no network, no keys) against the real Node protocol server and the
real core runner, then replay-verifies the written trajectories with the
Gauntlet CLI and checks the scorer against the trajectory's outcome.

Runs only when inspect_ai is installed (``pip install inspect-ai``); the
stdlib client's own test suite never needs it.

Run with: cd gauntlet/clients/python && python3 -m unittest
"""

from __future__ import annotations

import json
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

try:
    import inspect_ai  # noqa: F401

    from inspect_ai import eval as inspect_eval
    from inspect_ai.model import ModelOutput

    from playkit_gauntlet.inspect_task import playkit_gauntlet

    HAVE_INSPECT = True
except ImportError:
    HAVE_INSPECT = False

GAUNTLET_DIR = Path(__file__).resolve().parents[3]

# The observation lists the legal actions whenever there are 64 or fewer —
# the same derivation official-track agents must do.
_LEGAL_LINE = re.compile(r"Legal actions \(\d+[^)]*\): (.+)$")


def _first_legal_action_mock(input_messages, tools, tool_choice, config) -> ModelOutput:
    """A scripted mockllm that always plays the observation's first legal action."""
    content = input_messages[-1].content
    if not isinstance(content, str):
        content = "".join(
            getattr(part, "text", "") for part in content
        )
    match = _LEGAL_LINE.search(content)
    if not match:
        return ModelOutput.from_content(model="mockllm", content="I cannot find the legal actions")
    return ModelOutput.from_content(model="mockllm", content=match.group(1).split(",")[0].strip())


@unittest.skipUnless(HAVE_INSPECT, "inspect_ai is not installed (pip install inspect-ai)")
class InspectAdapterEndToEnd(unittest.TestCase):
    def _run_eval(self, tmp: Path, **task_args):
        task = playkit_gauntlet(
            run_dir=str(tmp / "runs"), gauntlet_dir=str(GAUNTLET_DIR), **task_args
        )
        logs = inspect_eval(
            tasks=[task],
            model="mockllm/mockllm",
            model_args={"custom_outputs": _first_legal_action_mock},
            display="none",
            log_dir=str(tmp / "logs"),
            max_samples=2,
        )
        self.assertEqual(len(logs), 1)
        log = logs[0]
        self.assertEqual(log.status, "success", log.error)
        return log

    def _assert_episode(self, tmp: Path, game: str, tier: str) -> None:
        run_dir = tmp / "runs"
        files = sorted(run_dir.glob("*.json"))
        self.assertEqual(len(files), 1, f"expected one trajectory, got {files}")

        trajectory = json.loads(files[0].read_text(encoding="utf-8"))
        self.assertEqual(trajectory["format"], "playkit-gauntlet-trajectory/1")
        self.assertEqual(trajectory["game"]["id"], game)
        self.assertEqual(trajectory["tier"], tier)
        self.assertEqual(trajectory["agent"]["track"], "official")

        # The Gauntlet CLI replay-verifies the written trajectory.
        proc = subprocess.run(
            [
                "node",
                str(GAUNTLET_DIR / "cli" / "gauntlet.js"),
                "verify",
                str(files[0]),
            ],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 0, f"verify failed: {proc.stdout}{proc.stderr}")

        # The scorer matches the trajectory's outcome for the agent's seat.
        log = self._last_log
        sample = log.samples[0]
        self.assertIn("gauntlet_score", sample.scores)
        score = sample.scores["gauntlet_score"]
        seat = trajectory["agent"]["seat"]
        expected = trajectory["end"]["outcome"]["normalized"][seat]
        self.assertEqual(float(score.value), float(expected))
        self.assertEqual(score.metadata["trajectoryPath"], str(files[0]))
        self.assertEqual(score.metadata["endReason"], trajectory["end"]["reason"])
        self.assertEqual(score.metadata["game"], game)
        self.assertEqual(score.metadata["tier"], tier)
        # The scripted mock always plays a listed legal action.
        self.assertEqual(trajectory["end"]["invalidActions"], 0)
        # Every agent step carries the model's usage (mockllm counts tokens).
        agent_steps = [step for step in trajectory["steps"] if step["by"] == "agent"]
        self.assertEqual(len(agent_steps), trajectory["end"]["agentActions"])
        self.assertTrue(all(step["usage"] is not None for step in agent_steps))

    def test_tictactoe_mockllm_episode_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            log = self._run_eval(tmp, game="tictactoe", tier="perfect-opponent", seeds=1)
            self._last_log = log
            self._assert_episode(tmp, "tictactoe", "perfect-opponent")

    def test_connect4_mockllm_episode_end_to_end(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            log = self._run_eval(tmp, game="connect4", tier="ladder-1", seeds=1)
            self._last_log = log
            self._assert_episode(tmp, "connect4", "ladder-1")

    def test_dataset_is_the_manifest_episodes(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            task = playkit_gauntlet(
                run_dir=str(tmp / "runs"), gauntlet_dir=str(GAUNTLET_DIR), game="tictactoe"
            )
            # tictactoe/perfect-opponent has 8 public seeds.
            self.assertEqual(len(task.dataset), 8)
            first = task.dataset[0]
            self.assertEqual(
                first.id, "tictactoe/perfect-opponent/tictactoe/perfect-opponent/public/0"
            )
            self.assertEqual(first.metadata["seed"], "tictactoe/perfect-opponent/public/0")

    def test_seeds_cap_limits_the_dataset(self) -> None:
        with tempfile.TemporaryDirectory() as raw_tmp:
            tmp = Path(raw_tmp)
            task = playkit_gauntlet(
                run_dir=str(tmp / "runs"),
                gauntlet_dir=str(GAUNTLET_DIR),
                game="connect4",
                tier="ladder-1",
                seeds=3,
            )
            self.assertEqual(len(task.dataset), 3)
            self.assertEqual(
                task.dataset[0].metadata["seed"], "connect4/ladder-1/public/0"
            )


if __name__ == "__main__":
    unittest.main()
