/**
 * Host-side model of one DeepSeek web account plus the chat actions the side
 * panel performs. Everything that touches the network goes through
 * `./api.js`; this module owns persistence, workspace context and the mapping
 * between a panel thread and a chat.deepseek.com conversation.
 */
import { randomUUID } from 'node:crypto';

// Every sibling module is imported through the revision this module was loaded
// with, so a reload of `lib/index.js` picks up edited sources instead of Node's
// cached copies.
const REV = new URL(import.meta.url).searchParams.get('rev') ?? '';
const load = (specifier) => import(new URL(`${specifier}${REV ? `?rev=${REV}` : ''}`, import.meta.url).href);

const [{ createPowSolver }, { DeepSeekWebApi, WebApiError, CODE }, workspace, wasm, dshSessionsModule, renderModule] = await Promise.all([
  load('./pow.js'),
  load('./api.js'),
  load('./workspace.js'),
  load('./wasm.js'),
  load('./dsh-sessions.js'),
  load('./session-render.js'),
]);
const { readWorkspaceFile, listWorkspaceDirectory, resolveWorkspaceRoot } = workspace;
const { readCachedTitle, pickerRow, visibleRows, foldTranscript, MAX_TURNS } = dshSessionsModule;
const { renderSession, SESSION_MODES } = renderModule;

/** Credential record key; the scope names this plugin, the id names the account. */
const RECORD_KEY = 'deepseek-web-chat/account';

/** Build tag shown in the panel; bump it whenever the panel document changes. */
const PANEL_VERSION = '0.7.2';

/** A DSH session id: `session-<uuid>`, tolerating a bare uuid. */
const SESSION_ID = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export class SignedOutError extends Error {
  constructor(message = 'Not signed in to chat.deepseek.com') {
    super(message);
    this.name = 'SignedOutError';
    this.code = 'SIGNED_OUT';
  }
}

/**
 * @param {object} options
 * @param {object} options.ctx Cordis context of the plugin.
 * @param {object} options.config Resolved plugin configuration.
 * @param {object} options.logger Cordis logger.
 */
