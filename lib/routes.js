import { z } from 'zod';
import {
  ChatRequest,
  buildOpenApiSpec,
  commonParametersManifest,
} from './schemas.js';
import { runAgent, isExecutableAvailableForHealth } from './agent-client.js';

const VERSION = '2.0.0';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** Mirrors the former Fastify `config.help` manifest plus shared OpenAI routes. */
const HELP_ENDPOINTS = {
  'GET /health': {
    description: 'Liveness probe and agent binary discovery.',
    parameters: {},
  },
  'GET /help': {
    description: 'Lists routes and accepted POST parameters.',
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
      'Single-turn chat via `agent --print` (streaming uses text/event-stream with final [DONE]).',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'User message for the agent.',
      },
      ...commonParametersManifest,
    },
  },
  'GET /v1/models': {
    description: 'OpenAI-compatible model list for SDK clients.',
    parameters: {},
  },
  'POST /v1/chat/completions': {
    description:
      'OpenAI-compatible chat completions; maps `messages` to a single agent prompt and returns `choices[0].message.content` (or SSE chunks).',
    parameters: {
      model: {
        type: 'string',
        optional: true,
        description: 'Model id; falls back to CURSOR_AGENT_MODEL or composer-2-fast.',
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
        description: 'Ignored by cursor-agent in print mode.',
      },
      max_tokens: {
        type: 'integer',
        optional: true,
        description: 'Ignored by cursor-agent in print mode.',
      },
    },
  },
};

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

function chatSseResponse(body) {
  const enc = new TextEncoder();
  return new Response(
    new ReadableStream({
      async start(controller) {
        try {
          const result = await runAgent({
            prompt: body.prompt,
            model: body.model,
            cwd: body.cwd,
            worktree: body.worktree,
            extraArgs: body.extraArgs,
            force: body.force,
            outputFormat: body.outputFormat,
            stream: true,
            timeout: body.timeout,
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

/**
 * @param {Request} req
 * @param {{ port: number; host: string }} ctx
 */
export async function handleRequest(req, ctx) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === 'GET' && path === '/health') {
    return json({
      status: 'ok',
      agentAvailable: isExecutableAvailableForHealth(),
      version: VERSION,
      timestamp: new Date().toISOString(),
    });
  }

  if (method === 'GET' && path === '/help') {
    return json({
      server: 'cursor-acp-api',
      version: VERSION,
      description:
        'OpenAPI-compatible REST API for cursor-agent inference via `agent --print` (non-interactive CLI).',
      endpoints: HELP_ENDPOINTS,
      commonParameters: commonParametersManifest,
    });
  }

  if (method === 'GET' && path === '/openapi.json') {
    return json(buildOpenApiSpec(ctx.port, ctx.host));
  }

  if (method === 'GET' && path === '/docs') {
    return new Response(swaggerUiHtml(), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  if (method === 'POST' && path === '/chat') {
    let raw;
    try {
      raw = await req.json();
    } catch {
      return json({ error: 'Invalid JSON body' }, 400);
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
        prompt: body.prompt,
        model: body.model,
        cwd: body.cwd,
        worktree: body.worktree,
        extraArgs: body.extraArgs,
        force: body.force,
        outputFormat: body.outputFormat,
        stream: false,
        timeout: body.timeout,
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
