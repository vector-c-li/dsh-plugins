/**
 * Implementation of the DeepSeek Chat side panel.
 *
 * Kept behind the `lib/index.js` shim so edits here can be picked up by a plugin
 * reload without restarting the application.
 */
import { fileURLToPath } from 'node:url';

// Imported through this module's own revision so a plugin reload sees edited
// sources rather than Node's cached modules.
const REV = new URL(import.meta.url).searchParams.get('rev') ?? '';
const load = (specifier) => import(new URL(`${specifier}${REV ? `?rev=${REV}` : ''}`, import.meta.url).href);
const [{ createService }, { registerRoutes }] = await Promise.all([load('./service.js'), load('./routes.js')]);

const DEFAULTS = {
  routePrefix: '/deepseek-web',
  baseUrl: 'https://chat.deepseek.com',
  locale: 'zh_CN',
  theme: '',
  defaultThinking: false,
  defaultSearch: false,
  workspaceRoot: '',
  maxFileBytes: 200_000,
  maxContextBytes: 400_000,
  sessionPageSize: 30,
};

/** Absolute path of the vendored proof-of-work module. */
const DEFAULT_WASM = fileURLToPath(new URL('../../assets/sha3_wasm_bg.wasm', import.meta.url));

export function resolveConfig(raw) {
  const input = raw ?? {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new Error('deepseek-web-chat: config must be an object');
  const config = { ...DEFAULTS, ...input, wasmPath: input.wasmPath ?? DEFAULT_WASM };

  if (typeof config.routePrefix !== 'string' || !config.routePrefix.startsWith('/')) {
    throw new Error('deepseek-web-chat: routePrefix must start with "/"');
  }
  config.routePrefix = config.routePrefix.replace(/\/+$/, '') || '/deepseek-web';
  if (typeof config.baseUrl !== 'string' || !/^https?:\/\//u.test(config.baseUrl)) {
    throw new Error('deepseek-web-chat: baseUrl must be an http(s) URL');
  }
  if (config.locale !== 'zh_CN' && config.locale !== 'en_US') {
    throw new Error('deepseek-web-chat: locale must be "zh_CN" or "en_US"');
  }
  for (const field of ['maxFileBytes', 'maxContextBytes', 'sessionPageSize']) {
    if (!Number.isInteger(config[field]) || config[field] <= 0) {
      throw new Error(`deepseek-web-chat: ${field} must be a positive integer`);
    }
  }
  // The web API rejects a page size below 2 ("ILLEGAL_COUNT").
  config.sessionPageSize = Math.min(Math.max(config.sessionPageSize, 2), 100);
  return config;
}

/**
 * Build the account service and publish the HTTP route.
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context.
 * @param {object} [rawConfig] Loader row config.
 */
export function mount(ctx, rawConfig = {}) {
  const config = resolveConfig(rawConfig);
  const logger = typeof ctx.logger === 'function' ? ctx.logger('deepseek-web') : console;

  const webServer = ctx.get('webServer');
  if (webServer === undefined) {
    throw new Error('deepseek-web-chat: this profile has no web server, so the side panel has nothing to attach to');
  }

  const service = createService({ ctx, config, logger });
  // Resolved per request, not captured: the connection service can be provided
  // after this plugin mounts, and a captured `undefined` silently disabled the
  // panel's admission check.
  let dispose;
  try {
    dispose = registerRoutes(webServer, service, logger, config, () => ctx.get('connection'));
  } catch (error) {
    // Route ownership is a composition contract: two enabled copies of this
    // plugin (a local development row next to the installed bundle) cannot share
    // one prefix. Say that plainly instead of letting the row fail with a bare
    // "duplicate prefix route".
    if (!/duplicate .*route/iu.test(String(error?.message ?? ''))) throw error;
    logger.warn(
      `${config.routePrefix} is already served by another row, so this row stays inactive. ` +
        'Disable one of them — a local development row and the installed bundle cannot both be enabled — then reload. ' +
        String(error.message),
    );
    return;
  }
  ctx.effect(() => () => {
    dispose();
  });

  logger.info?.(`DeepSeek Chat panel mounted at ${config.routePrefix}/`);
}