export function createService({ ctx, config, logger }) {
  const solver = createPowSolver({
    // Resolved on the first challenge: a git/pnpm install arrives without the
    // module, and it is fetched once into the user's DSH cache.
    wasmPath: () =>
      wasm.resolveWasmPath({
        wasmPath: config.wasmPath,
        cacheDir: wasm.defaultCacheDir(),
        warn: (message) => logger.warn(message),
      }),
    warn: (message) => logger.warn(message),
  });

  const api = new DeepSeekWebApi({
    baseUrl: config.baseUrl,
    locale: config.locale,
    deviceId: undefined,
    platform: 'web',
    solvePow: (challenge) => solver.solve(challenge),
    log: {
      debug: (message) => logger.debug(message),
      warn: (message) => logger.warn(message),
    },
  });

  /**
   * Conversation id -> newest message id, so follow-ups thread correctly. */
  const parents = new Map();

  const credentials = () => {
    const service = ctx.get('credentials');
    if (service === undefined) {
      throw new Error('The credentials service is not available in this profile; cannot store the web account token.');
    }
    return service;
  };

  /**
   * Read the stored grant.
   *
   * Deliberately uncached: the store is an in-memory map lookup, and a cached
   * miss used to pin the panel to "signed out" even though the record was on
   * disk (observed after a sign-out attempt that only cleared the cache).
   */
  async function readRecord() {
    const record = await credentials().readRecord(RECORD_KEY);
    return record?.kind === 'grant' ? record.payload ?? null : null;
  }

  /**
   * Store the grant, or delete the record when `payload` is null.
   *
   * `modifyRecord` treats an undefined mutation result as "no change", so signing
   * out has to delete explicitly — otherwise the token survives on disk and comes
   * back on the next start.
   */
  async function writeRecord(payload) {
    const store = credentials();
    if (payload === null) {
      if (typeof store.deleteRecord === 'function') await store.deleteRecord(RECORD_KEY);
      return;
    }
    await store.modifyRecord(RECORD_KEY, async () => ({ kind: 'grant', payload }));
  }

  /** Resolve the stored token, refusing when signed out. */
  async function requireToken() {
    const record = await readRecord();
    if (!record?.token) throw new SignedOutError();
    return record;
  }

  /** Make an API instance bound to the stored device identity. */
  async function boundApi() {
    const record = await requireToken();
    return {
      record,
      api: new DeepSeekWebApi({
        baseUrl: config.baseUrl,
        locale: config.locale,
        deviceId: record.deviceId,
        platform: 'web',
        solvePow: (challenge) => solver.solve(challenge),
        log: {
          debug: (message) => logger.debug(message),
          warn: (message) => logger.warn(message),
        },
      }),
    };
  }

  /**
   * The DSH account's masked contact, shown in the login dialog so the panel can
   * say "you are already signed in to this account elsewhere". It is a hint only:
   * DSH's Platform grant is a different credential and chat.deepseek.com refuses
   * it (verified: `/users/current` answers 40003 INVALID_TOKEN).
   */
  let dshAccountCache;
  /** Newest retention sweep result, published through `status`. */
  let attachmentGcSummary = null;
  /** Last failure while reading the DSH profile, surfaced in `status` for support. */
  let dshAccountError;
  async function dshAccountHint() {
    if (dshAccountCache !== undefined && dshAccountCache.expiresAt > Date.now()) return dshAccountCache.value;
    const account = ctx.get('deepseekAccount');
    if (account === undefined || typeof account.getProfile !== 'function') {
      dshAccountError = 'deepseekAccount service is not mounted';
      dshAccountCache = { value: null, expiresAt: Date.now() + 60_000 };
      return null;
    }
    const metadata = {
      version: PANEL_VERSION,
      locale: config.locale === 'en_US' ? 'en_US' : 'zh_CN',
      timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
    };
    try {
      const outcome = await Promise.race([
        account.getProfile(metadata),
        new Promise((resolve) => setTimeout(() => resolve('timeout'), 4000)),
      ]);
      if (outcome === 'timeout') {
        dshAccountError = 'profile request timed out';
        dshAccountCache = { value: null, expiresAt: Date.now() + 30_000 };
        return null;
      }
      // `getProfile` answers with the profile *outcome*, not the profile: the
      // ready case nests the fields under `value`.
      if (outcome === null || outcome === undefined) {
        dshAccountError = 'profile unavailable (signed out?)';
        dshAccountCache = { value: null, expiresAt: Date.now() + 30_000 };
        return null;
      }
      if (outcome.status !== 'ready' || outcome.value === undefined || outcome.value === null) {
        dshAccountError = 'profile request failed';
        dshAccountCache = { value: null, expiresAt: Date.now() + 60_000 };
        return null;
      }
      dshAccountError = undefined;
      const value = {
        contact: outcome.value.contact ?? null,
        name: outcome.value.name ?? null,
        id: outcome.value.id ?? null,
      };
      dshAccountCache = { value, expiresAt: Date.now() + 120_000 };
      return value;
    } catch (error) {
      dshAccountError = String(error?.message ?? error);
      logger.warn(`reading the DSH account profile failed: ${dshAccountError}`);
      dshAccountCache = { value: null, expiresAt: Date.now() + 30_000 };
      return null;
    }
  }

  const service = {
    /** Panel bootstrap: sign-in state, workspace roots and defaults. */
    async status() {
      let readError;
      const record = await readRecord().catch((error) => {
        readError = String(error?.message ?? error);
        logger.warn(`reading the web account record failed: ${readError}`);
        return null;
      });
      const roots = workspaceRoots();
      const dshAccount = await dshAccountHint();
      return {
        signedIn: Boolean(record?.token),
        user: record?.user ?? null,
        dshAccount,
        // The two credentials differ, but the underlying account does not: DSH's
        // Platform profile id and the web account id are the same value.
        sameAccount: Boolean(record?.user?.id && dshAccount?.id && record.user.id === dshAccount.id),
        ...(dshAccount === null && dshAccountError !== undefined ? { dshAccountError } : {}),
        ...(readError === undefined ? {} : { credentialsError: readError }),
        settings: {
          version: PANEL_VERSION,
          baseUrl: config.baseUrl,
          locale: config.locale,
          thinking: config.defaultThinking,
          search: config.defaultSearch,
          theme: config.theme,
          maxContextBytes: config.maxContextBytes,
        },
        workspace: roots[0] ?? { root: config.workspaceRoot ?? process.cwd(), name: '' },
        roots,
        // Retention for the answer files this panel inserted as attachments:
        // policy plus the last sweep, so "why did my attachment disappear" and
        // "is anything cleaning up" are answerable from one request.
        attachmentRetention: {
          retentionDays: config.attachmentRetentionDays,
          pruneReferenced: config.attachmentPruneReferenced === true,
          lastSweep: attachmentGcSummary,
        },
      };
    },

    /** Remember the newest retention sweep for `status`. */
    recordAttachmentGc(summary) {
      attachmentGcSummary = summary ?? null;
    },

    /** Validate a pasted `userToken` and store it. */
    async login(token) {
      if (typeof token !== 'string' || token.trim().length === 0) throw new Error('A userToken is required');
      const value = token.trim();
      const deviceId = (await readRecord())?.deviceId ?? randomUUID();
      const probe = new DeepSeekWebApi({
        baseUrl: config.baseUrl,
        locale: config.locale,
        deviceId,
        platform: 'web',
        solvePow: (challenge) => solver.solve(challenge),
        log: { debug() {}, warn: (message) => logger.warn(message) },
      });
      let user;
      try {
        user = await probe.currentUser(value);
      } catch (error) {
        if (error instanceof WebApiError) {
          if (error.code === CODE.MISSING_TOKEN || error.code === CODE.INVALID_TOKEN) {
            throw new Error('这个 userToken 无效或已过期，请重新从浏览器复制。');
          }
          if (error.status === 401 || error.status === 403 || error.status === 429) {
            throw new Error(error.message);
          }
        }
        throw error;
      }
      await writeRecord({ token: value, user, deviceId, signedInAt: new Date().toISOString() });
      logger.info(`signed in to chat.deepseek.com as ${user?.email ?? user?.mobile ?? user?.id ?? 'unknown'}`);
      return { user };
    },

    /** Forget the local grant. The remote session is left untouched. */
    async logout() {
      await writeRecord(null);
      parents.clear();
    },

    async sessions() {
      const { api, record } = await boundApi();
      const page = await api.listSessions(record.token, { count: config.sessionPageSize });
      return page;
    },

    async history(sessionId) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) throw new Error('sessionId is required');
      const { api, record } = await boundApi();
      const result = await api.history(record.token, sessionId);
      const lastAssistant = [...result.messages].reverse().find((message) => message.role === 'assistant');
      if (lastAssistant?.id != null) parents.set(sessionId, lastAssistant.id);
      return result;
    },

    /**
     * Drop a credential the provider has rejected (40002/40003) so the panel can
     * ask for a fresh login instead of repeating the same failure.
     * @param {unknown} error Failure raised by an API call.
     * @returns {Promise<boolean>} true when the stored login was cleared.
     */
    async handleAuthFailure(error) {
      if (!(error instanceof WebApiError)) return false;
      if (error.code !== CODE.MISSING_TOKEN && error.code !== CODE.INVALID_TOKEN) return false;
      const record = await readRecord();
      if (record === null) return false;
      await writeRecord(null);
      parents.clear();
      logger.info('stored chat.deepseek.com token was rejected; cleared it');
      return true;
    },

    files(path, root) {
      return listWorkspaceDirectory({ path, root: root ?? defaultRoot(), config });
    },

    /**
     * Describe one DSH session for a dropped conversation chip: title, message
     * count and size, without shipping the transcript to the browser.
     * @param {string} sessionId Session id carried by the drag payload.
     */
    async sessionPreview(sessionId) {
      const id = typeof sessionId === 'string' ? sessionId.trim() : '';
      if (!SESSION_ID.test(id)) {
        throw new Error('这个拖拽内容不是有效的会话 id');
      }
      const transcript = await readSessionTranscript(id, { persistence: ctx.get('sessionPersistence'), logger });
      const cached = await readCachedTitle({ home: config.dshHome, id });
      return {
        id: transcript.id,
        // The title DSH generated is what the sidebar shows, so a dropped chip
        // reads the same as the row it came from.
        title: cached.title ?? transcript.title,
        messages: transcript.total,
        kept: transcript.kept,
        truncated: transcript.truncated,
        bytes: transcript.bytes,
      };
    },

    /**
     * List recent DSH sessions so the panel can offer a click-to-add picker:
     * dragover delivery into an iframe is not something a plugin can rely on.
     * @param {{limit?: number, cwd?: string}} [request]
     */
    /**
     * Render one session at one fidelity level, for the picker's preview pane.
     *
     * Nothing leaves the machine here: no upload, no completion. The picker uses it
     * so that choosing \u6b63\u6587 / \u542b\u5de5\u5177 / \u6587\u4ef6\u9644\u4ef6 changes both the explanation and the
     * sample the user sees, instead of the choice only taking effect after sending.
     * @param {{id?: string, mode?: string, headChars?: number}} request
     */
    async sessionContextPreview(request = {}) {
      const id = typeof request.id === 'string' ? request.id.trim() : '';
      if (!SESSION_ID.test(id)) throw new Error('\u8fd9\u4e2a\u9009\u62e9\u4e0d\u662f\u6709\u6548\u7684 DSH \u4f1a\u8bdd id');
      const mode = request.mode === 'file' || SESSION_MODES.includes(request.mode) ? request.mode : config.sessionContextMode;
      const deps = { persistence: ctx.get('sessionPersistence'), background: ctx.get('sessionQuery'), logger, home: config.dshHome };
      const headChars = Math.min(Math.max(Number.isInteger(request.headChars) ? request.headChars : 1200, 200), 4000);
      if (mode === 'file') {
        // What the uploaded file would contain, quoted from the full rendering.
        const rendered = await renderSessionFile(id, { deps });
        return {
          id,
          mode,
          title: rendered.title,
          entries: rendered.entries,
          total: rendered.entries,
          rendered: rendered.entries,
          bytes: rendered.bytesTotal,
          omitted: 0,
          omittedBytes: 0,
          truncated: false,
          fileName: rendered.fileName,
          preview: rendered.head.slice(0, headChars),
          // The tail is where tool lines live in the rich levels, so the picker
          // can show a sample of the level's distinctive content, not just the
          // same opening message for every mode.
          tail: rendered.text.slice(-600),
        };
      }
      const rendered = await renderSessionSource(
        { id, mode },
        { mode, maxBytes: Math.min(config.maxSessionBytes ?? config.maxContextBytes, config.maxContextBytes), deps },
      );
      return {
        id,
        mode,
        title: rendered.title,
        entries: rendered.entries,
        total: rendered.entries,
        rendered: rendered.rendered,
        bytes: rendered.bytes,
        omitted: rendered.omitted,
        omittedBytes: rendered.omittedBytes,
        truncated: rendered.truncated,
        preview: rendered.text.slice(0, headChars),
        tail: rendered.text.slice(-600),
      };
    },

    async dshSessions(request = {}) {
      const persistence = ctx.get('sessionPersistence');
      if (persistence === undefined || typeof persistence.list !== 'function') {
        throw new Error('会话存储服务不可用');
      }
      const limit = Number.isInteger(request.limit) ? Math.min(Math.max(request.limit, 1), 40) : 12;
      const cwd = typeof request.cwd === 'string' && request.cwd.length > 0 ? request.cwd : undefined;
      const snapshots = await persistence.list();
      const sorted = [...snapshots]
        // Subagent runs are transcripts too, but they are not the user's own
        // conversations and would crowd the picker out.
        .filter((snapshot) => snapshot.header?.origin !== 'subagent')
        .filter((snapshot) => (cwd === undefined ? true : samePath(snapshot.header?.cwd ?? '', cwd)))
        .sort((left, right) => (right.header?.createdAt ?? 0) - (left.header?.createdAt ?? 0))
        // Read more than we show: the empty ones are dropped below.
        .slice(0, limit * 3);
      const rows = [];
      let unreadable = 0;
      for (const snapshot of sorted) {
        const id = snapshot.header?.id;
        if (typeof id !== 'string') continue;
        const base = {
          id,
          createdAt: snapshot.header?.createdAt ?? null,
          cwd: snapshot.header?.cwd ?? null,
        };
        try {
          const transcript = await readSessionTranscript(id, {
            persistence,
            logger,
            eventCount: Number.isInteger(snapshot.eventCount) ? snapshot.eventCount : undefined,
          });
          const cached = await readCachedTitle({ home: config.dshHome, id });
          rows.push(
            pickerRow({
              ...base,
              cached: cached.title ?? transcript.cachedTitle ?? null,
              firstAsk: cached.firstAsk ?? transcript.firstAsk ?? null,
              first: transcript.first,
              last: transcript.last,
              lines: transcript.lines,
              messages: transcript.total,
              kept: transcript.kept,
              truncated: transcript.truncated,
              bytes: transcript.bytes,
            }),
          );
        } catch (error) {
          // A session with no readable turn is not "broken", it is simply unused;
          // `visibleRows` drops it and the panel says how many were hidden.
          unreadable += 1;
          logger.debug(`skipping DSH session ${id}: ${String(error?.message ?? error)}`);
        }
      }
      const { rows: visible, hidden } = visibleRows(rows);
      return { sessions: visible.slice(0, limit), hidden: hidden + unreadable };
    },

    /**
     * Stream one answer. Yields normalized events for the HTTP route to relay.
     * @param {object} request Panel request.
     * @param {AbortSignal} signal Cancellation from the HTTP client.
     */
    async *chat(request, signal) {
      const prompt = typeof request.prompt === 'string' ? request.prompt.trim() : '';
      if (prompt.length === 0) throw new Error('prompt is required');
      const { api, record } = await boundApi();

      let sessionId = typeof request.sessionId === 'string' && request.sessionId.length > 0 ? request.sessionId : null;
      const sources = normalizeSessionSources(request.sessions, config.sessionContextMode);
      const deps = { persistence: ctx.get('sessionPersistence'), background: ctx.get('sessionQuery'), logger, home: config.dshHome };
      // File-mode sources are uploaded first: the model then owns the whole
      // transcript instead of receiving whichever slice fitted in the prompt.
      const preparedFiles = await prepareUploadedSessions(sources, { api, token: record.token, deps, signal });
      const context = await buildContext(
        {
          paths: request.paths ?? [],
          inline: request.inline ?? [],
          sessions: sources,
        },
        { ...config, workspaceRoot: defaultRoot() },
        { ...deps, preparedFiles: preparedFiles.byId },
      );
      const refFileIds = preparedFiles.fileIds;
      // Tell the panel what actually went out: bytes, mode and omissions per
      // source, so a chip can show "tools ? 214 KB ? -12" instead of guessing.
      if (context.summary.length > 0) yield { type: 'context', summary: context.summary };
      if (sessionId === null) {
        const created = await api.createSession(record.token, signal);
        sessionId = created.id;
        yield { type: 'ready', sessionId, title: created.title };
      } else {
        yield { type: 'ready', sessionId };
      }

      let parentMessageId = parents.get(sessionId) ?? null;
      if (parentMessageId === null) {
        try {
          const history = await api.history(record.token, sessionId, signal);
          const last = [...history.messages].reverse().find((message) => message.role === 'assistant');
          parentMessageId = last?.id ?? null;
        } catch (error) {
          logger.debug(`history lookup before continuing failed: ${error?.message ?? error}`);
        }
      }

      const finalPrompt = context.preamble ? `${context.preamble}\n\n${prompt}` : prompt;
      let sawText = false;

      for await (const delta of api.complete(
        record.token,
        {
          sessionId,
          parentMessageId,
          prompt: finalPrompt,
          thinking: Boolean(request.thinking ?? config.defaultThinking),
          search: Boolean(request.search ?? config.defaultSearch),
          refFileIds,
        },
        { signal },
      )) {
        if (delta.type === 'ready') {
          if (delta.responseMessageId != null) parents.set(sessionId, delta.responseMessageId);
          yield { type: 'ready', sessionId, messageId: delta.responseMessageId ?? null };
        } else if (delta.type === 'text') {
          sawText = true;
          yield { type: 'text', text: delta.text };
        } else if (delta.type === 'thinking') {
          yield { type: 'thinking', text: delta.text };
        } else if (delta.type === 'search') {
          yield {
            type: 'search',
            ...(delta.results === undefined ? {} : { results: delta.results }),
            ...(delta.searchStatus === undefined ? {} : { status: delta.searchStatus }),
          };
        } else if (delta.type === 'mode') {
          yield { type: 'mode', mode: delta.mode };
        } else if (delta.type === 'usage') {
          yield { type: 'usage', tokens: delta.tokens };
        } else if (delta.type === 'title') {
          yield { type: 'title', title: delta.title };
        } else if (delta.type === 'status') {
          yield { type: 'status', status: delta.status };
        } else if (delta.type === 'toast') {
          const text = delta.toast?.content;
          if (typeof text === 'string' && text.length > 0) yield { type: 'toast', message: text };
        } else if (delta.type === 'finish') {
          const reason = delta.data?.finish_reason ?? delta.data ?? null;
          yield { type: 'done', reason, files: context.summary };
        }
      }
      if (!sawText) yield { type: 'done', reason: 'empty', files: context.summary };
    },

    /** Rendering hint for the panel: resolved workspace roots. */
    roots: workspaceRoots,
  };

  /** Workspace roots, most recently registered first, with a cwd fallback. */
  function workspaceRoots() {
    const roots = [];
    try {
      const registry = ctx.get('workspaceRegistry');
      for (const workspace of registry?.list() ?? []) {
        roots.push({ root: workspace.path, name: workspace.title, id: workspace.id });
      }
    } catch (error) {
      logger.warn(`workspace registry unavailable: ${error?.message ?? error}`);
    }
    if (config.workspaceRoot) {
      const explicit = roots.find((entry) => samePath(entry.root, config.workspaceRoot));
      return explicit ? [explicit, ...roots.filter((entry) => entry !== explicit)] : [{ root: config.workspaceRoot, name: '' }, ...roots];
    }
    if (roots.length === 0) roots.push({ root: process.cwd(), name: '' });
    return roots;
  }

  /** The root a request uses when the panel names none of its own. */
  function defaultRoot() {
    if (config.workspaceRoot) return config.workspaceRoot;
    return workspaceRoots()[0]?.root ?? process.cwd();
  }

  void resolveWorkspaceRoot;
  void readWorkspaceFile;
  return service;
}

