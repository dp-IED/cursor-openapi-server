# cursor-openai-server

OpenAI-compatible REST API server for [cursor-agent](https://cursor.com/docs/cli) inference. Point any OpenAI SDK client at `localhost:3000/v1` and use Cursor's models as a drop-in replacement. All CLI flags, models, and help text are sourced dynamically from the agent binary — the server auto-updates when `agent` does.

**Runtime**: Bun — native HTTP, zero framework, ~4x faster than Node/Express.

## Quick Start

```bash
# Prerequisites: Bun + cursor-agent CLI
curl -fsSL https://bun.sh/install | bash   # if needed
agent login                                  # if not already authenticated

# Clone and run
git clone https://github.com/dp-IED/cursor-openai-server.git
cd cursor-openai-server
bun install
bun run server.js                           # → http://0.0.0.0:3000
```

On startup the server introspects the CLI and logs what it found:
```
cursor-openai-server v3.0.0 — 107 models, 23 flags
```

## Usage

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:3000/v1", api_key="not-needed")

response = client.chat.completions.create(
    model="composer-2-fast",
    messages=[{"role": "user", "content": "Explain monads in one paragraph."}]
)
print(response.choices[0].message.content)
```

### curl

```bash
# Non-streaming
curl -X POST :3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"What is SIMD?"}],"stream":false}'

# Streaming (SSE)
curl -N -X POST :3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Write a haiku about code"}],"stream":true}'
```

### Native web search (structured tool results)

`POST /v1/web-search` drives cursor-agent with a prompt that **must** invoke the built-in web search tool. The handler parses the raw `stream-json` tool payload (`webSearchToolCall.result.success.references`), kills the agent as soon as results arrive (no extra tokens), and returns `{ query, results[], searchTimeMs, resultCount }`. If the model finishes the turn without searching, you get **422** `no_web_search`; if the wait budget expires first, **504** `timeout`. Responses are not summaries — only structured rows derived from the tool output.

```bash
curl -s -X POST http://localhost:3000/v1/web-search \
  -H 'Content-Type: application/json' \
  -d '{"query":"Hello World","maxResults":5,"timeout":60000}'
```

```python
import json
import urllib.request

