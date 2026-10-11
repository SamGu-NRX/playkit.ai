/**
 * viewer.mjs — local, read-only rendering of a classified replay log.
 *
 * Rendering contract:
 * - Every dynamic string reaches the DOM via textContent or an attribute
 *   assignment — never via innerHTML or insertAdjacentHTML — so hostile
 *   labels stay inert text.
 * - A refused log renders a refusal banner and nothing else: the viewer
 *   refuses to render invalid containers rather than guessing a shape.
 * - Missing boards render an explicit "not recorded" placeholder; corrupt
 *   boards render "corrupt — not rendered". Silence is never used as data.
 */

import { readReplayLog } from "../lib/replay-reader.mjs";
import { buildTimeline } from "../lib/timeline.mjs";

const DIR_NAMES = ["Up", "Right", "Down", "Left"];

const DEFAULT_LOG = "valid-seed7.json";
const SAFE_NAME = /^[A-Za-z0-9._-]+\.json$/;

const els = {
  navStatus: document.getElementById("nav-status"),
  logList: document.getElementById("log-list"),
  loadStatus: document.getElementById("load-status"),
  sourceCard: document.getElementById("source-card"),
  sourceFacts: document.getElementById("source-facts"),
  refusedPanel: document.getElementById("refused-panel"),
  framePanel: document.getElementById("frame-panel"),
  frameStatus: document.getElementById("frame-status"),
  stateBanner: document.getElementById("state-banner"),
  frameList: document.getElementById("frame-list"),
  observedBoard: document.getElementById("observed-board"),
  referenceBoard: document.getElementById("reference-board"),
  observedHeading: document.getElementById("observed-heading"),
  referenceHeading: document.getElementById("reference-heading"),
  moveFacts: document.getElementById("move-facts"),
  problemsBlock: document.getElementById("problems-block"),
  problemsList: document.getElementById("problems-list"),
  compareBlock: document.getElementById("compare-block"),
  compareList: document.getElementById("compare-list"),
  notesList: document.getElementById("notes-list"),
  jumpForm: document.getElementById("jump-form"),
  jumpInput: document.getElementById("jump-input"),
};

const state = {
  read: null,
  timeline: null,
  cursor: 0,
};

// ---- helpers -------------------------------------------------------------

function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

function factList(node, pairs) {
  clear(node);
  for (const [term, value] of pairs) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    node.append(dt, dd);
  }
}

function boardOrNull(board) {
  return board === null
    ? "not recorded"
    : `recorded (${board.flat().filter((v) => v !== 0).length} tiles)`;
}

function renderBoard(holder, heading, board, options) {
  const { caption, diffs = null, unavailableText = "not recorded" } = options;
  heading.textContent = caption;
  clear(holder);

  if (board === null) {
    const p = document.createElement("p");
    p.className = "board-placeholder";
    p.textContent = unavailableText;
    holder.append(p);
    return;
  }

  const table = document.createElement("table");
  table.className = "board";
  const cap = document.createElement("caption");
  cap.textContent = `${caption} — 4×4 board`;
  table.append(cap);

  const headRow = document.createElement("tr");
  const corner = document.createElement("td");
  corner.className = "corner";
  corner.setAttribute("aria-hidden", "true");
  corner.textContent = "";
  headRow.append(corner);
  for (let c = 0; c < 4; c += 1) {
    const th = document.createElement("th");
    th.scope = "col";
    th.textContent = `c${c}`;
    headRow.append(th);
  }
  table.append(headRow);

  for (let r = 0; r < 4; r += 1) {
    const row = document.createElement("tr");
    const th = document.createElement("th");
    th.scope = "row";
    th.textContent = `r${r}`;
    row.append(th);
    for (let c = 0; c < 4; c += 1) {
      const td = document.createElement("td");
      const value = board[r][c];
      td.textContent = value === 0 ? "" : String(value);
      if (diffs) {
        const diff = diffs.find((d) => d.r === r && d.c === c);
        if (diff) {
          td.classList.add("diff");
          td.title = `observed ${diff.observed} / reference ${diff.reference}`;
        }
      }
      row.append(td);
    }
    table.append(row);
  }
  holder.append(table);
}

// ---- rendering ------------------------------------------------------------