function samePath(a, b) {
  return String(a).replace(/[\\/]+$/, '').toLowerCase() === String(b).replace(/[\\/]+$/, '').toLowerCase();
}

/**
 * Build the prompt preamble from the three context sources the panel can hand
 * over: workspace files by path, file contents read in the browser (a drop from
 * Explorer, where Electron hides the path), and DSH conversation transcripts
 * (a session dragged out of the sidebar).
 *
 * @param {{paths?: string[], inline?: Array<{name?: string, text?: string}>, sessions?: string[]}} sources
 * @param {object} config Resolved plugin config (byte caps live here).
 * @param {{persistence?: object, logger?: object}} deps Host services used for transcripts.
 * @returns {Promise<{preamble: string, summary: Array<object>}>}
 */
export async function buildContext(sources, config, deps = {}) {
  const paths = Array.isArray(sources?.paths) ? sources.paths.filter((item) => typeof item === 'string' && item.length > 0) : [];
  const inline = Array.isArray(sources?.inline) ? sources.inline : [];
  const sessions = normalizeSessionSources(sources?.sessions);
  const blocks = [];
  const summary = [];
  let used = 0;

  /** Clip one text block to the remaining budget and record what happened. */
  const clip = (text, budget) => {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= budget) return { text, bytes, truncated: false };
    const clipped = Buffer.from(text, 'utf8').subarray(0, Math.max(0, budget)).toString('utf8');
    return { text: `${clipped}\n…（已截断，原 ${bytes} 字节）`, bytes: Math.max(0, budget), truncated: true };
  };

  for (const path of paths) {
    if (used >= config.maxContextBytes) {
      summary.push({ source: 'file', label: path, bytes: 0, truncated: true });
      continue;
    }
    const budget = Math.min(config.maxFileBytes, config.maxContextBytes - used);
    try {
      const file = await readWorkspaceFile({ path, root: config.workspaceRoot, config, maxBytes: budget });
      used += file.bytes;
      summary.push({ source: 'file', label: file.path, bytes: file.bytes, truncated: file.truncated });
      blocks.push(`<file path="${file.path}">\n${file.text}\n</file>`);
    } catch (error) {
      const message = String(error?.message ?? error);
      summary.push({ source: 'file', label: path, bytes: 0, truncated: false, error: message });
      blocks.push(`<file path="${path}">(读取失败: ${message})</file>`);
    }
  }

  for (const entry of inline) {
    const name = typeof entry?.name === 'string' && entry.name.length > 0 ? entry.name : '拖入的内容';
    const text = typeof entry?.text === 'string' ? entry.text : '';
    if (text.length === 0) continue;
    if (used >= config.maxContextBytes) {
      summary.push({ source: 'drop', label: name, bytes: 0, truncated: true });
      continue;
    }
    const budget = Math.min(config.maxFileBytes, config.maxContextBytes - used);
    const clipped = clip(text, budget);
    used += clipped.bytes;
    summary.push({ source: 'drop', label: name, bytes: clipped.bytes, truncated: clipped.truncated });
    blocks.push(`<file path="${name}">\n${clipped.text}\n</file>`);
  }

  for (const source of sessions) {
    if (used >= config.maxContextBytes) {
      summary.push({ source: 'session', label: source.id, bytes: 0, truncated: true });
      continue;
    }
    const budget = config.maxContextBytes - used;
    try {
      // File mode is uploaded separately (see `prepareSessionFile`) so the model
      // reads the whole transcript itself instead of receiving a clipped inline
      // copy; inline it here only as the fallback when that upload failed.
      const prepared = source.mode === 'file' ? deps.preparedFiles?.get(source.id) : undefined;
      const rendered = await renderSessionSource(source, {
        mode: source.mode === 'file' ? 'full' : source.mode,
        maxBytes: Math.min(budget, config.maxSessionBytes ?? budget),
        deps,
      });
      if (source.mode === 'file' && prepared !== undefined) {
        summary.push({
          source: 'session',
          label: rendered.title,
          bytes: 0,
          truncated: false,
          mode: 'file',
          fileId: prepared.fileId,
          entries: rendered.entries,
          bytesTotal: prepared.bytesTotal,
        });
        blocks.push(
          `<conversation id="${source.id}" title="${escapeAttribute(rendered.title)}" mode="file" entries="${rendered.entries}" bytes="${prepared.bytesTotal}">\n` +
            `（全文已作为文件 ${prepared.fileName} 附在本对话中，请按需阅读；下面是开头摘要。）\n${prepared.head}\n</conversation>`,
        );
        continue;
      }
      used += rendered.bytes;
      summary.push({
        source: 'session',
        label: rendered.title,
        bytes: rendered.bytes,
        truncated: rendered.truncated,
        mode: rendered.mode,
        entries: rendered.entries,
        omitted: rendered.omitted,
        omittedBytes: rendered.omittedBytes,
        ...(source.mode === 'file' ? { uploadFallback: true } : {}),
      });
      blocks.push(
        `<conversation id="${source.id}" title="${escapeAttribute(rendered.title)}" mode="${rendered.mode}" entries="${rendered.entries}" rendered="${rendered.rendered}" bytes="${rendered.bytes}"${rendered.truncated ? ` omitted="${rendered.omitted}" omittedBytes="${rendered.omittedBytes}"` : ''}>\n` +
          `${rendered.text}\n` +
          `${rendered.truncated ? `（本会话共 ${rendered.entries} 条，已省略 ${rendered.omitted} 条最旧内容 / 约 ${rendered.omittedBytes} 字节，其余为截断标记。）\n` : ''}` +
          '</conversation>',
      );
    } catch (error) {
      const message = String(error?.message ?? error);
      deps.logger?.warn?.(`reading DSH session ${source.id} failed: ${message}`);
      summary.push({ source: 'session', label: source.id, bytes: 0, truncated: false, error: message });
      blocks.push(`<conversation id="${source.id}">(读取失败: ${message})</conversation>`);
    }
  }

  if (blocks.length === 0) return { preamble: '', summary };
  const preamble = [
    '下面是我提供的参考材料（工作区文件 / 我拖入的内容 / DSH 历史对话记录），它们只作为背景，',
    '请结合这些材料回答我最后提出的问题。',
    '',
    blocks.join('\n\n'),
  ].join('\n');
  return { preamble, summary };
}

