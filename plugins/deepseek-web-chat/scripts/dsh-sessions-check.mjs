/**
 * Checks for the DSH session picker rows.
 *
 * The picker used to show `会话 session-c6b923ac` for every conversation, because a
 * DSH session log carries no title — the title lives in the session projection
 * cache. These checks pin the title chain, the preview/excerpt clipping, and the
 * rule that a session with nothing to attach is hidden rather than listed.
 *
 * Run: node scripts/dsh-sessions-check.mjs
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  EXCERPT_CHARS,
  EXCERPT_LINES,
  PREVIEW_CHARS,
  ENTRY_CLIP,
  MAX_TURNS,
  excerptOf,
  foldTranscript,
  pickerRow,
  previewOf,
  readCachedTitle,
  titleOf,
  visibleRows,
} from '../lib/host/dsh-sessions.js';

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

/** Write a projection cache entry shaped like DSH's own file. */
async function makeHome(entries) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsw-picker-'));
  const dir = path.join(home, 'storages', 'session_projcache', 'sessions');
  await mkdir(dir, { recursive: true });
  for (const [id, body] of Object.entries(entries)) {
    await writeFile(path.join(dir, `${id}.json`), typeof body === 'string' ? body : JSON.stringify(body));
  }
  return home;
}

await check('the cached DSH title is read', async () => {
  const home = await makeHome({
    'session-aaa': { version: 7, record: { rows: { title: { val: 'DeepSeek对话能力插件开发' }, titleInput: { val: { first: { seq: 9, text: '我现在需要新建一个插件' } } } } } },
  });
  const result = await readCachedTitle({ home, id: 'session-aaa' });
  assert.equal(result.title, 'DeepSeek对话能力插件开发');
  assert.equal(result.firstAsk, '我现在需要新建一个插件');
  await rm(home, { recursive: true, force: true });
});

await check('an untitled session reports null instead of the id', async () => {
  const home = await makeHome({ 'session-bbb': { record: { rows: { title: { val: null }, titleInput: { val: { first: null } } } } } });
  const result = await readCachedTitle({ home, id: 'session-bbb' });
  assert.equal(result.title, null);
  assert.equal(result.firstAsk, null);
  await rm(home, { recursive: true, force: true });
});

await check('a missing cache file, or broken JSON, is not an error', async () => {
  const home = await makeHome({ 'session-ccc': '{ not json' });
  assert.deepEqual(await readCachedTitle({ home, id: 'session-ccc' }), { title: null, firstAsk: null });
  assert.deepEqual(await readCachedTitle({ home, id: 'session-zzz' }), { title: null, firstAsk: null });
  await rm(home, { recursive: true, force: true });
});

await check('the title falls back to the opening question, then to a placeholder', async () => {
  assert.equal(titleOf({ cached: 'Cached', firstAsk: 'ignored' }), 'Cached');
  assert.equal(titleOf({ cached: '  ', firstAsk: '  把工作区文件拖进来  当上下文 ' }), '把工作区文件拖进来 当上下文');
  const long = titleOf({ cached: null, firstAsk: 'x'.repeat(80) });
  assert.equal(long.length, 49);
  assert.equal(long.endsWith('…'), true);
  assert.equal(titleOf({ cached: null, firstAsk: null, fallback: '(untitled)' }), '(untitled)');
  assert.equal(titleOf({}), '');
});

await check('the preview collapses whitespace and clips at the limit', async () => {
  const { ask, answer } = previewOf({ first: 'line one\n\nline   two', last: 'y'.repeat(PREVIEW_CHARS + 10) });
  assert.equal(ask, 'line one line two');
  assert.equal(answer.length, PREVIEW_CHARS + 1);
  assert.equal(answer.endsWith('…'), true);
});

await check('a missing preview side stays empty', async () => {
  assert.deepEqual(previewOf({ first: null, last: undefined }), { ask: '', answer: '' });
});

await check('the excerpt keeps a few short lines', async () => {
  const lines = Array.from({ length: 10 }, (_, index) => `用户: message ${index} ${'z'.repeat(300)}`);
  const excerpt = excerptOf(lines);
  assert.equal(excerpt.length, EXCERPT_LINES);
  assert.equal(excerpt[0].length, EXCERPT_CHARS + 1);
  assert.equal(excerpt[0].endsWith('…'), true);
  assert.deepEqual(excerptOf(undefined), []);
  assert.deepEqual(excerptOf([]), []);
});

await check('a row carries title, preview and excerpt together', async () => {
  const row = pickerRow({
    id: 'session-ddd',
    cached: '在 VS Code 配置 Codex API key',
    first: '怎么配置？',
    last: '按文档设置环境变量即可。',
    lines: ['用户: 怎么配置？', '助手: 按文档设置环境变量即可。'],
    messages: 2,
    bytes: 2048,
    createdAt: 1792201305092,
    cwd: 'C:\\workspace',
  });
  assert.equal(row.title, '在 VS Code 配置 Codex API key');
  assert.equal(row.messages, 2);
  assert.equal(row.preview.ask, '怎么配置？');
  assert.equal(row.excerpt.length, 2);
  assert.equal(row.cwd, 'C:\\workspace');
});

