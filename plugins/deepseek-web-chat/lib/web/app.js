/**
 * DeepSeek Chat side panel — browser half.
 *
 * Served by the host plugin at /deepseek-web/ and rendered inside a DSH
 * sidebar iframe. Plain DOM, no build step, no third-party code.
 */
/**
 * All data calls hang off `/deepseek-web/api/`. Resolving the directory once
 * keeps that path correct regardless of the panel's trailing slash or query; stripping it and appending "api/…" produced /deepseek-webapi/…
 * which the router answered with 404 (GET) and 405 (POST).
 */
const API_BASE = new URL('api/', window.location.href).href;

/**
 * Surface a broken script instead of leaving an empty panel: a fatal error is
 * shown in place and recorded on `<body data-panel-error>` for diagnosis.
 */
function reportFatal(message) {
  if (document.body?.dataset.panelError === message) return;
  if (document.body) document.body.dataset.panelError = message;
  const banner = document.createElement('div');
  banner.className = 'fatal';
  banner.textContent = `面板脚本出错：${message}`;
  document.body?.append(banner);
}
window.addEventListener('error', (event) => reportFatal(event.message || 'unknown error'));
window.addEventListener('unhandledrejection', (event) => reportFatal(String(event.reason?.message ?? event.reason)));

const state = {
  signedIn: false,
  user: null,
  dshAccount: null,
  sameAccount: false,
  workspace: { root: '', name: '' },
  settings: {},
  sessions: [],
  sessionId: null,
  messages: [],
  context: [],
  thinking: false,
  search: false,
  streaming: false,
  pickerPath: '',
  pickerSelection: new Set(),
  lang: initialLang(),
};

const el = {
  account: document.getElementById('account'),
  who: document.getElementById('account-who'),
  signIn: document.getElementById('sign-in'),
  signOut: document.getElementById('sign-out'),
  newChat: document.getElementById('new-chat'),
  history: document.getElementById('history'),
  transcript: document.getElementById('transcript'),
  empty: document.getElementById('empty'),
  input: document.getElementById('input'),
  send: document.getElementById('send'),
  chips: document.getElementById('chips'),
  attach: document.getElementById('attach'),
  pickSession: document.getElementById('pick-session'),
  note: document.getElementById('note'),
  emptyHint: document.getElementById('empty-hint'),
  thinking: document.getElementById('toggle-thinking'),
  search: document.getElementById('toggle-search'),
  modal: document.getElementById('modal-backdrop'),
  modalTitle: document.getElementById('modal-title'),
  modalBody: document.getElementById('modal-body'),
  modalFoot: document.getElementById('modal-foot'),
  drop: document.getElementById('drop-overlay'),
  toast: document.getElementById('toast'),
};

/**
 * The pre-login gate and its bilingual copy.
 *
 * Before sign-in the panel shows nothing but this screen: the transcript, the
 * composer and the context rails stay out of reach until a credential exists.
 */
import { GATE_COPY } from './gate-copy.js';

/** Current gate language; persisted so it survives a reload. */
function initialLang() {
  try {
    const stored = window.localStorage.getItem('dsw-chat-lang');
    if (stored === 'zh' || stored === 'en') return stored;
  } catch {
    /* storage may be unavailable */
  }
  return 'zh';
}

/** Gate element handles, resolved once. */
const gate = {
  root: document.getElementById('gate'),
  title: document.getElementById('gate-title'),
  subtitle: document.getElementById('gate-subtitle'),
  steps: document.getElementById('gate-steps'),
  submit: document.getElementById('gate-submit'),
  browser: document.getElementById('gate-browser'),
  token: document.getElementById('gate-token'),
  status: document.getElementById('gate-status'),
  privacy: document.getElementById('gate-privacy'),
  langZh: document.getElementById('gate-lang-zh'),
  langEn: document.getElementById('gate-lang-en'),
};

/** Copy for the active language. */
function t(key) {
  return (GATE_COPY[state.lang] ?? GATE_COPY.zh)[key] ?? key;
}

/** Build the illustrated four-step guide (thumbnails zoom into a modal). */
function renderGateSteps() {
  const copy = (GATE_COPY[state.lang] ?? GATE_COPY.zh).steps;
  gate.steps.replaceChildren(
    ...copy.map(([title, caption], index) => {
      const step = index + 1;
      const image = h('img', {
        src: `guide/step${step}.svg`,
        alt: `${step}. ${title}`,
        loading: 'lazy',
        title: t('zoom'),
        onclick: () =>
          openModal({
            title: `${step}. ${title}`,
            body: [h('img', { class: 'zoom-img', src: `guide/step${step}.svg`, alt: title })],
            footer: [h('button', { text: state.lang === 'en' ? 'Close' : '关闭', onclick: closeModal })],
          }),
      });
      return h(
        'li',
        { class: 'gate-step' },
        h('div', { class: 'gate-step-thumb' }, image),
        h('div', { class: 'gate-step-text' }, h('b', { text: `${step}. ${title}` }), h('span', { text: caption })),
      );
    }),
  );
}