/** Neutralize characters that would break out of a quoted pseudo-XML attribute. */
function escapeAttribute(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('"', '&quot;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/**
 * Accept both wire shapes: `["session-id"]` (older panels) and
 * `[{id, mode}]`. Unknown modes fall back to the configured default.
 * @param {unknown} value
 * @param {string} [fallbackMode]
 * @returns {Array<{id: string, mode: 'transcript'|'tools'|'file'}>}
 */
export function normalizeSessionSources(value, fallbackMode = 'transcript') {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0) {
      out.push({ id: item, mode: SESSION_MODES.includes(fallbackMode) || fallbackMode === 'file' ? fallbackMode : 'transcript' });
      continue;
    }
    if (item !== null && typeof item === 'object' && typeof item.id === 'string' && item.id.length > 0) {
      const mode = item.mode === 'file' || SESSION_MODES.includes(item.mode) ? item.mode : 'transcript';
      out.push({ id: item.id, mode });
    }
  }
  return out;
}

/**
 * Read one session's event corpus, preferring the query service.
 *
 * `sessionQuery.readSession` is live-preferred (it includes events a running
 * session has not flushed yet) and validates the log; persistence is the fallback,
 * and both return the same event shape.
 * @param {string} sessionId
 * @param {{persistence?: object, background?: object}} deps
 * @returns {Promise<Array<{type?: string, data?: object}>>}
 */
