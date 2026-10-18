/**
 * Proof-of-work solver for `create_pow_challenge`.
 *
 * The web client ships a small Rust/WebAssembly module (`sha3-wasm`) whose
 * `wasm_solve` export searches for the nonce the server wants. We load the very
 * same module (vendored under `assets/`) and call it with the same ABI:
 *
 *   retptr = __wbindgen_add_to_stack_pointer(-16)
 *   wasm_solve(retptr, challengePtr, challengeLen, prefixPtr, prefixLen, difficulty)
 *   status = i32@retptr, answer = f64@retptr+8   // status 0 means "no solution"
 *
 * `prefix` is `${salt}_${expire_at}_`. The header value is base64 of the JSON
 * object `{algorithm, challenge, salt, answer, signature, target_path}`.
 */
import { readFile } from 'node:fs/promises';

let modulePromise;

/** Instantiate the wasm module once per process. */
async function loadModule(wasmPath) {
  if (modulePromise === undefined) {
    modulePromise = (async () => {
      const bytes = await readFile(wasmPath);
      const { instance } = await WebAssembly.instantiate(bytes, {});
      return instance.exports;
    })().catch((error) => {
      modulePromise = undefined;
      throw error;
    });
  }
  return modulePromise;
}

const encoder = new TextEncoder();

/** Write a UTF-8 string into wasm memory and return {ptr, len}. */
function allocString(exports, text) {
  const bytes = encoder.encode(text);
  const ptr = exports.__wbindgen_export_0(bytes.length, 1) >>> 0;
  new Uint8Array(exports.memory.buffer).set(bytes, ptr);
  return { ptr, len: bytes.length };
}

/**
 * Create a solver bound to one wasm asset.
 * @param {object} options
 * @param {string | (() => Promise<string>)} options.wasmPath Absolute path of
 *   `sha3_wasm_bg.wasm`, or a resolver so a download can happen on first use.
 * @param {(message: string) => void} [options.warn]
 */
export function createPowSolver({ wasmPath, warn = () => {} }) {
  /** Solved answers keyed by the exact challenge payload, with expiry. */
  const cache = new Map();

  // The path is resolved lazily: an install that arrives without the module can
  // fetch it on the first challenge instead of failing at mount time.
  let resolvedPath;
  const resolvePath = async () => {
    const value = typeof wasmPath === 'function' ? await wasmPath() : wasmPath;
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error('deepseek-web-chat: no proof-of-work module path could be resolved');
    }
    return value;
  };
  const moduleForChallenge = async () => {
    if (resolvedPath === undefined) {
      resolvedPath = resolvePath().catch((error) => {
        resolvedPath = undefined;
        throw error;
      });
    }
    return loadModule(await resolvedPath);
  };

  /**
   * @param {object} challenge Server payload: algorithm/challenge/salt/difficulty/signature/expire_at/target_path.
   * @returns {Promise<string>} base64 header value.
   */
  async function solve(challenge) {
    if (challenge.algorithm !== 'DeepSeekHashV1') {
      throw new Error(`Unsupported proof-of-work algorithm: ${String(challenge.algorithm)}`);
    }
    const expireAt = Number(challenge.expire_at ?? challenge.expireAt ?? 0);
    const key = `${challenge.challenge}|${challenge.salt}|${expireAt}|${challenge.difficulty}`;
    const cached = cache.get(key);
    if (cached !== undefined && (cached.expiresAtMs === 0 || cached.expiresAtMs > Date.now())) {
      return cached.header;
    }

    const exports = await moduleForChallenge();
    const prefix = `${challenge.salt}_${expireAt}_`;
    const retptr = exports.__wbindgen_add_to_stack_pointer(-16) >>> 0;
    let status;
    let answer;
    try {
      const challengePtr = allocString(exports, String(challenge.challenge));
      const prefixPtr = allocString(exports, prefix);
      exports.wasm_solve(
        retptr,
        challengePtr.ptr,
        challengePtr.len,
        prefixPtr.ptr,
        prefixPtr.len,
        Number(challenge.difficulty),
      );
      const view = new DataView(exports.memory.buffer);
      status = view.getInt32(retptr, true);
      answer = view.getFloat64(retptr + 8, true);
    } finally {
      exports.__wbindgen_add_to_stack_pointer(16);
    }

    if (status === 0 || !Number.isFinite(answer)) {
      warn(`proof-of-work: no solution for difficulty ${challenge.difficulty}`);
      throw new Error('The proof-of-work challenge could not be solved (the server may have raised its difficulty).');
    }

    const payload = {
      algorithm: challenge.algorithm,
      challenge: challenge.challenge,
      salt: challenge.salt,
      answer: Math.trunc(answer),
      signature: challenge.signature,
      target_path: challenge.target_path ?? '/api/v0/chat/completion',
    };
    const header = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');

    // `expire_after` is a relative lifetime; keep the cache small and short.
    const lifetimeMs = Number(challenge.expire_after ?? 0) * 1000;
    const expiresAtMs = lifetimeMs > 0 ? Date.now() + lifetimeMs : 0;
    if (cache.size > 8) cache.clear();
    cache.set(key, { header, expiresAtMs });
    return header;
  }

  return { solve };
}
