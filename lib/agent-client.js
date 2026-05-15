import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import { getParsedFlags } from './introspection-cache.js';

export function resolveExecutable(explicit) {
  if (explicit && explicit.trim()) return explicit.trim();
  if (process.env.CURSOR_AGENT_PATH && process.env.CURSOR_AGENT_PATH.trim()) {
    return process.env.CURSOR_AGENT_PATH.trim();
  }
  return 'agent';
}

function debugLog(...args) {
  if (process.env.DEBUG_ACP_API === '1' || process.env.DEBUG_ACP_API === 'true') {
    try {
      console.error('[cursor-acp-api]', ...args);
    } catch {
      /* ignore */
    }
  }
}

function envForceEnabled() {
  const v = (process.env.CURSOR_AGENT_FORCE || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

/**
 * @param {string} s
 */
function toKebabCase(s) {
  return s
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/_/g, '-')
    .toLowerCase();
}

/**
 * @param {string} s
 */
function isPathLike(s) {
  if (!s) return false;
  if (s.startsWith('.') || s.startsWith('/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(s)) return true;
  return s.includes('/') || s.includes('\\');
}

function formatPromptForOutput(prompt, outputFormat) {
  if (outputFormat === 'json') {
    return `${prompt}\n\n[API hint: respond with valid JSON only, no markdown fences.]`;
  }
  if (outputFormat === 'markdown') {
    return `${prompt}\n\n[API hint: use GitHub-flavored Markdown for the reply.]`;
  }
  return prompt;
}

function extractAssistantText(obj) {
  if (!obj || obj.type !== 'assistant' || !obj.message?.content) return '';
  let out = '';
  for (const block of obj.message.content) {
    if (block?.type === 'text' && typeof block.text === 'string') out += block.text;
  }
  return out;
}

/** Discriminated failures for `runWebSearch` (maps to HTTP error `type`). */
export class WebSearchError extends Error {
  /**
   * @param {'no_web_search' | 'timeout' | 'agent_error'} code
   * @param {string} message
   */
  constructor(code, message) {
    super(message);
    this.code = code;
    this.name = 'WebSearchError';
  }
}

/**
 * @param {string} text
 * @param {number} maxLen
 */
function truncateAtSentenceBoundary(text, maxLen) {
  const t = text.trim();
  if (t.length <= maxLen) return t;
  const slice = t.slice(0, maxLen);
  const lastBreak = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('.\n'));
  if (lastBreak >= 40) return slice.slice(0, lastBreak + 1).trim();
  return `${slice.trim()}…`;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * @param {string} chunk
 * @returns {{ links: { num: number; title: string; url: string }[]; content: string }}
 */
function parseChunkLinksAndContent(chunk) {
  const lines = chunk.split('\n');
  /** @type {{ num: number; title: string; url: string }[]} */
  const links = [];
  let i = 0;
  while (i < lines.length && /^\s*$/.test(lines[i])) i++;
  while (i < lines.length && /^links:\s*$/i.test(lines[i].trim())) i++;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^(\d+)\.\s*\[([^\]]+)\]\(([^)]+)\)/);
    if (m) {
      links.push({
        num: Number.parseInt(m[1], 10),
        title: m[2].trim(),
        url: m[3].trim(),
      });
      i++;
      continue;
    }
    if (links.length === 0 && /^\s*$/.test(line)) {
      i++;
      continue;
    }
    break;
  }
  const content = lines.slice(i).join('\n').trim();
  return { links, content };
}

/**
 * @param {string} chunk
 * @returns {{ num: number; title: string; url: string }[]}
 */
function fallbackMarkdownLinks(chunk) {
  const re = /\[([^\]]+)\]\((https?:[^)\s]+)\)/g;
  /** @type {{ num: number; title: string; url: string }[]} */
  const links = [];
  let m;
  let n = 1;
  while ((m = re.exec(chunk)) !== null) {
    links.push({ num: n++, title: m[1].trim(), url: m[2].trim() });
  }
  return links;
}

/**
 * @param {string} content
 * @param {{ num: number; title: string; url: string }[]} links
 * @param {string} chunkFallback
 * @returns {{ title: string; url: string; snippet: string }[]}
 */