export async function readSessionEvents(sessionId, deps = {}) {
  const query = deps.background;
  if (query !== undefined && typeof query.readSession === 'function') {
    const corpus = await query.readSession(sessionId);
    const events = Array.isArray(corpus?.events) ? corpus.events : [];
    if (events.length > 0) return events;
  }
  const persistence = deps.persistence;
  if (persistence === undefined || typeof persistence.open !== 'function') {
    throw new Error('会话存储服务不可用');
  }
  const handle = await persistence.open(sessionId, 'read');
  try {
    const result = await handle.read();
    return Array.isArray(result?.events) ? result.events : [];
  } finally {
    await handle.close?.();
  }
}

/**
 * Render one session source at the requested fidelity level.
 * @param {{id: string, mode: string}} source
 * @param {{mode?: string, maxBytes?: number, deps?: object}} options
 */
export async function renderSessionSource(source, options = {}) {
  const deps = options.deps ?? {};
  const events = await readSessionEvents(source.id, deps);
  const cached = await readCachedTitle({ home: deps.home ?? '', id: source.id });
  const rendered = renderSession(events, {
    mode: options.mode ?? source.mode,
    maxBytes: options.maxBytes,
  });
  // Title chain: the title DSH generated, else the opening ask, else the id.
  const firstAsk = rendered.text.split('\n\n').find((line) => line.startsWith('用户: '));
  const derived = firstAsk === undefined ? '' : firstAsk.slice(4).replace(/\s+/gu, ' ').trim().slice(0, 32);
  return {
    ...rendered,
    title: cached.title ?? (derived.length > 0 ? `DSH 会话 · ${derived}` : `DSH 会话 · ${source.id.slice(0, 8)}`),
  };
}