/** Translate every gate label and reflect the language buttons. */
function renderGate() {
  document.documentElement.lang = state.lang === 'en' ? 'en' : 'zh-CN';
  gate.title.textContent = t('title');
  gate.subtitle.textContent = t('subtitle');
  gate.submit.textContent = t('submit');
  gate.browser.textContent = t('openSite');
  gate.token.placeholder = t('tokenLabel');
  gate.privacy.textContent = t('privacy');
  renderGateSteps();
  gate.langZh.setAttribute('aria-pressed', String(state.lang === 'zh'));
  gate.langEn.setAttribute('aria-pressed', String(state.lang === 'en'));
  // The visual state is a class: attribute selectors alone left the highlight on
  // the wrong button in the packaged build.
  gate.langZh.classList.toggle('is-active', state.lang === 'zh');
  gate.langEn.classList.toggle('is-active', state.lang === 'en');
}

/** Show the gate (pre-login) or the chat surface. */
function showGate(visible) {
  if (gate.root === null) return;
  gate.root.hidden = !visible;
  document.body.dataset.gate = visible ? 'on' : 'off';
  if (visible) {
    renderGate();
    // The token box is the only sign-in input; guard anyway so a markup change
    // cannot turn the whole panel into a fatal-error banner.
    gate.token?.focus();
  }
}

/**
 * Accept the several shapes a pasted token arrives in: the raw value, a quoted
 * string, `userToken: …`, or the whole `{"value":"…","__version":"0"}` object
 * that DevTools shows when the storage entry is inspected.
 * @param {string} raw Whatever the user pasted.
 * @returns {string} The token alone, or an empty string.
 */
function parsePastedToken(raw) {
  const text = String(raw ?? '').trim();
  if (text.length === 0) return '';
  try {
    const parsed = JSON.parse(text);
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.value === 'string') return parsed.value.trim();
  } catch {
    /* not JSON, keep going */
  }
  const labelled = /\bvalue\b\s*[:=]\s*["']?([^"',}\s]+)/iu.exec(text);
  if (labelled !== null) return labelled[1];
  return text.replace(/^["']|["']$/gu, '').split(/\s+/u)[0];
}

/* ------------------------------------------------------------------ utils */

function h(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    node.append(typeof child === 'string' || typeof child === 'number' ? String(child) : child);
  }
  return node;
}

let toastTimer;
function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}

async function request(path, options = {}) {
  const response = await fetch(API_BASE + path, {
    method: options.body === undefined ? 'GET' : 'POST',
    headers: options.body === undefined ? {} : { 'content-type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`Unexpected response (HTTP ${response.status})`);
  }
  if (!response.ok || payload.ok === false) {
    // The Host clears a rejected credential; mirror that here so the panel drops
    // its signed-in look and offers the dialog instead of failing every call.
    if (payload.signedOut === true && state.signedIn) {
      state.signedIn = false;
      state.user = null;
      renderAccount();
    }
    throw new Error(payload.error ?? `HTTP ${response.status}`);
  }
  return payload;
}

function formatRelative(seconds) {
  if (!seconds) return '';
  const delta = Date.now() / 1000 - seconds;
  if (delta < 60) return '刚刚';
  if (delta < 3600) return `${Math.floor(delta / 60)} 分钟前`;
  if (delta < 86400) return `${Math.floor(delta / 3600)} 小时前`;
  return `${Math.floor(delta / 86400)} 天前`;
}

/* -------------------------------------------------------- text rendering */

/**
 * Render model text with the tiny subset that matters in a chat panel:
 * fenced code blocks, inline code, bold, and headings. Everything is created
 * as DOM text nodes — model output never reaches innerHTML.
 */
function renderRichText(text, sources = []) {
  const wrapper = document.createDocumentFragment();
  const fence = /```([^\n`]*)\n([\s\S]*?)```/g;
  let cursor = 0;
  let match;
  while ((match = fence.exec(text)) !== null) {
    appendInline(wrapper, text.slice(cursor, match.index), sources);
    const language = match[1].trim();
    const code = h('pre', { class: 'chunk' }, h('code', { text: match[2].replace(/\n$/, '') }));
    if (language) code.dataset.language = language;
    wrapper.append(code);
    cursor = match.index + match[0].length;
  }
  appendInline(wrapper, text.slice(cursor), sources);
  return wrapper;
}

/**
 * Render one non-code run, line by line: headings become strong text and list
 * markers become bullets, while inline code, bold and `[citation:N]` links keep
 * their own tokens. Everything stays a DOM text node — no innerHTML.
 */
function appendInline(wrapper, text, sources = []) {
  if (text.length === 0) return;
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (index > 0) wrapper.append(document.createTextNode('\n'));
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) {
      wrapper.append(h('strong', { class: 'md-heading', text: heading[1] }));
      return;
    }
    const bullet = /^\s*[*-]\s+(.*)$/.exec(line);
    appendInlineTokens(wrapper, bullet === null ? line : `• ${bullet[1]}`, sources);
  });
}

function appendInlineTokens(wrapper, text, sources) {
  if (text.length === 0) return;
  const token = /(`[^`\n]+`|\*\*[^*\n]+\*\*|\[citation:(\d+)\])/g;
  let cursor = 0;
  let match;
  while ((match = token.exec(text)) !== null) {
    if (match.index > cursor) wrapper.append(document.createTextNode(text.slice(cursor, match.index)));
    const piece = match[0];
    if (piece.startsWith('`')) wrapper.append(h('code', { class: 'inline', text: piece.slice(1, -1) }));
    else if (piece.startsWith('**')) wrapper.append(h('strong', { text: piece.slice(2, -2) }));
    else {
      const index = Number(match[2]);
      const source = sources[index - 1];
      if (source?.url) {
        wrapper.append(
          h('a', {
            class: 'citation',
            href: source.url,
            target: '_blank',
            rel: 'noreferrer noopener',
            title: source.title || source.url,
            text: String(index),
          }),
        );
      } else {
        wrapper.append(document.createTextNode(piece));
      }
    }
    cursor = match.index + piece.length;
  }
  if (cursor < text.length) wrapper.append(document.createTextNode(text.slice(cursor)));
}

