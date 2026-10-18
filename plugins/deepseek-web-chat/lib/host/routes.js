/**
 * HTTP surface of the side panel.
 *
 * One prefix route serves the panel document, its two assets, and a small JSON
 * API. `/api/chat` answers with `text/event-stream`: the panel renders those
 * frames as they arrive, so an answer appears token by token.
 */
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/** Browser assets live beside this module. */
const WEB_DIR = new URL('../web/', import.meta.url);
const ASSETS = {
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/index.html': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
  '/gate-copy.js': { file: 'gate-copy.js', type: 'text/javascript; charset=utf-8' },
  '/composer-bridge.js': { file: 'composer-bridge.js', type: 'text/javascript; charset=utf-8' },
  '/font-scale.js': { file: 'font-scale.js', type: 'text/javascript; charset=utf-8' },
  // Illustrations for the sign-in guide; a fixed whitelist, not a directory walk.
  '/guide/step1.svg': { file: 'guide/step1.svg', type: 'image/svg+xml; charset=utf-8' },
  '/guide/step2.svg': { file: 'guide/step2.svg', type: 'image/svg+xml; charset=utf-8' },
  '/guide/step3.svg': { file: 'guide/step3.svg', type: 'image/svg+xml; charset=utf-8' },
  '/guide/step4.svg': { file: 'guide/step4.svg', type: 'image/svg+xml; charset=utf-8' },
};

const MAX_BODY_BYTES = 1 << 20;

/**
 * Register the panel route.
 * @param {object} webServer The `ctx.webServer` service.
 * @param {object} service The panel service from `service.js`.
 * @param {object} logger Cordis logger.
 * @param {object} config Resolved plugin config.
 * @returns {() => void} disposer
 */