/**
 * Render one session for upload as a file, and give a short head to inline.
 * @param {string} sessionId
 * @param {{deps?: object, headBytes?: number}} [options]
 */
export async function renderSessionFile(sessionId, options = {}) {
  const deps = options.deps ?? {};
  const events = await readSessionEvents(sessionId, deps);
  const cached = await readCachedTitle({ home: deps.home ?? '', id: sessionId });
  // The file gets everything: no budget, no per-turn tool trimming.
  const full = renderSession(events, { mode: 'full', maxBytes: Number.MAX_SAFE_INTEGER, recentToolTurns: Number.MAX_SAFE_INTEGER });
  const headBytes = options.headBytes ?? 4000;
  const head = Buffer.from(full.text, 'utf8').subarray(0, headBytes).toString('utf8');
  return {
    title: cached.title ?? `DSH 会话 · ${sessionId.slice(0, 8)}`,
    text: full.text,
    entries: full.entries,
    bytesTotal: full.bytes,
    head,
    fileName: `dsh-session-${sessionId.replace(/^session-/u, '').slice(0, 8)}.md`,
  };
}

/**
 * Upload every file-mode source, reusing one upload per identical rendering.
 *
 * The web chat accepts a file reference id (`ref_file_ids`) that it keeps for the
 * conversation; uploading the same bytes again would only cost time, so the id is
 * memoised by session id plus rendered size.
 * @param {Array<{id: string, mode: string}>} sources
 * @param {{api: object, token: string, deps: object, signal?: AbortSignal}} options
 * @returns {Promise<{byId: Map<string, {fileId: string, fileName: string, bytesTotal: number, head: string}>, fileIds: string[]}>}
 */
