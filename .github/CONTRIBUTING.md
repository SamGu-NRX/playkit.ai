# Contributing to Playkit.ai

Thank you for helping build the Playkit.ai platform! Whether you are polishing adapters, tuning the solver, or tightening our documentation, we appreciate your time and energy. This guide explains how to get set up, the style expectations, and what we look for in pull requests.

## Ways to Contribute

- **Issues:** Report bugs, propose features, or request clarifications in [GitHub Issues](https://github.com/SamGu-NRX/playkit.ai/issues). Include logs, screenshots, and reproduction steps when possible.
- **Pull Requests:** Submit fixes, new capabilities, or documentation improvements. Start by searching open issues or specs in `.kiro/` to avoid duplication.
- **Discussions & Feedback:** Leave comments on specs (`.kiro/specs/`) or roadmap ideas to shape direction before coding.

## Getting Started

1. **Fork & Clone**
   ```bash
   git clone https://github.com/<your-username>/playkit.ai.git
   cd playkit.ai
   git remote add upstream https://github.com/SamGu-NRX/playkit.ai.git
   ```
2. **Create a Branch**
   ```bash
   git checkout -b feature/<short-description>
   ```
3. **Install Tooling**
   - Node.js 20+
   - pnpm 9+ (`corepack enable pnpm`)
   - CMake & a C++20 toolchain (for solver changes)
   - wasm-opt (Binaryen) when working on WebAssembly output optimisation

## Project Areas & Workflows

### Browser Runtime (`src/`, `scripts/`)

- Run `node scripts/build-phase0.js` to bundle the content script and bookmarklet payloads.
- Keep adapters pluggable—follow `src/adapters/adapter-registry.js` for priority ordering.
- Use concise inline comments for non-obvious heuristics or DOM selectors.
- When adding dependencies, prefer zero-runtime additions; the Phase 0 bundle is intentionally toolchain-light.

### Frontend Site (`frontend/`)

- Install dependencies with `pnpm install` and launch the dev server via `pnpm dev`.
- Lint and format with `pnpm lint` / `pnpm format` before opening a PR.
- Tailwind CSS (v4) powers styling—follow utility-first patterns and avoid hand-rolled global CSS when possible.

### Native Solver (`solver/`)

- Generate builds using `cmake -S . -B build` and `cmake --build build --config Release`.
- Keep benchmark data (`results/`) out of commits unless you are updating golden baselines with reviewer buy-in.
- Document new heuristics or strategies in `solver/notes.md` or `solver/roadmap.md` for future reference.

### Documentation & Specs (`docs/`, `.kiro/`)

- Extend `.kiro/specs/` when proposing sizable features—each spec should include motivation, acceptance criteria, and validation steps.
- Update `.kiro/steering/` if you adjust coding standards or testing philosophy.
- For public docs, add or update the markdown sources under `docs/` or the Next.js pages in `frontend/app/`.

## Coding Standards

- JavaScript runtime code targets modern browsers—use ES2022 features supported by Chromium 120+. Avoid TypeScript in the runtime unless the build pipeline is adjusted accordingly.
- C++ code should build cleanly with `-Wall -Wextra -Werror` on GCC/Clang; favour modern C++20 constructs.
- Keep functions focused; prefer pure helpers for heuristics and board manipulations.
- Write clear commit messages (`<scope>: <summary>` is encouraged) and keep commits focused.

## Testing & Validation

- **Runtime:** Manually exercise the HUD against `https://mitchgu.github.io/GetMIT/` after each change. Add console-based smoke tests to `src/test/` when useful.
- **Frontend:** Run `pnpm lint` and `pnpm build` before requesting review.
- **Solver:** Provide benchmark output or statistical summaries when tuning heuristics. Store heavy data outside the repository unless explicitly needed.
- Include screenshots or recordings in PR descriptions if UI behaviour changes.

## Pull Request Checklist

- [ ] Rebased on the latest `main`.
- [ ] Linted/formatted code in the areas you touched.
- [ ] Updated docs/specs when behaviour or APIs change.
- [ ] Added tests or manual verification notes describing how you validated the change.
- [ ] Linked the PR to the relevant issue or spec.

PRs with incomplete context are harder to review. When in doubt, share your reasoning, link to `.kiro` docs, and call out trade-offs explicitly.

## Code of Conduct

We follow a zero-tolerance policy for harassment or disrespectful behaviour. By participating, you agree to uphold our [Code of Conduct](CODE_OF_CONDUCT.md). If you experience or witness unacceptable behaviour, please reach out to the maintainers via GitHub or listed contact methods.

We’re excited to build the Playkit.ai marketplace together—thank you for contributing!
