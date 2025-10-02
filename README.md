# Playkit.ai

> An open platform for testing, benchmarking, and sharing game-playing AIs—starting with 2048 and its variants.

Playkit.ai is building an open marketplace for lightweight automations that can understand and play simple web games. We currently ship a browser-based runtime that detects 2048-style boards in the DOM, feeds them into a high-performance WebAssembly solver, and plays the game end-to-end—all while logging telemetry that helps you tune strategies.

The long-term goal is to let developers publish their own agents, browse community strategies, and run matchups, but today the stack is laser-focused on proving out 2048. This README captures the current surface area, how to get started, and where we are heading next.

## Contents
- [Current Capabilities](#current-capabilities)
- [Key Features](#key-features)
- [Architecture](#architecture)
- [Project Layout](#project-layout)
- [Getting Started](#getting-started)
  - [Clone & Prerequisites](#clone--prerequisites)
  - [Build the 2048 Automation Runtime](#build-the-2048-automation-runtime)
  - [Frontend Documentation Site](#frontend-documentation-site)
  - [Native Solver Tooling](#native-solver-tooling)
- [Roadmap & Backlog](#roadmap--backlog)
- [Documentation](#documentation)
- [Contributing](#contributing)
- [License](#license)

## Current Capabilities

- Autodetects classic 2048 boards on popular sites (e.g., `play2048.co`, `2048game.com`).
- Streams board state into a WebAssembly build of the Playkit solver and plays full games without manual input.
- Offers an overlay HUD for starting/stopping runs and switching between heuristics.
- Collects run metadata (score, peak tile, move count) for offline analysis.
- Ships as both a bookmarklet for quick testing and an MV3-compatible browser extension shell for persistent installs.

## Key Features

- **Real-time DOM adapters** that discover grid-based boards, even when classnames are obfuscated.
- **WASM solver core** compiled from modern C++ heuristics (expectimax, corner bias, Monte Carlo rollouts).
- **Shadow DOM HUD** with zero-dependency UI that plays nicely with embedded canvases and touch controls.
- **Next.js marketing/docs site** ready to host onboarding guides and future GitBook content.
- **Design repository** backed by `.kiro` specs for architecture, testing, and deployment guidance.

## Architecture

Playkit.ai is split into three collaborating systems:

- **Browser Runtime** (`src/`, `scripts/`, extension build assets)
  - Content script injects adapters and the HUD overlay.
  - Detection layer normalizes 2048 variants into a canonical board.
  - Driver dispatches keyboard/touch events with throttled confirmation.
- **Solver Engine** (`solver/`)
  - C++ strategies compiled to WebAssembly via Emscripten for in-browser use.
  - Native build target kept for benchmarking, regression tests, and ML experiments.
- **Static Site & Docs** (`frontend/`, `docs/`)
  - Next.js 15 + React 19 for marketing pages and future GitBook embeds.
  - `.kiro/` knowledge base containing design docs, testing playbooks, and architecture decisions.

## Project Layout

| Path | Description |
| --- | --- |
| `src/` | Browser runtime sources, HUD overlay, and adapter implementations. |
| `scripts/` | Tooling for building the WASM bundle, packaging extensions, and running CI tasks. |
| `frontend/` | Next.js application for the public site and documentation portal. |
| `solver/` | Standalone C++ solver, benchmarks, and research assets that feed the WASM build. |
| `docs/` | Statically generated documentation pages and design exports. |
| `.kiro/specs/` | Product and engineering specs (architecture, requirements, task breakdowns). |
| `.kiro/steering/` | Coding standards, testing guidelines, and architectural guardrails. |

## Getting Started

### Clone & Prerequisites

```bash
# Clone the repo
git clone https://github.com/SamGu-NRX/playkit-ai.git
cd playkit-ai

# Recommended toolchain
# - Node.js 20+
# - pnpm 9+ (via corepack) if you are working on the Next.js site
# - CMake & a C++20 compiler for native solver development
# - wasm-opt (Binaryen) if you plan to post-process the WASM payload
```

### Build the 2048 Automation Runtime

The runtime is delivered as a bookmarklet build (fast iteration) and an MV3 extension (persistent install).

```bash
# Bundle the shared runtime targets
node scripts/build-phase0.js

# Outputs land in:
# - dist/2048-hud.js and dist/2048-hud.min.js (bookmarklet / IIFE)
# - src/extension/content.js (extension content script)

# Optional: compile the C++ solver to WebAssembly (requires `emcc`)
node scripts/build-wasm.js --release
```

Loading the runtime:

1. **Bookmarklet:** drag `dist/2048-hud.min.js` into your bookmarks bar (or host it statically) and click it on a supported 2048 site.
2. **Browser extension:** load `src/extension/` as an unpacked extension in Chromium-based browsers (MV3). Safari/Firefox packaging scripts live on the roadmap.

When the HUD appears, choose an algorithm (Expectimax by default) and hit **Auto-Play** to watch the solver take over.

### Frontend Documentation Site

```bash
cd frontend
pnpm install
pnpm dev
```

This boots the Next.js 15 dev server (Turbopack) at `http://localhost:3000`, serving the marketing pages and integrations docs. Production builds use `pnpm build` and serve with `pnpm start`.

### Native Solver Tooling

```bash
cd solver
cmake -S . -B build
cmake --build build --config Release
```

The native binary is useful for regression testing, benchmarking new heuristics, or producing datasets for ML experimentation. See `solver/roadmap.md` for active research tasks.

## Roadmap & Backlog

We maintain detailed specs under `.kiro/`, but the immediate focus areas are:

- **Game coverage:** harden adapters for canvas-based 2048 clones and mobile layouts.
- **Strategy tuning:** ship Expectimax improvements, expose heuristics via the HUD, and surface run analytics.
- **Packaging:** automate MV3/Firefox/Safari builds and publish bookmarklet updates from CI.
- **Marketplace groundwork:** define the agent API, sandboxing model, and review process for community submissions.

Exploration tracks on the horizon include Sudoku, Minesweeper, incremental games, and multiplayer lobby bots once the 2048 experience is rock solid.

## Documentation

- `.kiro/specs/browser-extension-2048-solver/` — design docs, requirements, and implementation plans for the current runtime.
- `.kiro/steering/` — engineering guardrails covering coding standards, testing, and WebAssembly integration.
- `docs/` — rendered documentation and assets that will power the public knowledge base.

If you’re looking for something specific, start with `.kiro/project-architecture.md` to understand the system boundaries, then dive into the spec that matches your task.

## Contributing

We welcome new adapters, strategies, and documentation improvements. Please read [`CONTRIBUTING.md`](.github/CONTRIBUTING.md) for workflow details, coding standards, and release requirements. A friendly [`CODE_OF_CONDUCT.md`](.github/CODE_OF_CONDUCT.md) keeps our community safe.

## License

Licensed under the [Apache License 2.0](LICENSE). See the notice at the bottom of the license file for attribution guidance.
