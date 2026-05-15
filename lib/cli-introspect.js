import { execFileSync } from 'node:child_process';
import process from 'node:process';

function resolveAgentExecutable() {
  if (process.env.CURSOR_AGENT_PATH && process.env.CURSOR_AGENT_PATH.trim()) {
    return process.env.CURSOR_AGENT_PATH.trim();
  }
  return 'agent';
}

/**
 * @typedef {Object} ParsedFlag
 * @property {string} name
 * @property {string} [alias]
 * @property {'boolean' | 'string' | 'enum' | 'optional-string'} type
 * @property {string} description
 * @property {unknown} [default]
 * @property {string} [placeholder]
 * @property {string[]} [values]
 */

/**
 * Minimal fallback when `agent` cannot be executed (Zod + docs only).
 * @type {ParsedFlag[]}
 */
export const INTROSPECTION_FALLBACK_FLAGS = [
  {
    name: 'model',
    type: 'string',
    description: 'Model to use (from `agent --help` when available)',
    placeholder: 'model',
  },
  {
    name: 'output-format',
    type: 'enum',
    values: ['text', 'markdown', 'json', 'stream-json'],
    default: 'text',
    description: 'Output format for `--print` runs',
  },
  {
    name: 'force',
    alias: 'f',
    type: 'boolean',
    default: false,
    description: 'Force allow commands',
  },
  {
    name: 'trust',
    type: 'boolean',
    default: false,
    description: 'Trust the workspace',
  },
  {
    name: 'workspace',
    type: 'string',
    description: 'Workspace directory',
    placeholder: 'path',
  },
];

export function getCliHelp() {
  const exe = resolveAgentExecutable();
  return execFileSync(exe, ['--help'], { encoding: 'utf8', timeout: 5000 });
}

export function getModels() {
  const exe = resolveAgentExecutable();
  return execFileSync(exe, ['models'], { encoding: 'utf8', timeout: 5000 });
}

/**
 * @param {string} helpText
 * @returns {ParsedFlag[]}
 */
export function parseCliHelp(helpText) {
  const optionsSection = extractSection(helpText, /^Options:\s*$/m, /^Commands:\s*$/m);
  if (!optionsSection) return [];

  /** @type {string[]} */
  const lines = optionsSection.split(/\r?\n/);

  /** @type {{ rawFirst: string; continuation: string[] }[]} */
  const blocks = [];
  /** @type {{ rawFirst: string; continuation: string[] } | null} */
  let current = null;

  for (const line of lines) {
    if (!line.trim()) continue;

    if (isOptionStartLine(line)) {
      current = { rawFirst: line, continuation: [] };
      blocks.push(current);
    } else if (current) {
      current.continuation.push(line);
    }
  }

  /** @type {ParsedFlag[]} */
  const out = [];
  for (const block of blocks) {
    const fullText = [block.rawFirst, ...block.continuation].join('\n');
    const parsed = parseOptionBlock(block.rawFirst, fullText);
    if (parsed) out.push(parsed);
  }

  const seen = new Set();
  return out.filter((f) => {
    if (seen.has(f.name)) return false;
    seen.add(f.name);
    return true;
  });
}

/**
 * @param {string} text
 * @param {RegExp} startRe
 * @param {RegExp} endRe
 */
function extractSection(text, startRe, endRe) {
  const startMatch = text.match(startRe);
  if (!startMatch || startMatch.index === undefined) return null;
  const startIdx = startMatch.index + startMatch[0].length;
  const tail = text.slice(startIdx);
  const endMatch = tail.match(endRe);
  const endIdx = endMatch && endMatch.index !== undefined ? endMatch.index : tail.length;
  return tail.slice(0, endIdx);
}

/**
 * @param {string} line
 */
function isOptionStartLine(line) {
  return /^\s+(?:(-[\w]),\s*)?--[\w-]+/.test(line);
}

/**
 * @param {string} firstLine
 * @param {string} fullText
 * @returns {ParsedFlag | null}
 */
