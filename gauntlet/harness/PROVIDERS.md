# Providers: pointing Gauntlet at a model

The official track runs any model through `createModelAgent` in
`model-agent.js`. Three wire protocols are supported:

| Provider | Endpoint | `baseUrl` | API key | Token usage fields | Price-file key |
|---|---|---|---|---|---|
| `anthropic` | `<baseUrl>/v1/messages` | optional (default `https://api.anthropic.com`) | required — `ANTHROPIC_API_KEY`, override with `apiKeyEnv` | `usage.input_tokens` / `usage.output_tokens` | `anthropic/<model>` |
| `openai` | `<baseUrl>/v1/responses` | optional (default `https://api.openai.com`) | required — `OPENAI_API_KEY`, override with `apiKeyEnv` | `usage.input_tokens` / `usage.output_tokens` | `openai/<model>` |
| `openai-chat` | `<baseUrl>/v1/chat/completions` — a `baseUrl` already ending in `/chat/completions` (e.g. Google's Gemini endpoint `.../v1beta/openai/chat/completions`) is sent through as-is | **required** | optional (local servers often need none) — env var name set with `apiKeyEnv`; when unset, no `Authorization` header is sent | `usage.prompt_tokens` / `usage.completion_tokens` | `openai-chat/<model>` |

Shared options for every provider: `model`, `maxOutputTokens` (default 4096),
`params` (extra request-body fields; protocol fields win), `prices` (a price
file keyed `"<provider>/<model>"`), `maxRetries` / `retryBaseDelayMs` (429/5xx
and network errors retry with backoff; 4xx fails immediately), `fetchImpl`,
`sleep`, `id`, plus the reasoning settings `thinkingBudget` / `reasoningEffort`
(see the section below).

Rules that hold for all providers:

- Each turn sends exactly the official system prompt and one user message
  (see `official.js`). The agent carries its previous reply forward itself.
- The API key is read from the environment at call time and never appears in
  errors, logs, or trajectories.
- `usage.costUsd` comes from the caller-supplied `prices` file only: `null`
  without an entry for `<provider>/<model>`, and `0` only when that entry has
  explicit 0 rates.
- A provider that omits a token count (or reports a negative or non-numeric
  one) records `null` for it, never 0 — unreported usage is unknown, not free.
  A reported 0 stays 0. `usage.costUsd` is `null` whenever either count is
  `null`, so a run capped at `maxUsd` refuses instead of billing $0.
- A 2xx body that does not parse as JSON fails immediately (never retried) as
  `model agent: <provider> returned an unparseable 2xx body (HTTP <status)>:
  <first 200 characters>`. Every error the client throws carries a numeric
  `retries` property: the retries it performed, `0` when the first answer was
  not retryable.
- Reasoning delivered separately (chat-completions
  `message.reasoning_content` or `message.reasoning`) never enters the reply
  text the runner parses; only its character count is recorded in
  `reply.meta.reasoningChars`.
- An empty or null reply `content` is treated as the model's reply: the runner
  counts it as an invalid attempt. It is not a transport error and not retried.

## Reasoning settings: thinking budget and reasoning effort

Two flags turn a model's internal reasoning on and keep it auditable: what
reaches the wire, where the reasoning text goes, what the tokens cost, and
what the run records.

| Setting | Provider | Wire field | Values |
|---|---|---|---|
| `--thinking-budget <n>` | `anthropic` | `thinking: {type: "enabled", budget_tokens: n}` | integer ≥ 1024 |
| `--reasoning-effort <v>` | `openai` | `reasoning: {effort: v}` | `low` \| `medium` \| `high` |
| `--reasoning-effort <v>` | `openai-chat` | `reasoning_effort: v` | `low` \| `medium` \| `high` |

Rules that hold for both:

- **The settings are part of the agent's identity.** `--thinking-budget 10240`
  on `model:anthropic/claude-opus-4-5` makes the agent id
  `model:anthropic/claude-opus-4-5:thinking-budget=10240`, and `run.json`
  records the setting in `limits.thinkingBudget` / `limits.reasoningEffort`:
  the same model with different settings is a different leaderboard entry, not
  a re-run of the same one. The spec layer accepts the same settings as a
  suffix — `model:anthropic/claude-opus-4-5:thinking-budget=10240`,
  `model:openai/gpt-5.2:reasoning-effort=high` — and a trailing segment that
  matches neither pattern stays part of the model id, so Ollama tags like
  `model:openai-chat/qwen2.5:7b` keep working. Setting one setting both ways
  (suffix and flag) is an error.
- **A reasoning setting never applies to a `--dry-run` rehearsal or a
  `baseline:` agent**; both are loud parse errors naming the spec.
- **The provider pairing is validated, not silently ignored.** A thinking
  budget on a non-Anthropic spec (or an effort on an Anthropic spec) fails at
  parse time with the spec named in the message.

Anthropic specifics:

- **Thinking tokens spend `max_tokens`, so the client raises it.** Anthropic
  counts thinking tokens against `max_tokens`; with a budget set, the client
  sends `max_tokens = maxOutputTokens + thinkingBudget`, keeping the reply's
  full text budget on top of the thinking budget.
- **Thinking text never enters the reply text.** `thinking` and
  `redacted_thinking` content blocks are stripped; the runner parses only
  visible text. (A redacted block is encrypted server-side and never visible
  to the client.)
- **Cut-off reasoning is recorded, not hidden.** A reply that ends before any
  text — `stop_reason: "max_tokens"` while still thinking — records empty
  reply text (an invalid attempt for the runner) instead of throwing a
  transport error, with the usage honestly recorded.
- **The dollar cap reserves the budget.** The worst-case reservation is the
  wire `max_tokens` — the text cap plus the thinking budget — so a
  thinking-heavy reply cannot push realized spend past `--max-usd`.

OpenAI and chat-completions specifics:

- The `reasoning` output item on Responses is stripped from the reply text,
  same as Anthropic's blocks. A response with `status: "incomplete"` and no
  message item (cut off mid-reasoning by the output cap) records empty reply
  text and its usage instead of throwing.
- Reasoning tokens are inside the reported output total on both providers, and
  that total is what is billed. The provider's breakdown (Anthropic
  `usage.output_tokens_details.thinking_tokens`, OpenAI Responses
  `usage.output_tokens_details.reasoning_tokens`, chat-completions
  `usage.completion_tokens_details.reasoning_tokens`) is recorded per step as
  `meta.reasoningTokens` when reported; cost follows the reported totals (see
  `prices.example.json`).