function snippetsForLinks(content, links, chunkFallback) {
  const body = content.trim() ? content : chunkFallback;
  /** @type {Map<number, string[]>} */
  const byNum = new Map();
  const sentences = splitSentences(body);
  const citeRe = /\[(\d+)\]/g;
  for (const sentence of sentences) {
    citeRe.lastIndex = 0;
    let mm;
    /** @type {Set<number>} */
    const seen = new Set();
    while ((mm = citeRe.exec(sentence)) !== null) {
      const num = Number.parseInt(mm[1], 10);
      if (seen.has(num)) continue;
      seen.add(num);
      if (!byNum.has(num)) byNum.set(num, []);
      byNum.get(num)?.push(sentence);
    }
  }
  const shared = truncateAtSentenceBoundary(body, 300);
  /** @type {{ title: string; url: string; snippet: string }[]} */
  const out = [];
  for (const link of links) {
    const parts = byNum.get(link.num);
    const snippet =
      parts && parts.length > 0 ? parts.join(' ').trim() : shared;
    out.push({
      title: link.title,
      url: link.url,
      snippet: snippet || shared,
    });
  }
  return out;
}

/**
 * @param {unknown[]} references
 * @param {number} maxResults
 * @returns {{ title: string; url: string; snippet: string }[]}
 */
function referencesToStructuredResults(references, maxResults) {
  const chunks = [];
  for (const ref of references) {
    if (ref && typeof ref === 'object' && 'chunk' in ref && typeof /** @type {{chunk?: unknown}} */ (ref).chunk === 'string') {
      const c = /** @type {{ chunk: string }} */ (ref).chunk.trim();
      if (c) chunks.push(c);
    }
  }
  const chunkText = chunks.join('\n\n').trim();
  if (!chunkText) return [];

  let { links, content } = parseChunkLinksAndContent(chunkText);
  if (links.length === 0) links = fallbackMarkdownLinks(chunkText);

  const capped = links.slice(0, maxResults);
  if (capped.length === 0) return [];

  return snippetsForLinks(content, capped, chunkText);
}

/**
 * Spawn cursor-agent with stream-json; resolve on first completed web search tool result or structured errors.
 *
 * @param {{
 *   query: string;
 *   maxResults?: number;
 *   model?: string;
 *   timeout?: number;
 *   executable?: string;
 * }} opts
 */
