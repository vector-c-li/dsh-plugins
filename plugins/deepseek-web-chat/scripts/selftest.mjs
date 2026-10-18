/**
 * Offline/online self-test for the pieces that can be exercised without an
 * account token.
 *
 * Run: node scripts/selftest.mjs
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { DeepSeekWebApi, WebApiError, parseCompletionStream } from '../lib/host/api.js';
import { createPowSolver } from '../lib/host/pow.js';
import { buildContext, readSessionTranscript } from '../lib/host/service.js';

const wasmPath = fileURLToPath(new URL('../assets/sha3_wasm_bg.wasm', import.meta.url));
let failures = 0;

async function check(label, run) {
  try {
    await run();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${label}: ${error?.message ?? error}`);
  }
}

await check('anonymous /users/current reports an invalid token', async () => {
  const api = new DeepSeekWebApi({ baseUrl: 'https://chat.deepseek.com', locale: 'zh_CN' });
  await assert.rejects(
    () => api.currentUser('not-a-real-token'),
    (error) => {
      assert.ok(error instanceof WebApiError, `expected WebApiError, got ${error}`);
      assert.ok([40003, 40002].includes(error.code), `unexpected code ${error.code}`);
      return true;
    },
  );
});

await check('unauthenticated pow challenge is refused', async () => {
  const api = new DeepSeekWebApi({ baseUrl: 'https://chat.deepseek.com', locale: 'zh_CN' });
  await assert.rejects(() => api.request('POST', '/api/v0/chat/create_pow_challenge', { body: { target_path: '/api/v0/chat/completion' } }));
});

await check('stream parser turns patch frames into deltas', async () => {
  const frames = [
    'event: ready\ndata: {"response_message_id":42,"request_message_id":41,"model_type":"default"}\n\n',
    'event: delta\ndata: {"v":{"response":{"fragments":[{"type":"THINK","content":"想一想"}]}}}\n\n',
    'event: delta\ndata: {"p":"response/fragments","o":"APPEND","v":[{"type":"RESPONSE","content":"你好"}]}\n\n',
    'event: delta\ndata: {"p":"response/fragments/-1/content","v":"，世界"}\n\n',
    'event: delta\ndata: {"v":"!"}\n\n',
    'event: delta\ndata: {"p":"response/fragments/-1/results","v":[{"url":"https://example.com/a","title":"A","snippet":"s"}]}\n\n',
    'event: delta\ndata: {"p":"response/fragments/-1","o":"BATCH","v":[{"p":"status","v":"FINISHED"}]}\n\n',
    'event: delta\ndata: {"p":"response/accumulated_token_usage","v":12}\n\n',
    'event: finish\ndata: {"finish_reason":"stop"}\n\n',
  ];
  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  const deltas = [];
  for await (const delta of parseCompletionStream(stream)) deltas.push(delta);
  assert.deepEqual(
    deltas.map((delta) => delta.type),
    ['ready', 'thinking', 'text', 'text', 'text', 'search', 'usage', 'finish'],
  );
  assert.equal(deltas[2].text, '你好');
  assert.equal(deltas[3].text, '，世界');
  assert.equal(deltas[4].text, '!', 'a bare {v} frame continues the open fragment');
  assert.equal(deltas[5].results[0].url, 'https://example.com/a');
  assert.equal(deltas[6].tokens, 12);
});

await check('pow solver rejects an unknown algorithm', async () => {
  const solver = createPowSolver({ wasmPath });
  await assert.rejects(
    () => solver.solve({ algorithm: 'NopeV1', challenge: 'a'.repeat(64), salt: 's', difficulty: 1, expire_at: 1 }),
    /Unsupported proof-of-work algorithm/,
  );
});

await check('pow solver recovers the answer from a real challenge', async () => {
  const { instance } = await WebAssembly.instantiate(await readFile(wasmPath), {});
  const exports = instance.exports;
  const encode = (text) => {
    const bytes = new TextEncoder().encode(text);
    const ptr = exports.__wbindgen_export_0(bytes.length, 1) >>> 0;
    new Uint8Array(exports.memory.buffer).set(bytes, ptr);
    return { ptr, len: bytes.length };
  };
  /** DeepSeekHashV1(input): the module's own hash, exactly what the server commits to. */
  const hash = (text) => {
    const retptr = exports.__wbindgen_add_to_stack_pointer(-16) >>> 0;
    const input = encode(text);
    exports.wasm_deepseek_hash_v1(retptr, input.ptr, input.len);
    const view = new DataView(exports.memory.buffer);
    const outPtr = view.getUint32(retptr, true);
    const outLen = view.getUint32(retptr + 4, true);
    const hex = Buffer.from(exports.memory.buffer, outPtr, outLen).toString('utf8');
    exports.__wbindgen_add_to_stack_pointer(16);
    return hex;
  };

  const solver = createPowSolver({ wasmPath, warn: () => {} });
  for (const [answer, difficulty] of [
    [1234, 1235],
    [143_999, 144_000],
  ]) {
    const salt = 'a1b2c3';
    const expireAt = 1767225600;
    const prefix = `${salt}_${expireAt}_`;
    const challenge = {
      algorithm: 'DeepSeekHashV1',
      challenge: hash(prefix + String(answer)),
      salt,
      difficulty,
      signature: 'signature',
      expire_at: expireAt,
      target_path: '/api/v0/chat/completion',
    };
    const header = await solver.solve(challenge);
    const decoded = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
    assert.equal(decoded.answer, answer, `expected answer ${answer}, got ${decoded.answer}`);
    assert.equal(decoded.challenge, challenge.challenge);
    assert.equal(decoded.target_path, '/api/v0/chat/completion');
  }
  console.log('     recovered answers 1234 and 143999 through the wasm solver');
});