async function prepareUploadedSessions(sources, { api, token, deps, signal }) {
  const byId = new Map();
  const fileIds = [];
  for (const source of sources) {
    if (source.mode !== 'file') continue;
    const rendered = await renderSessionFile(source.id, { deps });
    const key = `${source.id}:${rendered.bytesTotal}`;
    let uploaded = uploadCache.get(key);
    if (uploaded === undefined) {
      try {
        const result = await api.uploadFile(
          token,
          { bytes: new TextEncoder().encode(rendered.text), filename: rendered.fileName, mimeType: 'text/markdown' },
          signal,
        );
        uploaded = { fileId: result.id, fileName: rendered.fileName };
        uploadCache.set(key, uploaded);
      } catch (error) {
        // Degrade to the inline rendering (`buildContext` notices the missing
        // entry in `preparedFiles` and emits the tail instead of nothing).
        deps.logger?.warn?.(`uploading session ${source.id} failed, inlining instead: ${String(error?.message ?? error)}`);
        continue;
      }
    }
    byId.set(source.id, { fileId: uploaded.fileId, fileName: uploaded.fileName, bytesTotal: rendered.bytesTotal, head: rendered.head });
    fileIds.push(uploaded.fileId);
  }
  return { byId, fileIds };
}

/** session id + rendered size → uploaded file id, for the life of this process. */
const uploadCache = new Map();

