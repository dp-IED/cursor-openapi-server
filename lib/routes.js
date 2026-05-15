import { z } from 'zod';
import { buildOpenApiSpec } from './schemas.js';
import { runAgent, isExecutableAvailableForHealth } from './agent-client.js';
import {
  getParsedFlags,
  getChatRequestSchema,
  getOpenAiChatRequestSchema,
  refreshIntrospection,
  cliHelpOk,
  cliModelsOk,
  getParsedModels,
} from './introspection-cache.js';

const VERSION = '3.0.0';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/**
 * @param {import('./cli-introspect.js').ParsedFlag[]} flags
 */
function flagsToParameterManifest(flags) {
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const f of flags) {
    /** @type {Record<string, unknown>} */
    const entry = {
      type: f.type,
      description: f.description,
    };
    if (f.alias) entry.alias = f.alias;
    if (f.placeholder) entry.placeholder = f.placeholder;
    if (f.values) entry.values = f.values;
    if ('default' in f) entry.default = f.default;
    out[f.name] = entry;
  }
  return out;
}

function buildHelpEndpoints() {
  const dynamicFlagHelp = flagsToParameterManifest(getParsedFlags());

  return {
    'GET /health': {
      description: 'Liveness probe and agent binary discovery.',
      parameters: {},
    },
    'GET /help': {
      description: 'Lists routes and POST fields (OpenAPI + CLI-sourced flags).',
      parameters: {},
    },
    'GET /refresh': {
      description: 'Re-parses `agent --help` and `agent models` to refresh caches.',
      parameters: {},
    },
    'GET /openapi.json': {
      description: 'OpenAPI 3.1 document for this server.',
      parameters: {},
    },
    'GET /docs': {
      description: 'Interactive API documentation (Swagger UI).',
      parameters: {},
    },
    'POST /chat': {
      description:
        'Single-turn chat via `agent --print` with JSON or SSE (driven by `stream`). Non-flag fields: prompt (required), outputFormat (text hint), stream, cwd/worktree/extraArgs/timeout.',
      parameters: {
        prompt: {
          type: 'string',
          required: true,
          description: 'User message or instruction for the agent.',
        },
        outputFormat: {
          type: 'enum',
          values: ['text', 'markdown', 'json'],
          default: 'text',
          description: 'Prepends API hint text to shape assistant output (stdout is always JSON/stream-json).',
        },
        stream: {
          type: 'boolean',
          default: false,
          description: 'When true, stream assistant text as Server-Sent Events.',
        },
        timeout: {
          type: 'integer',
          optional: true,
          description: 'Prompt timeout in ms; falls back to CURSOR_AGENT_TIMEOUT_MS.',
        },
        cwd: {
          type: 'string',
          optional: true,
          description: 'Working directory hint used to resolve the workspace path.',
        },
        worktree: {
          type: 'string',
          optional: true,
          description:
            'Legacy workspace path, OR a short git worktree name when not path-like (maps to `-w/--worktree`).',
        },
        extraArgs: {
          type: 'array',
          items: { type: 'string' },
          optional: true,
          description: 'Extra argv tokens inserted before other flags.',
        },
        ...dynamicFlagHelp,
      },
    },
    'GET /v1/models': {
      description: 'OpenAI-compatible model list sourced from `agent models`.',
      parameters: {},
    },
    'POST /v1/web-search': {
      description:
        'Native web search via cursor-agent web search tool only — returns structured title/url/snippet rows from raw tool output (no LLM summary fallback).',
      parameters: {
        query: {
          type: 'string',
          required: true,
          description: 'Search query forwarded to the web search tool.',
        },
        maxResults: {
          type: 'integer',
          optional: true,
          default: 10,
          description: 'Max structured hits (clamped 1–20).',
        },
        model: {
          type: 'string',
          optional: true,
          description: 'Agent model id; falls back like `/v1/chat/completions`.',
        },
        timeout: {
          type: 'integer',
          optional: true,
          default: 30000,
          description: 'Milliseconds to wait for the web search tool to complete.',
        },
      },
    },
    'POST /v1/chat/completions': {
      description:
        'OpenAI-compatible chat completions; maps `messages` to a single agent prompt. Extra JSON fields map to CLI flags when recognized.',
      parameters: {
        model: {
          type: 'string',
          optional: true,
          description: 'Model id; falls back to CURSOR_AGENT_MODEL or the CLI-marked default model.',
        },
        messages: {
          type: 'array',
          required: true,
          description: 'OpenAI-style chat messages (system, user, assistant).',
        },
        stream: {
          type: 'boolean',
          default: false,
          description: 'When true, stream OpenAI-shaped SSE chunks ending with [DONE].',
        },
        temperature: {
          type: 'number',
          optional: true,
          description: 'Ignored by cursor-agent in print mode unless the CLI adds support.',
        },
        max_tokens: {
          type: 'integer',
          optional: true,
          description: 'Ignored by cursor-agent in print mode unless the CLI adds support.',
        },
        ...dynamicFlagHelp,
      },
    },
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function swaggerUiHtml() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Cursor Agent API</title>
  <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" crossorigin />
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js" crossorigin></script>
  <script>
    window.ui = SwaggerUIBundle({
      url: '/openapi.json',
      dom_id: '#swagger-ui',
    });
  </script>
</body>
</html>`;
}

/**
 * @param {Record<string, unknown>} body
 */
function chatSseResponse(body) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const result = await runAgent({
            ...body,
            stream: true,
            onChunk: (delta) => {
              controller.enqueue(
                enc.encode(`data: ${JSON.stringify({ delta })}\n\n`),
              );
            },
          });
          controller.enqueue(
            enc.encode(
              `data: ${JSON.stringify({
                stopReason: result.stopReason,
                usage: result.usage ?? null,
              })}\n\n`,
            ),
          );
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          controller.enqueue(enc.encode(`data: ${JSON.stringify({ error: msg })}\n\n`));
          controller.enqueue(enc.encode('data: [DONE]\n\n'));
        } finally {
          controller.close();
        }
      },
    }),
    { status: 200, headers: SSE_HEADERS },
  );
}

function agentInferenceUnavailable() {
  return !isExecutableAvailableForHealth();
}

/**
 * @param {Request} req
 * @param {{ port: number; host: string }} ctx
 */
export async function handleRequest(req, ctx) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === 'GET' && path === '/health') {
    const agentAvailable = isExecutableAvailableForHealth();
    return json({
      status: 'ok',
      agentAvailable,
      webSearchAvailable: agentAvailable,
      version: VERSION,
      timestamp: new Date().toISOString(),
    });
  }

  if (method === 'GET' && path === '/help') {
    return json({
      server: 'cursor-openai-server',
      version: VERSION,
      description:
        'OpenAI-shaped REST API for `cursor-agent` inference. Flags come from `agent --help`; models from `agent models`.',
      endpoints: buildHelpEndpoints(),
      flags: getParsedFlags(),
      introspection: {
        cliHelpOk: cliHelpOk,
        cliModelsOk: cliModelsOk,
      },
    });
  }

  if (method === 'GET' && path === '/refresh') {
    refreshIntrospection();
    return json({
      ok: true,
      flagCount: getParsedFlags().length,
      modelCount: getParsedModels().length,
    });
  }

  if (method === 'GET' && path === '/openapi.json') {
    const chatZod = getChatRequestSchema();
    const openAiZod = getOpenAiChatRequestSchema();
    if (!chatZod || !openAiZod) {
      return json({ error: 'OpenAPI schemas not initialized' }, 500);
    }
    return json(
      buildOpenApiSpec(ctx.port, ctx.host, VERSION, chatZod, openAiZod),
    );
  }

  if (method === 'GET' && path === '/docs') {
    return new Response(swaggerUiHtml(), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  if (method === 'POST' && path === '/chat') {
    if (agentInferenceUnavailable()) {
      return json({ error: 'agent executable is not available on this host' }, 503);
    }

    /** @type {unknown} */
    let raw;
    try {
      raw = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    const ChatRequest = getChatRequestSchema();
    if (!ChatRequest) {
      return json({ error: 'Request schema not initialized' }, 500);
    }

    let body;
    try {
      body = ChatRequest.parse(raw);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return json({ error: e.flatten() }, 400);
      }
      return json({ error: String(e) }, 400);
    }

    if (body.stream) {
      return chatSseResponse(body);
    }

    try {
      const result = await runAgent({
        ...body,
        stream: false,
      });
      return json({
        text: result.text,
        stopReason: result.stopReason,
        usage: result.usage ?? null,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.includes('timed out') ? 504 : 502;
      return json({ error: msg }, code);
    }
  }

  return json({ error: 'Not found' }, 404);
}