/* -------------------------------------------------------------- rendering */

function renderAccount() {
  // Signed out means the gate is the whole panel: no transcript, no composer.
  showGate(!state.signedIn);
  el.account.classList.toggle('signed-in', state.signedIn);
  el.who.textContent = state.signedIn
    ? state.user?.name || state.user?.email || state.user?.mobile || '已登录'
    : '未登录';
  el.account.title = state.signedIn
    ? state.sameAccount
      ? `与 DSH 是同一个账号（${state.dshAccount?.contact ?? state.dshAccount?.name ?? '已验证'}）`
      : state.dshAccount?.contact
        ? `DSH 已登录的账号是 ${state.dshAccount.contact}`
        : '已登录 chat.deepseek.com'
    : '未登录 chat.deepseek.com';
  el.signIn.hidden = state.signedIn;
  el.signOut.hidden = !state.signedIn;
  const disabled = !state.signedIn;
  el.input.disabled = disabled;
  el.send.disabled = disabled || state.streaming;
  el.attach.disabled = disabled;
  el.pickSession.disabled = disabled;
  el.newChat.disabled = disabled;
  el.history.disabled = disabled || state.sessions.length === 0;
  el.input.placeholder = disabled
    ? '先登录 chat.deepseek.com 账号后再提问…'
    : '问点什么，Enter 发送，Shift+Enter 换行…';
  // A visible build tag: "the panel looks wrong" is usually a stale iframe, and
  // this makes that one glance instead of a conversation.
  const version = state.settings?.version ? `v${state.settings.version}` : '';
  if (version) {
    el.note.textContent = `内容经本机转发到 chat.deepseek.com · ${version}`;
    el.emptyHint.textContent = `Enter 发送 · Shift+Enter 换行 · 面板 ${version}`;
  }
}

function renderToggles() {
  el.thinking.setAttribute('aria-pressed', String(state.thinking));
  el.search.setAttribute('aria-pressed', String(state.search));
}

/**
 * Context chips: three kinds share one rail — a workspace file addressed by path,
 * path, a dropped file whose text the browser read, and a DSH conversation
 * transcript addressed by session id.
 */
const CONTEXT_ICON = { file: '文件', drop: '拖入', session: '会话' };

function renderChips() {
  el.chips.replaceChildren(
    ...state.context.map((item) =>
      h(
        'span',
        { class: `chip chip-${item.kind}`, title: item.hint ?? item.label },
        h('span', { class: 'chip-kind', text: CONTEXT_ICON[item.kind] ?? '内容' }),
        h('span', { text: item.label }),
        h('button', {
          text: '×',
          title: '移除',
          onclick: () => {
            state.context = state.context.filter((entry) => entry !== item);
            renderChips();
          },
        }),
      ),
    ),
  );
}

/** Add one context item, de-duplicated by kind + identity. */
function addContext(item) {
  const key = `${item.kind}:${item.path ?? item.id ?? item.name}`;
  const exists = state.context.some((entry) => `${entry.kind}:${entry.path ?? entry.id ?? entry.name}` === key);
  if (exists) {
    toast('这个内容已经在上下文里了');
    return;
  }
  state.context.push(item);
  renderChips();
}

