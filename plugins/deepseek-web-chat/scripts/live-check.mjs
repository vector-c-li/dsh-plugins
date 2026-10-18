/**
 * Live verification against the running DSH app.
 *
 * The panel's data endpoints require the app's own browser grant, so this
 * script mints the same local session cookie the app itself issues (HMAC over
 * `$DSH_HOME/.credentials.yaml`'s `client-connection/browser-session` secret)
 * and then exercises the real routes of the running host.
 *
 * Run: node scripts/live-check.mjs [origin]
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const origin = (process.argv[2] ?? process.env.DSW_ORIGIN ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').replace(/\/$/, '');
const authority = new URL(origin).host;
const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');

const b64url = (buffer) => Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

function readSecret() {
  const text = readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
  const match = /client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/u.exec(text);
  if (!match) throw new Error('client-connection/browser-session secret not found in .credentials.yaml');
  return Buffer.from(match[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
}

const secret = readSecret();
const issuedAt = Date.now();
const payload = { version: 1, authority, issuedAt, expiresAt: issuedAt + 60 * 60 * 1000 };
const body = b64url(JSON.stringify(payload));
const signature = b64url(createHmac('sha256', secret).update(body).digest());
const cookieName = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`;
const cookie = `${cookieName}=v1.${body}.${signature}`;

const call = async (pathname, init = {}) => {
  const response = await fetch(origin + pathname, {
    ...init,
    headers: { cookie, ...(init.headers ?? {}) },
  });
  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, text, json, headers: response.headers };
};

let failures = 0;
const check = async (label, run) => {
  try {
    await run();
    console.log(`ok   ${label}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL ${label}: ${error?.message ?? error}`);
  }
};

const assert = (condition, message) => {
  if (!condition) throw new Error(message);
};

await check('the shell document loads with the minted grant', async () => {
  const { status, text } = await call('/');
  assert(status === 200, `expected 200, got ${status}`);
  assert(text.includes('__DSH_BOOT__'), 'index.html carries no boot graph');
});

await check('the boot graph lists this plugin client bundle', async () => {
  const { text } = await call('/');
  assert(text.includes('dsh-deepseek-web-chat'), 'the plugin client package is absent from the boot graph');
});

await check('the panel document is served', async () => {
  const { status, text } = await call('/deepseek-web/');
  assert(status === 200, `expected 200, got ${status}`);
  assert(text.includes('DeepSeek Chat'), 'panel document looks wrong');
});

await check('the data API requires the grant', async () => {
  const response = await fetch(`${origin}/deepseek-web/api/status`);
  assert([401, 403].includes(response.status), `expected 401/403 without a cookie, got ${response.status}`);
});

await check('status reports the account state and a workspace root', async () => {
  const { status, json } = await call('/deepseek-web/api/status');
  assert(status === 200, `expected 200, got ${status}`);
  assert(json.ok === true, JSON.stringify(json));
  assert(typeof json.signedIn === 'boolean', 'signedIn must be a boolean');
  assert(typeof json.workspace?.root === 'string' && json.workspace.root.length > 0, 'no workspace root resolved');
  console.log(`     signedIn=${json.signedIn}${json.signedIn ? ` account=${json.user?.email ?? json.user?.id ?? '?'}` : ''}`);
});

await check('the file picker lists real workspace files', async () => {
  const { status, json } = await call('/deepseek-web/api/files?path=');
  assert(status === 200, `expected 200, got ${status}`);
  const names = (json.entries ?? []).map((entry) => entry.name);
  assert(names.includes('package.json'), `entries: ${names.join(', ')}`);
});

await check('a bogus token is rejected by chat.deepseek.com itself', async () => {
  const { status, json } = await call('/deepseek-web/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'not-a-real-token' }),
  });
  assert(status === 400, `expected 400, got ${status}`);
  assert(json.ok === false, JSON.stringify(json));
  assert(/token|令牌/i.test(String(json.error)), `unexpected error: ${json.error}`);
});

const snapshot = await call('/deepseek-web/api/status').then((result) => result.json);

if (snapshot.signedIn) {
  await check('the conversation list answers for a signed-in account', async () => {
    const { status, json } = await call('/deepseek-web/api/sessions');
    assert(status === 200, `expected 200, got ${status} (${json?.error ?? ''})`);
    assert(Array.isArray(json.sessions), 'sessions must be an array');
    console.log(`     ${json.sessions.length} conversation(s)`);
  });

  await check('one conversation can be re-read with its messages', async () => {
    const list = await call('/deepseek-web/api/sessions').then((result) => result.json);
    const first = list.sessions?.[0];
    assert(first !== undefined, 'no conversation to read');
    const { status, json } = await call('/deepseek-web/api/history', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: first.id }),
    });
    assert(status === 200, `expected 200, got ${status} (${json?.error ?? ''})`);
    assert(Array.isArray(json.messages), 'messages must be an array');
    console.log(`     "${String(first.title ?? '').slice(0, 30)}" -> ${json.messages.length} message(s)`);
  });

  if (process.argv.includes('--chat')) {
    await check('chat streams a real answer for a signed-in account', async () => {
      const response = await call('/deepseek-web/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: '只回答两个字：收到' }),
      });
      assert(response.status === 200, `expected 200, got ${response.status}`);
      assert(response.text.includes('"type":"text"'), `no text delta: ${response.text.slice(0, 300)}`);
      assert(!response.text.includes('"type":"error"'), `stream reported an error: ${response.text.slice(0, 300)}`);
    });
  } else {
    console.log('skip the real chat turn (pass --chat to create one conversation)');
  }
} else {
  console.log('skip the signed-in conversation checks (no account stored yet)');
  await check('chat surfaces signed-out instead of pretending to answer', async () => {
    const { status, text } = await call('/deepseek-web/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ prompt: 'hello' }),
    });
    assert(status === 200, `expected 200, got ${status}`);
    assert(text.includes('"type":"error"'), text.slice(0, 200));
  });
}

console.log(failures === 0 ? '\nlive checks passed' : `\n${failures} live check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
