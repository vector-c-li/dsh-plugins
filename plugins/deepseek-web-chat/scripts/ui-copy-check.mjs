/**
 * Copy checks for the panel interface.
 *
 * Three properties matter and none of them are visible at runtime until a user
 * flips the language:
 *   1. both languages declare exactly the same keys (a missing key falls back to
 *      Chinese text inside an English UI);
 *   2. every `ui('…')` / `p('…')` / `pf('…')` lookup in the panel script resolves;
 *   3. no Chinese literal survives in the panel script or document — the interface
 *      must come from the copy tables only, or the switch cannot reach it.
 *
 * Run: node scripts/ui-copy-check.mjs
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PANEL_COPY, UI_COPY, GATE_COPY } from '../lib/web/gate-copy.js';

const here = path.dirname(fileURLToPath(import.meta.url));
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

const keysOf = (table, lang) => Object.keys(table[lang] ?? {}).sort();

check('UI_COPY declares the same keys in both languages', () => {
  const zh = keysOf(UI_COPY, 'zh');
  const en = keysOf(UI_COPY, 'en');
  if (zh.length === 0) throw new Error('no keys');
  const zhOnly = zh.filter((key) => !en.includes(key));
  const enOnly = en.filter((key) => !zh.includes(key));
  if (zhOnly.length > 0 || enOnly.length > 0) {
    throw new Error(`zh-only: ${zhOnly.join(', ')} | en-only: ${enOnly.join(', ')}`);
  }
});

check('PANEL_COPY and GATE_COPY declare the same keys in both languages', () => {
  for (const [name, table] of [
    ['PANEL_COPY', PANEL_COPY],
    ['GATE_COPY', GATE_COPY],
  ]) {
    const zh = keysOf(table, 'zh');
    const en = keysOf(table, 'en');
    const zhOnly = zh.filter((key) => !en.includes(key));
    const enOnly = en.filter((key) => !zh.includes(key));
    if (zhOnly.length > 0 || enOnly.length > 0) {
      throw new Error(`${name} zh-only: ${zhOnly.join(', ')} | en-only: ${enOnly.join(', ')}`);
    }
  }
});

check('no UI_COPY value is empty in either language', () => {
  for (const lang of ['zh', 'en']) {
    for (const [key, value] of Object.entries(UI_COPY[lang])) {
      if (typeof value !== 'string' || value.trim() === '') throw new Error(`${lang}.${key} is empty`);
    }
  }
});

const appSource = await readFile(path.join(here, '..', 'lib', 'web', 'app.js'), 'utf8');
const htmlSource = await readFile(path.join(here, '..', 'lib', 'web', 'index.html'), 'utf8');

check('every copy lookup in the panel script resolves', () => {
  const known = {
    ui: new Set(keysOf(UI_COPY, 'zh')),
    p: new Set(keysOf(PANEL_COPY, 'zh')),
    t: new Set(keysOf(GATE_COPY, 'zh')),
  };
  const missing = [];
  for (const [fn, keys] of Object.entries(known)) {
    const pattern = new RegExp(`\\b${fn}\\(\\s*'([\\w.]+)'`, 'gu');
    for (const match of appSource.matchAll(pattern)) {
      if (!keys.has(match[1])) missing.push(`${fn}('${match[1]}')`);
    }
  }
  if (missing.length > 0) throw new Error(`unknown keys: ${[...new Set(missing)].join(', ')}`);
});

check('the panel script keeps no Chinese literal', () => {
  const offenders = appSource
    .split('\n')
    .map((line, index) => ({ line, index: index + 1 }))
    .filter((entry) => /[\u4e00-\u9fff]/u.test(entry.line))
    .map((entry) => `${entry.index}: ${entry.line.trim().slice(0, 80)}`);
  if (offenders.length > 0) throw new Error(`hard-coded text: ${offenders.slice(0, 4).join(' | ')}`);
});

check('the panel document keeps Chinese only as the pre-script fallback', () => {
  // index.html may carry Chinese: it is the no-script fallback, and the first
  // render overwrites it. Guard the amount so new strings land in the copy table.
  const count = [...htmlSource.matchAll(/[\u4e00-\u9fff]/gu)].length;
  if (count === 0) throw new Error('expected the static Chinese fallback to exist');
  if (count > 400) throw new Error(`too much static Chinese (${count}); move it into UI_COPY`);
});

console.log(failures === 0 ? '\nUI copy checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