function resetInputHeight() {
  el.input.style.height = 'auto';
}

function renderEmpty() {
  el.empty.hidden = state.messages.length > 0;
}

function renderTranscript() {
  el.transcript.replaceChildren();
  for (const message of state.messages) el.transcript.append(renderMessage(message));
  el.empty.hidden = state.messages.length > 0;
  scrollToBottom();
}

function renderMessage(message) {
  const bubble = h('div', { class: 'bubble' });
  if (message.text) bubble.append(renderRichText(message.text, message.sources ?? []));
  if (message.pending && !message.text) bubble.append(h('span', { class: 'status-line', text: '正在思考…' }));

  const parts = [];
  if (message.role === 'assistant' && message.thinking) {
    parts.push(
      h(
        'details',
        { class: 'thinking' },
        h('summary', { text: '深度思考' }),
        h('div', { class: 'body', text: message.thinking }),
      ),
    );
  }
  if (message.searchUsed) {
    parts.push(h('div', { class: 'meta' }, h('span', { class: 'tag', text: '已联网搜索' })));
  }
  parts.push(bubble);
  if (message.role === 'assistant' && (message.sources ?? []).length > 0) {
    const list = h('ol', { class: 'sources' });
    for (const source of message.sources) {
      list.append(
        h(
          'li',
          {},
          h('a', { href: source.url, target: '_blank', rel: 'noreferrer noopener', text: source.title || source.url }),
        ),
      );
    }
    parts.push(h('details', { class: 'sources-box' }, h('summary', { text: `来源（${message.sources.length}）` }), list));
  }
  if (message.role === 'assistant' && message.tokens) {
    parts.push(h('div', { class: 'meta' }, h('span', { text: `${message.tokens} tokens` })));
  }
  return h(
    'div',
    { class: `msg ${message.role}${message.error ? ' error' : ''}` },
    h('div', { class: 'role', text: message.role === 'user' ? '我' : 'DeepSeek' }),
    ...parts,
  );
}

function scrollToBottom() {
  el.transcript.scrollTop = el.transcript.scrollHeight;
}

/* ------------------------------------------------------------------- data */

async function refreshStatus() {
  const payload = await request('status');
  state.signedIn = Boolean(payload.signedIn);
  state.user = payload.user ?? null;
  state.workspace = payload.workspace ?? { root: '', name: '' };
  state.settings = payload.settings ?? {};
  state.dshAccount = payload.dshAccount ?? null;
  state.sameAccount = payload.sameAccount === true;
  state.thinking = Boolean(payload.settings?.thinking);
  state.search = Boolean(payload.settings?.search);
  if (payload.settings?.theme) document.documentElement.dataset.theme = payload.settings.theme;
  renderAccount();
  renderToggles();
}

async function refreshSessions() {
  if (!state.signedIn) {
    state.sessions = [];
    el.history.disabled = true;
    return;
  }
  try {
    const payload = await request('sessions');
    state.sessions = payload.sessions ?? [];
    el.history.disabled = state.sessions.length === 0;
  } catch (error) {
    toast(String(error.message ?? error));
  }
}

async function openSession(sessionId) {
  const payload = await request('history', { body: { sessionId } });
  state.sessionId = payload.session?.id ?? sessionId;
  state.messages = (payload.messages ?? []).map((message) => ({
    role: message.role,
    text: message.text,
    thinking: message.thinking,
    tokens: message.accumulatedTokens,
    searchUsed: message.searchEnabled,
  }));
  renderTranscript();
}

function newChat() {
  state.sessionId = null;
  state.messages = [];
  state.context = [];
  renderChips();
  renderTranscript();
  el.input.focus();
}

/* ------------------------------------------------------------------- chat */

