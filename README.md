# cursor-openapi-server

OpenAI-compatible REST API server for [cursor-cli]([https://cursor.com](https://cursor.com/cli)) inference. Point any OpenAI SDK client at `localhost:3000/v1` and use Cursor's models as a drop-in replacement.

**Runtime**: Bun — native HTTP.

## Quick Start

```bash
# Prerequisites: Bun + cursor-agent CLI
curl -fsSL https://bun.sh/install | bash   # if needed
agent login                                  # if not already authenticated

# Clone and run
git clone https://github.com/dp-IED/cursor-openapi-server.git
cd cursor-openapi-server
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

Works with Hermes Agent, LangChain, LiteLLM, and anything that speaks the OpenAI API. Just set `base_url` to `http://localhost:3000/v1`.

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

## License

MIT
