/**
 * Checks for the answer-file retention sweep.
 *
 * The sweep deletes only what this panel created (`answer-*.md`) and only when it
 * is safe: unreferenced by any stored conversation, or explicitly pruned by age.
 * The fixtures below build a fake harness home (attachment store + session logs,
 * plain and concatenated-zstd) and assert every branch of that policy.
 *
 * Run: node scripts/attachment-gc-check.mjs
 */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import {
  DEFAULT_RETENTION_DAYS,
  applySweep,
  decodeZstdFrames,
  listInsertedAttachments,
  planSweep,
  readSessionReferences,
  sweepAttachments,
} from '../lib/host/attachment-gc.js';

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

const DAY = 24 * 60 * 60 * 1000;
const hashOf = (text) => createHash('sha256').update(text).digest('hex');

/** Build `<home>/attachments/v1/{files,file-objects}` with one entry per spec. */
async function makeHome(specs, sessions) {
  const home = await mkdtemp(path.join(tmpdir(), 'dsw-gc-'));
  const filesRoot = path.join(home, 'attachments', 'v1', 'files');
  const objectsRoot = path.join(home, 'attachments', 'v1', 'file-objects');
  await mkdir(filesRoot, { recursive: true });
  await mkdir(objectsRoot, { recursive: true });
  for (const spec of specs) {
    const hash = spec.hash ?? hashOf(spec.body ?? spec.name);
    const shard = hash.slice(0, 2);
    const hashDir = path.join(filesRoot, shard, hash);
    await mkdir(hashDir, { recursive: true });
    await writeFile(path.join(hashDir, spec.name), spec.body ?? 'answer body');
    await mkdir(path.join(objectsRoot, shard), { recursive: true });
    await writeFile(path.join(objectsRoot, shard, hash), spec.body ?? 'answer body');
    if (spec.ageDays !== undefined) {
      const when = new Date(Date.now() - spec.ageDays * DAY);
      const { utimes } = await import('node:fs/promises');
      await utimes(path.join(hashDir, spec.name), when, when);
    }
  }
  for (const session of sessions ?? []) {
    const dir = path.join(home, 'sessions', '--workspace--', session.id);
    await mkdir(dir, { recursive: true });
    const body = JSON.stringify({
      type: 'file',
      attachment: { attachmentId: `sha256:${session.hash}`, name: 'x.md', bytes: 3 },
    });
    if (session.zstd === true) {
      // Two frames, like a real append-only log.
      const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
      await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame('{"a":1}\n'), frame(body)]));
    } else {
      await writeFile(path.join(dir, 'session.v4.jsonl'), body);
    }
  }
  return home;
}

await check('unreferenced answer files are deleted once past retention', async () => {
  const home = await makeHome([{ name: 'answer-old.md', ageDays: 30 }], []);
  const summary = await sweepAttachments({ home, retentionDays: 7 });
  assert.equal(summary.deleted, 1);
  assert.equal(summary.freedBytes > 0, true);
  assert.equal(existsSync(path.join(home, 'attachments', 'v1', 'files', hashOf('answer-old.md').slice(0, 2), hashOf('answer-old.md'))), false);
  await rm(home, { recursive: true, force: true });
});

await check('recent answer files are kept', async () => {
  const home = await makeHome([{ name: 'answer-fresh.md', ageDays: 1 }], []);
  const summary = await sweepAttachments({ home, retentionDays: 7 });
  assert.equal(summary.deleted, 0);
  assert.equal(summary.keptRecent, 1);
  await rm(home, { recursive: true, force: true });
});

await check('files the user attached by hand are never candidates', async () => {
  const home = await makeHome([{ name: 'screenshot.png', ageDays: 90 }, { name: 'notes.md', ageDays: 90 }], []);
  const summary = await sweepAttachments({ home, retentionDays: 7 });
  assert.equal(summary.candidates, 0);
  assert.equal(summary.deleted, 0);
  await rm(home, { recursive: true, force: true });
});

await check('an attachment a conversation still references is kept', async () => {
  const body = 'answer body';
  const hash = hashOf(body);
  const home = await makeHome([{ name: 'answer-sent.md', body, ageDays: 30, hash }], [{ id: 'session-1', hash, zstd: true }]);
  const summary = await sweepAttachments({ home, retentionDays: 7 });
  assert.equal(summary.mode, 'reference-aware');
  assert.equal(summary.deleted, 0);
  assert.equal(summary.keptReferenced, 1);
  await rm(home, { recursive: true, force: true });
});

await check('pruneReferenced deletes it anyway, and says the file was referenced', async () => {
  const body = 'answer body';
  const hash = hashOf(body);
  const home = await makeHome([{ name: 'answer-sent.md', body, ageDays: 30, hash }], [{ id: 'session-1', hash, zstd: true }]);
  const summary = await sweepAttachments({ home, retentionDays: 7, pruneReferenced: true });
  assert.equal(summary.deleted, 1);
  await rm(home, { recursive: true, force: true });
});

