/**
 * Checks for the three fidelity levels of session rendering.
 *
 * The numbers that motivated this: on one real session the prose was 183 KB while
 * tool calls plus results were 3.2 MB. So the renderer must make the cheap level
 * the default, keep the rich level cheap enough to be usable, and never drop
 * content without saying so.
 *
 * Run: node scripts/session-render-check.mjs
 */
import assert from 'node:assert/strict';
import {
  DEFAULT_RECENT_TOOL_TURNS,
  FULL_TOOL_RESULT_CLIP,
  SESSION_MODES,
  foldEntries,
  renderSession,
} from '../lib/host/session-render.js';

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${name}: ${error.message}`);
  }
}

const user = (text, extra = {}) => ({ type: 'user/message', data: { content: [{ type: 'text', text }, ...(extra.blocks ?? [])], ...(extra.data ?? {}) } });
const assistant = (text, calls = [], results = []) => ({
  type: 'assistant/message',
  data: {
    message: {
      content: [
        ...(text === '' ? [] : [{ type: 'text', text }]),
        ...calls.map(([name, args]) => ({ type: 'tool-call', name, arguments: args })),
        ...results.map((result) => ({ type: 'tool-result', text: result })),
      ],
    },
  },
});
const toolResult = (text) => ({ type: 'tool/result', data: { message: { content: [{ type: 'text', text }] } } });

/** A session with two turns; the first turn ran two tools. */
const sample = () => [
  user('重构这个仓库'),
  assistant('先看目录。', [['read', { file_path: '/repo/a.ts' }]], ['file a.ts …']),
  assistant('再跑测试。', [['pwsh', { command: 'pnpm test' }]], ['12 passed']),
  user('继续'),
  assistant('测试通过了。'),
];

check('every level is declared', () => {
  assert.deepEqual(SESSION_MODES, ['transcript', 'tools', 'full']);
});

check('transcript mode keeps prose only', () => {
  const result = renderSession(sample(), { mode: 'transcript' });
  assert.equal(result.text.includes('read(file_path=/repo/a.ts)'), false);
  assert.equal(result.text.includes('12 passed'), false);
  assert.equal(result.text, '用户: 重构这个仓库\n\n助手: 先看目录。\n再跑测试。\n\n用户: 继续\n\n助手: 测试通过了。');
});

check('tools mode adds call lines and clipped results for recent turns', () => {
  const result = renderSession(sample(), { mode: 'tools', recentToolTurns: 10 });
  assert.match(result.text, /→ read\(file_path=\/repo\/a\.ts\)/u);
  assert.match(result.text, /← file a\.ts/u);
  assert.match(result.text, /→ pwsh\(command=pnpm test\)/u);
  assert.match(result.text, /← 12 passed/u);
  assert.equal(result.mode, 'tools');
});

check('tools mode leaves old turns without tool detail', () => {
  const events = [];
  for (let index = 0; index < 20; index += 1) {
    events.push(user(`问题 ${index}`));
    events.push(assistant(`回答 ${index}`, [['read', { file_path: `/f${index}.ts` }]]));
  }
  const result = renderSession(events, { mode: 'tools', recentToolTurns: 2 });
  assert.equal(result.text.includes('/f0.ts'), false);
  assert.match(result.text, /\/f19\.ts/u);
  assert.ok(result.rendered === 40);
});

check('full mode raises the tool-result clip', () => {
  const long = 'x'.repeat(FULL_TOOL_RESULT_CLIP + 200);
  const result = renderSession([user('q'), assistant('a', [['read', {}]], [long])], { mode: 'full' });
  // 4000 characters kept, then the explicit notice (a plain 4001-char run never appears).
  assert.match(result.text, new RegExp(`x{${FULL_TOOL_RESULT_CLIP}}…（已截断）`, 'u'));
  assert.ok(DEFAULT_RECENT_TOOL_TURNS >= 1);
});

check('consecutive assistant steps fold into one entry', () => {
  const entries = foldEntries(sample());
  assert.equal(entries.length, 4);
  assert.equal(entries[1].text, '先看目录。\n再跑测试。');
  assert.deepEqual(entries[1].calls.map((call) => call.name), ['read', 'pwsh']);
});

check('tool results attach to the assistant entry that called them', () => {
  const entries = foldEntries([user('q'), assistant('a', [['read', {}]]), toolResult('result body')]);
  assert.deepEqual(entries.at(-1).results, ['result body']);
});

check('reasoning blocks never appear in any level', () => {
  const events = [
    user('q'),
    { type: 'assistant/message', data: { message: { content: [{ type: 'reasoning', text: 'scratchpad' }, { type: 'text', text: 'answer' }] } } },
  ];
  for (const mode of SESSION_MODES) {
    assert.equal(renderSession(events, { mode }).text.includes('scratchpad'), false, mode);
  }
});

check('a file attachment is named, not inlined', () => {
  const events = [
    { type: 'user/message', data: { content: [{ type: 'file', attachment: { attachmentId: 'sha256:abc', name: 'notes.md', bytes: 10 } }, { type: 'text', text: '看看这个' }] } },
  ];
  const result = renderSession(events, { mode: 'transcript' });
  assert.match(result.text, /\[附件\] notes\.md/u);
  assert.match(result.text, /看看这个/u);
});

check('a compaction checkpoint is marked and kept under budget pressure', () => {
  const events = [
    { type: 'user/message', data: { source: { kind: 'compact' }, content: [{ type: 'text', text: '前面的对话摘要：' + '摘'.repeat(200) }] } },
    user('新问题 ' + 'q'.repeat(400)),
    assistant('新回答 ' + 'a'.repeat(400)),
  ];
  const result = renderSession(events, { mode: 'transcript', maxBytes: 700 });
  assert.ok(result.checkpoints >= 1);
  assert.match(result.text, /前面的对话摘要/u);
  assert.equal(result.rendered, 1);
  assert.equal(result.omitted, 2);
});

check('over budget drops the oldest entries and reports it', () => {
  const events = [];
  for (let index = 0; index < 30; index += 1) {
    events.push(user(`问题 ${index} ` + 'z'.repeat(100)));
    events.push(assistant(`回答 ${index} ` + 'y'.repeat(100)));
  }
  const result = renderSession(events, { mode: 'transcript', maxBytes: 1200 });
  assert.equal(result.truncated, true);
  assert.ok(result.omitted > 0);
  assert.ok(result.bytes <= 1400);
  assert.equal(result.text.includes('问题 0'), false);
  assert.match(result.text, /问题 29/u);
});

check('an oversized single entry is shortened with a notice', () => {
  const result = renderSession([user('q'.repeat(5000))], { mode: 'transcript', maxBytes: 500 });
  assert.ok(result.bytes <= 600);
  assert.match(result.text, /已截断/u);
});

check('an empty session renders nothing and says so', () => {
  const result = renderSession([{ type: 'step/start' }], { mode: 'transcript' });
  assert.equal(result.text, '');
  assert.equal(result.entries, 0);
  assert.equal(result.truncated, false);
});

check('stats describe the render exactly', () => {
  const result = renderSession(sample(), { mode: 'tools' });
  assert.equal(result.entries, 4);
  assert.equal(result.rendered, 4);
  assert.equal(result.omitted, 0);
  assert.equal(result.bytes, Buffer.byteLength(result.text, 'utf8'));
});

console.log(failures === 0 ? '\nsession render checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
