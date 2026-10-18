/**
 * Minimal, dependency-free client for the DeepSeek web chat private API
 * (`https://chat.deepseek.com/api/v0/...`).
 *
 * Everything here mirrors what the site's own browser bundle does: the envelope
 * shape `{ code, msg, data: { biz_code, biz_msg, biz_data } }`, the
 * `x-client-*` identity headers, the proof-of-work header on POST endpoints,
 * and the newline-delimited JSON "delta" stream used by `/chat/completion`.
 *
 * This module deliberately knows nothing about DSH: no imports, no globals.
 * The host plugin supplies token, fetch, logger and the PoW solver.
 */

/** Business codes the caller may want to branch on. */
export const CODE = {
  OK: 0,
  MISSING_TOKEN: 40002,
  INVALID_TOKEN: 40003,
  POW_HEADER_ERROR: 40300,
  INVALID_POW_RESPONSE: 40301,
  USER_BANNED: 50002,
  MUTED: 50006,
};

/** Paths used by the site's web client. */
export const PATH = {
  current: '/api/v0/users/current',
  logout: '/api/v0/users/logout',
  createSession: '/api/v0/chat_session/create',
  fetchSessions: '/api/v0/chat_session/fetch_page',
  deleteSession: '/api/v0/chat_session/delete',
  history: '/api/v0/chat/history_messages',
  completion: '/api/v0/chat/completion',
  createPowChallenge: '/api/v0/chat/create_pow_challenge',
  uploadFile: '/api/v0/file/upload_file',
};

/** Errors thrown by this module carry the provider's own codes for diagnosis. */
export class WebApiError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'WebApiError';
    this.code = options.code;
    this.bizCode = options.bizCode;
    this.status = options.status;
    this.body = options.body;
    this.path = options.path;
  }
}

const CLIENT_VERSION = '2.5.0';
const BUNDLE_ID = 'com.deepseek.chat';

/**
 * Build the browser-identity headers the API validates.
 * @param {object} identity
 * @param {string} [identity.locale] BCP-47-ish tag; the API accepts `zh_CN` / `en_US`.
 * @param {string} [identity.deviceId] Stable UUID for this install.
 * @param {string} [identity.platform] `web` or `desktop`.
 */
export function identityHeaders(identity = {}) {
  const headers = {
    'x-client-bundle-id': BUNDLE_ID,
    'x-client-platform': identity.platform ?? 'web',
    'x-client-version': CLIENT_VERSION,
    'x-client-locale': identity.locale ?? 'zh_CN',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
  };
  if (identity.deviceId) headers['x-device-id'] = identity.deviceId;
  if (identity.deviceModel) headers['x-device-model'] = identity.deviceModel;
  return headers;
}

/** Normalize an envelope, surfacing transport and business failures distinctly. */
export function unwrap(envelope, path) {
  if (typeof envelope !== 'object' || envelope === null) {
    throw new WebApiError(`Unexpected response from ${path}`, { path });
  }
  if (typeof envelope.code === 'number' && envelope.code !== CODE.OK) {
    throw new WebApiError(envelope.msg || `Request failed (${envelope.code})`, {
      code: envelope.code,
      path,
      body: envelope,
    });
  }
  const data = envelope.data;
  if (typeof data !== 'object' || data === null) {
    throw new WebApiError(`Missing response payload from ${path}`, { path, body: envelope });
  }
  if (typeof data.biz_code === 'number' && data.biz_code !== CODE.OK) {
    throw new WebApiError(data.biz_msg || `Business failure (${data.biz_code})`, {
      bizCode: data.biz_code,
      code: envelope.code,
      path,
      body: envelope,
    });
  }
  return data.biz_data ?? {};
}

/**
 * The API surface. One instance is cheap; it holds no credentials itself.
 */
