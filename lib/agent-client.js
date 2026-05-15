import { spawn, execFileSync } from 'node:child_process';
import readline from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

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

/** @typedef {{ inputTokens?: number; outputTokens?: number; [k: string]: unknown }} AgentUsage */

/**
 * Run cursor-agent via `agent --print` (JSON stream-json / json modes).
 *
 * @param {{
 *   prompt: string,
 *   model?: string,
 *   cwd?: string,
 *   worktree?: string,
 *   extraArgs?: string[],
 *   force?: boolean,
 *   executable?: string,
 *   outputFormat?: 'text' | 'markdown' | 'json',
 *   stream: boolean,
 *   timeout?: number,
 *   onChunk?: (delta: string) => void,
 * }} opts
 */
export function runAgent({
  prompt,
  model,
  cwd,
  worktree,
  extraArgs,
  force,
  executable,
  outputFormat = 'text',
  stream,
  timeout: promptTimeoutMs,
  onChunk,
}) {
  return new Promise((resolve, reject) => {
    const cmd = resolveExecutable(executable);
    const effectiveCwd = path.resolve(worktree ?? cwd ?? process.cwd());

    const envModel = process.env.CURSOR_AGENT_MODEL && process.env.CURSOR_AGENT_MODEL.trim();
    const effectiveModel = model?.trim?.() || envModel;
    const effectiveForce = typeof force === 'boolean' ? force : envForceEnabled();

    const promptText = formatPromptForOutput(prompt, outputFormat);
    const outFmt = stream ? 'stream-json' : 'json';

    const argv = [
      ...(extraArgs ?? []),
      ...(effectiveModel ? ['--model', effectiveModel] : []),
      ...(effectiveForce ? ['-f'] : []),
      '--print',
      '--output-format',
      outFmt,
      '--trust',
      '--workspace',
      effectiveCwd,
      promptText,
    ];

    debugLog('spawn:', cmd, argv.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' '));

    const envTimeout = Number.parseInt(process.env.CURSOR_AGENT_TIMEOUT_MS || '300000', 10);
    const effectiveTimeout =
      Number.isFinite(promptTimeoutMs) && promptTimeoutMs > 0
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
        const usage = 'usage' in m ? /** @type {AgentUsage | undefined} */ (/** @type {unknown} */ (m.usage)) : undefined;
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
