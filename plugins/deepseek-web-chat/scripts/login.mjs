/**
 * Store a chat.deepseek.com `userToken` through the running plugin.
 *
 * The token is read from the environment so it never lands in a file:
 *
 *   $env:DSW_USER_TOKEN = '<paste the userToken value>'
 *   node scripts/login.mjs
 *
 * It is validated by the Host against `GET /api/v0/users/current` and then kept
 * in `$DSH_HOME/.credentials.yaml` under `deepseek-web-chat/account`.
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const origin = (process.env.DSW_ORIGIN ?? 'http://127.0.0.1:19387').replace(/\/$/, '');
const authority = new URL(origin).host;
const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const token = (process.env.DSW_USER_TOKEN ?? process.argv[2] ?? '').trim();

if (token.length === 0) {
  console.error('set DSW_USER_TOKEN to the userToken value (not the {value, __version} wrapper)');
  process.exit(2);
}

const b64url = (buffer) =>
  Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

const credentials = readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
const secretMatch = /client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/u.exec(credentials);
if (secretMatch === null) throw new Error('browser-session secret not found');
const secret = Buffer.from(secretMatch[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');

const issuedAt = Date.now();
const body = b64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 600_000 }));
const cookieName = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`;
const cookie = `${cookieName}=v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`;

const response = await fetch(`${origin}/deepseek-web/api/login`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ token }),
});
const payload = await response.json().catch(() => ({}));

if (!response.ok || payload.ok === false) {
  console.error(`login failed (HTTP ${response.status}): ${payload.error ?? 'unknown error'}`);
  process.exit(1);
}

console.log('signed in');
console.log(`  account id : ${payload.user?.id ?? '?'}`);
console.log(`  email      : ${payload.user?.email ?? '-'}`);
console.log(`  mobile     : ${payload.user?.mobile ?? '-'}`);
console.log(`  token      : stored in $DSH_HOME/.credentials.yaml (deepseek-web-chat/account)`);