export class DeepSeekWebApi {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl] Origin of the web chat; defaults to production.
   * @param {(input: string, init?: object) => Promise<Response>} [options.fetch] Injectable fetch.
   * @param {string} [options.locale]
   * @param {string} [options.deviceId]
   * @param {string} [options.platform]
   * @param {(chat: object, signal?: AbortSignal) => Promise<string>} [options.solvePow]
   *   Solves a PoW challenge; returns the base64 `x-ds-pow-response` value.
   * @param {{debug: Function, warn: Function}} [options.log]
   */
  constructor(options = {}) {
    this.baseUrl = (options.baseUrl ?? 'https://chat.deepseek.com').replace(/\/+$/, '');
    this.fetchImpl = options.fetch ?? globalThis.fetch?.bind(globalThis);
    this.locale = options.locale;
    this.deviceId = options.deviceId;
    this.platform = options.platform;
    this.solvePow = options.solvePow;
    this.log = options.log ?? { debug() {}, warn() {} };
    if (typeof this.fetchImpl !== 'function') throw new Error('DeepSeekWebApi requires fetch');
  }

  /** Headers common to every call. */
  headers(token, extra) {
    return {
      accept: '*/*',
      'accept-language': `${this.locale === 'en_US' ? 'en-US,en;q=0.9' : 'zh-CN,zh;q=0.9,en;q=0.8'}`,
      origin: this.baseUrl,
      referer: `${this.baseUrl}/`,
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      ...identityHeaders({ locale: this.locale, deviceId: this.deviceId, platform: this.platform }),
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      ...extra,
    };
  }

  /** Issue one JSON request and unwrap the envelope. */
  async request(method, path, { token, body, query, signal, headers, pow } = {}) {
    const url = new URL(this.baseUrl + path);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const init = {
      method,
      headers: this.headers(token, {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(pow === undefined ? {} : pow),
        ...headers,
      }),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal === undefined ? {} : { signal }),
    };
    const response = await this.fetchImpl(url.toString(), init);
    const text = await response.text();
    if (!response.ok) {
      throw new WebApiError(httpFailureMessage(response.status, text), {
        status: response.status,
        path,
        body: text.slice(0, 500),
      });
    }
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new WebApiError(`Non-JSON response from ${path}`, { status: response.status, path, body: text.slice(0, 500) });
    }
    return unwrap(envelope, path);
  }

  /** Solve and shape the `x-ds-pow-response` header for one target path. */
  async powHeader(token, targetPath, signal) {
    if (typeof this.solvePow !== 'function') return undefined;
    const data = await this.request('POST', PATH.createPowChallenge, {
      token,
      body: { target_path: targetPath },
      signal,
    });
    const challenge = data.challenge ?? data;
    if (!challenge || typeof challenge.challenge !== 'string') {
      throw new WebApiError('PoW challenge payload is missing fields', { path: PATH.createPowChallenge });
    }
    const raw = await this.solvePow({ ...challenge, target_path: challenge.target_path ?? targetPath }, signal);
    return { 'x-ds-pow-response': raw };
  }

  /** `GET /users/current` — validates a token and returns the account. */
  async currentUser(token, signal) {
    const data = await this.request('GET', PATH.current, { token, signal });
    return normalizeUser(data);
  }

  /** Create an empty chat session and return its id. */
  async createSession(token, signal) {
    const data = await this.request('POST', PATH.createSession, { token, body: {}, signal });
    const id = data.chat_session?.id ?? data.id;
    if (!id) throw new WebApiError('Session creation returned no id', { path: PATH.createSession });
    return { id, title: data.chat_session?.title ?? '' };
  }

  /** List recent conversations, newest first. */
  async listSessions(token, { count = 30, signal } = {}) {
    const data = await this.request('GET', PATH.fetchSessions, {
      token,
      query: { count, 'lte_cursor.pinned': 'false', 'lte_cursor.updated_at': Math.floor(Date.now() / 1000) + 86400 },
      signal,
    });
    const sessions = Array.isArray(data.chat_sessions) ? data.chat_sessions : [];
    return {
      hasMore: Boolean(data.has_more),
      sessions: sessions.map((session) => ({
        id: session.id,
        title: session.title ?? '',
        updatedAt: session.updated_at ?? null,
        pinned: Boolean(session.pinned),
        modelType: session.model_type ?? null,
      })),
    };
  }

  /** Fetch every message of one conversation. */
  async history(token, sessionId, signal) {
    const data = await this.request('GET', PATH.history, {
      token,
      // `cache_version`/`cache_reset_at` are optional incremental-replay
      // hints; sending a literal "null" makes the server reject the request.
      query: { chat_session_id: sessionId },
      signal,
    });
    const messages = Array.isArray(data.chat_messages) ? data.chat_messages : [];
    return {
      session: {
        id: data.chat_session?.id ?? sessionId,
        title: data.chat_session?.title ?? '',
      },
      messages: messages.map(normalizeMessage),
    };
  }

  /**
   * Stream one completion.
   *
   * Yields semantic deltas: `{type:'ready'|'thinking'|'text'|'search'|'status'|'usage'|'title'|'toast'}`.
   * Calling code owns the transcript; this only normalizes the wire protocol.
   */
  async *complete(token, request, { signal } = {}) {
    const pow = await this.powHeader(token, PATH.completion, signal);
    const url = new URL(this.baseUrl + PATH.completion);
    const response = await this.fetchImpl(url.toString(), {
      method: 'POST',
      headers: this.headers(token, {
        'content-type': 'application/json',
        accept: 'text/event-stream',
        ...(pow ?? {}),
      }),
      body: JSON.stringify({
        chat_session_id: request.sessionId,
        ...(request.parentMessageId === undefined || request.parentMessageId === null
          ? {}
          : { parent_message_id: request.parentMessageId }),
        model_type: request.modelType ?? 'default',
        prompt: request.prompt,
        ref_file_ids: request.refFileIds ?? [],
        thinking_enabled: Boolean(request.thinking),
        search_enabled: Boolean(request.search),
        ...(typeof request.source === 'string' && request.source.length > 0 ? { source: request.source } : {}),
      }),
      signal,
    });
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new WebApiError(httpFailureMessage(response.status, body), {
        status: response.status,
        path: PATH.completion,
        body: body.slice(0, 500),
      });
    }
    if (!response.body) throw new WebApiError('Completion returned no body', { path: PATH.completion });
    yield* parseCompletionStream(response.body);
  }

  /** Upload one file and return its file id (used as `ref_file_ids`). */
  async uploadFile(token, { bytes, filename, mimeType }, signal) {
    const pow = await this.powHeader(token, PATH.uploadFile, signal);
    const form = new FormData();
    form.append('file', new Blob([bytes], { type: mimeType ?? 'application/octet-stream' }), filename);
    const response = await this.fetchImpl(this.baseUrl + PATH.uploadFile, {
      method: 'POST',
      headers: this.headers(token, pow ?? {}),
      body: form,
      signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new WebApiError(httpFailureMessage(response.status, text), { status: response.status, path: PATH.uploadFile });
    }
    const data = unwrap(JSON.parse(text), PATH.uploadFile);
    const id = data.file?.id ?? data.id;
    if (!id) throw new WebApiError('Upload returned no file id', { path: PATH.uploadFile, body: data });
    return { id, name: filename };
  }
}

