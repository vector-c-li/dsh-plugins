# Writing a DSH plugin

[中文](writing-a-plugin.zh-CN.md) · English

Everything here comes from building [`plugins/deepseek-web-chat`](../plugins/deepseek-web-chat) against
DSH `0.2.x` on Windows. It is a working recipe, not an API reference.

## The two halves

A DSH plugin is one npm package with two independent halves, plus a patch that tells the loader about
the Host half.

| Half | File | Runs in | Registers |
|---|---|---|---|
| **Host** | `lib/index.js` → `lib/host/*` | the DSH Host process (Node) | services, HTTP routes, credentials, long-running work |
| **Browser** | `lib/client.js` | the DSH web UI (a ModuleLoader bundle) | slots, tab types, settings pages — anything the user sees |
| **Bundle patch** | `cordis.patch.yml` | the loader | the Host row itself (`insert: [{ id, name, config }]`) |

They talk over HTTP: the browser half renders a view that calls the Host's route on
`http://127.0.0.1:<port>/<prefix>/…`.

```jsonc
// package.json
{
  "name": "dsh-my-plugin",
  "type": "module",
  "exports": { ".": "./lib/index.js", "./client": "./lib/client.js", "./cordis.patch.yml": "./cordis.patch.yml" },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right", "@deepseek-ai/dsh-client-ui-slots"] }
  }
}
```

## Host half

```js
// lib/index.js — the stable entry
export const name = 'my-plugin';
export const inject = ['webServer']; // hard dependencies
export async function apply(ctx, config) {
  ctx.effect(() => {
    const off = ctx.get('webServer').register({ kind: 'prefix', path: '/my-prefix', handler });
    return () => off();
  });
}
```

Three things that cost me hours:

1. **Do not also `export default apply`** — a default export overrides the named `inject`, and the
   Host then fails with `cannot get property "webServer" without inject`.
2. **Late-bind optional services.** `ctx.get('credentials')` can be `undefined` while the plugin
   mounts; resolve it inside the handler (`() => ctx.get('connection')`) instead of capturing it at
   mount time. Ours returned `undefined` once and made an authenticated API silently public.
3. **Node caches ES modules by URL.** Editing `lib/index.js` on disk does not reload anything. Keep a
   thin, stable `index.js` that dynamic-imports the real implementation with a revision:

```js
export async function apply(ctx, config) {
  const revision = Date.now();
  const impl = await import(`./host/main.js?rev=${revision}`);
  impl.mount(ctx, config, revision);
}
```

…and have `main.js` import its siblings with the same `?rev=` so the whole subtree refreshes.
Bumping the `?v=` query on the *loader row* is what makes the Host re-read `index.js` in the first
place.

## Browser half

`lib/client.js` is a single `window.__ModuleLoader__.load({ id, factory: (require) => … })` call. Only
a fixed set of specifiers may be required: `react`, `react/jsx-runtime`, `react-dom`,
`react-dom/client`, `@deepseek-ai/cordis`, `@deepseek-ai/dsh-client-store`, `-ui-slots`,
`-ui-primitives`, `-ui-dockkit`. CSS is injected by hand as a `<style data-plugin data-plugin-css>`.

A sidebar tab needs two registrations:

```js
ctx.sidebarRightTabs.register({ id: 'my-plugin/tab', kind: 'my-kind', title: 'My plugin', guide: … });
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'my-plugin/tab' }, Panel);
```

The simplest reliable body is an `<iframe src="/<prefix>/?theme=…">` pointing at the Host route: you
get a normal web app (own CSS, own reload) without fighting the UI framework.

## Reload workflow

| Change | How to see it |
|---|---|
| `lib/web/*` (panel HTML/CSS/JS) | Reload the iframe (`Ctrl+R` on the panel) — served from disk per request |
| `lib/host/*` | Bump the row's `?v=` (or the plugin id), toggle the plugin off/on |
| `lib/client.js` | Toggle the plugin, then refresh the DSH page |
| Everything, cleanly | Restart DSH |

Add a build tag (`v0.5.1`) somewhere visible in the panel so "is this the new code?" is one glance and
not a conversation.

## Testing pyramid

1. **`node --check`** on every file you touch — four of my bugs were syntax errors found in a second.
2. **Offline unit tests** (`scripts/selftest.mjs`): pure functions — parsers, the PoW solver, the
   context builder. No network, no DSH.
3. **Route smoke** (`scripts/route-smoke.mjs`): register the routes against a fake `ctx` with a fake
   `webServer` and fake `credentials`, then hit them with `fetch`. This is where auth, traversal
   refusals and SSE framing get tested.
4. **Client smoke** (`scripts/client-smoke.mjs`): a fake `window.__ModuleLoader__` that records the
   registration, so a broken bundle fails in CI instead of in the sidebar.
5. **Live check** (`scripts/live-check.mjs`): mint the browser cookie from
   `$DSH_HOME/.credentials.yaml` (`client-connection/browser-session` secret, HMAC over
   `{version, authority, issuedAt, expiresAt}`) and assert the real host serves and refuses correctly.

## Privacy checklist before the first commit

- No absolute home paths (`C:\Users\<name>`, `/home/<name>`) — use `$DSH_HOME`, `$env:USERPROFILE`,
  `<abs path>` placeholders.
- No account identifiers, even masked ones: emails, phones, user ids, session ids.
- No tokens, cookies, or `.credentials.yaml` content — grep for the first 8 characters of any token
  you pasted while testing.
- No screenshots of a signed-in panel or of real conversations; retake them with demo data or drop
  them.
- Vendor binaries and large assets: fetch with a script, keep them in `.gitignore`.
- State plainly in the README what the plugin stores and what leaves the machine.

## Distribution

The plugin is distributed as a git checkout that the user links into their profile:

```powershell
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-my-plugin" "<path to plugin>"
```

with `"dsh-my-plugin": "link:<path to plugin>"` in `profiles/desktop/package.json` and a matching
`insert` row in `profiles/desktop/cordis.patch.yml`. Keep the *bundle* patch inside the plugin so
`dsh.bundle.patch` stays the single source of truth for the row.
