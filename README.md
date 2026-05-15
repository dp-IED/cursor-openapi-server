# cursor-openapi-server

OpenAI-compatible REST API server for [cursor-agent](https://cursor.com) inference. Point any OpenAI SDK client at `localhost:3000/v1` and use Cursor's models as a drop-in replacement.

**Runtime**: Bun — native HTTP, zero framework overhead, ~4x faster than Node/Express.

## Quick Start

```bash
# Prerequisites: Bun + cursor-agent CLI
curl -fsSL https://bun.sh/install | bash   # if needed
agent login                                  # if not already authenticated

# Clone and run
git clone https://github.com/dp-IED/super-duper-fishstick.git
cd super-duper-fishstick
bun install
bun run server.js                           # → http://0.0.0.0:3000
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

# Workspace-aware (agent sees your project)
curl -X POST :3000/chat \
  -H 'Content-Type: application/json' \
  -d '{"prompt":"Summarize the architecture","cwd":"/path/to/your/project"}'
```

### Any OpenAI-compatible client

Works with Continue.dev, Open Interpreter, LangChain, LiteLLM, and anything that speaks the OpenAI API. Just set `base_url` to `http://localhost:3000/v1`.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat (streaming SSE + non-streaming) |
| `GET` | `/v1/models` | Model list for SDK discovery |
| `POST` | `/chat` | Simple prompt-only interface with workspace support |
| `GET` | `/health` | Liveness probe + cursor-agent availability |
| `GET` | `/help` | Human-readable endpoint manifest |
| `GET` | `/openapi.json` | OpenAPI 3.1 specification |
| `GET` | `/docs` | Swagger UI (interactive API explorer) |

## Configuration

| Env Variable | Default | Description |
|-------------|---------|-------------|
| `PORT` | `3000` | Listen port |
| `HOST` | `0.0.0.0` | Listen address |
| `CURSOR_AGENT_PATH` | `agent` (PATH) | Path to cursor-agent binary |
| `CURSOR_AGENT_MODEL` | `composer-2-fast` | Default model for inference |
| `CURSOR_AGENT_FORCE` | `false` | Auto-approve tool use (`-f` flag) |
| `CURSOR_AGENT_TIMEOUT_MS` | `300000` | Per-request timeout (5 min default) |
| `CURSOR_AGENT_CWD` | `cwd` | Default workspace for repo context |
| `DEBUG_ACP_API` | `0` | Enable debug logging |

## Architecture

```
Client (OpenAI SDK, curl, etc.)
        │  HTTP (OpenAI-format JSON / SSE)
        ▼
┌─────────────────────────┐
│  Bun.serve()            │  ← Native Bun HTTP (~4x Node)
│  /v1/chat/completions   │
│  /v1/models             │
│  /chat, /health, /help  │
│  Zod validation         │
└───────────┬─────────────┘
            │  spawn()
            ▼
┌─────────────────────────┐
│  agent --print          │  ← Cursor CLI (non-interactive)
│  --output-format        │
│  stream-json | json     │
└─────────────────────────┘
```

- **No framework** — Bun's native `Bun.serve()` handles HTTP, `ReadableStream` handles SSE
- **No ACP** — Uses `agent --print` mode (ACP had a backend bug in cursor-agent v2026.05.09)
- **6 dependencies** — Only `zod` and `zod-to-json-schema` (+ Bun types for dev)
- **28ms install** — `bun install` completes in under 30ms

## Why not `agent acp`?

Cursor Agent's ACP (Agent Client Protocol) mode has an internal backend bug in v2026.05.09 that causes `"Failed to run step, exceeded max retries"` on all prompts. The `--print` mode is stable and delivers identical results. ACP support can be re-enabled when the upstream fix lands.

## License

MIT