/** Account shape the plugin exposes, with tokens stripped. */
export function normalizeUser(raw) {
  const user = raw?.user ?? raw ?? {};
  return {
    id: stringOrNull(user.id),
    email: stringOrNull(user.email),
    mobile: stringOrNull(user.mobile_number),
    areaCode: stringOrNull(user.area_code),
    name: stringOrNull(user.name),
    avatar: stringOrNull(user.picture ?? user.avatar_url),
  };
}

/** Message shape used by the UI: role + text/reasoning plus search citations. */
export function normalizeMessage(raw) {
  const fragments = Array.isArray(raw.fragments) ? raw.fragments : [];
  let text = '';
  let thinking = '';
  const files = [];
  for (const fragment of fragments) {
    const type = String(fragment?.type ?? '').toUpperCase();
    const content = typeof fragment?.content === 'string' ? fragment.content : '';
    if (type === 'THINK') thinking += content;
    else if (type === 'RESPONSE' || type === 'ANSWER' || type === 'REQUEST' || type === 'USER') text += content;
    else if (type === 'FILE') files.push(content);
  }
  const role = typeof raw.role === 'string' ? raw.role.toLowerCase() : raw.role;
  return {
    id: raw.message_id ?? raw.id ?? null,
    role: role === 'assistant' || role === 2 ? 'assistant' : 'user',
    // History responses already carry the normalized fields; keep them when the
    // raw wire shape is absent so the same function serves both sides.
    text: text.length > 0 ? text : typeof raw.text === 'string' ? raw.text : '',
    thinking: thinking.length > 0 ? thinking : typeof raw.thinking === 'string' ? raw.thinking : '',
    files,
    status: raw.status ?? null,
    insertedAt: raw.inserted_at ?? raw.insertedAt ?? null,
    accumulatedTokens: raw.accumulated_token_usage ?? raw.accumulatedTokens ?? null,
    searchEnabled: Boolean(raw.search_enabled ?? raw.searchEnabled),
    thinkingEnabled: Boolean(raw.thinking_enabled ?? raw.thinkingEnabled),
  };
}

