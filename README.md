<div align="center">
  <svg width="200" height="50" xmlns="http://www.w3.org/2000/svg">
    <style>
      .text {
        font-family: "Segoe UI", "Roboto", "Helvetica Neue", sans-serif;
        font-size: 32px;
        font-weight: bold;
      }
      .play { fill: #4285F4; }
      .kit { fill: #34A853; }
      .ai { fill: #FBBC05; }
    </style>
    <text x="0" y="35" class="text">
      <tspan class="play">Play</tspan><tspan class="kit">kit</tspan><tspan class="ai">.ai</tspan>
    </text>
  </svg>
</div>

**An open-source platform for testing and running AI on simple games.**

Playkit.ai is a powerful platform for developers and AI enthusiasts to test, run, and analyze the performance of various artificial intelligence strategies on web-based games. Starting with 2048, Playkit.ai provides a browser extension that can automatically detect and play games, offering a seamless experience for watching AI solvers in action.

## Current Focus: 2048 and its Variants

Currently, our primary focus is on perfecting the 2048 solver and expanding its capabilities to a wide range of 2048-like games. We are continuously improving the AI strategies and heuristics to achieve higher scores and win rates.

## How It Works

The Playkit.ai platform consists of three main components:

1.  **Game Detection:** A browser extension injects a content script into web pages. This script uses a set of adapters to detect the presence of a 2048 game board and extract the game state from the DOM.
2.  **AI Solver:** The game state is then passed to our high-performance C++ solver, which has been compiled to WebAssembly. The solver uses a selected AI strategy (e.g., Expectimax, Monte Carlo) to determine the best possible move.
3.  **Move Execution:** The chosen move is sent back to the content script, which then simulates the corresponding keyboard or touch event to execute the move in the game.

This entire process happens in real-time, providing a seamless and automated gameplay experience.

## Technical Stack

*   **Frontend:** [Next.js](https://nextjs.org/) with [React](https://reactjs.org/) and [TypeScript](https://www.typescriptlang.org/) for the documentation website.
*   **Solver:** A highly optimized C++ engine compiled to [WebAssembly](https://webassembly.org/) using [Emscripten](https://emscripten.org/).
*   **Browser Extension:** A cross-platform browser extension built with JavaScript and leveraging the Shadow DOM for UI isolation. The extension is compatible with Chrome, Firefox, and Safari.

## Future Vision & Backlog

While our current focus is on 2048, our long-term vision is to create a vibrant marketplace for game-playing AIs. Here are some of the ideas on our backlog:

*   **Support for More Games:** Expand the platform to support other simple games like Sudoku, Minesweeper, and more.
*   **AI Marketplace:** Create a marketplace where developers can submit their own AI agents for various games, and users can browse and use them.
*   **Advanced Analytics:** Provide more in-depth analytics and visualizations to help users understand the performance of different AI strategies.
*   **Community Features:** Build a community around the platform, with forums, leaderboards, and other social features.

## Getting Started

To get started with Playkit.ai, you can either build the browser extension from the source or use the provided bookmarklet for a quick start.

### Building the Extension

1.  Clone the repository:
    ```bash
    git clone https://github.com/SamGu-NRX/playkit-ai.git
    ```
2.  Navigate to the `frontend` directory and install the dependencies:
    ```bash
    cd frontend
    pnpm install
    ```
3.  Build the project:
    ```bash
    pnpm build
    ```
4.  Load the extension in your browser of choice by following the instructions for loading an unpacked extension.

## Contributing

We welcome contributions from the community! If you're interested in contributing to Playkit.ai, please take a look at our [contributing guidelines](.github/CONTRIBUTING.md).

## License

Playkit.ai is licensed under the [Apache License 2.0](LICENSE).