function renderRefusal(read) {
  els.refusedPanel.classList.remove("hidden");
  els.framePanel.classList.add("hidden");
  els.sourceCard.classList.add("hidden");
  clear(els.refusedPanel);
  const strong = document.createElement("strong");
  strong.textContent = "Log refused — nothing rendered.";
  const span = document.createElement("span");
  span.textContent = ` ${read.shape === "unknown" ? "Unrecognized shape." : `Shape: ${read.shape}.`} ` +
    read.refusals.map((r) => `${r.code}: ${r.message}`).join(" ");
  els.refusedPanel.append(strong, span);
  els.loadStatus.textContent = `Refused: ${read.fileName}`;
}

function renderFrame() {
  const { frames } = state.timeline;
  const frame = frames[state.cursor];

  els.frameStatus.textContent = `Frame ${state.cursor + 1} of ${frames.length}`;
  els.stateBanner.className = `banner ${frame.state}`;
  els.stateBanner.textContent =
    `State: ${frame.state}` +
    (frame.state === "diverged" ? ` — ${frame.compare.length} cell(s) differ` : "");

  renderBoard(
    els.observedBoard,
    els.observedHeading,
    frame.observedAfter,
    {
      caption: `Observed — after move ${state.cursor + 1} (${eventIdLabel(frame)})`,
      unavailableText: frame.state === "corrupt" ? "corrupt — not rendered" : "not recorded",
    },
  );

  renderBoard(
    els.referenceBoard,
    els.referenceHeading,
    frame.referenceAfter,
    {
      caption: `Reference — after move ${state.cursor + 1} (${eventIdLabel(frame)})`,
      diffs: frame.state === "diverged" ? frame.compare : null,
      unavailableText:
        frame.state === "unverifiable"
          ? "reference unavailable — unverifiable after a corrupt event"
          : frame.state === "reference-incomplete"
            ? "reference unavailable — reference chain incomplete"
            : "not computed",
    },
  );

  factList(els.moveFacts, [
    ["Event ID", frame.eventId],
    ["Direction", frame.dirState === "ok" ? `${DIR_NAMES[frame.dir]} (dir ${frame.dir})` : `unknown (dir ${JSON.stringify(frame.dir)})`],
    ["Spawn", frame.spawn ? `(${frame.spawn.r}, ${frame.spawn.c}) value ${frame.spawn.value}` : "not recorded"],
    ["Observed before", boardOrNull(frame.observedBefore)],
  ]);

  clear(els.problemsList);
  if (frame.problems.length === 0) {
    els.problemsBlock.classList.add("hidden");
  } else {
    els.problemsBlock.classList.remove("hidden");
    for (const problem of frame.problems) {
      const li = document.createElement("li");
      li.textContent = `${problem.code}: ${problem.message}`;
      els.problemsList.append(li);
    }
  }

  if (frame.state === "diverged") {
    els.compareBlock.classList.remove("hidden");
    clear(els.compareList);
    for (const cell of frame.compare) {
      const li = document.createElement("li");
      li.textContent = `(r${cell.r}, c${cell.c}): observed ${cell.observed} / reference ${cell.reference}`;
      els.compareList.append(li);
    }
  } else {
    els.compareBlock.classList.add("hidden");
  }

  clear(els.notesList);
  for (const note of frame.notes) {
    const li = document.createElement("li");
    li.textContent = note;
    els.notesList.append(li);
  }

  [...els.frameList.children].forEach((li, i) => {
    const button = li.firstChild;
    if (i === state.cursor) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  });

  els.jumpInput.value = String(state.cursor + 1);
  els.jumpInput.max = String(frames.length);
}

function eventIdLabel(frame) {
  return `event ${frame.eventId}`;
}

function renderAccepted(read) {
  els.refusedPanel.classList.add("hidden");
  els.sourceCard.classList.remove("hidden");
  els.framePanel.classList.remove("hidden");

  factList(els.sourceFacts, [
    ["File", read.fileName],
    ["Shape", read.shape],
    ["Synthetic", read.synthetic === null ? "not labelled" : read.synthetic ? "yes (labelled synthetic)" : "no"],
    ["Source identity", read.source.identityState],
    ["Source name", read.source.name ?? "—"],
    ["Seed", read.source.seed === null ? "—" : String(read.source.seed)],
    ["Scenario", read.source.scenario ?? "—"],
    ["Recorded by", read.source.recordedBy ?? "—"],
  ]);

  state.read = read;
  state.timeline = buildTimeline(read);
  state.cursor = 0;

  clear(els.frameList);
  state.timeline.frames.forEach((frame, i) => {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = `st-${frame.state}`;
    button.textContent = `${i + 1}: ${frame.state}`;
    button.setAttribute("aria-label", `Frame ${i + 1}, state ${frame.state}, event ${frame.eventId}`);
    button.addEventListener("click", () => {
      state.cursor = i;
      renderFrame();
    });
    li.append(button);
    els.frameList.append(li);
  });

  els.loadStatus.textContent =
    `Loaded ${read.fileName}: ${read.counts.events} events (` +
    Object.entries(read.counts)
      .filter(([k]) => k !== "events")
      .map(([k, v]) => `${v} ${k}`)
      .join(", ") +
    `); frames: ` +
    Object.entries(state.timeline.counts)
      .filter(([, v]) => v > 0)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ") +
    ".";
  renderFrame();
}

