/**
 * Turn a stored DSH session into prompt text, at three fidelity levels.
 *
 * DSH's own cross-session reference (`@deepseek-ai/dsh-session-reference`) projects
 * only user/assistant prose and drops tool traffic. That is the right default —
 * on a real agentic session the prose was 183 KB while tool calls plus results
 * were 3.2 MB — but it is also lossy: "what did the agent actually do" disappears.
 * This module therefore renders the same event stream at three levels and lets the
 * caller pick one:
 *
 *   transcript — user/assistant prose only, compaction checkpoints marked.
 *                Matches DSH's projection, cheapest, best default.
 *   tools      — adds one line per tool call and a clipped tool result, for the
 *                most recent turns. Answers "which files did it touch, what did
 *                the commands print" without the whole payload.
 *   full       — every turn's tool calls and results at a large clip. This is the
 *                level to upload as a file (the web chat then reads it itself),
 *                not to inline.
 *
 * Budget handling follows the same idea as DSH's reference: drop the oldest
 * non-checkpoint entries until the text fits, then shorten the longest entry with
 * an explicit notice. Nothing is dropped silently; the returned stats say exactly
 * how much was left out.
 *
 * @module deepseek-web-chat/session-render
 */

/** Fidelity levels, cheapest first. */
export const SESSION_MODES = ['transcript', 'tools', 'full'];

/** One prose entry may not exceed this before it is cut (characters). */
export const DEFAULT_ENTRY_CLIP = 8000;
/** Tool results in `tools` mode are this long at most. */
export const DEFAULT_TOOL_RESULT_CLIP = 400;
/** Tool results in `full` mode are this long at most. */
export const FULL_TOOL_RESULT_CLIP = 4000;
/** In `tools` mode, only this many of the newest turns keep tool detail. */
export const DEFAULT_RECENT_TOOL_TURNS = 12;

/**
 * Split one message's blocks into prose, tool calls, tool results, and file names.
 * @param {unknown} content
 * @returns {{text: string, calls: Array<{name: string, args: string}>, results: string[], files: string[]}}
 */
export function readBlocks(content) {
  const out = { text: '', calls: [], results: [], files: [] };
  if (!Array.isArray(content)) return out;
  const texts = [];
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    else if (block?.type === 'tool-call') {
      out.calls.push({ name: typeof block.name === 'string' ? block.name : '?', args: summarizeArgs(block.arguments) });
    } else if (block?.type === 'tool-result') {
      const text = collectText(block);
      if (text !== '') out.results.push(text);
    } else if (block?.type === 'file') {
      const name = block.attachment?.name ?? block.name;
      if (typeof name === 'string' && name.length > 0) out.files.push(name);
    }
  }
  out.text = texts.join('\n');
  return out;
}

/** One short, single-line argument summary for a tool call. */
function summarizeArgs(args) {
  if (args === undefined || args === null) return '';
  let value = args;
  if (typeof args === 'string') {
    try {
      value = JSON.parse(args);
    } catch {
      return clip(args.replace(/\s+/gu, ' ').trim(), 120);
    }
  }
  if (typeof value !== 'object') return clip(String(value), 120);
  const parts = [];
  for (const [key, item] of Object.entries(value)) {
    if (parts.length >= 3) break;
    const text = typeof item === 'string' ? item : JSON.stringify(item);
    if (text === undefined) continue;
    parts.push(`${key}=${clip(text.replace(/\s+/gu, ' ').trim(), 60)}`);
  }
  return parts.join(' ');
}

/** Flatten a tool-result block's text without pulling in binary payloads. */
function collectText(block) {
  if (typeof block.text === 'string') return block.text;
  if (Array.isArray(block.content)) {
    const texts = [];
    for (const inner of block.content) {
      if (inner?.type === 'text' && typeof inner.text === 'string') texts.push(inner.text);
    }
    return texts.join('\n');
  }
  return '';
}