function stringOrNull(value) {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Map an HTTP failure onto an actionable message, including the WAF case. */
function httpFailureMessage(status, body) {
  const snippet = typeof body === 'string' ? body.replace(/\s+/g, ' ').slice(0, 200) : '';
  if (status === 429 || status === 403) {
    if (/request blocked|just a moment|cf-|captcha/i.test(snippet)) {
      return `The web chat refused this request (HTTP ${status}) with an anti-bot challenge. The token may be stale, or the account is rate limited.`;
    }
    return `The web chat refused this request (HTTP ${status}).`;
  }
  if (status === 401) return 'The web chat rejected the credential (HTTP 401).';
  return `The web chat request failed (HTTP ${status})${snippet ? `: ${snippet}` : ''}`;
}

/**
 * Parse the completion stream.
 *
 * The server writes `event:`/`data:` frames; `delta` frames carry JSON-patch
 * operations (`p` path, `o` operation, `v` value) that append text fragments.
 */
export async function* parseCompletionStream(body, { onEvent } = {}) {
  const decoder = new TextDecoder();
  let buffer = '';
  // Patch state: fragment index -> kind ('think' | 'text'), plus the newest one.
  const fragments = [];
  let lastPath = '';
  let finished = false;

  const reader = body.getReader();
  try {
    while (!finished) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = findBoundary(buffer);
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary.length);
        const frame = parseFrame(raw);
        if (frame) {
          for (const delta of applyFrame(frame, { fragments, setLastPath: (p) => (lastPath = p), lastPath: () => lastPath })) {
            if (delta.type === 'finish') finished = true;
            onEvent?.(frame, delta);
            yield delta;
          }
        }
        boundary = findBoundary(buffer);
      }
    }
    const tail = parseFrame(buffer);
    if (tail) {
      for (const delta of applyFrame(tail, { fragments, setLastPath: (p) => (lastPath = p), lastPath: () => lastPath })) {
        onEvent?.(tail, delta);
        yield delta;
      }
    }
  } finally {
    reader.releaseLock?.();
    try {
      await body.cancel?.();
    } catch {
      /* the response may already be closed */
    }
  }
}

/** Frames end with a blank line; tolerate `\r\n` and two newlines. */
function findBoundary(buffer) {
  const lf = buffer.indexOf('\n\n');
  const crlf = buffer.indexOf('\r\n\r\n');
  if (lf === -1 && crlf === -1) return -1;
  if (crlf !== -1 && (lf === -1 || crlf < lf)) return { index: crlf, length: 4 };
  return { index: lf, length: 2 };
}

/** Decode one `event:`/`data:` frame. */
function parseFrame(raw) {
  const text = raw.trim();
  if (text.length === 0) return null;
  let event = 'message';
  const dataLines = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
    else if (line.startsWith(':')) continue;
  }
  if (dataLines.length === 0) return { event, data: undefined };
  const data = dataLines.join('\n');
  try {
    return { event, data: JSON.parse(data) };
  } catch {
    return { event, data };
  }
}

/**
 * Fold one wire frame into UI deltas.
 * `state` carries the fragment table and the currently addressed path.
 */
function* applyFrame(frame, state) {
  if (frame.event === 'ready') {
    yield {
      type: 'ready',
      responseMessageId: frame.data?.response_message_id ?? null,
      requestMessageId: frame.data?.request_message_id ?? null,
      modelType: frame.data?.model_type ?? null,
    };
    return;
  }
  if (frame.event === 'finish') {
    yield { type: 'finish', data: frame.data ?? null };
    return;
  }
  if (frame.event === 'title') {
    yield { type: 'title', title: frame.data?.content ?? frame.data ?? '' };
    return;
  }
  if (frame.event === 'toast') {
    yield { type: 'toast', toast: frame.data ?? null };
    return;
  }
  if (frame.event === 'close') {
    yield { type: 'close', data: frame.data ?? null };
    return;
  }
  if (frame.event !== 'delta' && frame.event !== 'message') {
    yield { type: 'other', event: frame.event, data: frame.data ?? null };
    return;
  }
  const patch = frame.data;
  if (typeof patch !== 'object' || patch === null) {
    if (typeof patch === 'string' && patch.length > 0) yield { type: 'text', text: patch };
    return;
  }
  yield* applyPatch(patch, state);
}

/**
 * Apply one `{p,o,v}` operation (or a snapshot/append sequence).
 *
 * The server mixes three shapes in one stream: full snapshots, path-addressed
 * patches, and bare `{v:"text"}` token frames that continue the previously
 * addressed fragment. All three are folded here.
 */
