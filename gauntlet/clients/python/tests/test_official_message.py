"""Byte-identity tests for the Python rebuild of the official-track message.

The adapter must put in front of the model exactly what Gauntlet's own
harness would: ``tests`` here run ``gauntlet/harness/official.js`` through
Node on shared vectors and compare bytes. No inspect_ai required — the
rebuild is client-side, stdlib-only code.

Run with: cd gauntlet/clients/python && python3 -m unittest
"""

from __future__ import annotations

import unittest
from pathlib import Path

from playkit_gauntlet.nodebridge import (
    node_official_system_prompt,
    node_official_turn_message,
    node_registry,
)
from playkit_gauntlet.official import (
    NO_PREVIOUS_REPLY,
    OFFICIAL_SYSTEM_PROMPT,
    build_official_turn_message,
)

GAUNTLET_DIR = Path(__file__).resolve().parents[3]


def _real_rules_text() -> str:
    return node_registry(GAUNTLET_DIR)["tictactoe"]["rulesText"]


class OfficialSystemPromptByteIdentity(unittest.TestCase):
    def test_system_prompt_matches_node_bytes(self) -> None:
        self.assertEqual(
            node_official_system_prompt(GAUNTLET_DIR),
            OFFICIAL_SYSTEM_PROMPT.encode("utf-8"),
        )


class OfficialTurnMessageByteIdentity(unittest.TestCase):
    """Shared vectors: the Python output must equal the Node output, bytes."""

    def _check(self, ctx: dict, previous_reply) -> None:
        node_bytes = node_official_turn_message(GAUNTLET_DIR, ctx, previous_reply)
        python_bytes = build_official_turn_message(ctx, previous_reply).encode("utf-8")
        self.assertEqual(node_bytes, python_bytes)

    def test_first_turn(self) -> None:
        ctx = {
            "spec": {"rulesText": _real_rules_text()},
            "observation": {
                "text": (
                    "Tic-Tac-Toe. You are seat 0 (X) and move first.\n"
                    "Board:\n. . .\n. . .\n. . .\n"
                    "Legal actions (9): a1, a2, a3, b1, b2, b3, c1, c2, c3"
                )
            },
            "feedback": None,
        }
        self._check(ctx, None)

    def test_feedback_turn(self) -> None:
        ctx = {
            "spec": {"rulesText": _real_rules_text()},
            "observation": {
                "text": (
                    "Tic-Tac-Toe. You are seat 0 (X).\n"
                    "Board:\nX . .\n. O .\n. . .\n"
                    "Legal actions (7): a2, a3, b1, b3, c1, c2, c3"
                )
            },
            "feedback": 'expected a legal action: "zz9" is not one of the documented alternates.',
        }
        self._check(ctx, "b2")

    def test_unicode_and_newlines(self) -> None:
        ctx = {
            "spec": {
                "rulesText": "Résumé of the rules ✓\nsecond line — em dash\nτ-shaped note"
            },
            "observation": {"text": "Board:\n× ○ ×\n… multiline …\n✓\n"},
            "feedback": "multi-line\nfeedback\n…",
        }
        self._check(ctx, "drop into càlumn 4 ✓")


class PreviousReplyHandling(unittest.TestCase):
    """The rebuild alone: blank replies collapse to (none), as in Node."""

    def test_none_becomes_placeholder(self) -> None:
        ctx = {"spec": {"rulesText": "R"}, "observation": {"text": "S"}}
        self.assertIn(f"Your previous reply:\n{NO_PREVIOUS_REPLY}", build_official_turn_message(ctx, None))

    def test_empty_and_blank_become_placeholder(self) -> None:
        ctx = {"spec": {"rulesText": "R"}, "observation": {"text": "S"}}
        for blank in ("", "   \n\t "):
            self.assertEqual(
                build_official_turn_message(ctx, blank),
                build_official_turn_message(ctx, None),
                "a blank reply must be treated exactly like no reply",
            )

    def test_real_reply_carried_in_full(self) -> None:
        ctx = {"spec": {"rulesText": "R"}, "observation": {"text": "S"}}
        message = build_official_turn_message(ctx, "b2 -- taking the center")
        self.assertIn("Your previous reply:\nb2 -- taking the center", message)

    def test_empty_feedback_omitted(self) -> None:
        ctx = {
            "spec": {"rulesText": "R"},
            "observation": {"text": "S"},
            "feedback": "",
        }
        self.assertNotIn("Feedback on your previous reply", build_official_turn_message(ctx, None))

    def test_missing_rules_text_raises(self) -> None:
        with self.assertRaises(ValueError):
            build_official_turn_message({"observation": {"text": "S"}}, None)
        with self.assertRaises(ValueError):
            build_official_turn_message({"spec": {"rulesText": 3}, "observation": {"text": "S"}}, None)

    def test_missing_observation_raises(self) -> None:
        with self.assertRaises(ValueError):
            build_official_turn_message({"spec": {"rulesText": "R"}}, None)


if __name__ == "__main__":
    unittest.main()