await check('pow solver reports an unsolvable challenge as a failure', async () => {
  const solver = createPowSolver({ wasmPath, warn: () => {} });
  await assert.rejects(
    () =>
      solver.solve({
        algorithm: 'DeepSeekHashV1',
        challenge: 'f'.repeat(64),
        salt: 'a1b2c3',
        difficulty: 1000,
        signature: 'sig',
        expire_at: 1767225600,
      }),
    /could not be solved/,
  );
});

await check('dropped text becomes context and is byte-capped', async () => {
  const config = { maxContextBytes: 1000, maxFileBytes: 1000, workspaceRoot: wasmPath };
  const small = await buildContext({ inline: [{ name: 'note.txt', text: 'hello context' }] }, config);
  assert.match(small.preamble, /<file path="note\.txt">\nhello context/);
  assert.equal(small.summary[0].source, 'drop');

  const big = await buildContext({ inline: [{ name: 'big.txt', text: 'x'.repeat(5000) }] }, config);
  assert.match(big.preamble, /已截断/);
  assert.equal(big.summary[0].truncated, true);
  assert.ok(big.summary[0].bytes <= 1000);
});

await check('a dropped DSH session becomes a conversation block', async () => {
  const sessionId = '11111111-2222-4333-8444-555555555555';
  const persistence = {
    async open(id, access) {
      assert.equal(id, sessionId);
      assert.equal(access, 'read');
      return {
        async read() {
          return {
            events: [
              { type: 'user/message', data: { message: { content: [{ type: 'text', text: '把这个仓库重构一下' }] } } },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '好的，先看目录结构。' }, { type: 'tool-call', name: 'bash' }] } } },
            ],
          };
        },
        async close() {},
      };
    },
  };
  const config = { maxContextBytes: 100_000, maxFileBytes: 100_000, workspaceRoot: wasmPath };
  const context = await buildContext({ sessions: [sessionId] }, config, { persistence });
  assert.match(context.preamble, /<conversation title="DSH 会话 · 把这个仓库重构一下">/);
  assert.match(context.preamble, /用户: 把这个仓库重构一下/);
  assert.match(context.preamble, /助手: 好的，先看目录结构。/);
  assert.match(context.preamble, /本回合使用了 1 次工具：bash/);
  assert.equal(context.summary[0].source, 'session');

  const preview = await readSessionTranscript(sessionId, { persistence });
  assert.equal(preview.lines.length, 2);
});

await check('an unreadable session reports the failure instead of silently dropping', async () => {
  const failing = {
    async open() {
      throw new Error('no such session');
    },
  };
  const config = { maxContextBytes: 10_000, maxFileBytes: 10_000, workspaceRoot: wasmPath };
  const context = await buildContext({ sessions: ['22222222-3333-4444-8555-666666666666'] }, config, { persistence: failing });
  assert.match(context.preamble, /读取失败: no such session/);
  assert.equal(context.summary[0].error, 'no such session');
});

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