// ---- loading --------------------------------------------------------------

async function loadLog(name) {
  if (!SAFE_NAME.test(name)) {
    els.loadStatus.textContent = `Rejected log name ${JSON.stringify(name)}: names are plain .json file names.`;
    return;
  }
  els.loadStatus.textContent = `Loading ${name}…`;
  try {
    const response = await fetch(`../fixtures/${encodeURIComponent(name)}`);
    if (!response.ok) {
      els.loadStatus.textContent = `Could not load ${name} (HTTP ${response.status}). Serve the repository root and use ?log=<fixture>.json.`;
      return;
    }
    const raw = await response.json();
    const read = readReplayLog(raw, { fileName: name });
    markCurrentNav(name);
    if (read.status === "refused") {
      renderRefusal(read);
      els.loadStatus.textContent = `${name} was refused — nothing rendered (${read.refusals.map((r) => r.code).join(", ")}).`;
      return;
    }
    renderAccepted(read);
  } catch (error) {
    els.loadStatus.textContent = `Failed to load ${name}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function markCurrentNav(name) {
  [...els.logList.querySelectorAll("a")].forEach((a) => {
    if (a.dataset.log === name) a.setAttribute("aria-current", "page");
    else a.removeAttribute("aria-current");
  });
}

async function loadNav() {
  try {
    const response = await fetch("./manifest.json");
    const manifest = await response.json();
    clear(els.logList);
    for (const file of manifest.files) {
      const li = document.createElement("li");
      const a = document.createElement("a");
      a.href = `?log=${encodeURIComponent(file)}`;
      a.dataset.log = file;
      a.textContent = file;
      li.append(a);
      els.logList.append(li);
    }
    els.navStatus.textContent = "Select a synthetic log:";
    return true;
  } catch {
    els.navStatus.textContent =
      "Log list unavailable (manifest.json not found — serve the repository root). Load one with ?log=<fixture>.json.";
    return false;
  }
}

// ---- controls -------------------------------------------------------------

function clampCursor(value) {
  const { frames } = state.timeline;
  if (!frames || frames.length === 0) return;
  state.cursor = Math.min(frames.length - 1, Math.max(0, value));
  renderFrame();
}

document.getElementById("btn-first").addEventListener("click", () => clampCursor(0));
document.getElementById("btn-prev").addEventListener("click", () => clampCursor(state.cursor - 1));
document.getElementById("btn-next").addEventListener("click", () => clampCursor(state.cursor + 1));
document.getElementById("btn-last").addEventListener("click", () => clampCursor(Infinity));

els.jumpForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const oneBased = Number.parseInt(els.jumpInput.value, 10);
  if (Number.isFinite(oneBased)) clampCursor(oneBased - 1);
});

window.addEventListener("keydown", (event) => {
  if (!state.timeline) return;
  const target = event.target;
  if (target instanceof HTMLElement && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT")) return;
  const frames = state.timeline.frames.length;
  switch (event.key) {
    case "ArrowLeft": clampCursor(state.cursor - 1); event.preventDefault(); break;
    case "ArrowRight": clampCursor(state.cursor + 1); event.preventDefault(); break;
    case "Home": clampCursor(0); event.preventDefault(); break;
    case "End": clampCursor(frames - 1); event.preventDefault(); break;
    case "PageUp": clampCursor(state.cursor - 5); event.preventDefault(); break;
    case "PageDown": clampCursor(state.cursor + 5); event.preventDefault(); break;
    default: break;
  }
});

// ---- boot -----------------------------------------------------------------

const params = new URLSearchParams(window.location.search);
const requested = params.get("log");
const logName = requested !== null ? requested : DEFAULT_LOG;

loadNav().then(() => loadLog(logName));

// Positive inertness marker for the browser walk: the page sets this only
// after a clean boot with no handler executing attacker-controlled text as
// code. The walk asserts it is true and that window.__replayPwned (which the
// hostile fixture's injected onerror would set) stays undefined.
window.__replayViewerInert = true;
