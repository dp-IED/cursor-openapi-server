import { warmIntrospection, getParsedFlags, getParsedModels } from './lib/introspection-cache.js';
import { handleRequest } from './lib/routes.js';
import { handleOpenAiRequest } from './lib/openai-routes.js';

const VERSION = '3.0.0';

const port = Number.parseInt(process.env.PORT || '3000', 10);
const host = process.env.HOST || '0.0.0.0';

warmIntrospection();
console.log(
  `cursor-openapi-server v${VERSION} — ${getParsedModels().length} models, ${getParsedFlags().length} flags`,
);

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function addCors(res) {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.headers.set(k, v);
  }
  return res;
}

Bun.serve({
  port,
  hostname: host,
  async fetch(req) {
    const method = req.method;

    if (method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { ...CORS_HEADERS } });
    }

    const url = new URL(req.url);
    const path = url.pathname;

    try {
      if (path.startsWith('/v1/')) {
        return addCors(await handleOpenAiRequest(req, { port, host }));
      }
      return addCors(await handleRequest(req, { port, host }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return addCors(
        new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
        }),
      );
    }
  },
});

console.log(`listening — http://${host}:${port}`);
