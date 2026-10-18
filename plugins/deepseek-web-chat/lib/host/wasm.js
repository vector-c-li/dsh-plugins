/**
 * Locate the proof-of-work module, downloading it once when a checkout does not
 * contain it.
 *
 * The module is DeepSeek's own front-end asset, so this repository does not
 * redistribute it (`.gitignore` excludes `*.wasm`). A git/pnpm install therefore
 * arrives without it. Rather than failing the first chat with an obscure error,
 * resolve it in this order:
 *
 *   1. `config.wasmPath` when that file exists (explicit win, e.g. a vendored copy);
 *   2. the package's own `assets/sha3_wasm_bg.wasm` (a clone plus `fetch-wasm.mjs`);
 *   3. a per-user cache under `$DSH_HOME/cache/deepseek-web-chat/`, downloading
 *      from the vendor's CDN when it is not there yet.
 *
 * Writing into the cache (not into `node_modules`) keeps a pnpm store copy clean.
 */
import { readFile, mkdir, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Official location of the module the web client itself loads. */
export const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm';

const PACKAGE_WASM = fileURLToPath(new URL('../../assets/sha3_wasm_bg.wasm', import.meta.url));
const WASM_MAGIC = Buffer.from([0x00, 0x61, 0x73, 0x6d]);

/**
 * Per-user cache directory for a downloaded copy. Never inside `node_modules`:
 * a pnpm install is a hard link into the content-addressable store.
 * @returns {string}
 */
export function defaultCacheDir() {
  const home = process.env.DSH_HOME || path.join(homedir(), '.dsh');
  return path.join(home, 'cache', 'deepseek-web-chat');
}

/** @param {string} file */
async function isWasm(file) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size < 8) return false;
    const handle = await readFile(file);
    return handle.subarray(0, 4).equals(WASM_MAGIC);
  } catch {
    return false;
  }
}

/**
 * Resolve a usable wasm path, downloading into the cache when necessary.
 * @param {object} options
 * @param {string} options.wasmPath Configured path (may be the package default).
 * @param {string} [options.cacheDir] Writable directory for a downloaded copy.
 * @param {(message: string) => void} [options.warn]
 * @returns {Promise<string>}
 */
export async function resolveWasmPath({ wasmPath, cacheDir, warn = () => {} }) {
  if (typeof wasmPath === 'string' && wasmPath.length > 0 && (await isWasm(wasmPath))) return wasmPath;
  // The configured path may be the package default that simply is not there yet.
  if (wasmPath !== PACKAGE_WASM && (await isWasm(PACKAGE_WASM))) return PACKAGE_WASM;

  if (typeof cacheDir !== 'string' || cacheDir.length === 0) {
    throw new Error(
      'deepseek-web-chat: the proof-of-work module is missing. Run `node scripts/fetch-wasm.mjs` in the plugin directory, or point the `wasmPath` config at a copy of sha3_wasm_bg.wasm.',
    );
  }

  const cached = path.join(cacheDir, 'sha3_wasm_bg.wasm');
  if (await isWasm(cached)) return cached;

  warn(`proof-of-work module not found locally; downloading it once into ${cached}`);
  const response = await fetch(WASM_URL, { headers: { accept: '*/*', 'user-agent': 'dsh-deepseek-web-chat' } });
  if (!response.ok) {
    throw new Error(
      `deepseek-web-chat: downloading the proof-of-work module failed (HTTP ${response.status}). Run \`node scripts/fetch-wasm.mjs\` in the plugin directory, then reload the plugin.`,
    );
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(WASM_MAGIC)) {
    throw new Error('deepseek-web-chat: the downloaded proof-of-work module is not a WebAssembly binary');
  }
  await mkdir(cacheDir, { recursive: true });
  await writeFile(cached, bytes);
  warn(`proof-of-work module cached (${bytes.length} bytes)`);
  return cached;
}

export { PACKAGE_WASM };
