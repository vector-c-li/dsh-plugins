#!/usr/bin/env node
/**
 * Download the vendor proof-of-work module into `assets/`.
 *
 * The blob is DeepSeek's own front-end asset, so it is not committed to this repo
 * (see README → Third-party assets). Run this once per checkout; every completion
 * needs it to solve the site's `DeepSeekHashV1` challenge.
 *
 * Usage: node scripts/fetch-wasm.mjs [--force]
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCE = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, '..', 'assets', 'sha3_wasm_bg.wasm');
const force = process.argv.includes('--force');

/** @returns {Promise<Buffer | null>} Existing module, if it still looks valid. */
async function existing() {
  try {
    const bytes = await readFile(target);
    return bytes.length > 8 && bytes.subarray(0, 4).equals(WASM_MAGIC) ? bytes : null;
  } catch {
    return null;
  }
}

const current = await existing();
if (current !== null && !force) {
  console.log(`already present: ${target} (${current.length} bytes) — pass --force to replace`);
  process.exit(0);
}

console.log(`downloading ${SOURCE}`);
const response = await fetch(SOURCE, {
  headers: { accept: '*/*', 'user-agent': 'dsh-deepseek-web-chat/fetch-wasm' },
});
if (!response.ok) {
  console.error(`download failed: HTTP ${response.status} ${response.statusText}`);
  process.exit(1);
}
const bytes = Buffer.from(await response.arrayBuffer());
if (bytes.length < 8 || !bytes.subarray(0, 4).equals(WASM_MAGIC)) {
  console.error('download failed: the payload is not a WebAssembly module');
  process.exit(1);
}

await mkdir(path.dirname(target), { recursive: true });
await writeFile(target, bytes);
console.log(`saved ${bytes.length} bytes to ${target}`);
