/**
 * Drive one real chat turn through the running panel API and print the stream.
 *
 * The account token never leaves the Host: this script authenticates as the
 * local browser (minted grant cookie) and lets the plugin resolve the stored
 * credential itself.
 *
 * Run: node scripts/live-chat.mjs ["你的问题"] [--thinking] [--search]
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const origin = (process.env.DSW_ORIGIN ?? process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387').replace(/\/$/, '');
const authority = new URL(origin).host;
const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');

const args = process.argv.slice(2);
const flags = new Set(args.filter((arg) => arg.startsWith('--')));
const sessionIndex = args.indexOf('--session');
const filesIndex = args.indexOf('--files');
const dshIndex = args.indexOf('--dsh-session');
const sessionId = sessionIndex === -1 ? undefined : args[sessionIndex + 1];
const dshSession = dshIndex === -1 ? undefined : args[dshIndex + 1];
const paths =
  filesIndex === -1
    ? []
    : (args[filesIndex + 1] ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
const consumed = new Set([sessionIndex + 1, filesIndex + 1, dshIndex + 1]);
const prompt =
  args.filter((arg, index) => !arg.startsWith('--') && !consumed.has(index)).join(' ') ||
  '用一句话介绍你自己，并说明你看到了哪些文件。';

const b64url = (buffer) =>
  Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

const credentials = readFileSync(path.join(home, '.credentials.yaml'), 'utf8');
const secretMatch = /client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/u.exec(credentials);
if (secretMatch === null) throw new Error('browser-session secret not found');
const secret = Buffer.from(secretMatch[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');

const issuedAt = Date.now();
const body = b64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 3_600_000 }));
const cookieName = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}`;
const cookie = `${cookieName}=v1.${body}.${b64url(createHmac('sha256', secret).update(body).digest())}`;

const status = await fetch(`${origin}/deepseek-web/api/status`, { headers: { cookie } }).then((r) => r.json());
if (!status.signedIn) {
  console.error('not signed in: open the DeepSeek Chat panel and paste a userToken first');
  process.exit(2);
}
console.log(`account: ${status.user?.email ?? status.user?.mobile ?? status.user?.id ?? 'unknown'}`);
console.log(`workspace: ${status.workspace?.root}`);
if (sessionId) console.log(`session:  ${sessionId}`);
if (paths.length > 0) console.log(`context:  ${paths.join(', ')}`);
if (dshSession) console.log(`dsh conv: ${dshSession}`);
console.log(`prompt:   ${prompt}\n`);

const response = await fetch(`${origin}/deepseek-web/api/chat`, {
  method: 'POST',
  headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({
    prompt,
    ...(sessionId === undefined ? {} : { sessionId }),
    thinking: flags.has('--thinking') || undefined,
    search: flags.has('--search') || undefined,
    ...(paths.length === 0 ? {} : { paths }),
    ...(dshSession === undefined ? {} : { sessions: [dshSession] }),
  }),
});

if (!response.ok || !response.body) {
  console.error(`chat failed: HTTP ${response.status} ${await response.text()}`);
  process.exit(1);
}

const reader = response.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
let text = '';
let thinking = '';
const results = [];
let resolvedSessionId = sessionId;

while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  let index = buffer.indexOf('\n\n');
  while (index !== -1) {
    const frame = buffer.slice(0, index);
    buffer = buffer.slice(index + 2);
    for (const line of frame.split('\n')) {
      if (!line.startsWith('data: ')) continue;
      const event = JSON.parse(line.slice(6));
      if (event.type === 'ready') {
        if (event.sessionId && event.sessionId !== resolvedSessionId) {
          resolvedSessionId = event.sessionId;
          console.log(`session: ${event.sessionId}`);
        }
      } else if (event.type === 'text') text += event.text;
      else if (event.type === 'thinking') thinking += event.text;
      else if (event.type === 'search') {
        if (Array.isArray(event.results)) {
          results.push(...event.results);
          console.log(`search: ${event.results.length} result(s)`);
        }
        if (event.status) console.log(`search status: ${String(event.status).slice(0, 80)}`);
      } else if (event.type === 'mode') console.log(`mode: ${event.mode}`);
      else if (event.type === 'usage') console.log(`usage: ${event.tokens} tokens`);
      else if (event.type === 'error') console.error(`error: ${event.message}`);
      else if (event.type === 'done') console.log(`done: ${JSON.stringify(event.reason ?? null)}`);
    }
    index = buffer.indexOf('\n\n');
  }
}

if (thinking.length > 0) console.log(`\n--- thinking (${thinking.length} chars) ---\n${thinking.slice(0, 600)}`);
console.log(`\n--- answer (${text.length} chars) ---\n${text}`);
if (results.length > 0) {
  console.log(`\n--- sources (${results.length}) ---`);
  for (const [index, result] of results.entries()) console.log(`${index + 1}. ${result.title}\n   ${result.url}`);
}
console.log(resolvedSessionId ? `\ncontinue with: --session ${resolvedSessionId}` : '');
process.exitCode = text.length > 0 ? 0 : 1;