export function runWebSearch(opts) {
  return new Promise((resolve, reject) => {
    const {
      query,
      maxResults: rawMax = 10,
      model: requestedModel,
      timeout: waitMs = 30000,
      executable,
    } = opts;

    const maxResults = Math.min(20, Math.max(1, Number.isFinite(rawMax) ? rawMax : 10));
    const model =
      typeof requestedModel === 'string' && requestedModel.trim()
        ? requestedModel.trim()
        : process.env.CURSOR_AGENT_MODEL?.trim() || 'composer-2-fast';

    const prompt = `Search the web for: ${query}

IMPORTANT: Use the web search tool to find current information. Do NOT answer from your training data or memory. Only use the web search tool, then stop — do not write a summary or analysis.`;

    const cmd = resolveExecutable(
      typeof executable === 'string' && executable.trim() ? executable : undefined,
    );

    const effectiveCwd = process.cwd();
    const argv = [
      '--print',
      '--output-format',
      'stream-json',
      '--trust',
      '--workspace',
      path.resolve(effectiveCwd),
      '--model',
      model,
      '--force',
      prompt,
    ];

    debugLog(
      'runWebSearch spawn:',
      cmd,
      argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '),
    );

    const started = Date.now();
    let completed = false;
    let stderrBuf = '';
    let sawWebSearchCompleted = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** @type {import('node:child_process').ChildProcess | undefined} */
    let child;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    const killChild = () => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };

    const finishOk = (
      /** @type {{ query: string; results: { title: string; url: string; snippet: string }[]; searchTimeMs: number; resultCount: number }} */ val,
    ) => {
      if (completed) return;
      completed = true;
      clearTimer();
      killChild();
      resolve(val);
    };

    const finishErr = (/** @type {WebSearchError | Error} */ err) => {
      if (completed) return;
      completed = true;
      clearTimer();
      killChild();
      reject(err);
    };

    timer = setTimeout(() => {
      finishErr(
        new WebSearchError(
          'timeout',
          `Web search timed out after ${waitMs}ms without invoking the search tool`,
        ),
      );
    }, waitMs);

    child = spawn(cmd, argv, {
      shell: false,
      cwd: effectiveCwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stderr?.on('data', (d) => {
      stderrBuf += d.toString();
    });

    child.on('error', (err) => {
      finishErr(new WebSearchError('agent_error', err.message));
    });

    let streamGotResult = false;

    child.on('close', (code) => {
      if (completed) return;
      if (streamGotResult) return;
      finishErr(
        new WebSearchError(
          'agent_error',
          `agent exited with code ${code}${stderrBuf ? `: ${stderrBuf.trimEnd().slice(-500)}` : ''}`,
        ),
      );
    });

    const rl = readline.createInterface({ input: /** @type {NodeJS.ReadableStream} */ (child.stdout), crlfDelay: Infinity });
    rl.on('line', (line) => {
      if (completed) return;
      /** @type {unknown} */
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        debugLog('runWebSearch non-json stream line', line.slice(0, 200));
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      /** @type {Record<string, unknown>} */
      const m = /** @type {Record<string, unknown>} */ (msg);

      if (m.type === 'tool_call' && m.subtype === 'completed') {
        /** @type {{ webSearchToolCall?: { result?: unknown } }} */
        const tc = /** @type {{ webSearchToolCall?: { result?: unknown } }} */ (m.tool_call ?? {});
        const wst = tc.webSearchToolCall;
        if (!wst) return;

        const result = wst.result;
        if (!result || typeof result !== 'object') {
          finishErr(new WebSearchError('agent_error', 'Web search tool completed without a result payload.'));
          return;
        }

        /** @type {Record<string, unknown>} */
        const rob = /** @type {Record<string, unknown>} */ (result);
        const success = rob.success;
        if (success !== undefined && typeof success === 'object' && success !== null) {
          const refs = /** @type {{ references?: unknown }} */ (success).references;
          if (!Array.isArray(refs)) {
            finishErr(
              new WebSearchError(
                'agent_error',
                'Web search tool completed without a references array.',
              ),
            );
            return;
          }

          sawWebSearchCompleted = true;
          if (refs.length === 0) {
            finishErr(new WebSearchError('no_web_search', 'Web search returned no references.'));
            return;
          }
          const results = referencesToStructuredResults(refs, maxResults);
          if (results.length === 0) {
            finishErr(new WebSearchError('no_web_search', 'Web search returned no references.'));
            return;
          }
          clearTimer();
          finishOk({
            query,
            results,
            searchTimeMs: Date.now() - started,
            resultCount: results.length,
          });
          return;
        }

        finishErr(
          new WebSearchError(
            'agent_error',
            `web search tool failed: ${JSON.stringify(result).slice(0, 800)}`,
          ),
        );
        return;
      }

      if (m.type === 'result') {
        streamGotResult = true;
        if (sawWebSearchCompleted) return;
        if (m.is_error === true) {
          const msgText =
            typeof m.result === 'string'
              ? m.result
              : `agent reported an error${stderrBuf ? `: ${stderrBuf.trimEnd().slice(-400)}` : ''}`;
          finishErr(new WebSearchError('agent_error', msgText));
          return;
        }
        finishErr(
          new WebSearchError(
            'no_web_search',
            'Agent completed without using web search tool. The model may have answered from memory instead of searching.',
          ),
        );
      }
    });
  });
}

/** @typedef {{ inputTokens?: number; outputTokens?: number; [k: string]: unknown }} AgentUsage */

/**
 * Build argv for agent from a flat request body (minus internal-only fields).
 *
 * @param {{
 *   prompt: string;
 *   stream: boolean;
 *   outputFormat?: string;
 *   cwd?: string;
 *   worktree?: string;
 *   extraArgs?: string[];
 *   force?: boolean;
 *   [k: string]: unknown;
 * }} opts
 */
function buildAgentArgv(opts) {
  const {
    prompt,
    stream,
    outputFormat: _hint,
    cwd,
    worktree,
    extraArgs,
    timeout: _timeout,
    onChunk: _onChunk,
    executable: _executable,
    ...rest
  } = opts;

  /** @type {Map<string, { alias?: string }} } */
  const metaByName = new Map();
  for (const f of getParsedFlags()) {
    metaByName.set(f.name, { alias: f.alias });
  }

  const explicitWorkspace = rest.workspace;
  delete rest.workspace;

  let gitWorktreeName;
  let legacyWorktreePath;
  if (worktree !== undefined && worktree !== null && String(worktree).trim()) {
    const ws = String(worktree).trim();
    if (isPathLike(ws)) legacyWorktreePath = ws;
    else gitWorktreeName = ws;
  }

  /** @type {string | undefined} */
  let explicitWorkspaceStr;
  if (explicitWorkspace !== undefined && explicitWorkspace !== null && String(explicitWorkspace).trim()) {
    explicitWorkspaceStr = String(explicitWorkspace).trim();
  }

  const resolvedWorkspace = explicitWorkspaceStr
    ? path.resolve(explicitWorkspaceStr)
    : legacyWorktreePath
      ? path.resolve(legacyWorktreePath)
      : cwd && String(cwd).trim()
        ? path.resolve(String(cwd).trim())
        : process.cwd();

  delete rest['output-format'];

  /** @type {string[]} */
  const argv = [...(extraArgs ?? [])];

  /** @type {Record<string, unknown>} */
  const passthrough = { ...rest };

  if (passthrough.force === undefined && envForceEnabled()) {
    passthrough.force = true;
  }

  /** @type {[string, unknown][]} */
  const entries = Object.entries(passthrough).filter(
    ([key]) => key !== 'workspace' && key !== 'worktree',
  );
  entries.sort(([a], [b]) => toKebabCase(a).localeCompare(toKebabCase(b)));

  const usedShort = new Set();

  for (const [rawKey, rawVal] of entries) {
    const k = toKebabCase(rawKey);
    if (k === 'output-format') continue;
    if (rawVal === undefined) continue;

    const meta = metaByName.get(k);
    const isBool = typeof rawVal === 'boolean';

    if (isBool) {
      if (rawVal === false) continue;
      if (meta?.alias && !usedShort.has(meta.alias)) {
        argv.push(`-${meta.alias}`);
        usedShort.add(meta.alias);
      } else {
        argv.push(`--${k}`);
      }
      continue;
    }

    if (typeof rawVal === 'string') {
      if (rawVal.trim() === '') continue;
      argv.push(`--${k}`, rawVal);
      continue;
    }

    if (typeof rawVal === 'number' && Number.isFinite(rawVal)) {
      argv.push(`--${k}`, String(rawVal));
    }
  }

  if (!argv.includes('--print') && !argv.includes('-p')) {
    argv.push('--print');
  }

  const outFmt = stream ? 'stream-json' : 'json';
  const ofIdx = argv.findIndex((a, i) => a === '--output-format' && argv[i + 1] !== undefined);
  if (ofIdx >= 0) argv.splice(ofIdx, 2);
  argv.push('--output-format', outFmt);

  if (!argv.includes('--trust') && passthrough.trust !== false) argv.push('--trust');

  const wsIdx = argv.findIndex((a, i) => a === '--workspace' && argv[i + 1] !== undefined);
  if (wsIdx >= 0) argv.splice(wsIdx, 2);
  argv.push('--workspace', resolvedWorkspace);

  if (gitWorktreeName) {
    argv.push('--worktree', gitWorktreeName);
  }

  argv.push(typeof prompt === 'string' ? prompt : String(prompt));

  return { argv, cwd: resolvedWorkspace };
}

/**
 * Run cursor-agent via `agent --print` (JSON stream-json / json modes).
 *
 * @param {{
 *   prompt: string;
 *   stream: boolean;
 *   onChunk?: (delta: string) => void;
 *   timeout?: number;
 *   executable?: string;
 *   outputFormat?: string;
 *   cwd?: string;
 *   worktree?: string;
 *   extraArgs?: string[];
 *   [k: string]: unknown;
 * }} opts
 */
export function runAgent(opts) {
  return new Promise((resolve, reject) => {
    const {
      prompt: rawPrompt,
      stream,
      onChunk,
      timeout: promptTimeoutMs,
      executable,
      outputFormat = 'text',
      ...restForArgv
    } = opts;

    const promptText = formatPromptForOutput(
      typeof rawPrompt === 'string' ? rawPrompt : String(rawPrompt),
      /** @type {'text' | 'markdown' | 'json'} */ (
        outputFormat === 'markdown' || outputFormat === 'json' ? outputFormat : 'text'
      ),
    );

    const { argv: builtArgv, cwd: effectiveCwd } = buildAgentArgv({
      ...restForArgv,
      prompt: promptText,
      stream: stream === true,
      outputFormat,
    });

    const cmd = resolveExecutable(
      typeof executable === 'string' && executable.trim() ? executable : undefined,
    );

    debugLog(
      'spawn:',
      cmd,
      builtArgv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '),
    );

    const envTimeout = Number.parseInt(process.env.CURSOR_AGENT_TIMEOUT_MS || '300000', 10);
    const effectiveTimeout =
      Number.isFinite(promptTimeoutMs) && promptTimeoutMs && promptTimeoutMs > 0
        ? promptTimeoutMs
        : Number.isFinite(envTimeout) && envTimeout > 0
          ? envTimeout
          : 300000;

    let stderrBuf = '';
    let completed = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;

    const clearTimer = () => {
      if (timer) clearTimeout(timer);
      timer = null;
    };

    /** @type {import('node:child_process').ChildProcess | undefined} */
    let child;

    const finishOk = (/** @type {{ text: string; stopReason: string; usage?: AgentUsage }} */ val) => {
      if (completed) return;
      completed = true;
      clearTimer();
      resolve(val);
    };

    const finishErr = (/** @type {Error} */ err) => {
      if (completed) return;
      completed = true;
      clearTimer();
      try {
        child?.kill('SIGKILL');
      } catch {
        /* ignore */
      }
      reject(err);
    };

    timer = setTimeout(() => {
      finishErr(new Error(`agent timed out after ${effectiveTimeout}ms`));
    }, effectiveTimeout);

    child = spawn(cmd, builtArgv, {
      shell: false,
      cwd: effectiveCwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    child.stderr?.on('data', (d) => {
      stderrBuf += d.toString();
    });

    child.on('error', (err) => {
      finishErr(err);
    });

    if (!stream) {
      const chunks = [];
      child.stdout?.on('data', (d) => chunks.push(d));

      child.on('close', (code) => {
        if (completed) return;
        const raw = Buffer.concat(chunks).toString('utf8').trimEnd();
        if (code !== 0) {
          finishErr(
            new Error(
              `agent exited with code ${code}${stderrBuf ? `: ${stderrBuf.slice(-500)}` : raw ? `: ${raw.slice(-500)}` : ''}`,
            ),
          );
          return;
        }

        /** @type {unknown} */
        let parsed;
        try {
          parsed = JSON.parse(raw);
        } catch {
          finishOk({ text: raw, stopReason: 'end_turn', usage: undefined });
          return;
        }

        /** @type {Record<string, unknown> | null} */
        const parsedObj =
          parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? /** @type {Record<string, unknown>} */ (parsed)
            : null;
        const resultBody =
          parsedObj && typeof parsedObj.result === 'string'
            ? parsedObj.result
            : String(parsedObj?.result ?? raw);
        const stopReason = parsedObj?.is_error === true ? 'error' : 'end_turn';
        const usage =
          parsedObj && 'usage' in parsedObj ? /** @type {AgentUsage | undefined} */ (parsedObj.usage) : undefined;

        finishOk({
          text: typeof resultBody === 'string' ? resultBody : String(resultBody),
          stopReason,
          usage,
        });
      });
      return;
    }

    let streamGotResult = false;
    let accumulatedStr = '';

    child.on('close', (code) => {
      if (completed || streamGotResult) return;
      finishErr(
        new Error(
          `agent exited with code ${code} before completing stream${stderrBuf ? `: ${stderrBuf.slice(-500)}` : ''}`,
        ),
      );
    });

    const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.on('line', (line) => {
      /** @type {unknown} */
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        debugLog('non-json stream line', line.slice(0, 200));
        return;
      }
      if (!msg || typeof msg !== 'object') return;
      /** @type {Record<string, unknown>} */
      const m = /** @type {Record<string, unknown>} */ (msg);
      const asst = extractAssistantText(m);
      if (asst && typeof onChunk === 'function') onChunk(asst);
      if (asst) accumulatedStr += asst;
      if (m.type === 'result') {
        streamGotResult = true;
        const usage = 'usage' in m ? /** @type {AgentUsage | undefined} */ (m.usage) : undefined;
        const textCombined =
          accumulatedStr.trim() !== ''
            ? accumulatedStr
            : typeof m.result === 'string'
              ? m.result
              : '';
        finishOk({
          text: textCombined,
          stopReason: m.is_error === true ? 'error' : 'end_turn',
          usage,
        });
      }
    });
  });
}

export function isExecutableAvailableForHealth(explicit) {
  const p = resolveExecutable(explicit);
  try {
    if (path.isAbsolute(p)) {
      fs.accessSync(p, fs.constants.X_OK);
      return true;
    }
    execFileSync('which', [p], { encoding: 'utf8', timeout: 3000 });
    return true;
  } catch {
    const home = process.env.HOME || '';
    const fallback = path.join(home, '.local/bin/agent');
    try {
      fs.accessSync(fallback, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
}
