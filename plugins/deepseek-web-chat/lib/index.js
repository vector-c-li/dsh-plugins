/**
 * `dsh-deepseek-web-chat` — a DeepSeek Chat side panel for DSH.
 *
 * This entry is a deliberately thin, stable shim: the whole implementation lives
 * in `./host/main.js` and is loaded through a cache-busted dynamic import, so a
 * plugin reload (HMR or the Plugins page) always picks up the current sources
 * even though Node caches ES modules per URL.
 *
 * @module dsh-deepseek-web-chat
 */

export const name = 'deepseek-web-chat';

/** Both services must exist before the panel can work. */
export const inject = ['credentials', 'webServer'];

/**
 * Import the implementation and mount it on the given context.
 * @param {import('@deepseek-ai/cordis').Context} ctx Plugin context.
 * @param {object} [config] Loader row config.
 */
export async function apply(ctx, config = {}) {
  const url = new URL('./host/main.js', import.meta.url);
  url.searchParams.set('rev', String(Date.now()));
  const implementation = await import(url.href);
  return implementation.mount(ctx, config);
}