async function send() {
  const prompt = el.input.value.trim();
  if (prompt.length === 0 || state.streaming || !state.signedIn) return;

  el.input.value = '';
  resetInputHeight();
  state.streaming = true;
  renderAccount();

  state.messages.push({ role: 'user', text: prompt });
  const assistant = { role: 'assistant', text: '', thinking: '', pending: true };
  state.messages.push(assistant);
  renderTranscript();
  scrollToBottom();

  try {
    const controller = new AbortController();
    const response = await fetch(`${API_BASE}chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: state.sessionId,
        prompt,
        thinking: state.thinking,
        search: state.search,
        paths: state.context.filter((item) => item.kind === 'file').map((item) => item.path),
        inline: state.context.filter((item) => item.kind === 'drop').map((item) => ({ name: item.name, text: item.text })),
        sessions: state.context.filter((item) => item.kind === 'session').map((item) => item.id),
      }),
      signal: controller.signal,
    });
    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => '');
      throw new Error(detail || `HTTP ${response.status}`);
    }
    await consumeStream(response.body, (event) => {
      if (event.type === 'ready') {
        state.sessionId = event.sessionId ?? state.sessionId;
        assistant.pending = true;
      } else if (event.type === 'text') {
        assistant.text += event.text;
        assistant.pending = false;
        repaintAssistant();
      } else if (event.type === 'thinking') {
        assistant.thinking += event.text;
        repaintAssistant();
      } else if (event.type === 'search') {
        assistant.searchUsed = true;
        if (Array.isArray(event.results) && event.results.length > 0) {
          const merged = assistant.sources ?? [];
          for (const source of event.results) {
            if (!merged.some((item) => item.url === source.url)) merged.push(source);
          }
          assistant.sources = merged;
        }
        repaintAssistant();
      } else if (event.type === 'mode') {
        if (event.mode === 'SEARCH') assistant.searchUsed = true;
        repaintAssistant();
      } else if (event.type === 'usage') {
        assistant.tokens = event.tokens;
        repaintAssistant();
      } else if (event.type === 'title' && event.title) {
        state.title = event.title;
      } else if (event.type === 'error') {
        assistant.error = true;
        assistant.text = assistant.text || String(event.message ?? '请求失败');
        repaintAssistant();
      }
    });
    if (!assistant.text && !assistant.error) {
      assistant.text = '（没有收到内容）';
    }
    assistant.pending = false;
    repaintAssistant();
    state.context = [];
    renderChips();
  } catch (error) {
    assistant.pending = false;
    assistant.error = true;
    assistant.text = String(error.message ?? error);
    repaintAssistant();
  } finally {
    state.streaming = false;
    renderAccount();
    refreshSessions().catch(() => {});
  }
}

function repaintAssistant() {
  const index = state.messages.length - 1;
  const node = el.transcript.lastElementChild;
  const fresh = renderMessage(state.messages[index]);
  if (node && node.classList.contains('msg')) node.replaceWith(fresh);
  else el.transcript.append(fresh);
  el.empty.hidden = true;
  scrollToBottom();
}

/** Read `data:`-only SSE frames written by the host route. */
async function consumeStream(body, onEvent) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index = buffer.indexOf('\n\n');
    while (index !== -1) {
      const frame = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of frame.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload.length === 0) continue;
        try {
          onEvent(JSON.parse(payload));
        } catch {
          /* ignore malformed keep-alive frames */
        }
      }
      index = buffer.indexOf('\n\n');
    }
  }
}

/* ------------------------------------------------------------------ modals */

function openModal({ title, body, footer }) {
  el.modalTitle.textContent = title;
  el.modalBody.replaceChildren(...body);
  el.modalFoot.replaceChildren(...footer);
  el.modal.classList.add('open');
}

function closeModal() {
  el.modal.classList.remove('open');
  el.modalBody.replaceChildren();
  el.modalFoot.replaceChildren();
}

/**
 * Click-to-add fallback for the dragged conversation: pick a DSH session from a
 * list instead of dragging it. The Host reads the transcript, so nothing but the
 * id travels from this list.
 */
async function openSessionPicker() {
  const status = h('div', { class: 'status-line', text: '正在读取 DSH 会话…' });
  openModal({
    title: '把 DSH 会话记录加入上下文',
    body: [status],
    footer: [h('button', { text: '关闭', onclick: closeModal })],
  });
  try {
    const query = new URLSearchParams({ limit: '15' });
    if (state.workspace?.root) query.set('cwd', state.workspace.root);
    const payload = await request(`dsh-sessions?${query.toString()}`);
    const list = h('div', { class: 'sessions' });
    const sessions = payload.sessions ?? [];
    if (sessions.length === 0) {
      status.textContent = '这个工作区还没有可读取的 DSH 会话。';
      return;
    }
    for (const session of sessions) {
      list.append(
        h(
          'button',
          {
            onclick: () => {
              addContext({
                kind: 'session',
                id: session.id,
                label: session.title || `会话 ${session.id.slice(0, 8)}`,
                hint: `${session.title ?? session.id} · ${session.messages ?? 0} 条消息`,
              });
              toast('会话原文会作为上下文发给 chat.deepseek.com');
              closeModal();
            },
          },
          h('span', { class: 't', text: session.title || `会话 ${session.id.slice(0, 8)}` }),
          h('span', {
            class: 'd',
            text: `${session.messages ?? 0} 条消息${session.error ? ` · ${session.error}` : ''}`,
          }),
        ),
      );
    }
    status.replaceWith(list);
  } catch (error) {
    status.textContent = `读取失败：${String(error?.message ?? error)}`;
  }
}

function openHistory() {  const list = h('div', { class: 'sessions' });
  for (const session of state.sessions) {
    list.append(
      h(
        'button',
        {
          onclick: async () => {
            closeModal();
            try {
              await openSession(session.id);
            } catch (error) {
              toast(String(error.message ?? error));
            }
          },
        },
        h('span', { class: 't', text: session.title || '(无标题)' }),
        h('span', { class: 'd', text: formatRelative(session.updatedAt) }),
      ),
    );
  }
  if (state.sessions.length === 0) list.append(h('div', { class: 'status-line', text: '还没有历史会话。' }));
  openModal({
    title: '历史会话',
    body: [list],
    footer: [h('button', { text: '关闭', onclick: closeModal })],
  });
}

async function openFilePicker(path = '') {
  state.pickerPath = path;
  const payload = await request(`files?path=${encodeURIComponent(path)}`);
  const list = h('ul', { id: 'file-list' });
  if (path) {
    list.append(
      h(
        'li',
        { class: 'up', onclick: () => openFilePicker(parentOf(path)) },
        h('span', { class: 'icon', text: '↑' }),
        h('span', { class: 'name', text: '返回上级' }),
      ),
    );
  }
  for (const entry of payload.entries ?? []) {
    const row = h(
      'li',
      {
        onclick: () => {
          if (entry.kind === 'directory') openFilePicker(entry.path);
          else togglePicked(entry.path, row);
        },
      },
      h('span', { class: 'icon', text: entry.kind === 'directory' ? '▸' : '·' }),
      h('span', { class: 'name', text: entry.name }),
      h('span', { class: 'size', text: entry.kind === 'directory' ? '' : `${Math.max(1, Math.round((entry.size ?? 0) / 1024))} KB` }),
    );
    if (state.pickerSelection.has(entry.path) || state.context.some((item) => item.path === entry.path)) row.style.background = 'var(--dsw-accent-weak)';
    list.append(row);
  }
  if ((payload.entries ?? []).length === 0) {
    list.append(h('li', {}, h('span', { class: 'name', text: '（空目录）' })));
  }
  const crumbs = h('div', { id: 'path-crumbs', text: `${payload.root ?? ''}/${payload.path ?? ''}` });
  openModal({
    title: '选择工作区文件作为上下文',
    body: [crumbs, list],
    footer: [
      h('button', {
        text: '清空',
        onclick: () => {
          state.context = [];
          state.pickerSelection.clear();
          renderChips();
          closeModal();
        },
      }),
      h('button', {
        class: 'primary',
        text: '完成',
        onclick: () => {
          for (const path of state.pickerSelection) {
            addContext({ kind: 'file', path, label: path.split('/').pop(), hint: path });
          }
          state.pickerSelection.clear();
          renderChips();
          closeModal();
        },
      }),
    ],
  });
}

function togglePicked(path, row) {
  if (state.pickerSelection.has(path)) {
    state.pickerSelection.delete(path);
    row.style.background = '';
  } else {
    state.pickerSelection.add(path);
    row.style.background = 'var(--dsw-accent-weak)';
  }
}

function parentOf(path) {
  const parts = path.split('/').filter(Boolean);
  parts.pop();
  return parts.join('/');
}

/* --------------------------------------------------------- drag and drop */

/**
 * Drag & drop intake.
 *
 * Two payloads matter here:
 *  - `Files`, from Explorer or any OS drag. Electron 44 no longer exposes
 *    `File.path`, so the text is read in the browser and forwarded inline; the
 *    Host never needs a filesystem path.
 *  - `text/plain` carrying a DSH session id, which is what the sidebar's
 *    conversation rows put on the transfer. The Host resolves that transcript
 *    through the session persistence service.
 */
// DSH session ids look like session-<uuid>; accept the bare uuid too.
const SESSION_ID = /^(?:session-)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
let dragDepth = 0;

function dragKinds(event) {
  const types = event.dataTransfer?.types;
  if (!types) return { files: false, text: false };
  return { files: Array.from(types).includes('Files'), text: Array.from(types).includes('text/plain') };
}

/**
 * Pick a drop effect the drag source actually allows.
 *
 * `dropEffect` must be a subset of `effectAllowed`, or the browser cancels the
 * whole drop: DSH's session rows start a `move` drag, so insisting on `copy`
 * turned the cursor into the red "no drop" sign and `drop` never fired.
 */
function compatibleDropEffect(dataTransfer) {
  const allowed = dataTransfer.effectAllowed;
  // We only ever copy data, so prefer `copy` whenever the source permits it;
  // `move` is required only for sources that allow nothing else (DSH's rows).
  if (allowed === 'all' || allowed === 'copy' || allowed === 'copyMove' || allowed === 'copyLink' || allowed === 'uninitialized') {
    return 'copy';
  }
  if (allowed === 'move' || allowed === 'linkMove') return 'move';
  return 'copy';
}

function showDropOverlay(visible) {
  if (el.drop === null) return;
  el.drop.classList.toggle('open', visible);
}

async function addDroppedFile(file) {
  const max = Number(state.settings?.maxFileBytes ?? 200_000);
  if (file.size === 0) {
    toast(`${file.name} 是空文件`);
    return;
  }
  if (file.size > max) {
    toast(`${file.name} 超过 ${Math.round(max / 1024)} KB 上限`);
    return;
  }
  let text;
  try {
    text = await file.text();
  } catch (error) {
    toast(`读不到 ${file.name}：${String(error?.message ?? error)}`);
    return;
  }
  if (text.includes('\u0000')) {
    toast(`${file.name} 看起来是二进制文件，只支持文本`);
    return;
  }
  addContext({
    kind: 'drop',
    name: file.name,
    text,
    label: file.name,
    hint: `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB（拖入）`,
  });
}

async function addDroppedSession(id) {
  try {
    const preview = await request('session-preview', { body: { id } });
    addContext({
      kind: 'session',
      id,
      label: preview.title ?? `会话 ${id.slice(0, 8)}`,
      hint: `${preview.title ?? id} · ${preview.messages} 条消息 · ${Math.round((preview.bytes ?? 0) / 1024)} KB`,
    });
    toast('会话原文会作为上下文发给 chat.deepseek.com');
  } catch (error) {
    toast(`无法读取这个会话：${String(error?.message ?? error)}`);
  }
}

document.addEventListener('dragenter', (event) => {
  const kinds = dragKinds(event);
  if (!kinds.files && !kinds.text) return;
  event.preventDefault();
  dragDepth += 1;
  showDropOverlay(true);
});

document.addEventListener('dragover', (event) => {
  const kinds = dragKinds(event);
  if (!kinds.files && !kinds.text) return;
  // Cancelling the default is what makes this element a drop target at all;
  // the effect then has to agree with what the drag source permits.
  event.preventDefault();
  const dataTransfer = event.dataTransfer;
  if (dataTransfer) {
    dataTransfer.dropEffect = compatibleDropEffect(dataTransfer);
    document.body.dataset.dragEffect = `${dataTransfer.effectAllowed}->${dataTransfer.dropEffect}`;
  }
  showDropOverlay(true);
});

document.addEventListener('dragleave', (event) => {
  const kinds = dragKinds(event);
  if (!kinds.files && !kinds.text) return;
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) showDropOverlay(false);
});

document.addEventListener('drop', (event) => {
  const kinds = dragKinds(event);
  if (!kinds.files && !kinds.text) {
    // Record what did arrive: without it, "drag does nothing" is hard to tell
    // apart from "the drag never reached the iframe".
    const types = event.dataTransfer ? Array.from(event.dataTransfer.types) : [];
    document.body.dataset.dropTypes = types.join(',') || '(none)';
    if (types.length > 0) toast(`拖拽内容类型 ${types.join(' / ')} 暂不支持`);
    return;
  }
  event.preventDefault();
  dragDepth = 0;
  showDropOverlay(false);
  document.body.dataset.dropTypes = Array.from(event.dataTransfer?.types ?? []).join(',');
  if (!state.signedIn) {
    toast('先登录 chat.deepseek.com 账号');
    return;
  }
  if (kinds.files && (event.dataTransfer?.files?.length ?? 0) > 0) {
    for (const file of event.dataTransfer.files) {
      addDroppedFile(file).catch((error) => toast(String(error?.message ?? error)));
    }
    return;
  }
  const text = event.dataTransfer.getData('text/plain').trim();
  if (SESSION_ID.test(text)) {
    addDroppedSession(text).catch((error) => toast(String(error?.message ?? error)));
    return;
  }
  if (text.length > 0 && PATH_LIKE.test(text)) {
    // A file row dragged out of DSH's own tree carries its workspace path.
    addContext({
      kind: 'file',
      path: text,
      label: text.split(/[\\/]/u).pop() ?? text,
      hint: text,
    });
    return;
  }
  if (text.length > 0) {
    // Anything else (a text selection, or a tree row's opaque id) goes into the
    // composer so the user can see and edit what arrived.
    insertIntoComposer(text);
    return;
  }
  toast('这个拖拽内容暂不支持，试试拖文件或侧边栏的会话');
});

/** A single-line, path-shaped string: safe to treat as a workspace path. */
const PATH_LIKE = /^[\w.@~+$()\- \\/]{2,400}$/u;

function insertIntoComposer(text) {
  const start = el.input.selectionStart ?? el.input.value.length;
  const end = el.input.selectionEnd ?? start;
  const before = el.input.value.slice(0, start);
  const after = el.input.value.slice(end);
  el.input.value = `${before}${text}${after}`;
  el.input.selectionStart = el.input.selectionEnd = start + text.length;
  el.input.focus();
  el.input.dispatchEvent(new Event('input'));
}

/* ------------------------------------------------------------------- wire */

/**
 * One successful sign-in.
 * @param {{user?: object}} payload Reply from `/api/login`.
 */
async function gateSignedIn(payload) {
  gate.token.value = '';
  gate.status.textContent = '';
  state.signedIn = true;
  state.user = payload.user ?? null;
  renderAccount();
  await refreshSessions();
  toast(t('welcome'));
}

/** The pasted userToken is the only sign-in input. */
async function submitGateToken() {
  const token = parsePastedToken(gate.token.value);
  if (token.length === 0) {
    gate.status.textContent = t('missingToken');
    return;
  }
  gate.status.textContent = t('verifying');
  try {
    const payload = await request('login', { body: { token } });
    await gateSignedIn(payload);
  } catch (error) {
    gate.status.textContent = String(error?.message ?? error);
  }
}

gate.submit.addEventListener('click', () => {
  submitGateToken().catch((error) => {
    gate.status.textContent = String(error?.message ?? error);
  });
});
// Ctrl+Enter submits without leaving the textarea.
gate.token.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submitGateToken();
});
gate.browser.addEventListener('click', () => {
  // The shell turns a new-window request into `shell.openExternal`, so this opens
  // the real site in the system browser, where every official sign-in method works.
  try {
    window.open('https://chat.deepseek.com/', '_blank', 'noopener,noreferrer');
    gate.status.textContent = '';
    gate.token.focus();
    toast(t('opened'));
  } catch (error) {
    gate.status.textContent = String(error?.message ?? error);
  }
});
for (const [button, lang] of [
  [gate.langZh, 'zh'],
  [gate.langEn, 'en'],
]) {
  button.addEventListener('click', () => {
    state.lang = lang;
    try {
      window.localStorage.setItem('dsw-chat-lang', lang);
    } catch {
      /* storage may be unavailable */
    }
    renderGate();
  });
}

function autoready() {
  el.input.style.height = 'auto';
}

el.input.addEventListener('input', () => {
  el.input.style.height = 'auto';
  el.input.style.height = `${Math.min(el.input.scrollHeight, 180)}px`;
});

el.input.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    send();
  }
});

el.send.addEventListener('click', send);
// The gate is the only sign-in surface; this button just re-reveals it.
el.signIn.addEventListener('click', () => showGate(true));
el.signOut.addEventListener('click', async () => {
  try {
    await request('logout', { body: {} });
    state.signedIn = false;
    state.user = null;
    state.messages = [];
    state.sessionId = null;
    renderAccount();
    renderTranscript();
    refreshSessions().catch(() => {});
    toast('已退出');
  } catch (error) {
    toast(String(error.message ?? error));
  }
});
el.newChat.addEventListener('click', newChat);
el.history.addEventListener('click', openHistory);
el.attach.addEventListener('click', () => {
  state.pickerSelection.clear();
  openFilePicker('').catch((error) => toast(String(error.message ?? error)));
});
el.pickSession.addEventListener('click', () => {
  openSessionPicker().catch((error) => toast(String(error.message ?? error)));
});
el.thinking.addEventListener('click', () => {
  state.thinking = !state.thinking;
  renderToggles();
});
el.search.addEventListener('click', () => {
  state.search = !state.search;
  renderToggles();
});
el.modal.addEventListener('click', (event) => {
  if (event.target === el.modal) closeModal();
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeModal();
});

/* ------------------------------------------------------------------- boot */

(function applyThemeFromQuery() {
  const theme = new URLSearchParams(window.location.search).get('theme');
  if (theme === 'dark' || theme === 'light') document.documentElement.dataset.theme = theme;
})();

(async function boot() {
  document.body.dataset.boot = 'started';
  renderAccount();
  renderToggles();
  renderChips();
  renderTranscript();
  try {
    await refreshStatus();
    document.body.dataset.boot = `status:${state.signedIn ? 'signed-in' : 'signed-out'}`;
    await refreshSessions();
    // Deep link: ?session=<id> opens an existing conversation.
    const requested = new URLSearchParams(window.location.search).get('session');
    if (state.signedIn && requested) await openSession(requested);
    // Signed out shows the gate; `renderAccount` already did, this re-focuses it.
    showGate(!state.signedIn);
  } catch (error) {
    document.body.dataset.boot = `failed:${String(error?.message ?? error).slice(0, 120)}`;
    toast(String(error.message ?? error));
  }
})();
