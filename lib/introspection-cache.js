import {
  getCliHelp,
  getModels,
  parseCliHelp,
  parseModels,
  INTROSPECTION_FALLBACK_FLAGS,
} from './cli-introspect.js';
import { buildDynamicSchemas } from './schemas.js';

/** @type {import('zod').ZodTypeAny | null} */
let chatRequestSchema = null;

/** @type {import('zod').ZodTypeAny | null} */
let openAiChatRequestSchema = null;

/** @type {import('./cli-introspect.js').ParsedFlag[]} */
export let parsedFlags = [...INTROSPECTION_FALLBACK_FLAGS];

/** @type {{ id: string; name: string; default: boolean }[]} */
export let parsedModels = [];

export let cliHelpOk = false;
export let cliModelsOk = false;

/** @type {Error | null} */
export let lastHelpError = null;

/** @type {Error | null} */
export let lastModelsError = null;

export function rebuildApiSchemas() {
  const built = buildDynamicSchemas(parsedFlags);
  chatRequestSchema = built.ChatRequest;
  openAiChatRequestSchema = built.OpenAiChatRequest;
}

export function getChatRequestSchema() {
  return chatRequestSchema;
}

export function getOpenAiChatRequestSchema() {
  return openAiChatRequestSchema;
}

export function warmIntrospection() {
  try {
    parsedFlags = parseCliHelp(getCliHelp());
    cliHelpOk = true;
    lastHelpError = null;
  } catch (err) {
    lastHelpError = err instanceof Error ? err : new Error(String(err));
    console.warn(
      '[cursor-openapi-server] `agent --help` failed; using fallback flag metadata:',
      lastHelpError.message,
    );
    parsedFlags = [...INTROSPECTION_FALLBACK_FLAGS];
    cliHelpOk = false;
  }

  try {
    parsedModels = parseModels(getModels());
    cliModelsOk = true;
    lastModelsError = null;
  } catch (err) {
    lastModelsError = err instanceof Error ? err : new Error(String(err));
    console.warn(
      '[cursor-openapi-server] `agent models` failed; model list will be empty until /refresh:',
      lastModelsError.message,
    );
    parsedModels = [];
    cliModelsOk = false;
  }

  rebuildApiSchemas();
}

export function refreshIntrospection() {
  warmIntrospection();
}

export function getParsedFlags() {
  return parsedFlags;
}

export function getParsedModels() {
  return parsedModels;
}
