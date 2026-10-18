/**
 * Picker rows for DSH conversations.
 *
 * A DSH session log carries no title: the sidebar title lives in the session
 * projection cache (`storages/session_projcache/sessions/<id>.json` →
 * `record.rows.title.val`). Without it the picker can only offer
 * `会话 session-c6b923ac`, which tells a user nothing — that is the bug this module
 * fixes. The cache is DSH-internal, so every read is defensive: a missing,
 * malformed or newer-format file simply yields `null` and the caller falls back to
 * the first user message.
 *
 * Empty sessions (created by pressing "new chat" and never used) have no messages
 * at all. Listing them made the picker look broken, so they are dropped by
 * default.
 *
 * @module deepseek-web-chat/dsh-sessions
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/** How much of the opening question / closing answer a row shows. */
export const PREVIEW_CHARS = 160;
/** Longest title taken from a message when the cache has no title. */
export const DERIVED_TITLE_CHARS = 48;

/**
 * Read the cached title for one session.
 * @param {object} options
 * @param {string} options.home Harness home.
 * @param {string} options.id Session id.
 * @returns {Promise<{title: string|null, firstAsk: string|null}>}
 */
export async function readCachedTitle({ home, id }) {
  const file = path.join(home, 'storages', 'session_projcache', 'sessions', `${id}.json`);
  try {
    const text = await readFile(file, 'utf8');
    const record = JSON.parse(text)?.record;
    const rows = record?.rows ?? {};
    const title = typeof rows.title?.val === 'string' && rows.title.val.trim().length > 0 ? rows.title.val.trim() : null;
    const first = rows.titleInput?.val?.first;
    const firstAsk = typeof first?.text === 'string' && first.text.trim().length > 0 ? first.text.trim() : null;
    return { title, firstAsk };
  } catch {
    // No cache yet, unreadable file, or a format this build does not know.
    return { title: null, firstAsk: null };
  }
}

/**
 * Pick the label a user will recognise.
 *
 * Order: the title DSH generated → the opening question → a neutral placeholder.
 * The session id is never the primary label; it stays available as metadata.
 * @param {object} options
 * @param {string|null} [options.cached] Title from the projection cache.
 * @param {string|null} [options.firstAsk] First user message text.
 * @param {string} [options.fallback] Placeholder when nothing else exists.
 */
export function titleOf({ cached, firstAsk, fallback = '' }) {
  if (typeof cached === 'string' && cached.trim().length > 0) return clip(cached.trim(), 80);
  if (typeof firstAsk === 'string' && firstAsk.trim().length > 0) {
    const text = firstAsk.replace(/\s+/gu, ' ').trim();
    return text.length > DERIVED_TITLE_CHARS ? `${text.slice(0, DERIVED_TITLE_CHARS)}…` : text;
  }
  return fallback;
}

/**
 * Two short excerpts: how the conversation opened and how it last answered.
 * @param {{first?: string|null, last?: string|null}} parts
 * @returns {{ask: string, answer: string}}
 */
export function previewOf({ first, last }) {
  return {
    ask: clip(collapse(first), PREVIEW_CHARS),
    answer: clip(collapse(last), PREVIEW_CHARS),
  };
}

/** Normalize whitespace so a multi-line message still reads as one line. */
function collapse(text) {
  return typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim() : '';
}

/** Cut on a character boundary and add an ellipsis only when something was cut. */
function clip(text, limit) {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}…`;
}

/** How many transcript lines the expanded row shows, and how long each may be. */
export const EXCERPT_LINES = 4;
export const EXCERPT_CHARS = 240;

/** Longest one transcript entry may be, and how many entries are kept. */
export const ENTRY_CLIP = 4000;
export const MAX_TURNS = 40;

/**
 * Split one message's blocks into prose and the names of the tools it called.
 * Reasoning blocks are deliberately dropped: they are the model's scratchpad, and
 * including them would triple the prompt size for no context value.
 * @param {unknown} content
 */
export function blocksToContent(content) {
  if (!Array.isArray(content)) return { text: '', tools: [] };
  const texts = [];
  const tools = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block?.type === 'tool-call' && typeof block.name === 'string') tools.push(block.name);
  }
  return { text: texts.join('\n'), tools };
}

/** Fold a turn's tool calls into one readable note. */
export function summarizeTools(tools) {
  if (tools.length === 0) return '';
  const counts = new Map();
  for (const name of tools) counts.set(name, (counts.get(name) ?? 0) + 1);
  const parts = [...counts].map(([name, count]) => (count > 1 ? `${name}×${count}` : name));
  return `（本回合使用了 ${tools.length} 次工具：${parts.join(', ')}）`;
}

/** Cut one entry, marking that it was cut rather than silently losing text. */
function clipEntry(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断）`;
}

