/**
 * Route smoke test: mount the plugin against a fake DSH context, serve it on a
 * throwaway HTTP port, and exercise every panel endpoint.
 *
 * Run: node scripts/route-smoke.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { apply } from '../lib/index.js';

const records = new Map();
const credentials = {
  async readRecord(key) {
    return records.get(key);
  },
  async describeRecord(key) {
    return { configured: records.has(key), writable: true };
  },
  async modifyRecord(key, mutate) {
    const next = await mutate(records.get(key));
    // Mirror credentials-local: an undefined mutation result means "no change".
    if (next === undefined) return records.get(key);
    records.set(key, next);
    return next;
  },
  async deleteRecord(key) {
    records.delete(key);
  },
  async listRecords() {
    return [...records].map(([key, record]) => ({ key, kind: record.kind }));
  },
};

const workspaces = [{ id: 'w1', path: process.cwd(), title: 'deepseek_chat', createdAt: '', updatedAt: '', sessionIds: [] }];

let route;
const ctx = {
  logger: () => ({ info() {}, debug() {}, warn: (...args) => console.log('[warn]', ...args) }),
  effect(fn) {
    const disposer = fn();
    return () => disposer?.();
  },
  get(name) {
    if (name === 'credentials') return credentials;
    if (name === 'workspaceRegistry') return { list: () => workspaces };
    if (name === 'webServer') return webServer;
    if (name === 'connection') return admitAll();
    return undefined;
  },
};

const webServer = {
  register(candidate) {
    route = candidate;
    return () => {
      route = undefined;
    };
  },
};

/** Admits every request, like a request carrying the app's own browser grant. */
const admitAll = () => ({ admit: () => ({ peer: { kind: 'owner' } }) });

await apply(ctx, { locale: 'zh_CN', workspaceRoot: process.cwd() });
assert.ok(route, 'the plugin must register exactly one HTTP route');
assert.equal(route.kind, 'prefix');

const server = http.createServer((req, res) => {
  Promise.resolve(route.handler(req, res)).catch((error) => {
    res.writeHead(500).end(String(error));
  });
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
console.log(`serving ${origin}${route.path}`);

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

const json = async (path, init) => {
  const response = await fetch(origin + path, init);
  const body = await response.json();
  return { status: response.status, body };
};

await check('panel document is served', async () => {
  const response = await fetch(`${origin}/deepseek-web/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /text\/html/);
  const html = await response.text();
  assert.match(html, /DeepSeek Chat/);
  assert.match(html, /app\.js/);
});

await check('panel assets are served', async () => {
  for (const [path, type] of [
    ['/deepseek-web/app.js', /javascript/],
    ['/deepseek-web/app.css', /text\/css/],
    ['/deepseek-web/gate-copy.js', /javascript/],
  ]) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get('content-type') ?? '', type, path);
  }
});

await check('the four guide illustrations are served', async () => {
  for (const step of [1, 2, 3, 4]) {
    const response = await fetch(`${origin}/deepseek-web/guide/step${step}.svg`);
    assert.equal(response.status, 200, `step${step}`);
    assert.match(response.headers.get('content-type') ?? '', /image\/svg\+xml/, `step${step}`);
    const body = await response.text();
    assert.ok(body.startsWith('<svg'), `step${step} should be an svg`);
  }
});

await check('the guide directory is not a browsable route', async () => {
  const response = await fetch(`${origin}/deepseek-web/guide/`);
  assert.equal(response.status, 404);
  const dotdot = await fetch(`${origin}/deepseek-web/guide/../../package.json`);
  assert.equal(dotdot.status, 404);
});

await check('status reports a signed-out account and a workspace root', async () => {
  const { status, body } = await json('/deepseek-web/api/status');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.equal(body.signedIn, false);
  assert.ok(body.workspace.root.length > 0);
  assert.equal(body.settings.locale, 'zh_CN');
});

await check('files lists the workspace root', async () => {
  const { status, body } = await json('/deepseek-web/api/files?path=');
  assert.equal(status, 200);
  assert.equal(body.ok, true);
  const names = body.entries.map((entry) => entry.name);
  assert.ok(names.includes('package.json'), `entries: ${names.join(', ')}`);
});

await check('file listing refuses a traversal', async () => {
  const { body } = await json('/deepseek-web/api/files?path=../../..');
  assert.equal(body.ok, false);
  assert.match(String(body.error), /escapes the workspace root/);
});

await check('an invalid token is rejected with a readable reason', async () => {
  const { body } = await json('/deepseek-web/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: 'definitely-not-valid' }),
  });
  assert.equal(body.ok, false);
  assert.match(String(body.error), /无效|过期|invalid/i);
});

await check('chat without a session streams an error frame', async () => {
  const response = await fetch(`${origin}/deepseek-web/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ prompt: 'hello' }),
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type') ?? '', /event-stream/);
  const text = await response.text();
  assert.ok(text.includes('data: '), text.slice(0, 200));
  const frames = text
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice(6)));
  assert.ok(frames.some((frame) => frame.type === 'error'), JSON.stringify(frames));
});

await check('unknown api actions 404', async () => {
  const { status } = await json('/deepseek-web/api/nope');
  assert.equal(status, 404);
});

await check('a rejected stored token is dropped instead of kept', async () => {
  // Seed a grant whose token chat.deepseek.com will refuse, then ask for the
  // conversation list. The 40003 must clear the record, so the panel can ask for
  // a fresh login rather than repeating the same failure forever.
  records.set('deepseek-web-chat/account', {
    kind: 'grant',
    payload: { token: 'not-a-real-token', deviceId: 'device-1', user: { id: 'someone' }, signedInAt: '2026-01-01T00:00:00.000Z' },
  });
  const before = await json('/deepseek-web/api/status');
  assert.equal(before.body.signedIn, true, 'the seeded grant should look signed in');

  const { status, body } = await json('/deepseek-web/api/sessions');
  assert.equal(status, 401, `expected 401, got ${status}: ${JSON.stringify(body)}`);
  assert.equal(body.signedOut, true, JSON.stringify(body));
  assert.match(String(body.error), /登录已过期|重新登录/);
  assert.equal(records.has('deepseek-web-chat/account'), false, 'the rejected grant must be deleted');

  const after = await json('/deepseek-web/api/status');
  assert.equal(after.body.signedIn, false);
});

await check('signing out really deletes the stored grant', async () => {
  records.set('deepseek-web-chat/account', {
    kind: 'grant',
    payload: { token: 'still-here', deviceId: 'device-2', user: { id: 'someone' }, signedInAt: '2026-01-01T00:00:00.000Z' },
  });
  const { body } = await json('/deepseek-web/api/logout', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  assert.equal(body.ok, true);
  assert.equal(records.has('deepseek-web-chat/account'), false, 'logout must remove the record, not just the cache');
});

server.close();
console.log(failures === 0 ? '\nall route checks passed' : `\n${failures} route check(s) failed`);
process.exitCode = failures === 0 ? 0 : 1;