/**
 * Read one DSH session's transcript through the persistence service.
 *
 * A DSH turn emits one assistant event per step, so a long agentic turn can be
 * hundreds of events. Reading a fixed 240-event tail therefore returned three
 * entries for a conversation of 59 ? the attached context depended on how much
 * metadata the session snapshot happened to carry. The tail is now grown in
 * steps until enough *entries* exist (or the log start is reached), and the
 * folding itself lives in `foldTranscript` so the rule is unit-tested.
 *
 * @param {string} sessionId Stored session id.
 * @param {{persistence?: object, eventCount?: number}} deps Host services; a known
 *   event count lets the reader start from the tail instead of the whole log.
 * @returns {Promise<{id: string, title: string, lines: string[], total: number, kept: number, truncated: boolean, first: string|null, last: string|null, bytes: number}>}
 */
export async function readSessionTranscript(sessionId, deps = {}) {
  const persistence = deps.persistence;
  if (persistence === undefined || typeof persistence.open !== 'function') {
    throw new Error('会话存储服务不可用');
  }
  const handle = await persistence.open(sessionId, 'read');
  try {
    const eventCount = Number.isInteger(deps.eventCount) ? deps.eventCount : undefined;
    // Small first window keeps the picker fast; grow only when the folding did not
    // produce enough entries, and give up after the whole log has been read once.
    const windows = eventCount === undefined ? [null] : [240, 1200, 4000, null];
    let folded = null;
    let eventsSeen = 0;
    let reachedStart = eventCount === undefined;
    for (const window of windows) {
      const result = window === null ? await handle.read() : await handle.read(Math.max(0, eventCount - window), window);
      const events = Array.isArray(result?.events) ? result.events : [];
      eventsSeen = events.length;
      folded = foldTranscript(events);
      reachedStart = window === null || window >= eventCount || events.length < window;
      if (reachedStart || folded.total > MAX_TURNS + 8) break;
    }
    if (folded === null || folded.lines.length === 0) throw new Error('这个会话还没有可读的对话内容');

    // Name the chip after the most recent user ask; seeded preambles and
    // runtime banners are skipped because they read as noise.
    const asks = (folded.lines ?? [])
      .filter((line) => line.startsWith('用户:'))
      .map((line) => line.slice(3).replace(/\s+/gu, ' ').trim())
      .filter((line) => line.length >= 8 && !/^(?:session-|<|\{|\[|#|\/)/u.test(line));
    const titleText = asks.at(-1) ?? asks[0] ?? '';
    const title = titleText.length > 0 ? titleText.slice(0, 32) : sessionId.slice(0, 8);
    return {
      id: sessionId,
      title: `DSH 会话 · ${title}`,
      lines: folded.lines,
      total: folded.total,
      kept: folded.kept,
      truncated: folded.truncated,
      first: folded.first,
      last: folded.last,
      bytes: folded.lines.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8'), 0),
      events: eventsSeen,
      reachedStart,
    };
  } finally {
    await handle.close?.();
  }
}

