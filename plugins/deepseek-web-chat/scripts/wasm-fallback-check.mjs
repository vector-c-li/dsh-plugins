/**
 * End-to-end check of the "installed from git, module missing" path.
 *
 * Copies the plugin into a temp dir WITHOUT `assets/`, points DSH_HOME at a temp
 * location, and drives a real DeepSeekHashV1 challenge. The first use must
 * download the module into the DSH cache; a second solver must reuse it.
 *
 * Run: node scripts/wasm-fallback-check.mjs
 */
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(here, '..');
const scratch = await mkdtemp(path.join(tmpdir(), 'dsw-wasm-'));
process.env.DSH_HOME = path.join(scratch, 'dsh-home');

const target = path.join(scratch, 'plugin');
await cp(path.join(pluginDir, 'lib'), path.join(target, 'lib'), { recursive: true });

const load = (relative) => import(pathToFileURL(path.join(target, relative)).href);
const { resolveWasmPath, defaultCacheDir, PACKAGE_WASM } = await load('lib/host/wasm.js');
const { createPowSolver } = await load('lib/host/pow.js');

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures += 1;
};

const cacheDir = defaultCacheDir();
const cacheFile = path.join(cacheDir, 'sha3_wasm_bg.wasm');
let downloads = 0;
const pathProvider = async () => {
  const existedBefore = (await stat(cacheFile).catch(() => null)) !== null;
  const resolved = await resolveWasmPath({ wasmPath: PACKAGE_WASM, cacheDir, warn: () => {} });
  if (!existedBefore && (await stat(cacheFile).catch(() => null)) !== null) downloads += 1;
  return resolved;
};

try {
  check('a fresh install has no vendored module', !(await stat(PACKAGE_WASM).catch(() => null)));

  // 1. First use downloads the module into the DSH cache.
  const first = await pathProvider();
  check('the first use downloads into the DSH cache', first === cacheFile, first);
  const info = await stat(cacheFile).catch(() => null);
  check('the cached module looks like a wasm binary', info !== null && info.size > 1000, `${info?.size ?? 0} bytes`);
  check('exactly one download happened', downloads === 1, `downloads=${downloads}`);

  // 2. Drive a real challenge through the solver using that cached module.
  const { instance } = await WebAssembly.instantiate(await readFile(cacheFile), {});
  const exports = instance.exports;
  const encode = (text) => {
    const bytes = new TextEncoder().encode(text);
    const ptr = exports.__wbindgen_export_0(bytes.length, 1) >>> 0;
    new Uint8Array(exports.memory.buffer).set(bytes, ptr);
    return { ptr, len: bytes.length };
  };
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
  const salt = 'a1b2c3';
  const expireAt = 1767225600;
  const answer = 1234;
  const challenge = {
    algorithm: 'DeepSeekHashV1',
    challenge: hash(`${salt}_${expireAt}_${answer}`),
    salt,
    difficulty: answer + 1,
    signature: 'signature',
    expire_at: expireAt,
    target_path: '/api/v0/chat/completion',
  };
  const solver = createPowSolver({ wasmPath: pathProvider, warn: () => {} });
  const decoded = JSON.parse(Buffer.from(await solver.solve(challenge), 'base64').toString('utf8'));
  check('the solver answers a real challenge from the cached module', decoded.answer === answer, `answer=${decoded.answer}`);

  // 3. A second solver run reuses the cache instead of downloading again.
  const second = createPowSolver({ wasmPath: pathProvider, warn: () => {} });
  const again = JSON.parse(
    Buffer.from(await second.solve({ ...challenge, difficulty: answer + 1 }), 'base64').toString('utf8'),
  );
  check('a later run reuses the cached module', again.answer === answer && downloads === 1, `downloads=${downloads}`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}

console.log(failures === 0 ? '\nwasm fallback checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
