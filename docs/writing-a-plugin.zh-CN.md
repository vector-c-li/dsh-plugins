# 怎么写一个 DSH 插件

中文 · [English](writing-a-plugin.md)

这里的每一条都来自在 Windows 上对着 DSH `0.2.x` 写 [`plugins/deepseek-web-chat`](../plugins/deepseek-web-chat)
的过程。它是一份能跑通的配方，不是 API 手册。

## 两半结构

一个 DSH 插件就是一个 npm 包，包含两半互不依赖的部分，外加一份告诉加载器「Host 行在哪」的补丁。

| 半 | 文件 | 跑在哪 | 负责注册 |
|---|---|---|---|
| **Host 半** | `lib/index.js` → `lib/host/*` | DSH Host 进程（Node） | 服务、HTTP 路由、凭据、长任务 |
| **浏览器半** | `lib/client.js` | DSH Web UI（ModuleLoader bundle） | 插槽、标签页类型、设置页 —— 一切用户看得见的东西 |
| **Bundle 补丁** | `cordis.patch.yml` | 加载器 | Host 行本身（`insert: [{ id, name, config }]`） |

两半通过 HTTP 通信：浏览器半渲染的视图去调用 Host 在 `http://127.0.0.1:<端口>/<前缀>/…` 上的路由。

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

## Host 半

```js
// lib/index.js —— 稳定的入口
export const name = 'my-plugin';
export const inject = ['webServer']; // 硬依赖
export async function apply(ctx, config) {
  ctx.effect(() => {
    const off = ctx.get('webServer').register({ kind: 'prefix', path: '/my-prefix', handler });
    return () => off();
  });
}
```

三个坑，每个都花了我不止一小时：

1. **不要同时 `export default apply`** —— 默认导出会盖掉具名 `inject`，Host 随即报
   `cannot get property "webServer" without inject`。
2. **可选服务要延迟取。** 插件挂载时 `ctx.get('credentials')` 可能还是 `undefined`；要在处理函数里
   现取（`() => ctx.get('connection')`），而不是挂载时把它存下来。我就这么让一个本该鉴权的接口
   悄悄变成了公开接口。
3. **Node 按 URL 缓存 ES 模块。** 直接改磁盘上的 `lib/index.js` 不会重载任何东西。做法是留一个
   稳定的薄入口，按版本号动态 import 真正的实现：

```js
export async function apply(ctx, config) {
  const revision = Date.now();
  const impl = await import(`./host/main.js?rev=${revision}`);
  impl.mount(ctx, config, revision);
}
```

……并让 `main.js` 用同一个 `?rev=` 去 import 同级模块，整棵子树才会一起刷新。而真正让 Host 重新
读取 `index.js` 的，是**加载器行**上那个 `?v=` 参数被改掉。

## 浏览器半

`lib/client.js` 就是一个 `window.__ModuleLoader__.load({ id, factory: (require) => … })` 调用。
只能 require 固定的一组模块：`react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、
`@deepseek-ai/cordis`、`@deepseek-ai/dsh-client-store`、`-ui-slots`、`-ui-primitives`、`-ui-dockkit`。
CSS 要自己注入成 `<style data-plugin data-plugin-css>`。

一个侧边栏标签页需要两次注册：

```js
ctx.sidebarRightTabs.register({ id: 'my-plugin/tab', kind: 'my-kind', title: 'My plugin', guide: … });
ctx.slots.register({ name: 'sidebar.right.pane.tab', key: 'my-plugin/tab' }, Panel);
```

最省心也最可控的视图体，是一个指向 Host 路由的 `<iframe src="/<前缀>/?theme=…">`：
你得到一个普通 Web 应用（自己的 CSS、自己的刷新），不用和 UI 框架较劲。

## 改完怎么生效

| 改动 | 怎么看到 |
|---|---|
| `lib/web/*`（面板 HTML/CSS/JS） | 重载 iframe（面板里 `Ctrl+R`）—— 每次请求都从磁盘读 |
| `lib/host/*` | 改行里的 `?v=`（或改插件 id），再把插件关掉/打开 |
| `lib/client.js` | 关掉/打开插件，然后刷新 DSH 页面 |
| 全部、彻底 | 重启 DSH |

在面板里放一个构建标记（如 `v0.5.1`），这样"这是新代码吗"只需一眼，而不是一轮对话。

## 测试分层

1. **`node --check`** 每个改过的文件 —— 我有四个 bug 是一秒内就被它抓到的语法错误。
2. **离线单测**（`scripts/selftest.mjs`）：纯函数 —— 解析器、PoW 求解、上下文拼接。不碰网络和 DSH。
3. **路由冒烟**（`scripts/route-smoke.mjs`）：用假的 `ctx`（假 `webServer`、假 `credentials`）注册路由，
   再用 `fetch` 打它们。鉴权、目录穿越拒绝、SSE 分帧都在这里测。
4. **客户端冒烟**（`scripts/client-smoke.mjs`）：假的 `window.__ModuleLoader__` 记录注册结果，
   这样 bundle 坏了会在测试里失败，而不是在侧边栏里。
5. **实机检查**（`scripts/live-check.mjs`）：用 `$DSH_HOME/.credentials.yaml` 里的
   `client-connection/browser-session` 密钥，对 `{version, authority, issuedAt, expiresAt}` 做 HMAC
   自签一个浏览器 cookie，然后验证真实 Host 既能服务、也能正确拒绝。

## 首次提交前的隐私清单

- 不放绝对家目录路径（`C:\Users\<名字>`、`/home/<名字>`）—— 用 `$DSH_HOME`、`$env:USERPROFILE`、
  `<abs path>` 占位。
- 不放账号标识，哪怕是打码的：邮箱、手机号、用户 id、会话 id。
- 不放 token、cookie、`.credentials.yaml` 内容 —— 拿你测试时贴过的 token 前 8 位去 grep 一遍。
- 不放已登录面板、真实对话的截图；需要就换成演示数据重拍，或者干脆不放。
- 厂商二进制与大文件：用脚本下载，写进 `.gitignore`。
- 在 README 里明确写：插件存了什么、什么会离开你的机器。

## 分发方式

插件的分发形态是"一份 git 检出，用户把它链进自己的 profile"：

```powershell
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-my-plugin" "<插件路径>"
```

同时在 `profiles/desktop/package.json` 里写 `"dsh-my-plugin": "link:<插件路径>"`，
并在 `profiles/desktop/cordis.patch.yml` 里加对应的 `insert` 行。把 *bundle* 补丁留在插件内部，
让 `dsh.bundle.patch` 始终是那一行的唯一来源。