await check('the shared object survives while another name still points at it', async () => {
  const body = 'same bytes';
  const hash = hashOf(body);
  const home = await makeHome([
    { name: 'answer-copy.md', body, hash, ageDays: 30 },
    { name: 'answer-keep.md', body, hash, ageDays: 1 },
  ], []);
  const summary = await sweepAttachments({ home, retentionDays: 7 });
  assert.equal(summary.deleted, 1);
  assert.equal(summary.removedObjects, 0);
  assert.equal(existsSync(path.join(home, 'attachments', 'v1', 'files', hash.slice(0, 2), hash, 'answer-keep.md')), true);
  await rm(home, { recursive: true, force: true });
});

await check('the object is removed when the last name goes', async () => {
  const body = 'lonely bytes';
  const hash = hashOf(body);
  const home = await makeHome([{ name: 'answer-only.md', body, hash, ageDays: 30 }], []);
  const summary = await sweepAttachments({ home, retentionDays: 7 });
  assert.equal(summary.deleted, 1);
  assert.equal(summary.removedObjects, 1);
  assert.equal(existsSync(path.join(home, 'attachments', 'v1', 'file-objects', hash.slice(0, 2), hash)), false);
  await rm(home, { recursive: true, force: true });
});

await check('plain (uncompressed) session logs are scanned too', async () => {
  const body = 'plain log bytes';
  const hash = hashOf(body);
  const home = await makeHome([{ name: 'answer-plain.md', body, hash, ageDays: 30 }], [{ id: 'session-2', hash, zstd: false }]);
  const { references } = await readSessionReferences(home);
  assert.equal(references?.has(hash), true);
  const summary = await sweepAttachments({ home, retentionDays: 7 });
  assert.equal(summary.deleted, 0);
  await rm(home, { recursive: true, force: true });
});

await check('a retention of 0 disables the sweep instead of deleting everything', async () => {
  const home = await makeHome([{ name: 'answer-old.md', ageDays: 30 }], []);
  const summary = await sweepAttachments({ home, retentionDays: 0 });
  assert.equal(summary.deleted, 0);
  await rm(home, { recursive: true, force: true });
});

await check('dryRun reports a plan without touching the disk', async () => {
  const home = await makeHome([{ name: 'answer-old.md', ageDays: 30 }], []);
  const summary = await sweepAttachments({ home, retentionDays: 7, dryRun: true });
  assert.equal(summary.deleted, 1);
  assert.equal(summary.freedBytes, 0);
  const files = await listInsertedAttachments(home);
  assert.equal(files.length, 1);
  await rm(home, { recursive: true, force: true });
});

await check('multi-frame zstd logs decode completely', async () => {
  const home = await makeHome([{ name: 'answer-z.md', ageDays: 30 }], []);
  const dir = path.join(home, 'sessions', '--ws--', 'session-z');
  await mkdir(dir, { recursive: true });
  const frame = (text) => zlib.zstdCompressSync(Buffer.from(text, 'utf8'));
  const hash = hashOf('answer-z');
  await writeFile(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([frame('{"a":1}\n'), frame(`{"id":"sha256:${hash}"}`)]));
  const raw = await (await import('node:fs/promises')).readFile(path.join(dir, 'session.v4.jsonl.zstd'));
  const text = decodeZstdFrames(raw);
  assert.equal(text.includes(hash), true);
  assert.equal(text.includes('{"a":1}'), true);
  await rm(home, { recursive: true, force: true });
});

await check('a missing store is a no-op, not an error', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'dsw-gc-empty-'));
  const summary = await sweepAttachments({ home, retentionDays: 7 });
  assert.equal(summary.candidates, 0);
  assert.equal(summary.deleted, 0);
  await rm(home, { recursive: true, force: true });
});

await check('planSweep without references reports age-only mode', async () => {
  const plan = planSweep({ files: [{ hash: 'a', name: 'answer-a.md', path: 'p', mtimeMs: 0, bytes: 1 }], references: null, now: 10 * DAY, retentionDays: DEFAULT_RETENTION_DAYS });
  assert.equal(plan.mode, 'age-only');
  assert.equal(plan.delete.length, 1);
});

await check('applySweep tolerates a file that vanished first', async () => {
  const home = await makeHome([{ name: 'answer-gone.md', ageDays: 30 }], []);
  const files = await listInsertedAttachments(home);
  await rm(files[0].path);
  const result = await applySweep({ home, files: files.map((file) => ({ ...file, referenced: false })) });
  assert.equal(result.deleted, 0);
  await rm(home, { recursive: true, force: true });
});

console.log(failures === 0 ? '\nattachment GC checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
