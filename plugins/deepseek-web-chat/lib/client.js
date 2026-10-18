/**
 * `dsh-deepseek-web-chat` — Client half.
 *
 * Declares one right-sidebar tab type ("DeepSeek Chat") whose body is an iframe
 * onto the panel page the Host half serves at `/deepseek-web/`. The tab gets
 * docking, floating, splitting and fullscreen from the sidebar for free.
 */
window.__ModuleLoader__.load({
  id: 'dsh-deepseek-web-chat',
  factory: (require) => {
    const module = { exports: {} };
    const exports = module.exports;
    const react = require('react');
    const jsxRuntime = require('react/jsx-runtime');

    /** Tab type identity; it doubles as the Slot dispatch key. */
    const TAB_ID = 'dsh-deepseek-web-chat/tab';
    /** Kind the guide entry opens. */
    const TAB_KIND = 'deepseek-chat';
    /** Where the Host half serves the panel document. */
    const PANEL_URL = '/deepseek-web/';

    const STYLE_ID = 'dsh-deepseek-web-chat/frame.css';
    const CSS = [
      '.dswc-frame-wrap{display:flex;flex-direction:column;flex:auto;height:100%;min-height:0;min-width:0;background:transparent}',
      '.dswc-frame{display:flex;flex:auto;width:100%;min-height:0;border:0;background:transparent;color-scheme:normal}',
    ].join('\n');

    /** Inject the panel stylesheet once per document. */
    function ensureStyle() {
      if (typeof document === 'undefined') return;
      if (document.querySelector(`style[data-plugin-css="${STYLE_ID}"]`) !== null) return;
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-deepseek-web-chat';
      tag.dataset.pluginCss = STYLE_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
    }

    /**
     * The tab body: a full-bleed iframe. The panel owns its own layout and
     * scroll containers, so this component deliberately reads no slot props.
     */
    function DeepSeekChatPanel() {
      ensureStyle();
      // Carry the shell's colour scheme into the panel document so the two do
      // not disagree when the OS preference differs from the app's theme.
      const dark =
        typeof document !== 'undefined' &&
        (document.body?.hasAttribute('data-ds-dark-theme') === true ||
          document.documentElement?.dataset?.theme === 'dark');
      return jsxRuntime.jsx('div', {
        className: 'dswc-frame-wrap',
        children: jsxRuntime.jsx('iframe', {
          className: 'dswc-frame',
          src: `${PANEL_URL}?theme=${dark ? 'dark' : 'light'}`,
          title: 'DeepSeek Chat',
          allow: 'clipboard-write',
        }),
      });
    }

    /** Services this client half needs. */
    const inject = ['slots', 'sidebarRight', 'sidebarRightTabs'];

    /**
     * Register the tab type, its guide entry, and its body.
     * @param {object} ctx Client plugin context.
     */
    function apply(ctx) {
      ctx.effect(
        () =>
          ctx.sidebarRightTabs.register({
            id: TAB_ID,
            kind: TAB_KIND,
            priority: 'extension',
            title: () => 'DeepSeek Chat',
            guide: [
              {
                id: 'open',
                order: 40,
                title: () => 'DeepSeek Chat',
                description: () => '用当前工作区内容向 chat.deepseek.com 提问',
              },
            ],
          }),
        'deepseek-web-chat: tab type',
      );

      ctx.effect(
        () =>
          ctx.slots.inject('sidebar.right.pane.tab', () =>
            ctx.slots.register(
              {
                name: 'sidebar.right.pane.tab',
                key: TAB_ID,
              },
              DeepSeekChatPanel,
            ),
          ),
        'deepseek-web-chat: tab body',
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