/** Cut text, saying that it was cut. */
function clip(text, max) {
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断）`;
}

/**
 * Fold events into entries, keeping whatever the chosen level needs.
 * @param {Array<{type?: string, data?: object}>} events
 * @returns {Array<{role: 'user'|'assistant', text: string, calls: Array<{name: string, args: string}>, results: string[], files: string[], checkpoint: boolean}>}
 */
export function foldEntries(events) {
  const entries = [];
  for (const event of Array.isArray(events) ? events : []) {
    const type = event?.type;
    // Real logs put a user message under `data.content` and an assistant message
    // under `data.message.content`; older fixtures and flat V4 records differ, so
    // both shapes are read.
    const contentOf = (event_) => event_?.data?.content ?? event_?.data?.message?.content;
    if (type === 'user/message') {
      const blocks = readBlocks(contentOf(event));
      const checkpoint = isCheckpoint(event.data?.source);
      if (blocks.text.trim() === '' && blocks.files.length === 0) continue;
      entries.push({ role: 'user', text: blocks.text, calls: [], results: [], files: blocks.files, checkpoint });
      continue;
    }
    if (type === 'assistant/message') {
      const blocks = readBlocks(contentOf(event));
      const last = entries.at(-1);
      if (last !== undefined && last.role === 'assistant') {
        if (blocks.text.length > 0) last.text = last.text.length > 0 ? `${last.text}\n${blocks.text}` : blocks.text;
        last.calls.push(...blocks.calls);
        last.results.push(...blocks.results);
      } else if (blocks.text.length > 0 || blocks.calls.length > 0) {
        entries.push({ role: 'assistant', text: blocks.text, calls: [...blocks.calls], results: [...blocks.results], files: [], checkpoint: false });
      }
      continue;
    }
    if (type === 'tool/result') {
      const blocks = readBlocks(contentOf(event));
      const target = [...entries].reverse().find((entry) => entry.role === 'assistant');
      if (target !== undefined) {
        target.results.push(...blocks.results);
        if (blocks.text.trim() !== '') target.results.push(blocks.text);
      }
      continue;
    }
    // Everything else (developer/system messages, job and turn bookkeeping,
    // stream frames) is neither prose nor action detail.
  }
  return entries;
}

/** True when a user message is a compaction checkpoint rather than a typed ask. */
function isCheckpoint(source) {
  const kind = source?.kind;
  return kind === 'compact' || kind === 'compaction';
}

/**
 * Render one entry as prompt text at the chosen level.
 * @param {ReturnType<typeof foldEntries>[number]} entry
 * @param {'transcript'|'tools'|'full'} mode
 * @param {{entryClip: number, toolResultClip: number, withTools: boolean}} limits
 */
function renderEntry(entry, mode, limits) {
  const role = entry.role === 'user' ? '用户' : '助手';
  const parts = [];
  const text = entry.text.trim();
  if (text !== '') parts.push(limits.entryClip > 0 ? clip(text, limits.entryClip) : text);
  if (entry.files.length > 0) {
    parts.push(entry.files.map((name) => `[附件] ${name}`).join('\n'));
  }
  if (limits.withTools) {
    for (const call of entry.calls) {
      parts.push(`→ ${call.name}${call.args === '' ? '' : `(${call.args})`}`);
    }
    if (mode !== 'transcript') {
      for (const result of entry.results.slice(0, 6)) {
        const body = result.replace(/\s+/gu, ' ').trim();
        if (body !== '') parts.push(`  ← ${clip(body, limits.toolResultClip)}`);
      }
    }
  }
  const body = parts.filter((part) => part.length > 0).join('\n');
  return body === '' ? '' : `${role}: ${body}`;
}

/**
 * Render a session at one fidelity level within a byte budget.
 *
 * @param {Array<{type?: string, data?: object}>} events Raw session events.
 * @param {object} [options]
 * @param {'transcript'|'tools'|'full'} [options.mode] Fidelity level.
 * @param {number} [options.maxBytes] Budget for the rendered text.
 * @param {number} [options.entryClip] Per-entry character cap.
 * @param {number} [options.toolResultClip] Tool-result character cap.
 * @param {number} [options.recentToolTurns] In `tools` mode, how many newest turns keep tool detail.
 * @returns {{text: string, mode: string, entries: number, rendered: number, omitted: number, omittedBytes: number, truncated: boolean, bytes: number, checkpoints: number}}
 */
export function renderSession(events, options = {}) {
  const mode = SESSION_MODES.includes(options.mode) ? options.mode : 'transcript';
  const maxBytes = Number.isFinite(options.maxBytes) ? Math.max(0, options.maxBytes) : 400_000;
  const entryClip = Number.isFinite(options.entryClip) ? Math.max(0, options.entryClip) : DEFAULT_ENTRY_CLIP;
  const toolResultClip =
    options.toolResultClip ?? (mode === 'full' ? FULL_TOOL_RESULT_CLIP : DEFAULT_TOOL_RESULT_CLIP);
  const recentToolTurns = Number.isFinite(options.recentToolTurns) ? Math.max(0, options.recentToolTurns) : DEFAULT_RECENT_TOOL_TURNS;

  const entries = foldEntries(events);
  const checkpoints = entries.filter((entry) => entry.checkpoint).length;
  // `tools` mode keeps tool detail only for the newest turns: the older ones are
  // usually superseded ("that command failed, try another"), and their payloads
  // are what make this level expensive.
  const toolFrom = mode === 'transcript' ? entries.length : Math.max(0, entries.length - recentToolTurns);

  const lines = entries.map((entry, index) =>
    renderEntry(entry, mode, {
      entryClip,
      toolResultClip,
      withTools: index >= toolFrom && entry.calls.length > 0,
    }),
  );
  const kept = lines.map((line, index) => ({ line, index })).filter((item) => item.line !== '');

  // Budget: drop the oldest non-checkpoint entry first, then shorten the longest.
  let omitted = 0;
  let omittedBytes = 0;
  const sizeOf = (items) => Buffer.byteLength(items.map((item) => item.line).join('\n\n'), 'utf8');
  while (sizeOf(kept) > maxBytes && kept.length > 1) {
    const dropAt = kept.findIndex((item) => entries[item.index]?.checkpoint !== true);
    if (dropAt < 0) break;
    const [removed] = kept.splice(dropAt, 1);
    omitted += 1;
    omittedBytes += Buffer.byteLength(removed.line, 'utf8');
  }
  while (sizeOf(kept) > maxBytes) {
    let longest = -1;
    let longestBytes = 0;
    for (const [position, item] of kept.entries()) {
      const bytes = Buffer.byteLength(item.line, 'utf8');
      if (bytes > longestBytes) {
        longestBytes = bytes;
        longest = position;
      }
    }
    if (longest < 0) break;
    const overflow = sizeOf(kept) - maxBytes;
    const target = Math.max(0, longestBytes - overflow - 8);
    const shortened = clip(kept[longest].line, target);
    if (shortened.length >= kept[longest].line.length) break;
    omittedBytes += kept[longest].line.length - shortened.length;
    kept[longest] = { ...kept[longest], line: shortened };
  }

  const body = kept.map((item) => item.line).join('\n\n');
  return {
    text: body,
    mode,
    entries: entries.length,
    rendered: kept.length,
    omitted,
    omittedBytes,
    truncated: omitted > 0 || omittedBytes > 0,
    bytes: Buffer.byteLength(body, 'utf8'),
    checkpoints,
  };
}
