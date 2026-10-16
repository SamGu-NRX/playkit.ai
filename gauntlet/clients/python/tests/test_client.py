"""End-to-end tests for the Python client: every test drives the real Node
protocol server over real pipes through full tictactoe episodes. No network,
no paid APIs, no in-process stubs.

Run with: cd gauntlet/clients/python && python3 -m unittest
"""

from __future__ import annotations

import random
import re
import unittest

from playkit_gauntlet import GauntletClient, GauntletError
from playkit_gauntlet.example_random import legal_actions_from_text

SEED_0 = "tictactoe/perfect-opponent/public/0"
SEED_1 = "tictactoe/perfect-opponent/public/1"
SEED_2 = "tictactoe/perfect-opponent/public/2"
SEED_3 = "tictactoe/perfect-opponent/public/3"

_LEGAL_LINE = re.compile(r"Legal actions \(\d+[^)]*\): (.+)$")


class GauntletClientEndToEnd(unittest.TestCase):
    def setUp(self) -> None:
        self.client = GauntletClient()

    def tearDown(self) -> None:
        self.client.close()

    def test_list_games_registers_tictactoe(self) -> None:
        games = self.client.list_games()
        ids = [game["id"] for game in games]
        self.assertIn("tictactoe", ids)
        tictactoe = next(game for game in games if game["id"] == "tictactoe")
        self.assertEqual([tier["id"] for tier in tictactoe["tiers"]], ["perfect-opponent"])
        self.assertEqual(tictactoe["tiers"][0]["maxActions"], 20)

    def test_full_community_episode(self) -> None:
        rng = random.Random(SEED_0)
        response = self.client.reset(
            game="tictactoe",
            tier="perfect-opponent",
            seed=SEED_0,
            agent_id="unittest-random",
            track="community",
        )
        plies = 0
        while "turn" in response:
            turn = response["turn"]
            self.assertIsInstance(turn["legalActions"], list)
            self.assertGreater(len(turn["legalActions"]), 0)
            move = rng.choice(turn["legalActions"])
            response = self.client.act(move)
            plies += 1
            self.assertLess(plies, 50, "episode did not finish")
        self.assertTrue(response["done"])
        self.assertIn(response["end"]["reason"], ("terminal", "budget-exhausted", "forfeit-invalid"))
        self.assertEqual(response["end"]["agentActions"], plies)

        trajectory = self.client.trajectory()
        self.assertEqual(trajectory["format"], "playkit-gauntlet-trajectory/1")
        self.assertEqual(trajectory["game"]["id"], "tictactoe")
        self.assertEqual(trajectory["seed"], SEED_0)
        self.assertEqual(trajectory["end"]["agentActions"], plies)
        self.assertGreaterEqual(len(trajectory["steps"]), plies)

        # act after done is an error until the next reset
        with self.assertRaises(GauntletError):
            self.client.act("a1")

    def test_official_track_hides_legal_actions(self) -> None:
        rng = random.Random(SEED_1 + "/official")
        response = self.client.reset(
            game="tictactoe",
            tier="perfect-opponent",
            seed=SEED_1,
            agent_id="unittest-official",
            track="official",
        )
        plies = 0
        while "turn" in response:
            turn = response["turn"]
            self.assertIsNone(turn["legalActions"])
            legal = legal_actions_from_text(turn["observation"]["text"])
            self.assertTrue(legal)
            response = self.client.act(rng.choice(legal))
            plies += 1
            self.assertLess(plies, 50, "episode did not finish")
        self.assertTrue(response["done"])
        self.assertEqual(response["end"]["agentActions"], plies)

        trajectory = self.client.trajectory()
        self.assertEqual(trajectory["agent"]["track"], "official")
        self.assertEqual(trajectory["end"]["agentActions"], plies)

    def test_invalid_attempts_give_feedback_and_forfeit_after_three(self) -> None:
        self.client.reset(
            game="tictactoe",
            tier="perfect-opponent",
            seed=SEED_2,
            agent_id="unittest-forfeit",
            track="community",
        )
        for attempt in range(3):
            response = self.client.act("zz9")
            if attempt < 2:
                self.assertIn("turn", response)
                self.assertIsNotNone(response["turn"]["feedback"])
                self.assertIn("zz9", str(response["turn"]["feedback"]))
        self.assertTrue(response["done"])
        self.assertEqual(response["end"]["reason"], "forfeit-invalid")
        self.assertEqual(response["end"]["invalidActions"], 3)

        trajectory = self.client.trajectory()
        self.assertTrue(all(step["invalid"] for step in trajectory["steps"]))
        agent_seat = trajectory["agent"]["seat"]
        self.assertEqual(trajectory["end"]["outcome"]["normalized"][agent_seat], 0)

    def test_act_before_reset_raises(self) -> None:
        with self.assertRaises(GauntletError):
            self.client.act("a1")

    def test_trajectory_before_reset_raises(self) -> None:
        with self.assertRaises(GauntletError):
            self.client.trajectory()

    def test_unknown_game_raises(self) -> None:
        with self.assertRaises(GauntletError) as caught:
            self.client.reset(game="not-a-game")
        self.assertIn("unknown game", str(caught.exception))

    def test_unknown_tier_raises(self) -> None:
        with self.assertRaises(GauntletError) as caught:
            self.client.reset(game="tictactoe", tier="impossible-tier")
        self.assertIn("no tier", str(caught.exception))

    def test_reset_while_playing_raises(self) -> None:
        self.client.reset(
            game="tictactoe",
            tier="perfect-opponent",
            seed=SEED_3,
            agent_id="unittest-reset",
            track="community",
        )
        with self.assertRaises(GauntletError) as caught:
            self.client.reset(game="tictactoe", seed=SEED_3)
        self.assertIn("already in progress", str(caught.exception))

        # finish the first episode, then reset works
        response: dict = {"op": ""}
        for _ in range(3):
            response = self.client.act("nope")
            if response.get("done"):
                break
        self.assertTrue(response["done"])
        fresh = self.client.reset(
            game="tictactoe",
            tier="perfect-opponent",
            seed=SEED_3,
            agent_id="unittest-reset",
            track="community",
        )
        self.assertIn("turn", fresh)

    def test_usage_is_recorded_in_the_trajectory(self) -> None:
        self.client.reset(
            game="tictactoe",
            tier="perfect-opponent",
            seed=SEED_0,
            agent_id="unittest-usage",
            track="community",
        )
        rng = random.Random(SEED_0 + "/usage")
        response = self.client.act(
            "b2", usage={"inputTokens": 11, "outputTokens": 1, "costUsd": 0.0}
        )
        plies = 0
        while "turn" in response:
            move = rng.choice(response["turn"]["legalActions"])
            response = self.client.act(move)
            plies += 1
            self.assertLess(plies, 50, "episode did not finish")
        self.assertTrue(response["done"])
        trajectory = self.client.trajectory()
        recorded = [step for step in trajectory["steps"] if step["usage"]]
        self.assertTrue(recorded)
        self.assertEqual(recorded[0]["usage"]["inputTokens"], 11)

    def test_close_terminates_the_server(self) -> None:
        self.client.list_games()
        self.client.close()
        self.assertIsNotNone(self.client.process.poll())

    def test_context_manager_closes_the_server(self) -> None:
        with GauntletClient() as client:
            client.list_games()
        self.assertIsNotNone(client.process.poll())


if __name__ == "__main__":
    unittest.main()