req = urllib.request.Request(
    "http://localhost:3000/v1/web-search",
    data=json.dumps({"query": "Hello World", "maxResults": 5}).encode(),
    headers={"Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req) as resp:
    print(json.load(resp))
```

### Any OpenAI-compatible client

Works with Continue.dev, Open Interpreter, LangChain, LiteLLM, and anything that speaks the OpenAI API. Just set `base_url` to `http://localhost:3000/v1`.

---

## Modes

cursor-agent has three execution modes. Pass the `mode` flag in any request body:

### Agent mode (default)

Full capabilities — reads, edits, runs commands, searches. Omit `mode` or set `"mode": "agent"`.

```bash
curl -X POST :3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Add error handling to src/auth.ts","cwd":"/path/to/project","force":true}'
```

### Plan mode

Read-only planning — analyzes code, proposes plans, no edits or command execution.

```bash
curl -X POST :3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Propose a plan to refactor the auth module","cwd":"/path/to/project","mode":"plan"}'
```

```python
# OpenAI SDK — plan mode
response = client.chat.completions.create(
    model="composer-2-fast",
    messages=[{"role": "user", "content": "Propose a plan to add rate limiting"}],
    extra_body={"mode": "plan"}  # passed through as --mode plan
)
```

Plan mode is useful for: architecture review, implementation proposals, codebase analysis, and scoping work before committing to changes.

### Ask mode

Q&A — explanations, questions, read-only. No edits or command execution.

```bash
curl -X POST :3000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"messages":[{"role":"user","content":"Explain how the auth middleware works"}],"mode":"ask"}'
```

Ask mode is useful for: code understanding, documentation questions, debugging guidance, and learning a codebase.

---

## File Diffs & Workspace Edits

When using **agent mode** (default) with a workspace directory, the agent can read and edit files. Here's how to see what changed:

### 1. Read the response text

The agent describes every edit it makes in the response. The `text` field (or `choices[0].message.content` in OpenAI format) includes a summary of changes.

```bash
curl -X POST :3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Rename getCwd to getCurrentWorkingDirectory in all files","cwd":"/path/to/project","force":true}'
# Response: {"text":"I found 4 files referencing getCwd...\n\nChanges made:\n- src/utils.ts: renamed function\n- tests/utils.test.ts: updated import\n..."}
```

### 2. Use git diff

Since the agent edits files in your workspace, run `git diff` after the call to see the exact changes:

```bash
cd /path/to/project
git diff
```

### 3. Dry-run with plan mode first

Always review what the agent *would* do before letting it make changes:

```bash
# Step 1: Plan (no edits)
curl -X POST :3000/chat -d '{"prompt":"Add error handling to src/auth.ts","cwd":"/path/to/project","mode":"plan"}'

# Step 2: Review the plan, then execute
curl -X POST :3000/chat -d '{"prompt":"Add error handling to src/auth.ts","cwd":"/path/to/project","force":true}'

# Step 3: Review the diff
cd /path/to/project && git diff
```

### 4. Use `trust` and `force` flags

- `"trust": true` — trusts the workspace without prompting (required for `--print` mode)
- `"force": true` — auto-approves tool use including file writes

```bash
curl -X POST :3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Fix all TODOs in src/","cwd":"/path/to/project","trust":true,"force":true}'
```

---

## Debug Mode

Enable debug logging to see the exact CLI command being spawned and the agent's raw protocol output:

```bash
DEBUG_ACP_API=1 bun run server.js

# Or per-request: the stderr will show the full argv and JSON-RPC exchange
curl -X POST :3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Say OK","debug":true}'
```

Debug output includes:
- Spawn command and arguments
- Prompt preview (truncated to 400 chars)
- Raw stdout/stderr from the agent process
- Exit code and timing

---

## Live Model & Flag Discovery

The server parses `agent --help` and `agent models` at startup. All flags are available as request body parameters. All models appear in `/v1/models`.

### See available flags

```bash
curl :3000/help | jq '.flags'
```

Sample output:
```json
{
  "model":      {"type": "string", "description": "Model to use (e.g., gpt-5, sonnet-4)"},
  "mode":       {"type": "enum", "values": ["plan","ask"], "description": "Execution mode"},
  "force":      {"type": "boolean", "description": "Force allow commands"},
  "trust":      {"type": "boolean", "description": "Trust the workspace"},
  "workspace":  {"type": "string", "description": "Workspace directory to use"},
  "sandbox":    {"type": "enum", "values": ["enabled","disabled"]},
  ...
}
```

### See available models

```bash
curl :3000/v1/models | jq '.data[].id'
# auto, composer-2-fast, gpt-5.5-medium, claude-4.6-sonnet-medium, ...
```

### Refresh without restarting

If you run `agent update` and want the server to pick up new models/flags without a restart:

```bash
curl -X GET :3000/refresh
# → {"ok":true,"models":108,"flags":23}
```

---

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat (streaming SSE + non-streaming) |
| `POST` | `/v1/web-search` | Native web search tool — structured title/url/snippet results only |
| `GET` | `/v1/models` | Model list sourced from `agent models` |
| `POST` | `/chat` | Simple prompt interface with full flag passthrough |
| `GET` | `/health` | Liveness probe + cursor-agent availability |
| `GET` | `/help` | Endpoint manifest + live CLI flag documentation |
| `GET` | `/refresh` | Re-parse `agent --help` and `agent models` |
| `GET` | `/openapi.json` | OpenAPI 3.1 specification |
| `GET` | `/docs` | Swagger UI (interactive API explorer) |

---

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `CURSOR_AGENT_PATH` | `agent` (PATH) | Path to cursor-agent binary |
| `CURSOR_AGENT_MODEL` | `composer-2-fast` | Default model for inference |
| `CURSOR_AGENT_FORCE` | `false` | Auto-approve tool use (`-f` flag) |
| `CURSOR_AGENT_TIMEOUT_MS` | `300000` | Per-request timeout (5 min default) |
| `DEBUG_ACP_API` | `0` | Enable debug logging to stderr |

---

## Architecture

```
Client (OpenAI SDK, curl, etc.)
        │  HTTP (OpenAI-format JSON / SSE)
        ▼
┌─────────────────────────────────┐
│  Bun.serve()                     │
│  ┌─────────────────────────────┐ │
│  │ /v1/chat/completions        │ │  ← OpenAI protocol
│  │ /v1/web-search              │ │  ← native web search tool (stream-json capture)
│  │ /v1/models                  │ │  ← live from `agent models`
│  │ /chat (flag passthrough)    │ │  ← any CLI flag as body param
│  │ /health, /help, /refresh    │ │  ← operational
│  │ /openapi.json, /docs        │ │  ← spec + Swagger UI
│  │ Zod validation (dynamic)    │ │  ← schemas built from --help
│  └──────────────┬──────────────┘ │
│                 │ spawn()         │
│  ┌──────────────▼──────────────┐ │
│  │ agent --print                │ │  ← Cursor CLI (non-interactive)
│  │ --output-format stream-json  │ │
│  │ --model <model> --mode <m>   │ │  ← all flags passed through
│  │ <prompt>                     │ │
│  └──────────────────────────────┘ │
└─────────────────────────────────┘
```

- **Dynamic introspection** — `agent --help` and `agent models` parsed at startup; `/refresh` re-parses live
- **Flag passthrough** — any CLI flag (`--mode`, `--sandbox`, `--trust`, etc.) becomes a JSON body field
- **No hardcoded schemas** — Zod validation, OpenAPI spec, and `/help` manifest are all built from live CLI introspection
- **Bun native** — `Bun.serve()` handles HTTP, `ReadableStream` handles SSE streaming

## License

MIT
