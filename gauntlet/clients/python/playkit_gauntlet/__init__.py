"""Python client for the PlayKit Gauntlet wire protocol.

Standard library only (Python 3.10+). The client starts the Node protocol
server (`gauntlet/protocol/server.js`) as a subprocess and speaks JSON Lines
over its stdin/stdout, so Python agents — BALROG-, TextArena- and ARC-AGI-3
style harnesses — can play every registered Gauntlet game while episode
rules, budgets, and trajectories stay in the core runner.
"""

from .client import GauntletClient, GauntletError

__all__ = ["GauntletClient", "GauntletError"]
__version__ = "0.1.0"
