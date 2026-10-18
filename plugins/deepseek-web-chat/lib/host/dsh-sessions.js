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
export function pickerRow({ id, title, cached, firstAsk, first, last, lines, messages = 0, bytes = 0, createdAt = null, cwd = null, untitled = '' }) {
  return {
    id,
    title: title ?? titleOf({ cached, firstAsk, fallback: untitled }),
    messages,
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
