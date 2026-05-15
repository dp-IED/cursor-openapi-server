import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';

/** Fields reused by POST bodies (chat and future endpoints). */
export const CommonParams = {
  model: z.string().optional(),
  outputFormat: z.enum(['text', 'markdown', 'json']).default('text'),
  stream: z.boolean().default(false),
  force: z.boolean().default(false),
  cwd: z.string().optional(),
  worktree: z.string().optional(),
  extraArgs: z.array(z.string()).optional(),
  timeout: z.number().int().min(1).optional(),
};

export const ChatRequest = z.object({
  prompt: z.string().min(1),
  ...CommonParams,
});

export const OpenAiMessage = z.object({
  role: z.enum(['system', 'user', 'assistant']),
  content: z.string(),
});

export const OpenAiChatRequest = z.object({
  model: z.string().optional(),
  messages: z.array(OpenAiMessage).min(1),
  stream: z.boolean().default(false),
  temperature: z.number().optional(),
  max_tokens: z.number().int().min(1).optional(),
});

export function zodSchemaToJson(schema, name = 'Schema') {
  return zodToJsonSchema(schema, {
    name,
    $refStrategy: 'none',
    target: 'openApi3',
  });
}

const API_DESCRIPTION =
  'REST API wrapping the Cursor CLI `agent --print` subprocess (non-interactive JSON/stream-json output).';

/**
 * @param {number} port
 * @param {string} host Server bind address (e.g. 0.0.0.0)
 */
export function buildOpenApiSpec(port, host) {
  const openApiHost = host === '0.0.0.0' ? '127.0.0.1' : host;
  const serverUrl = process.env.OPENAPI_SERVER_URL || `http://${openApiHost}:${port}`;

  return {
    openapi: '3.1.0',
    info: {
      title: 'Cursor Agent API',
      version: '2.0.0',
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
          description: 'Lists routes and accepted POST parameters.',
          responses: { '200': { description: 'Manifest' } },
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
            'Runs cursor-agent subprocess with `--print` and `--output-format json|stream-json`. Supports SSE when stream is true.',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: zodSchemaToJson(ChatRequest, 'ChatRequest'),
              },
            },
          },
          responses: {
            '200': { description: 'Completed turn or SSE stream' },
            '400': { description: 'Validation error' },
            '502': { description: 'Agent error' },
            '504': { description: 'Timeout' },
          },
        },
      },
      '/v1/models': {
        get: {
          summary: 'List models',
          description: 'Returns Cursor/agent model ids usable with chat completions.',
          responses: { '200': { description: 'OpenAI models list' } },
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
                schema: zodSchemaToJson(OpenAiChatRequest, 'OpenAiChatRequest'),
              },
            },
          },
          responses: {
            '200': { description: 'OpenAI chat.completion or SSE stream' },
            '400': { description: 'Validation error' },
            '502': { description: 'Agent error' },
            '504': { description: 'Timeout' },
          },
        },
      },
    },
  };
}

export const commonParametersManifest = {
  model: {
    type: 'string',
    optional: true,
    description: 'Agent model id; falls back to CURSOR_AGENT_MODEL when omitted.',
  },
  outputFormat: {
    type: 'enum',
    values: ['text', 'markdown', 'json'],
    default: 'text',
    description: 'Hints how the assistant should shape output (prepended hint for markdown/json).',
  },
  stream: {
    type: 'boolean',
    default: false,
    description: 'When true, stream assistant text as Server-Sent Events.',
  },
  force: {
    type: 'boolean',
    default: false,
    description: 'Passes agent force flag when true or CURSOR_AGENT_FORCE enables it.',
  },
  cwd: {
    type: 'string',
    optional: true,
    description: 'Working directory hint; resolved to an absolute path with worktree.',
  },
  worktree: {
    type: 'string',
    optional: true,
    description: 'Preferred workspace directory; overrides cwd when both are set.',
  },
  extraArgs: {
    type: 'array',
    items: { type: 'string' },
    optional: true,
    description: 'Extra argv tokens passed to the agent before --print.',
  },
  timeout: {
    type: 'integer',
    optional: true,
    description: 'Prompt timeout in ms; falls back to CURSOR_AGENT_TIMEOUT_MS.',
  },
};
