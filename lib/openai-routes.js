import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { z } from 'zod';
import { runAgent, isExecutableAvailableForHealth, runWebSearch, WebSearchError } from './agent-client.js';
import { WebSearchRequest } from './schemas.js';
import { getOpenAiChatRequestSchema, getParsedModels } from './introspection-cache.js';

export function messagesToPrompt(messages) {
  const lines = [];
  for (const m of messages) {
    if (m.role === 'system') lines.push(`[System: ${m.content}]`);
    else if (m.role === 'user') lines.push(`User: ${m.content}`);
    else if (m.role === 'assistant') lines.push(`Assistant: ${m.content}`);
  }
  return lines.join('\n');
}

function defaultModelId() {
  const env = process.env.CURSOR_AGENT_MODEL?.trim();
  if (env) return env;
  const models = getParsedModels();
  const def = models.find((m) => m.default);
  if (def) return def.id;
  return 'composer-2-fast';
}

function resolveModel(requested) {
  return requested?.trim() || defaultModelId();
}

function buildUsage(prompt, completionText, rawUsage) {
  const promptTok =
    typeof rawUsage?.inputTokens === 'number' && Number.isFinite(rawUsage.inputTokens)
      ? rawUsage.inputTokens
      : Math.max(1, Math.ceil(prompt.length / 4));
  const completionTok =
    typeof rawUsage?.outputTokens === 'number' && Number.isFinite(rawUsage.outputTokens)
      ? rawUsage.outputTokens
      : Math.max(1, Math.ceil(completionText.length / 4));
  return {
    prompt_tokens: promptTok,
    completion_tokens: completionTok,
    total_tokens: promptTok + completionTok,
  };
}

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

function modelsPayload() {
  const created = Math.floor(Date.now() / 1000);
  const models = getParsedModels();
  const envFallback = process.env.CURSOR_AGENT_MODEL?.trim();
  const rows =
    models.length > 0
      ? models
      : envFallback
        ? [{ id: envFallback, name: envFallback, default: true }]
        : [{ id: 'composer-2-fast', name: 'Composer 2 Fast (fallback)', default: true }];

  return {
    object: 'list',
    data: rows.map((m) => ({
      id: m.id,
      object: 'model',
      created,
      owned_by: 'cursor',
    })),
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function agentInferenceUnavailable() {
  return !isExecutableAvailableForHealth();
}

/**
 * @param {Request} req
 * @param {{ port: number; host: string }} _ctx
 */
export async function handleOpenAiRequest(req, _ctx) {
  const url = new URL(req.url);
  const path = url.pathname;
  const method = req.method;

  if (method === 'GET' && path === '/v1/models') {
    return json(modelsPayload());
  }

  if (method === 'POST' && path === '/v1/web-search') {
    if (agentInferenceUnavailable()) {
      return json({ error: { message: 'agent executable is not available on this host' } }, 503);
    }

    /** @type {unknown} */
    let raw;
    try {
      raw = await req.json();
    } catch {
      return json({ error: { message: 'Invalid JSON body' } }, 400);
    }

    let body;
    try {
      body = WebSearchRequest.parse(raw);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return json({ error: e.flatten() }, 400);
      }
      return json({ error: { message: String(e) } }, 400);
    }

    try {
      const out = await runWebSearch({
        query: body.query,
        maxResults: body.maxResults,
        model: resolveModel(body.model),
        timeout: body.timeout,
      });
      return json(out, 200);
    } catch (err) {
      if (err instanceof WebSearchError) {
        const payload = { error: { type: err.code, message: err.message } };
        const status =
          err.code === 'timeout' ? 504 : err.code === 'no_web_search' ? 422 : 502;
        return json(payload, status);
      }
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: { type: 'agent_error', message: msg } }, 502);
    }
  }

  if (method === 'POST' && path === '/v1/chat/completions') {
    if (agentInferenceUnavailable()) {
      return json({ error: { message: 'agent executable is not available on this host' } }, 503);
    }

    /** @type {unknown} */
    let raw;
    try {
      raw = await req.json();
    } catch {
      return json({ error: { message: 'Invalid JSON body' } }, 400);
    }

    const OpenAiChatRequest = getOpenAiChatRequestSchema();
    if (!OpenAiChatRequest) {
      return json({ error: { message: 'Request schema not initialized' } }, 500);
    }

    let body;
    try {
      body = OpenAiChatRequest.parse(raw);
    } catch (e) {
      if (e instanceof z.ZodError) {
        return json({ error: e.flatten() }, 400);
      }
      return json({ error: { message: String(e) } }, 400);
    }

    const { messages, temperature: _t, max_tokens: _m, stream, model, ...cliFlags } = body;
    const composedPrompt = messagesToPrompt(messages);
    const modelLabel = resolveModel(model);
    const created = Math.floor(Date.now() / 1000);
    const completionId = `chatcmpl-${randomUUID().replace(/-/g, '')}`;

    if (stream) {
      const enc = new TextEncoder();
      return new Response(
        new ReadableStream({
          async start(controller) {
            const writeChunk = (payload) => {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(payload)}\n\n`));
            };

            try {
              writeChunk({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: modelLabel,
                choices: [
                  {
                    index: 0,
                    delta: { role: 'assistant', content: '' },
                    finish_reason: null,
                  },
                ],
              });

              const result = await runAgent({
                ...cliFlags,
                prompt: composedPrompt,
                model,
                stream: true,
                outputFormat: 'text',
                onChunk: (deltaText) => {
                  if (!deltaText) return;
                  writeChunk({
                    id: completionId,
                    object: 'chat.completion.chunk',
                    created,
                    model: modelLabel,
                    choices: [
                      {
                        index: 0,
                        delta: { content: deltaText },
                        finish_reason: null,
                      },
                    ],
                  });
                },
              });

              const usage = buildUsage(composedPrompt, result.text, result.usage);
              writeChunk({
                id: completionId,
                object: 'chat.completion.chunk',
                created,
                model: modelLabel,
                choices: [
                  {
                    index: 0,
                    delta: {},
                    finish_reason: 'stop',
                  },
                ],
                usage,
              });
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              writeChunk({ error: { message: msg } });
              controller.enqueue(enc.encode('data: [DONE]\n\n'));
            } finally {
              controller.close();
            }
          },
        }),
        { status: 200, headers: SSE_HEADERS },
      );
    }

    try {
      const result = await runAgent({
        ...cliFlags,
        prompt: composedPrompt,
        model,
        stream: false,
        outputFormat: 'text',
      });
      const usage = buildUsage(composedPrompt, result.text, result.usage);
      return json({
        id: completionId,
        object: 'chat.completion',
        created,
        model: modelLabel,
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: result.text },
            finish_reason: 'stop',
          },
        ],
        usage,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = msg.includes('timed out') ? 504 : 502;
      return json({ error: { message: msg } }, code);
    }
  }

  return json({ error: 'Not found' }, 404);
}
