/**
 * Local preview server: serves the panel's own files from `lib/web/` and proxies
 * `/deepseek-web/api/*` to the running DSH host with a minted browser grant.
 *
 * Used to exercise the panel in a real browser (and for screenshots) without
 * touching the DSH window.
 *
 * Run: node scripts/_preview.mjs [port]
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { createHash, createHmac } from 'node:crypto';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const upstreamUrl = new URL(process.env.DSH_WEB_URL ?? 'http://127.0.0.1:19387');
const UPSTREAM = { host: upstreamUrl.hostname, port: Number(upstreamUrl.port || 80) };
const authority = `${UPSTREAM.host}:${UPSTREAM.port}`;
const port = Number(process.argv[2] ?? 19491);
const home = process.env.DSH_HOME ?? path.join(homedir(), '.dsh');
const webDir = fileURLToPath(new URL('../lib/web/', import.meta.url));

const b64url = (buffer) =>
  Buffer.from(buffer).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');

const secret = Buffer.from(
  /client-connection\/browser-session:[\s\S]*?secret:\s*(\S+)/u
    .exec(await readFile(path.join(home, '.credentials.yaml'), 'utf8'))[1]
    .replaceAll('-', '+')
    .replaceAll('_', '/'),
  'base64',
);
const issuedAt = Date.now();
const body = b64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 3_600_000 }));
const cookie = `dsh-auth-${b64url(createHash('sha256').update(authority).digest())}=v1.${body}.${b64url(
  createHmac('sha256', secret).update(body).digest(),
)}`;

const STATIC = {
  '/deepseek-web/': ['index.html', 'text/html; charset=utf-8'],
  '/deepseek-web/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/deepseek-web/app.css': ['app.css', 'text/css; charset=utf-8'],
  '/deepseek-web/gate-copy.js': ['gate-copy.js', 'text/javascript; charset=utf-8'],
  '/deepseek-web/composer-bridge.js': ['composer-bridge.js', 'text/javascript; charset=utf-8'],
  '/deepseek-web/guide/step1.svg': ['guide/step1.svg', 'image/svg+xml; charset=utf-8'],
  '/deepseek-web/guide/step2.svg': ['guide/step2.svg', 'image/svg+xml; charset=utf-8'],
  '/deepseek-web/guide/step3.svg': ['guide/step3.svg', 'image/svg+xml; charset=utf-8'],
  '/deepseek-web/guide/step4.svg': ['guide/step4.svg', 'image/svg+xml; charset=utf-8'],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  console.log(`${req.method} ${url.pathname}${url.search}`);

  if (url.pathname.startsWith('/deepseek-web/api/')) {
    // `gate=1` (carried as a cookie by the frame page) rewrites `status` to a
    // signed-out snapshot, so the pre-login gate can be inspected without
    // touching the real credential.
    const forceGate = /(?:^|;\s*)dsw_gate_demo=1(?:;|$)/u.test(req.headers.cookie ?? '');
    const upstream = http.request(
      {
        host: UPSTREAM.host,
        port: UPSTREAM.port,
        method: req.method,
        path: req.url,
        headers: {
          ...req.headers,
          cookie,
          host: authority,
          origin: `http://${authority}`,
          'accept-encoding': 'identity',
        },
      },
      (answer) => {
        if (!forceGate || !url.pathname.endsWith('/status')) {
          res.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(res);
          return;
        }
        const chunks = [];
        answer.on('data', (chunk) => chunks.push(chunk));
        answer.on('end', () => {
          let payload = {};
          try {
            payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          } catch {
            /* fall through with an empty payload */
          }
          const body = Buffer.from(
            JSON.stringify({ ...payload, signedIn: false, user: null, sameAccount: false }),
            'utf8',
          );
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.byteLength });
          res.end(body);
        });
      },
    );
    upstream.on('error', (error) => {
      res.writeHead(502, { 'content-type': 'text/plain' }).end(String(error));
    });
    req.pipe(upstream);
    return;
  }

  if (url.pathname === '/frame') {
    const width = Number(url.searchParams.get('w') ?? 400);
    const theme = url.searchParams.get('theme') ?? 'light';
    const demo = url.searchParams.get('demo');
    const gateDemo = url.searchParams.get('gate') === '1';
    const demoScript =
      demo === 'drop'
        ? `<script>
      // Drive the panel's own drop handler with synthetic drags, so the chips
      // rail can be inspected without a human doing the drag.
      const frame = document.querySelector('iframe');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      frame.addEventListener('load', async () => {
        await wait(2200);
        const doc = frame.contentDocument;
        if (!doc) return;
        const fileDrop = new DataTransfer();
        fileDrop.items.add(new File(['export const answer = 42;\\n'], 'config.js', { type: 'text/javascript' }));
        doc.dispatchEvent(new DragEvent('drop', { dataTransfer: fileDrop, bubbles: true }));
        await wait(400);
        const sessionDrop = new DataTransfer();
        sessionDrop.effectAllowed = 'move';
        sessionDrop.setData('text/plain', ${JSON.stringify(url.searchParams.get('session') ?? '')});
        doc.dispatchEvent(new DragEvent('drop', { dataTransfer: sessionDrop, bubbles: true }));
        await wait(1200);
        const chips = doc.querySelectorAll('#chips .chip');
        document.title = 'chips:' + chips.length + ' | ' + [...chips].map((c) => c.textContent).join(' , ');
      });
    </script>`
        : demo === 'picker'
          ? `<script>
      // Open the click-to-add session picker, the drag-free path.
      const frame = document.querySelector('iframe');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      frame.addEventListener('load', async () => {
        await wait(2200);
        const doc = frame.contentDocument;
        if (!doc) return;
        doc.getElementById('pick-session').click();
        await wait(1500);
        document.title = 'picker:' + doc.querySelectorAll('#modal-body .sessions button').length;
      });
    </script>`
          : demo === 'login'
            ? `<script>
      // Open the sign-in dialog without touching the stored grant: the button is
      // only hidden while signed in, so reveal and click it.
      const frame = document.querySelector('iframe');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      frame.addEventListener('load', async () => {
        await wait(2200);
        const doc = frame.contentDocument;
        if (!doc) return;
        const button = doc.getElementById('sign-in');
        button.hidden = false;
        button.click();
        await wait(1200);
        document.title = 'login-dialog:' + (doc.querySelector('.login-form') ? 'account' : 'missing');
      });
    </script>`
            : '';
    const gateCookie = gateDemo ? '<script>document.cookie = "dsw_gate_demo=1; path=/";</script>' : '';
    const zoomDemo =
      demo === 'zoom'
        ? `<script>
      // Click the first guide thumbnail and report whether the enlarged view is on top.
      const frame = document.querySelector('iframe');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      frame.addEventListener('load', async () => {
        await wait(2400);
        const doc = frame.contentDocument;
        if (!doc) return;
        doc.querySelector('#gate-steps .gate-step-thumb img').click();
        await wait(700);
        const backdrop = doc.getElementById('modal-backdrop');
        const img = doc.querySelector('#modal .zoom-img');
        const box = img ? img.getBoundingClientRect() : { width: 0, height: 0 };
        document.title = 'zoom:open=' + backdrop.classList.contains('open') + ',z=' + getComputedStyle(backdrop).zIndex + ',w=' + Math.round(box.width);
      });
    </script>`
        : '';
    const langDemo =
      demo === 'gate-en'
        ? `<script>
      // Flip the gate to English and report its headline for verification.
      const frame = document.querySelector('iframe');
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      frame.addEventListener('load', async () => {
        await wait(2200);
        const doc = frame.contentDocument;
        if (!doc) return;
        doc.getElementById('gate-lang-en').click();
        await wait(400);
        const zh = doc.getElementById('gate-lang-zh');
        const en = doc.getElementById('gate-lang-en');
        document.title = 'lang:' + doc.querySelector('.gate-lang').outerHTML.replace(/\s+/g, ' ');
      });
    </script>`
        : '';
    const html = `<!doctype html><meta charset="utf-8"><style>
      html,body{margin:0;background:#0b0d12;font:12px system-ui;color:#888}
      .frame{width:${width}px;height:100vh;border:0;display:block}
    </style>${gateCookie}<iframe class="frame" src="/deepseek-web/?theme=${theme}"></iframe>${demoScript}${langDemo}${zoomDemo}`;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
    return;
  }

  const asset = STATIC[url.pathname];
  if (asset !== undefined) {
    try {
      const bytes = await readFile(path.join(webDir, asset[0]));
      res.writeHead(200, { 'content-type': asset[1], 'cache-control': 'no-store', 'content-length': bytes.byteLength });
      res.end(bytes);
    } catch (error) {
      res.writeHead(500, { 'content-type': 'text/plain' }).end(String(error));
    }
    return;
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found');
});

server.listen(port, '127.0.0.1', () => {
  console.log(`preview: http://127.0.0.1:${port}/deepseek-web/?theme=dark`);
});