export function registerRoutes(webServer, service, logger, config, getConnection) {
  const prefix = config.routePrefix;

  /**
   * Data endpoints require the app's own browser grant. A route registered on
   * the web server bypasses the `/api` bridge, so admission is asked explicitly
   * here; the static panel page carries no data and stays open.
   *
   * The connection service is looked up per request because it can be provided
   * after this plugin mounts; a missing one means "not ready yet", never "open".
   */
  function admitted(req, res) {
    const connection = getConnection?.();
    if (connection === undefined || typeof connection.admit !== 'function') {
      sendJson(res, 503, { ok: false, error: 'The app connection is not ready yet; reload the panel in a moment.' });
      return false;
    }
    const admission = connection.admit(req);
    if (admission !== undefined && 'rejection' in admission) {
      res.writeHead(admission.rejection, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(admission.rejection === 401 ? 'unauthorized' : 'forbidden');
      return false;
    }
    return true;
  }

  async function handler(req, res) {
    try {
      await dispatch(req, res);
    } catch (error) {
      logger.warn(`deepseek-web route failed: ${error?.stack ?? error}`);
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) });
    }
  }

  async function dispatch(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (!url.pathname.startsWith(prefix)) {
      sendJson(res, 404, { ok: false, error: 'Not found' });
      return;
    }
    if (!sameOrigin(req)) {
      sendJson(res, 403, { ok: false, error: 'Cross-origin request refused' });
      return;
    }
    const suffix = url.pathname.slice(prefix.length) || '/';

    if (suffix.startsWith('/api/')) {
      if (!admitted(req, res)) return;
      await handleApi(req, res, suffix.slice('/api/'.length), url);
      return;
    }
    const asset = ASSETS[suffix];
    if (asset !== undefined) {
      const body = await readFile(fileURLToPath(new URL(asset.file, WEB_DIR)));
      res.writeHead(200, {
        'content-type': asset.type,
        'cache-control': 'no-cache',
        'content-length': body.byteLength,
        'x-content-type-options': 'nosniff',
      });
      res.end(body);
      return;
    }
    // A bare path without the trailing slash still opens the panel.
    if (suffix === '') {
      const body = await readFile(fileURLToPath(new URL('index.html', WEB_DIR)));
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
      res.end(body);
      return;
    }
    sendJson(res, 404, { ok: false, error: 'Not found' });
  }

  async function handleApi(req, res, action, url) {
    if (req.method === 'GET') {
      if (action === 'status') {
        sendJson(res, 200, { ok: true, ...(await service.status()) });
        return;
      }
      if (action === 'sessions') {
        try {
          const page = await service.sessions();
          sendJson(res, 200, { ok: true, ...page });
        } catch (error) {
          await sendError(res, error, service);
        }
        return;
      }
      if (action === 'files') {
        try {
          const listing = await service.files(url.searchParams.get('path') ?? '', url.searchParams.get('root') ?? undefined);
          sendJson(res, 200, { ok: true, ...listing });
        } catch (error) {
          await sendError(res, error, service);
        }
        return;
      }
      if (action === 'dsh-sessions') {
        try {
          const limit = Number(url.searchParams.get('limit') ?? '');
          const result = await service.dshSessions({
            ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
            ...(url.searchParams.get('cwd') === null ? {} : { cwd: url.searchParams.get('cwd') }),
          });
          sendJson(res, 200, { ok: true, ...result });
        } catch (error) {
          await sendError(res, error, service);
        }
        return;
      }
      if (action === 'session-context') {
        // Preview only: render one session at one level so the picker can show what
        // the chosen level would actually send, without uploading or sending.
        try {
          const preview = await service.sessionContextPreview({
            id: url.searchParams.get('id') ?? '',
            mode: url.searchParams.get('mode') ?? undefined,
            headChars: Number(url.searchParams.get('headChars') ?? '') || undefined,
          });
          sendJson(res, 200, { ok: true, ...preview });
        } catch (error) {
          await sendError(res, error, service);
        }
        return;
      }
      sendJson(res, 404, { ok: false, error: `Unknown action: ${action}` });
      return;
    }

    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: 'Method not allowed' });
      return;
    }

    let body;
    try {
      body = await readJsonBody(req);
    } catch (error) {
      sendJson(res, 400, { ok: false, error: String(error?.message ?? error) });
      return;
    }

    if (action === 'login') {
      try {
        // The only accepted credential is a chat.deepseek.com `userToken`.
        const result = await service.login(body.token);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        await sendError(res, error, service);
      }
      return;
    }
    if (action === 'logout') {
      try {
        await service.logout();
        sendJson(res, 200, { ok: true });
      } catch (error) {
        await sendError(res, error, service);
      }
      return;
    }
    if (action === 'history') {
      try {
        const result = await service.history(body.sessionId);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        await sendError(res, error, service);
      }
      return;
    }
    if (action === 'session-preview') {
      try {
        const result = await service.sessionPreview(body.id);
        sendJson(res, 200, { ok: true, ...result });
      } catch (error) {
        await sendError(res, error, service);
      }
      return;
    }
    if (action === 'chat') {
      await streamChat(req, res, body);
      return;
    }
    sendJson(res, 404, { ok: false, error: `Unknown action: ${action}` });
  }

  async function streamChat(req, res, body) {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const controller = new AbortController();
    let closed = false;
    const onClose = () => {
      closed = true;
      controller.abort();
    };
    req.on('close', onClose);
    const ping = setInterval(() => {
      if (!closed) res.write(': ping\n\n');
    }, 15_000);
    try {
      for await (const event of service.chat(body, controller.signal)) {
        if (closed) break;
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
      if (!closed) res.write(`data: ${JSON.stringify({ type: 'end' })}\n\n`);
    } catch (error) {
      const expired = await clearExpired(service, error);
      if (!closed) {
        res.write(
          `data: ${JSON.stringify({
            type: 'error',
            message: expired ? '登录已过期，请重新登录' : describeError(error),
            signedOut: error?.code === 'SIGNED_OUT' || expired,
          })}\n\n`,
        );
      } else {
        logger.debug(`chat stream ended after client disconnect: ${error?.message ?? error}`);
      }
    } finally {
      clearInterval(ping);
      req.off('close', onClose);
      if (!closed) res.end();
    }
  }

  return webServer.register({ kind: 'prefix', path: prefix, handler });
}

/* ------------------------------------------------------------------ helpers */

function sendJson(res, status, payload) {
  if (res.headersSent) {
    res.end();
    return;
  }
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': body.byteLength,
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function sendError(res, error, service) {
  // A credential the server no longer accepts is dropped here, so the panel stops
  // pretending to be signed in and offers the login dialog again.
  const expired = await clearExpired(service, error);
  const status = error?.code === 'SIGNED_OUT' || expired ? 401 : 400;
  sendJson(res, status, {
    ok: false,
    error: expired ? '登录已过期，请重新登录' : describeError(error),
    signedOut: error?.code === 'SIGNED_OUT' || expired,
  });
}

/** Ask the service to forget a token the provider rejected (40002/40003). */
async function clearExpired(service, error) {
  if (typeof service.handleAuthFailure !== 'function') return false;
  try {
    return (await service.handleAuthFailure(error)) === true;
  } catch (failure) {
    console.warn(`deepseek-web: clearing an expired credential failed: ${failure?.message ?? failure}`);
    return false;
  }
}

function describeError(error) {
  if (error === undefined || error === null) return 'Unknown error';
  if (typeof error === 'string') return error;
  return String(error.message ?? error);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch (error) {
        reject(new Error(`Invalid JSON body: ${error.message}`));
      }
    });
    req.on('error', reject);
  });
}

/** Reject cross-site posts; the panel is only ever opened from this origin. */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return true;
  try {
    const host = req.headers.host;
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
