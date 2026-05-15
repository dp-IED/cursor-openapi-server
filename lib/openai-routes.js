import { randomUUID } from 'node:crypto';
import process from 'node:process';
import { z } from 'zod';
import { OpenAiChatRequest } from './schemas.js';
import { runAgent } from './agent-client.js';

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
  return env || 'composer-2-fast';
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
  const primary = defaultModelId();
  const ids = new Set([
    primary,
    'composer-2-fast',
    'claude-3.5-sonnet',
    'gpt-4o',
  ]);
  return {
    object: 'list',
    data: [...ids].map((id) => ({
      id,
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

  if (method === 'POST' && path === '/v1/chat/completions') {
    let raw;
    try {
      raw = await req.json();
    } catch {
      return json({ error: { message: 'Invalid JSON body' } }, 400);
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

    const composedPrompt = messagesToPrompt(body.messages);
    const modelLabel = resolveModel(body.model);
    const created = Math.floor(Date.now() / 1000);
    const completionId = `chatcmpl-${randomUUID().replace(/-/g, '')}`;

    if (body.stream) {
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
                prompt: composedPrompt,
                model: body.model,
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
        prompt: composedPrompt,
        model: body.model,
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
