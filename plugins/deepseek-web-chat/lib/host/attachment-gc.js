/**
 * Retention for the answer files this panel inserts as attachments.
 *
 * Inserting an answer as a file goes through DSH's own upload route, so the bytes
 * live in DSH's content-addressed store (`$DSH_HOME/attachments/v1`) and DSH never
 * prunes it. Those objects are ours by *name*: the panel only ever creates
 * `answer-*.md`, so this sweep never touches images or files the user attached by
 * hand.
 *
 * Safety model, in order of preference:
 *
 *   1. reference-aware — decode the session logs (one zstd frame per append) and
 *      collect every `sha256:<hash>` they mention. An object a conversation still
 *      references is kept no matter how old it is, because deleting it would break
 *      re-reading that conversation's attachment.
 *   2. age-only — when this runtime cannot decode zstd, the sweep degrades to
 *      deleting by age and says so in its summary.
 *
 * `pruneReferenced` is the explicit dial for the other trade-off: prune by age
 * even when a conversation references the object (re-reading that old attachment
 * will then fail; the transcript text is unaffected).
 *
 * @module deepseek-web-chat/attachment-gc
 */
import { readdir, readFile, rmdir, stat, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

/** Files this panel creates; nothing else is ever a candidate. */
export const INSERTED_NAME_PATTERN = /^answer-[\w.-]*\.md$/u;
/** Default retention for unreferenced answer files. */
export const DEFAULT_RETENTION_DAYS = 7;
/** Default sweep interval: four times a day. */
export const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** A hash as it appears in a session's attachment reference. */
const HASH_PATTERN = /[0-9a-f]{64}/gu;
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * Decode a concatenated-zstd log (DSH appends one frame per event batch).
 * @param {Buffer} raw
 * @returns {string|null} Decoded text, or null when zstd is unavailable here.
 */
export function decodeZstdFrames(raw) {
  const decompress = zlib.zstdDecompressSync;
  if (typeof decompress !== 'function') return null;
  const parts = [];
  const starts = [];
  let at = raw.indexOf(ZSTD_MAGIC);
  while (at !== -1) {
    starts.push(at);
    at = raw.indexOf(ZSTD_MAGIC, at + ZSTD_MAGIC.length);
  }
  if (starts.length === 0) return raw.toString('utf8');
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index];
    const to = index + 1 < starts.length ? starts[index + 1] : raw.length;
    try {
      parts.push(decompress(raw.subarray(from, to)).toString('utf8'));
    } catch {
      // A magic-looking byte sequence inside compressed data: skip that slice.
    }
  }
  return parts.join('');
}

/**
 * List session logs below the harness home.
 * @param {string} home
 * @returns {Promise<string[]>}
 */
async function listSessionLogs(home) {
  const root = path.join(home, 'sessions');
  if (!existsSync(root)) return [];
  const found = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/^session\..*\.jsonl(\.zstd)?$/u.test(entry.name)) found.push(full);
    }
  };
  await walk(root);
  return found;
}

/**
 * Every attachment hash a stored conversation still references.
 *
 * Returns `null` when the runtime cannot decode the logs, so the caller can fall
 * back to age-only pruning instead of assuming "no references".
 * @param {string} home
 * @returns {Promise<{references: Set<string>|null, logs: number, undecoded: number}>}
 */
export async function readSessionReferences(home) {
  const logs = await listSessionLogs(home);
  const references = new Set();
  let undecoded = 0;
  let decoded = 0;
  for (const log of logs) {
    let raw;
    try {
      raw = await readFile(log);
    } catch {
      continue;
    }
    const text = raw.includes(ZSTD_MAGIC) ? decodeZstdFrames(raw) : raw.toString('utf8');
    if (text === null) {
      undecoded += 1;
      continue;
    }
    decoded += 1;
    for (const match of text.matchAll(HASH_PATTERN)) references.add(match[0]);
  }
  return { references: undecoded > 0 ? null : references, logs: decoded, undecoded };
}

/**
 * Files this panel inserted, newest last.
 * @param {string} home
 * @returns {Promise<Array<{hash: string, name: string, path: string, mtimeMs: number, bytes: number}>>}
 */
export async function listInsertedAttachments(home) {
  const root = path.join(home, 'attachments', 'v1', 'files');
  if (!existsSync(root)) return [];
  const found = [];
  for (const shard of await readdir(root, { withFileTypes: true })) {
    if (!shard.isDirectory()) continue;
    const shardDir = path.join(root, shard.name);
    for (const hashed of await readdir(shardDir, { withFileTypes: true })) {
      if (!hashed.isDirectory()) continue;
      const hashDir = path.join(shardDir, hashed.name);
      for (const entry of await readdir(hashDir, { withFileTypes: true })) {
        if (!entry.isFile() || INSERTED_NAME_PATTERN.test(entry.name) === false) continue;
        const full = path.join(hashDir, entry.name);
        const info = await stat(full);
        found.push({ hash: hashed.name, name: entry.name, path: full, mtimeMs: info.mtimeMs, bytes: info.size });
      }
    }
  }
  return found;
}

/**
 * Decide what to delete without touching the disk.
 * @param {object} options
 * @param {Array<{hash: string, name: string, path: string, mtimeMs: number, bytes: number}>} options.files
 * @param {Set<string>|null} options.references
 * @param {number} [options.now]
 * @param {number} [options.retentionDays]
 * @param {boolean} [options.pruneReferenced]
 * @returns {{delete: Array<object>, keep: Array<object>, skippedReferenced: Array<object>, mode: 'reference-aware'|'age-only'}}
 */