function* applyPatch(patch, state) {
  const hasPath = typeof patch.p === 'string';
  if (hasPath) state.setLastPath(patch.p);
  const path = hasPath ? patch.p : state.lastPath();
  const op = typeof patch.o === 'string' ? patch.o : undefined;
  const value = patch.v;

  if (!hasPath && op === undefined && typeof value === 'object' && value !== null && 'response' in value) {
    yield* snapshot(value, state);
    return;
  }
  if (value === undefined) return;

  // A bare string with no address continues the fragment most recently spoken
  // for: `{"v":"6"}` is one token of the open thinking or response fragment.
  if (!hasPath && op === undefined && typeof value === 'string') {
    const last = state.fragments[state.fragments.length - 1];
    if (last) last.content += value;
    if (value.length > 0) yield { type: last?.kind === 'think' ? 'thinking' : 'text', text: value };
    return;
  }
  if (!hasPath && op === undefined && Array.isArray(value)) {
    yield* applyPatch({ p: path, o: 'BATCH', v: value }, state);
    return;
  }

  if (path === 'response' && (op === 'BATCH' || Array.isArray(value))) {
    for (const item of Array.isArray(value) ? value : []) {
      if (item && typeof item === 'object') yield* applyPatch(item, state);
    }
    return;
  }
  // `response/fragments/-1` batches speak about the fragment itself.
  if (path === 'response/fragments/-1' && Array.isArray(value)) {
    for (const item of Array.isArray(value) ? value : []) {
      if (item && typeof item === 'object' && item.p === 'content' && typeof item.v === 'string') {
        const last = state.fragments[state.fragments.length - 1];
        if (last && last.kind !== 'other') {
          last.content += item.v;
          yield { type: last.kind === 'think' ? 'thinking' : 'text', text: item.v };
        }
      }
    }
    return;
  }
  // Search results hang off the fragment that carried the query.
  if (path.endsWith('/results') && Array.isArray(value)) {
    yield { type: 'search', results: normalizeSearchResults(value) };
    return;
  }
  if (path === 'response/conversation_mode' && typeof value === 'string') {
    yield { type: 'mode', mode: value };
    return;
  }
  if (path === 'response/fragments' && (op === 'APPEND' || op === undefined)) {
    for (const fragment of Array.isArray(value) ? value : [value]) {
      const delta = pushFragment(fragment, state);
      if (delta) yield delta;
    }
    return;
  }
  if (path === 'response/fragments/-1/content' && typeof value === 'string') {
    const last = state.fragments[state.fragments.length - 1];
    if (last) last.content += value;
    if (value.length > 0) yield { type: last?.kind === 'think' ? 'thinking' : 'text', text: value };
    return;
  }
  if (path === 'response/status' && typeof value === 'string') {
    yield { type: 'status', status: value };
    return;
  }
  if (path === 'response/search_status') {
    yield { type: 'search', searchStatus: value };
    return;
  }
  if (path === 'response/search_results') {
    yield { type: 'search', results: normalizeSearchResults(value) };
    return;
  }
  if (path === 'response/accumulated_token_usage' || path === 'accumulated_token_usage') {
    if (typeof value === 'number') yield { type: 'usage', tokens: value };
    return;
  }
  if (path === 'response/content' && typeof value === 'string') {
    yield { type: 'text', text: value };
    return;
  }
  if (path === 'response/thinking_content' && typeof value === 'string') {
    yield { type: 'thinking', text: value };
    return;
  }
}

/** Detached, URL-bearing search results; anything malformed is dropped. */
function normalizeSearchResults(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const results = [];
  for (const item of list) {
    if (!item || typeof item !== 'object' || typeof item.url !== 'string' || item.url.length === 0) continue;
    results.push({
      url: item.url,
      title: typeof item.title === 'string' ? item.title : item.url,
      snippet: typeof item.snippet === 'string' ? item.snippet : '',
    });
  }
  return results;
}

/** Seed the fragment table from a full snapshot. */
function* snapshot(value, state) {
  const response = value.response;
  const fragments = Array.isArray(response?.fragments) ? response.fragments : [];
  for (const fragment of fragments) {
    const delta = pushFragment(fragment, state);
    if (delta) yield delta;
  }
}

/** Append one fragment and describe the text it contributes. */
function pushFragment(fragment, state) {
  if (!fragment || typeof fragment !== 'object') return null;
  const type = String(fragment.type ?? '').toUpperCase();
  const kind = type === 'THINK' ? 'think' : type === 'RESPONSE' || type === 'ANSWER' ? 'text' : 'other';
  const content = typeof fragment.content === 'string' ? fragment.content : '';
  state.fragments.push({ kind, type, content });
  if (content.length === 0) return null;
  if (kind === 'think') return { type: 'thinking', text: content };
  if (kind === 'text') return { type: 'text', text: content };
  return null;
}
