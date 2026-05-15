import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** @typedef {import('./cli-introspect.js').ParsedFlag} ParsedFlag */

export const OpenAiMessage = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

/** Body for `POST /v1/web-search` — native cursor-agent web search tool (structured results only). */
export const WebSearchRequest = z.object({
  query: z.string().trim().min(1, 'query must not be empty'),
  maxResults: z.number().int().min(1).max(20).optional().default(10),
  model: z.string().optional(),
  timeout: z.number().int().min(1).optional().default(30000),
});

const API_DESCRIPTION =
  'REST API wrapping the Cursor CLI `agent --print` subprocess (non-interactive JSON/stream-json output). Flags and models are sourced from `agent --help` and `agent models` at startup.';

/** Fields handled by the HTTP layer (not generic CLI passthrough in Zod composition). */
const RESERVED_CHAT_KEYS = new Set([
  'prompt',
  'outputFormat',
  'stream',
  'timeout',
  'cwd',
  'worktree',
  'extraArgs',
  'messages',
  'temperature',
  'max_tokens',
]);

/**
 * @param {ParsedFlag[]} flags
 */
export function buildDynamicSchemas(flags) {
  /** @type {Record<string, z.ZodTypeAny>} */
  const flagFields = {};

  for (const f of flags) {
    if (f.name === 'output-format') continue;
    if (RESERVED_CHAT_KEYS.has(f.name)) continue;

    let zod;
    switch (f.type) {
      case 'boolean':
        zod =
          typeof f.default === 'boolean'
            ? z.boolean().default(f.default)
            : z.boolean().optional();
        break;
      case 'string':
        zod = z.string().optional();
        break;
      case 'optional-string':
        zod = z.string().optional();
        break;
      case 'enum': {
        const vals = f.values && f.values.length ? f.values : null;
        if (vals && vals.length >= 2) {
          const tup = /** @type {[string, ...string[]]} */ (
            /** @type {unknown} */ (vals)
          );
          zod =
            typeof f.default === 'string' && vals.includes(f.default)
              ? z.enum(tup).default(f.default)
              : z.enum(tup).optional();
        } else {
          zod = z.string().optional();
        }
        break;
      }
      default:
        zod = z.string().optional();
    }
    flagFields[f.name] = zod;
  }

  const ChatRequest = z
    .object({
      prompt: z.string().min(1),
      outputFormat: z.enum(['text', 'markdown', 'json']).default('text'),
      stream: z.boolean().default(false),
      timeout: z.number().int().min(1).optional(),
      cwd: z.string().optional(),
      worktree: z.string().optional(),
      extraArgs: z.array(z.string()).optional(),
      ...flagFields,
    })
    .passthrough();

  /** @type {Record<string, z.ZodTypeAny>} */
  const openAiFlagFields = {};
  for (const [k, v] of Object.entries(flagFields)) {
    if (k === 'model') continue;
    openAiFlagFields[k] = v;
  }

  const OpenAiChatRequest = z
    .object({
      model: z.string().optional(),
      messages: z.array(OpenAiMessage).min(1),
      stream: z.boolean().default(false),
      temperature: z.number().optional(),
      max_tokens: z.number().int().min(1).optional(),
      ...openAiFlagFields,
    })
    .passthrough();

  return { ChatRequest, OpenAiChatRequest };
}

/**
 * @param {z.ZodTypeAny} schema
 * @param {string} name
 */
export function zodSchemaToJson(schema, name = 'Schema') {
  return zodToJsonSchema(schema, {
    name,
    $refStrategy: 'none',
    target: 'openApi3',
  });
}

/**
 * @param {number} port
 * @param {string} host
 * @param {string} version
 * @param {z.ZodTypeAny} chatRequestZod
 * @param {z.ZodTypeAny} openAiChatZod
 */
export function buildOpenApiSpec(port, host, version, chatRequestZod, openAiChatZod) {
  const openApiHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const serverUrl = process.env.OPENAPI_SERVER_URL || `http://${openApiHost}:${port}`;

  return {
    openapi: '3.1.0',
    info: {
      title: 'Cursor Agent API',
      version,
      description: API_DESCRIPTION,
    },
    servers: [{ url: serverUrl }],
    paths: {
      '/health': {
        get: {
          summary: 'Health check',
          description: 'Service liveness and whether the agent executable can be resolved.',
          responses: {
            '200': {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string' },
                      agentAvailable: { type: 'boolean' },
                      webSearchAvailable: { type: 'boolean' },
                      version: { type: 'string' },
                      timestamp: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/help': {
        get: {
          summary: 'Endpoint manifest',
          description: 'Lists routes and flags discovered from `agent --help`.',
          responses: { '200': { description: 'Manifest' } },
        },
      },
      '/refresh': {
        get: {
          summary: 'Refresh CLI metadata',
          description: 'Re-runs `agent --help` and `agent models` to refresh cached flags and models.',
          responses: { '200': { description: 'Refresh summary' } },
        },
      },
      '/openapi.json': {
        get: {
          summary: 'OpenAPI document',
          description: 'OpenAPI 3.1 document for this server.',
          responses: { '200': { description: 'OpenAPI JSON' } },
        },
      },
      '/docs': {
        get: {
          summary: 'Swagger UI',
          description: 'Interactive API documentation.',
          responses: { '200': { description: 'HTML' } },
        },
      },
      '/chat': {
        post: {
          summary: 'Simple chat',
          description:
            'Runs `cursor-agent` with `--print` and `--output-format json|stream-json` (driven by `stream`).',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: zodSchemaToJson(chatRequestZod, 'ChatRequest'),
              },
            },
          },
          responses: {
            '200': { description: 'Completed turn or SSE stream' },
            '400': { description: 'Validation error' },
            '503': { description: 'Agent binary unavailable' },
            '502': { description: 'Agent error' },
            '504': { description: 'Timeout' },
          },
        },
      },
      '/v1/models': {
        get: {
          summary: 'List models',
          description: 'Returns model ids from `agent models`.',
          responses: {
            '200': { description: 'OpenAI models list' },
            '503': { description: 'Agent binary unavailable' },
          },
        },
      },
      '/v1/chat/completions': {
        post: {
          summary: 'OpenAI-compatible chat',
          description:
            'Runs cursor-agent with a prompt composed from OpenAI-style messages; supports JSON or SSE streaming.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: zodSchemaToJson(openAiChatZod, 'OpenAiChatRequest'),
              },
            },
          },
          responses: {
            '200': { description: 'OpenAI chat.completion or SSE stream' },
            '400': { description: 'Validation error' },
            '503': { description: 'Agent binary unavailable' },
            '502': { description: 'Agent error' },
            '504': { description: 'Timeout' },
          },
        },
      },
      '/v1/web-search': {
        post: {
          summary: 'Native web search',
          description:
            'Executes a web search via cursor-agent web tool and returns structured results. No LLM summarization — raw tool output.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: zodSchemaToJson(WebSearchRequest, 'WebSearchRequest'),
              },
            },
          },
          responses: {
            '200': { description: 'Search results' },
            '400': { description: 'Validation error' },
            '422': { description: 'Agent did not use web search or returned no references' },
            '503': { description: 'Agent binary unavailable' },
            '502': { description: 'Agent error' },
            '504': { description: 'Timeout before web search tool ran' },
          },
        },
      },
    },
  };
}