Deprecation note: Anthropic documents manual thinking-budget mode as
deprecated on Claude 4.6 and not accepted on later models, which steer
thinking adaptively instead — use `--thinking-budget` on models that accept
manual mode, and keep the price file's `checked` date recording what a model
accepted when the price was verified.

Minimal example (`openai-chat`, no key, local server):

```js
const agent = createModelAgent({
  provider: 'openai-chat',
  model: 'qwen2.5-1.5b-instruct',
  baseUrl: 'http://127.0.0.1:8080',
  // apiKeyEnv: 'MY_KEY_ENV'  // only for servers that want a key
});
const trajectory = await runEpisode({ game, tierId, seed, agent });
assert.deepEqual(await verifyTrajectory(game, trajectory), { ok: true });
```

## Serving a local model (no cost, no data leaves the machine)

Any OpenAI-compatible server works. The path that was actually run end to end
for this repository: **llama.cpp's `llama-server`** with
**Qwen2.5-1.5B-Instruct GGUF Q4_K_M** (Apache-2.0).

Exact commands used (llama.cpp `b11662`, version `0.6.0-dev (build 11662,
commit c0cb53ac4)`, Debian 13, 8-core CPU):

```sh
# 1. Get llama-server (prebuilt Ubuntu/x64 asset from the llama.cpp release)
curl -LO https://github.com/ggml-org/llama.cpp/releases/download/b11662/llama-b11662-bin-ubuntu-x64.tar.gz
tar xzf llama-b11662-bin-ubuntu-x64.tar.gz

# 2. Get the model (single 1,117,320,736-byte file) and record its SHA-256
curl -LO https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf
sha256sum qwen2.5-1.5b-instruct-q4_k_m.gguf
# 6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e  qwen2.5-1.5b-instruct-q4_k_m.gguf

# 3. Serve an OpenAI-compatible endpoint on 127.0.0.1:8080
./llama-b11662/llama-server -m qwen2.5-1.5b-instruct-q4_k_m.gguf \
  --host 127.0.0.1 --port 8080 --ctx-size 4096
```

Then run the opt-in live test (one episode per tictactoe public seed):

```sh
GAUNTLET_LOCAL_CHAT_URL=http://127.0.0.1:8080 \
GAUNTLET_LOCAL_CHAT_MODEL=qwen2.5-1.5b-instruct-q4_k_m \
node --test harness/live-local.test.js
```

`GAUNTLET_LOCAL_CHAT_MODEL` is the label Gauntlet sends and records; this
llama-server build echoes the model file path back in the `model` response
field and does not check the request's `model` value, so any stable label
works. Every call stays on `127.0.0.1`; nothing is billed.

Alternatives that work unchanged through the same provider:

- **Ollama** (`ollama serve`, then `ollama pull qwen2.5:1.5b-instruct-q4_K_M`):
  set `GAUNTLET_LOCAL_CHAT_URL=http://127.0.0.1:11434` and
  `GAUNTLET_LOCAL_CHAT_MODEL=qwen2.5:1.5b-instruct-q4_K_M`. Ollama also serves
  `/v1/chat/completions`. It manages model storage internally, which makes the
  exact model-file hash harder to record; that is the one reason llama.cpp won
  here.
- **vLLM** (`vllm serve Qwen/Qwen2.5-1.5B-Instruct`): same provider and env
  vars, port 8000. Needs more RAM/disk and a Python environment, so it was not
  used in this sandbox.
- **llamafile / llama.cpp `--server` on other platforms**: same shape, any
  port, pass `http://127.0.0.1:<port>` as the base URL.

For a hosted gateway that speaks chat completions, the same provider works:
point `baseUrl` at the gateway root (the client appends `/v1/chat/completions`)
and set `apiKeyEnv` to the name of the environment variable holding the key.

## Recording prices for a local server

A local server costs nothing, but `costUsd` stays `null` until a price file
says so — an unknown price never masquerades as a known one. To record an
explicit 0:

```json
{
  "openai-chat/qwen2.5-1.5b-instruct-q4_k_m": {
    "inputPerMTok": 0,
    "outputPerMTok": 0,
    "source": "local llama.cpp server, no charge",
    "checked": "2026-10-15"
  }
}
```

and pass that object (or a file loaded from it) as `prices`. See
`prices.example.json`.