/**
 * Turn raw session events into transcript lines.
 *
 * A DSH turn emits one `assistant/message` per step, so a turn with a dozen tool
 * calls would contribute a dozen entries; consecutive assistant steps are folded
 * into one, with their tool calls tallied into a single line. Only then does the
 * `maxTurns` cap apply — it counts **entries**, not raw messages, and it keeps the
 * tail (the newest context).
 *
 * `total` is how many entries existed, `kept` how many survived the cap, so a UI
 * can say "40 of 59" instead of claiming 40 is the whole conversation.
 *
 * @param {Array<{type?: string, data?: object}>} events
 * @param {{maxTurns?: number, clip?: number}} [options]
 * @returns {{entries: number, total: number, kept: number, truncated: boolean, lines: string[], first: string|null, last: string|null}}
 */
export function foldTranscript(events, { maxTurns = MAX_TURNS, clip = ENTRY_CLIP } = {}) {
  const folded = [];
  for (const event of Array.isArray(events) ? events : []) {
    if (event?.type !== 'user/message' && event?.type !== 'assistant/message') continue;
    const content = event.data?.message?.content ?? event.data?.content;
    const { text, tools } = blocksToContent(content);
    if (event.type === 'user/message') {
      if (text.length === 0) continue;
      folded.push({ role: '用户', texts: [text], tools: [] });
      continue;
    }
    const last = folded.at(-1);
    if (last !== undefined && last.role === '助手') {
      if (text.length > 0) last.texts.push(text);
      last.tools.push(...tools);
    } else {
      folded.push({ role: '助手', texts: text.length > 0 ? [text] : [], tools: [...tools] });
    }
  }

  const lines = [];
  for (const entry of folded) {
    const prose = entry.texts.join('\n').trim();
    const toolNote = summarizeTools(entry.tools);
    const body = [prose, toolNote].filter((part) => part.length > 0).join('\n');
    if (body.length === 0) continue;
    lines.push(`${entry.role}: ${clipEntry(body, clip)}`);
  }

  const keptLines = lines.slice(-maxTurns);
  const firstAsk = folded.find((entry) => entry.role === '用户' && entry.texts.join('').trim().length > 0);
  const lastAnswer = [...folded].reverse().find((entry) => entry.role === '助手' && entry.texts.join('').trim().length > 0);
  return {
    entries: folded.length,
    total: lines.length,
    kept: keptLines.length,
    truncated: lines.length > keptLines.length,
    lines: keptLines,
    first: firstAsk?.texts.join('\n') ?? null,
    last: lastAnswer?.texts.join('\n') ?? null,
  };
}

/**
 * Build the short transcript excerpt an expanded row shows.
 * @param {string[]} [lines] `用户: …` / `助手: …` lines from the reader.
 */
export function excerptOf(lines) {
  if (!Array.isArray(lines)) return [];
  return lines.slice(0, EXCERPT_LINES).map((line) => clip(String(line).replace(/\s+/gu, ' ').trim(), EXCERPT_CHARS));
}

/**
 * One picker row.
 * @param {object} options
 * @param {string} options.id
 * @param {string|null} [options.title]
 * @param {string|null} [options.cached]
 * @param {string|null} [options.firstAsk]
 * @param {string|null} [options.first]
 * @param {string|null} [options.last]
 * @param {string[]} [options.lines]
 * @param {number} [options.messages]
 * @param {number} [options.bytes]
 * @param {number|null} [options.createdAt]
 * @param {string|null} [options.cwd]
 * @param {string} [options.untitled]
 */
export function pickerRow({ id, title, cached, firstAsk, first, last, lines, messages = 0, kept = messages, truncated = false, bytes = 0, createdAt = null, cwd = null, untitled = '' }) {
  return {
    id,
    title: title ?? titleOf({ cached, firstAsk, fallback: untitled }),
    messages,
    kept,
    truncated,
    bytes,
    createdAt,
    cwd,
    preview: previewOf({ first, last }),
    excerpt: excerptOf(lines),
  };
}

/**
 * Drop sessions that have nothing to attach, and report how many were hidden.
 * @param {Array<{messages?: number}>} rows
 */
export function visibleRows(rows) {
  const kept = rows.filter((row) => (row.messages ?? 0) > 0);
  return { rows: kept, hidden: rows.length - kept.length };
}