export function planSweep({ files, references, now = Date.now(), retentionDays = DEFAULT_RETENTION_DAYS, pruneReferenced = false }) {
  const retentionMs = Math.max(0, retentionDays) * 24 * 60 * 60 * 1000;
  const mode = references === null ? 'age-only' : 'reference-aware';
  const plan = { delete: [], keep: [], skippedReferenced: [], mode };
  for (const file of files) {
    if (now - file.mtimeMs < retentionMs) {
      plan.keep.push(file);
      continue;
    }
    const referenced = references === null ? false : references.has(file.hash);
    if (referenced && pruneReferenced === false) {
      plan.skippedReferenced.push(file);
      continue;
    }
    plan.delete.push({ ...file, referenced });
  }
  return plan;
}

/**
 * Delete the planned files, then drop directories (and the shared object) that no
 * longer hold anything.
 * @param {object} options
 * @param {string} options.home
 * @param {Array<{hash: string, path: string, bytes: number, referenced: boolean}>} options.files
 * @returns {Promise<{deleted: number, freedBytes: number, objects: number}>}
 */
export async function applySweep({ home, files }) {
  let deleted = 0;
  let freedBytes = 0;
  let objects = 0;
  const hashes = new Set();
  for (const file of files) {
    try {
      await unlink(file.path);
      deleted += 1;
      freedBytes += file.bytes;
      hashes.add(file.hash);
    } catch {
      /* already gone or locked: leave it for the next sweep */
    }
  }
  const filesRoot = path.join(home, 'attachments', 'v1', 'files');
  const objectsRoot = path.join(home, 'attachments', 'v1', 'file-objects');
  for (const hash of hashes) {
    const hashDir = path.join(filesRoot, hash.slice(0, 2), hash);
    try {
      const left = await readdir(hashDir);
      if (left.length === 0) await rmdir(hashDir);
      else continue; // another name still points at these bytes
    } catch {
      continue;
    }
    const object = path.join(objectsRoot, hash.slice(0, 2), hash);
    try {
      await unlink(object);
      objects += 1;
    } catch {
      /* no object, or still referenced by a name we did not remove */
    }
  }
  return { deleted, freedBytes, objects };
}

/**
 * One full sweep: read references, plan, apply.
 * @param {object} options
 * @param {string} options.home
 * @param {number} [options.retentionDays]
 * @param {boolean} [options.pruneReferenced]
 * @param {number} [options.now]
 * @param {boolean} [options.dryRun]
 */
export async function sweepAttachments({ home, retentionDays = DEFAULT_RETENTION_DAYS, pruneReferenced = false, now = Date.now(), dryRun = false }) {
  // `0` (or a negative value) means "keep everything": a retention sweep that
  // deletes on every run would be the opposite of what that setting asks for.
  if (!(retentionDays > 0)) {
    return {
      at: new Date(now).toISOString(),
      mode: 'disabled',
      retentionDays,
      pruneReferenced,
      candidates: 0,
      deleted: 0,
      keptRecent: 0,
      keptReferenced: 0,
      freedBytes: 0,
      removedObjects: 0,
      sessionLogs: 0,
      undecodedLogs: 0,
      dryRun,
      disabled: true,
    };
  }
  const files = await listInsertedAttachments(home);
  const { references, logs, undecoded } = await readSessionReferences(home);
  const plan = planSweep({ files, references, now, retentionDays, pruneReferenced });
  const applied = dryRun
    ? { deleted: 0, freedBytes: 0, objects: 0 }
    : await applySweep({ home, files: plan.delete });
  return {
    at: new Date(now).toISOString(),
    mode: plan.mode,
    retentionDays,
    pruneReferenced,
    candidates: files.length,
    deleted: plan.delete.length,
    keptRecent: plan.keep.length,
    keptReferenced: plan.skippedReferenced.length,
    freedBytes: applied.freedBytes,
    removedObjects: applied.objects,
    sessionLogs: logs,
    undecodedLogs: undecoded,
    dryRun,
  };
}

/**
 * Run the sweep now and then on an interval, for the life of the plugin.
 * @param {object} options
 * @param {string} options.home
 * @param {number} [options.retentionDays] 0 or less disables the sweeper.
 * @param {boolean} [options.pruneReferenced]
 * @param {number} [options.intervalMs]
 * @param {(summary: object) => void} [options.onSummary]
 * @param {number} [options.initialDelayMs]
 * @returns {{dispose: () => void, last: () => object|null, run: () => Promise<object|null>}}
 */
export function startAttachmentGc({
  home,
  retentionDays = DEFAULT_RETENTION_DAYS,
  pruneReferenced = false,
  intervalMs = DEFAULT_INTERVAL_MS,
  onSummary,
  initialDelayMs = 15_000,
}) {
  let last = null;
  let disposed = false;
  let timer = null;

  const run = async () => {
    if (disposed) return null;
    if (!(retentionDays > 0)) return null;
    try {
      const summary = await sweepAttachments({ home, retentionDays, pruneReferenced });
      last = summary;
      onSummary?.(summary);
      return summary;
    } catch (error) {
      last = { at: new Date().toISOString(), error: String(error?.message ?? error) };
      onSummary?.(last);
      return null;
    }
  };

  const kickoff = setTimeout(() => {
    void run();
    timer = setInterval(() => void run(), Math.max(60_000, intervalMs));
    timer.unref?.();
  }, initialDelayMs);
  kickoff.unref?.();

  return {
    run,
    last: () => last,
    dispose() {
      disposed = true;
      clearTimeout(kickoff);
      if (timer !== null) clearInterval(timer);
    },
  };
}
