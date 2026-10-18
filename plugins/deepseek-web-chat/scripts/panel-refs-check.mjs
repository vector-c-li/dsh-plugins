/**
 * Static check for the panel script: every `gate.x` / `el.x` it reads must exist
 * in the corresponding lookup table.
 *
 * This exists because a `gate.account.focus()` survived the removal of the
 * password form and turned the panel into a fatal-error banner at boot — a whole
 * class of bug that a DOM-less check catches in milliseconds.
 *
 * Run: node scripts/panel-refs-check.mjs
 */
import { readdirSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const source = await readFile(path.join(here, '..', 'lib', 'web', 'app.js'), 'utf8');

/**
 * Keys declared inside `const <name> = { … };`.
 * @param {string} name variable name
 * @returns {Set<string>}
 */
function declaredKeys(name) {
  const start = source.indexOf(`const ${name} = {`);
  if (start < 0) throw new Error(`no declaration for ${name}`);
  const end = source.indexOf('\n};', start);
  if (end < 0) throw new Error(`unterminated declaration for ${name}`);
  const body = source.slice(start, end);
  const keys = new Set();
  for (const match of body.matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gmu)) keys.add(match[1]);
  return keys;
}

/** Every `name.x` access in the file, ignoring the declaration block itself. */
function usedKeys(name) {
  const pattern = new RegExp(`\\b${name}\\.([A-Za-z_$][\\w$]*)`, 'gu');
  return new Set([...source.matchAll(pattern)].map((match) => match[1]));
}

let failures = 0;
for (const name of ['gate', 'el']) {
  const declared = declaredKeys(name);
  const used = usedKeys(name);
  const missing = [...used].filter((key) => !declared.has(key)).sort();
  const unused = [...declared].filter((key) => !used.has(key)).sort();
  if (missing.length === 0) {
    console.log(`ok   ${name}: ${used.size} reference(s), all declared`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}: references undeclared field(s): ${missing.join(', ')}`);
  }
  if (unused.length > 0) console.log(`     note: ${name}.${unused.join(`, ${name}.`)} declared but never read`);
}

// A panel module that is imported but not whitelisted in ASSETS 404s, and the
// panel silently stops running (the document's static markup still shows). Assert
// every relative import and every <script src> has a served path.
{
  const routesSource = readFileSync('lib/host/routes.js', 'utf8');
  const served = new Set([...routesSource.matchAll(/'(\/[^']+\.js)'/gu)].map((match) => match[1]));
  const missing = [];
  for (const name of readdirSync('lib/web')) {
    if (!name.endsWith('.js')) continue;
    const source = readFileSync(`lib/web/${name}`, 'utf8');
    for (const match of source.matchAll(/from '(\.[^']+)'/gu)) {
      const path = match[1].replace(/^\.\//u, '/');
      if (!served.has(path)) missing.push(`${name} imports ${path}`);
    }
  }
  const html = readFileSync('lib/web/index.html', 'utf8');
  for (const match of html.matchAll(/src="(\/[^"]+\.js)"/gu)) {
    if (!served.has(match[1])) missing.push(`index.html loads ${match[1]}`);
  }
  if (missing.length > 0) {
    failures += 1;
    console.log('FAIL every panel module is served: ' + missing.join(' | '));
  } else {
    console.log('ok   every panel module is served (ASSETS whitelist)');
  }
}

console.log(failures === 0 ? '\npanel reference checks passed' : `\n${failures} check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
