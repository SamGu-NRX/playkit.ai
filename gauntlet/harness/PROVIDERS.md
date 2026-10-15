# Providers: pointing Gauntlet at a model

The official track runs any model through `createModelAgent` in
`model-agent.js`. Three wire protocols are supported:

| Provider | Endpoint | `baseUrl` | API key | Token usage fields | Price-file key |
|---|---|---|---|---|---|
| `anthropic` | `<baseUrl>/v1/messages` | optional (default `https://api.anthropic.com`) | required — `ANTHROPIC_API_KEY`, override with `apiKeyEnv` | `usage.input_tokens` / `usage.output_tokens` | `anthropic/<model>` |
| `openai` | `<baseUrl>/v1/responses` | optional (default `https://api.openai.com`) | required — `OPENAI_API_KEY`, override with `apiKeyEnv` | `usage.input_tokens` / `usage.output_tokens` | `openai/<model>` |
| `openai-chat` | `<baseUrl>/v1/chat/completions` | **required** | optional (local servers often need none) — env var name set with `apiKeyEnv`; when unset, no `Authorization` header is sent | `usage.prompt_tokens` / `usage.completion_tokens` | `openai-chat/<model>` |

Shared options for every provider: `model`, `maxOutputTokens` (default 4096),
`params` (extra request-body fields; protocol fields win), `prices` (a price
file keyed `"<provider>/<model>"`), `maxRetries` / `retryBaseDelayMs` (429/5xx
and network errors retry with backoff; 4xx fails immediately), `fetchImpl`,
`sleep`, `id`.

Rules that hold for all providers:

- Each turn sends exactly the official system prompt and one user message
  (see `official.js`). The agent carries its previous reply forward itself.
- The API key is read from the environment at call time and never appears in
  errors, logs, or trajectories.
- `usage.costUsd` comes from the caller-supplied `prices` file only: `null`
  without an entry for `<provider>/<model>`, and `0` only when that entry has
  explicit 0 rates.
- Reasoning delivered separately (chat-completions
  `message.reasoning_content` or `message.reasoning`) never enters the reply
  text the runner parses; only its character count is recorded in
  `reply.meta.reasoningChars`.
- An empty or null reply `content` is treated as the model's reply: the runner
  counts it as an invalid attempt. It is not a transport error and not retried.

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

Exact commands used (llama.cpp b7053, Debian 13, 8-core CPU):

```sh
# 1. Get llama-server (prebuilt Ubuntu/x64 asset from the llama.cpp release)
curl -LO https://github.com/ggml-org/llama.cpp/releases/download/b7053/llama-b7053-bin-ubuntu-x64.zip
unzip llama-b7053-bin-ubuntu-x64.zip -d llama.cpp && cd llama.cpp

# 2. Get the model (single ~987 MB file) and record its SHA-256
curl -LO https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf
sha256sum qwen2.5-1.5b-instruct-q4_k_m.gguf

# 3. Serve an OpenAI-compatible endpoint on 127.0.0.1:8080
./llama-server -m qwen2.5-1.5b-instruct-q4_k_m.gguf \
  --host 127.0.0.1 --port 8080 --ctx-size 4096
```

Then run the opt-in live test (one episode per tictactoe public seed):

```sh
GAUNTLET_LOCAL_CHAT_URL=http://127.0.0.1:8080 \
GAUNTLET_LOCAL_CHAT_MODEL=qwen2.5-1.5b-instruct \
npm test -- live-local
```

`llama-server` reports `"model": "qwen2.5-1.5b-instruct"` in the response, so
that string is the `GAUNTLET_LOCAL_CHAT_MODEL` value. Every call stays on
`127.0.0.1`; nothing is billed.

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
  "openai-chat/qwen2.5-1.5b-instruct": {
    "inputPerMTok": 0,
    "outputPerMTok": 0,
    "source": "local llama.cpp server, no charge",
    "checked": "2026-10-15"
  }
}
```

and pass that object (or a file loaded from it) as `prices`. See
`prices.example.json`.