function parseOptionBlock(firstLine, fullText) {
  const header = firstLine.match(/^\s+(?:(-[\w]),\s*)?(--[\w-]+)/);
  if (!header || header.index === undefined) return null;

  const shortAlias = header[1] ? header[1].replace(/^-/, '') : undefined;
  const longToken = header[2];
  const name = longToken.replace(/^--/, '');

  const afterLong = firstLine.slice(header.index + header[0].length);

  /** @type {'boolean' | 'string' | 'enum' | 'optional-string'} */
  let type = 'boolean';
  /** @type {string | undefined} */
  let placeholder;
  /** @type {string} */
  let descriptionRest = afterLong.trimStart();

  const angle = descriptionRest.match(/^<([^>]+)>\s*(.*)$/s);
  const square = descriptionRest.match(/^\[([^\]]+)\]\s*(.*)$/s);
  if (angle) {
    type = 'string';
    placeholder = angle[1].trim();
    descriptionRest = angle[2] ?? '';
  } else if (square) {
    type = 'optional-string';
    placeholder = square[1].trim();
    descriptionRest = square[2] ?? '';
  }

  const description = normalizeDescription(`${descriptionRest}\n${fullText.slice(firstLine.length)}`.trim());

  const choices = parseChoices(description);
  const defaultVal = parseDefault(description);

  /** @type {string[] | undefined} */
  let enumValues = choices;
  if (!enumValues) {
    const pipes = enumFromPipeList(description);
    if (pipes && pipes.length >= 2) enumValues = pipes;
  }

  if (enumValues && enumValues.length >= 2) {
    type = 'enum';
  }

  /** @type {ParsedFlag} */
  const flag = {
    name,
    description: extractSummary(description),
    type,
  };
  if (shortAlias) flag.alias = shortAlias;
  if (placeholder) flag.placeholder = placeholder;
  if (enumValues && enumValues.length >= 2) flag.values = enumValues;
  if (defaultVal !== undefined) flag.default = defaultVal;

  if (type === 'boolean' && !('default' in flag) && /\(default:\s*false\)/i.test(description)) {
    flag.default = false;
  }
  if (type === 'boolean' && !('default' in flag) && /\(default:\s*true\)/i.test(description)) {
    flag.default = true;
  }

  return flag;
}

/**
 * @param {string} text
 */
function normalizeDescription(text) {
  return text
    .split(/\r?\n/)
    .map((l) => l.replace(/^\s+/, ' ').trimEnd())
    .join('\n')
    .replace(/\s+\n/g, '\n')
    .trim();
}

/**
 * @param {string} text
 */
function extractSummary(text) {
  const one = text.replace(/\s+/g, ' ').trim();
  if (!one) return '';
  const sent = one.split(/(?<=[.!?])\s+/);
  return sent[0] ?? one;
}

/**
 * @param {string} text
 */
function parseDefault(text) {
  const m = text.match(/\(default:\s*([^)]+)\)/i);
  if (!m) return undefined;
  let raw = m[1].trim();
  if (raw === 'false') return false;
  if (raw === 'true') return true;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  return raw;
}

/**
 * @param {string} text
 */
function parseChoices(text) {
  const m = text.match(/\(choices:\s*([^)]+)\)/i);
  if (!m) return null;
  const inner = m[1];
  const parts = [];
  for (const tok of inner.split(',')) {
    const s = tok.trim();
    const unq = s.replace(/^["']|["']$/g, '');
    if (unq) parts.push(unq);
  }
  return parts.length >= 2 ? parts : null;
}

/**
 * @param {string} text
 */
function enumFromPipeList(text) {
  /** @type {string | null} */
  let best = null;
  let bestLen = 0;
  const re = /([\w][\w.-]*(?:\s*\|\s*[\w][\w.-]*)+)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const candidate = m[1];
    const parts = candidate.split(/\s*\|\s*/).map((p) => p.trim());
    if (parts.length >= 2 && candidate.length > bestLen) {
      best = candidate;
      bestLen = candidate.length;
    }
  }
  if (!best) return null;
  return best.split(/\s*\|\s*/).map((p) => p.trim()).filter(Boolean);
}

/**
 * @param {string} modelsText
 * @returns {{ id: string; name: string; default: boolean }[]}
 */
export function parseModels(modelsText) {
  /** @type {{ id: string; name: string; default: boolean }[]} */
  const out = [];
  for (const line of modelsText.split(/\r?\n/)) {
    const t = line.trim();
    if (!t) continue;
    if (/^available models/i.test(t)) continue;
    if (t.toLowerCase().startsWith('tip:')) continue;

    const m = t.match(/^(\S+)\s+-\s+(.+?)(?:\s*\(([^)]*)\))?\s*$/);
    if (!m) continue;
    const id = m[1];
    const baseName = m[2].trim();
    const paren = (m[3] || '').toLowerCase();
    const isDefault = paren.includes('default');
    out.push({
      id,
      name: baseName,
      default: isDefault,
    });
  }
  return out;
}
