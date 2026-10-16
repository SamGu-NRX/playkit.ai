"""The official-track turn message, rebuilt in Python.

Gauntlet's graded surface is one fixed system prompt and one user message per
turn, defined in ``gauntlet/harness/official.js`` (the ARC-AGI-3 technical
report wording, section 4.3.1). The wire protocol does not carry the message
itself — a turn is an observation plus feedback — so an official-track client
rebuilds it from the same inputs. This module is that rebuild, kept in
lockstep with the Node implementation: ``tests/test_official_message.py``
compares its output byte for byte against ``harness/official.js``, so the two
cannot drift silently.

Sections, in the fixed order, separated by blank lines: the game's rules
text; the agent's previous reply in full (or ``(none)``); the previous
attempt's feedback when there is any; then the current observation.

Mirror of: gauntlet/harness/official.js
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

__all__ = [
    "OFFICIAL_SYSTEM_PROMPT",
    "NO_PREVIOUS_REPLY",
    "build_official_turn_message",
]

# Verbatim from gauntlet/harness/official.js (ARC-AGI-3 technical report,
# section 4.3.1, https://arcprize.org/media/ARC_AGI_3_Technical_Report.pdf).
# Do not edit: a prompt change is a manifest-version bump that separates old
# entries from new ones.
OFFICIAL_SYSTEM_PROMPT = (
    "You are playing a game. Your goal is to win. Reply with the exact action "
    "you want to take. The final action in your reply will be executed next "
    "turn. Your entire reply will be carried to the next turn."
)

# The reply an agent sees as "your previous reply" when it has none yet.
NO_PREVIOUS_REPLY = "(none)"


def build_official_turn_message(
    ctx: Mapping[str, Any], previous_reply: Optional[str] = None
) -> str:
    """Build the single user message for one turn on the official track.

    Byte-identical mirror of ``buildOfficialTurnMessage`` in
    ``gauntlet/harness/official.js``: same section order, same separators,
    same handling of a missing or blank previous reply and of empty feedback.

    Args:
        ctx: The turn context as the protocol delivers it, plus the game's
            ``spec.rulesText`` (the wire protocol does not carry the rules
            text; the adapter reads it from the registry). Only
            ``spec.rulesText``, ``observation.text`` and ``feedback`` are
            read — ``legalActions`` is null on the official track.
        previous_reply: The agent's full previous reply text, or ``None`` on
            the first turn.

    Raises:
        ValueError: when ``ctx.spec.rulesText`` or ``ctx.observation.text``
            is missing or not a string.
    """
    spec = (ctx or {}).get("spec") or {}
    rules_text = spec.get("rulesText")
    if not isinstance(rules_text, str):
        raise ValueError("build_official_turn_message: ctx.spec.rulesText is required")
    observation = (ctx or {}).get("observation") or {}
    observation_text = observation.get("text")
    if not isinstance(observation_text, str):
        raise ValueError("build_official_turn_message: ctx.observation.text is required")

    sections = [rules_text]
    previous = (
        previous_reply
        if isinstance(previous_reply, str) and previous_reply.strip()
        else NO_PREVIOUS_REPLY
    )
    sections.append(f"Your previous reply:\n{previous}")
    feedback = (ctx or {}).get("feedback")
    if isinstance(feedback, str) and len(feedback) > 0:
        sections.append(f"Feedback on your previous reply: {feedback}")
    sections.append(f"Current state:\n{observation_text}")
    return "\n\n".join(sections)