await check('empty sessions are hidden, and the count is reported', async () => {
  const { rows, hidden } = visibleRows([
    { id: 'a', messages: 0 },
    { id: 'b', messages: 12 },
    { id: 'c', messages: 0 },
    { id: 'd', messages: 1 },
  ]);
  assert.deepEqual(rows.map((row) => row.id), ['b', 'd']);
  assert.equal(hidden, 2);
});

await check('a picker with only empty sessions yields no rows', async () => {
  const { rows, hidden } = visibleRows([{ id: 'a', messages: 0 }]);
  assert.equal(rows.length, 0);
  assert.equal(hidden, 1);
});

/* ---------------------------------------------------------------- folding */

const userEvent = (text) => ({ type: 'user/message', data: { content: [{ type: 'text', text }] } });
const assistantEvent = (text, tools = []) => ({
  type: 'assistant/message',
  data: { message: { content: [{ type: 'text', text }, ...tools.map((name) => ({ type: 'tool-call', name }))] } },
});

await check('consecutive assistant steps fold into one entry with a tool tally', async () => {
  const folded = foldTranscript([
    userEvent('do the thing'),
    assistantEvent('step one', ['pwsh']),
    assistantEvent('step two', ['pwsh', 'read']),
    userEvent('thanks'),
    assistantEvent('done'),
  ]);
  assert.equal(folded.total, 4);
  assert.equal(folded.lines[0], '用户: do the thing');
  assert.match(folded.lines[1], /^助手: step one\nstep two/u);
  assert.match(folded.lines[1], /本回合使用了 3 次工具：pwsh×2, read/u);
  assert.equal(folded.lines[2], '用户: thanks');
  assert.equal(folded.lines[3], '助手: done');
});

await check('reasoning blocks never reach the transcript', async () => {
  const folded = foldTranscript([
    { type: 'user/message', data: { content: [{ type: 'text', text: 'q' }] } },
    { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'scratchpad' }, { type: 'text', text: 'answer' }] } } },
  ]);
  assert.equal(folded.lines.join('\n').includes('scratchpad'), false);
  assert.equal(folded.lines[1], '助手: answer');
});

await check('empty user messages and tool-only steps without prose are dropped', async () => {
  const folded = foldTranscript([
    userEvent(''),
    { type: 'assistant/message', data: { message: { content: [{ type: 'tool-call', name: 'read' }] } } },
    userEvent('real question'),
  ]);
  assert.equal(folded.total, 2);
  assert.equal(folded.lines[0], '助手: （本回合使用了 1 次工具：read）');
  assert.equal(folded.lines[1], '用户: real question');
});

await check('one entry is clipped at the documented limit and says so', async () => {
  const folded = foldTranscript([userEvent('x'.repeat(ENTRY_CLIP + 50))]);
  assert.equal(folded.lines[0].length, '用户: '.length + ENTRY_CLIP + '…（已截断）'.length);
  assert.equal(folded.lines[0].endsWith('…（已截断）'), true);
});

await check('the cap keeps the newest entries and reports the total', async () => {
  const events = [];
  for (let index = 0; index < MAX_TURNS + 19; index += 1) {
    events.push(userEvent(`question ${index}`));
    events.push(assistantEvent(`answer ${index}`));
  }
  const folded = foldTranscript(events);
  assert.equal(folded.total, 118);
  assert.equal(folded.kept, MAX_TURNS);
  assert.equal(folded.truncated, true);
  assert.equal(folded.lines.length, MAX_TURNS);
  // Only the tail survives.
  assert.match(folded.lines.at(-1), /answer 58/u);
  assert.equal(folded.lines[0].includes('question 0'), false);
});

await check('a short conversation is not marked truncated', async () => {
  const folded = foldTranscript([userEvent('q'), assistantEvent('a')]);
  assert.equal(folded.truncated, false);
  assert.equal(folded.total, 2);
  assert.equal(folded.first, 'q');
  assert.equal(folded.last, 'a');
});

await check('no messages at all yields no lines', async () => {
  const folded = foldTranscript([{ type: 'step/start' }]);
  assert.equal(folded.total, 0);
  assert.equal(folded.lines.length, 0);
  assert.equal(folded.first, null);
});

await check('a row reports kept, total and the truncation flag', async () => {
  const row = pickerRow({ id: 'x', cached: 'T', messages: 59, kept: 40, truncated: true, bytes: 100 });
  assert.equal(row.messages, 59);
  assert.equal(row.kept, 40);
  assert.equal(row.truncated, true);
});

console.log(failures === 0 ? '\nDSH session picker checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
