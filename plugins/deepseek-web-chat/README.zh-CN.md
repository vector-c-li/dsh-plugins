# DeepSeek Chat · DSH 插件

中文 · [English](README.md)

一个 **DSH**（DeepSeek Harness）插件：在右侧边栏里加一个 chat.deepseek.com 面板，
不离开 DSH 就能问网页版，并且可以把当前工作区的文件、或者一条 DSH 会话记录带上当作上下文。

属于 [`dsh-plugins`](https://github.com/vector-c-li/dsh-plugins) 插件集合。

![登录页](docs/gate-zh.png)

## 它能做什么

| | |
|---|---|
| **侧边栏标签页** | 在 DSH 右侧边栏注册 `DeepSeek Chat`（侧栏 `+` 菜单里可见）。 |
| **用你自己的账号** | 用你的 `userToken` 直连 `chat.deepseek.com`；不需要 API Key，没有代理，没有第三方服务器。 |
| **深度思考 / 联网搜索** | 两个开关，对应网页版的 `深度思考` 与 `联网搜索`。 |
| **工作区上下文** | 从工作区挑文件（或拖进来）作为提示词的一部分。 |
| **DSH 会话上下文** | 拖一条侧边栏会话进来（或用 `会话` 按钮）；Host 读转录并折进提示词。 |
| **历史会话** | 浏览并继续网页版已有的对话。 |
| **中英双语登录页** | 登录前整屏只有登录页，带四步图文指引，可切换中/英。 |

## 环境要求

- DSH，使用 **desktop** profile（侧边栏标签页依赖 `@deepseek-ai/dsh-client-ui-sidebar-right`）；
- 一个 `chat.deepseek.com` 账号。

## 安装

### 快路径：把一段 spec 粘进 DSH

打开 DSH 的 **插件 → 添加插件**，粘贴：

```
github:vector-c-li/dsh-plugins#path:/plugins/deepseek-web-chat
```

DSH 会读出 spec 指向什么、用 pnpm 装好、并把它作为组合包启用。然后刷新 DSH 页面
（侧栏标签页没出现就重启一次），从侧边栏 `+` 菜单打开 **DeepSeek Chat**。

同一段 spec 也能在终端用，但命令行只负责装包 —— 装完要在插件页把它启用：

```powershell
dsh plugin --profile desktop add "github:vector-c-li/dsh-plugins#path:/plugins/deepseek-web-chat"
```

包括工作量证明模块在内，其余东西都会在首次使用时自动取回（缓存在
`$DSH_HOME/cache/deepseek-web-chat/`）。想升级就再装一次同一段 spec —— git 安装是一个快照，
重新安装才会拉到新提交。

### 手动方式（开发用）

#### 1. 克隆

```powershell
git clone https://github.com/vector-c-li/dsh-plugins.git "$env:USERPROFILE\dsh-plugins"
```

```bash
git clone https://github.com/vector-c-li/dsh-plugins.git ~/dsh-plugins
```

插件位于 `<clone>/plugins/deepseek-web-chat`。

#### 2. 取回 PoW 模块（可选）

git 安装会按需自动下载，所以这一步只在离线机器、或者你想让本地检出里就带着它时才需要
（见[第三方资源](#第三方资源)）：

```powershell
node plugins\deepseek-web-chat\scripts\fetch-wasm.mjs
```

脚本从 `fe-static.deepseek.com` 取 `assets/sha3_wasm_bg.wasm`（约 26 KB）。
本地没有这份拷贝时，Host 会在第一次挑战时把它下到 `$DSH_HOME/cache/deepseek-web-chat/`。

#### 3. 注册到 DSH profile

编辑 `$DSH_HOME/profiles/desktop/package.json`（Windows 下是 `C:\Users\<你>\.dsh\profiles\desktop`）：

```json
{
  "dsh": { "profile": { "bundles": ["...", "dsh-deepseek-web-chat"] } },
  "dependencies": {
    "dsh-deepseek-web-chat": "link:<plugins/deepseek-web-chat 的绝对路径>"
  }
}
```

然后把插件链进 profile 的 `node_modules`，Windows 用目录联接即可：

```powershell
cmd /c mklink /J "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-deepseek-web-chat" "$env:USERPROFILE\dsh-plugins\plugins\deepseek-web-chat"
```

macOS / Linux 改用符号链接：

```bash
ln -s ~/dsh-plugins/plugins/deepseek-web-chat ~/.dsh/profiles/desktop/node_modules/dsh-deepseek-web-chat
```

最后在 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 里加 Host 行：

```yaml
- insert:
    - id: deepseek-web-chat
      name: "file:///<plugins/deepseek-web-chat 的绝对路径>/lib/index.js"
      config:
        locale: zh_CN
```

重启 DSH（或在 Plugins 页把插件关掉再打开）。

#### 4. 验证并登录

- 打开 `http://127.0.0.1:<dsh 端口>/deepseek-web/`，应看到登录页；
- 或者刷新 DSH，从侧边栏 `+` 菜单打开 **DeepSeek Chat**。

登录只认 `userToken`：面板上用四步图文引导你取，长版本见
[`docs/guide.zh-CN.md`](docs/guide.zh-CN.md)。

## 配置

所有键都可选，写在插件行的 `config` 里。

| 键 | 默认值 | 含义 |
|---|---|---|
| `routePrefix` | `/deepseek-web` | 面板与其 JSON/SSE 接口的 HTTP 前缀。 |
| `baseUrl` | `https://chat.deepseek.com` | 上游站点。 |
| `locale` | `zh_CN` | 发给上游的 `x-client-locale`，也决定指引默认语言。 |
| `theme` | `''` | 强制 `light` / `dark`；留空跟随 DSH。 |
| `thinking` | `false` | 深度思考开关的初始状态。 |
| `search` | `false` | 联网搜索开关的初始状态。 |
| `workspaceRoot` | 第一个 DSH 工作区 | 文件选择器的根目录。 |
| `maxFileBytes` | `200000` | 单个文件内联上限。 |
| `maxContextBytes` | `400000` | 上下文总量上限，超出会截断并标注。 |
| `sessionPageSize` | `30` | 每页会话数（上游限制 2–100）。 |
| `wasmPath` | `assets/sha3_wasm_bg.wasm` | 工作量证明模块。 |

## 上下文怎么进提示词

三种来源共用一条 chip rail：

| chip | 来源 | 进入提示词的方式 |
|---|---|---|
| File | 工作区文件（选择器或拖拽） | Host 读取，内联在 `<file path="…">` 里 |
| Drop | 从系统拖进来的文件 | 浏览器读成文本随请求发送，再内联 |
| Session | DSH 会话（侧栏拖入，或 `会话` 按钮） | Host 折叠最多 40 轮，放进 `<conversation title="…">` |

上下文是**提示词里的文本**，不是上传附件。DSH 会话里的工具调用会被折叠成一行统计，
让长对话仍然可读。

## 开发

```powershell
node scripts/selftest.mjs              # 接口解析、PoW 求解、上下文拼接（离线）
node scripts/client-smoke.mjs          # 客户端 bundle 注册 + 插槽注入（假 loader）
node scripts/route-smoke.mjs           # 用假 ctx 跑 HTTP 面
node scripts/wasm-fallback-check.mjs   # 没有 assets 的安装：下载一次、之后复用
node scripts/live-check.mjs            # 对着运行中的 DSH（自签浏览器 cookie）
node scripts/live-chat.mjs --dsh-session <id>   # 真实提问，打印答案与引用
node scripts/preview.mjs               # 面板 UI 的静态预览服务
```

`live-check.mjs` / `live-chat.mjs` 读 `$DSH_WEB_URL`（或 `DSW_ORIGIN`），并用
`$DSH_HOME/.credentials.yaml` 里的密钥自签 cookie，不会打印任何机密。

改完代码怎么生效：插件行指向 `file://` URL，Node 按 URL 缓存模块，所以要**改掉行里的 `?v=`**
（或改插件 id）再把插件关掉/打开。细节见 [`docs/writing-a-plugin.md`](../../docs/writing-a-plugin.md)。

## 隐私

- **存了什么**：一条凭据记录 `deepseek-web-chat/account`，在 `$DSH_HOME/.credentials.yaml` 里，
  包含 `userToken`、打码后的账号信息和一个设备 id。没有别的。
- **数据发到哪**：只发往 `chat.deepseek.com`。没有遥测、没有统计、没有第三方端点。
- **什么会离开本机**：你的提问，加上你主动附上的上下文。附件或 DSH 会话会把**原文**发给
  `chat.deepseek.com` —— 请按"公开发布"来对待；转录里出现的密钥也会一起发出去。
- **什么留在本机**：工作区文件列表、侧栏会话列表与转录都由本机 Host 读；只有你附上并切片后的
  上下文会发出。
- **退出**会**删除**本地凭证（真的删除，不是只清缓存）。

## 已知限制

- **私有接口**：`/api/v0/*` 是网页版前端自己在用的接口，随时可能变；字段、请求头、PoW 算法都变过。
- **不支持工具调用**：网页版没有 function calling，所以面板没法让 DSH 读文件或跑命令，
  它只是"把提示词发出去、把答案流回来"。
- **账号风险**：用的是你本人的会话，高频自动化可能触发限流或风控；请当成自己用的便捷入口，
  不要拿去当对外服务。
- **必须解 PoW**：每次对话都要解一个 `DeepSeekHashV1` 挑战。求解器在 `lib/host/pow.js`，
  但依赖厂商的 wasm 文件。

## 第三方资源

`assets/sha3_wasm_bg.wasm` 是 DeepSeek 自己的前端模块（来自 `fe-static.deepseek.com`），
只用来按官方客户端的算法解网页版的工作量证明。仓库**不重新分发**它：`.gitignore` 让 `*.wasm`
不进提交，Host 会在首次使用时把它下到 `$DSH_HOME/cache/deepseek-web-chat/`
（也可以用 `scripts/fetch-wasm.mjs` 在本地检出里留一份）。版权归 DeepSeek。

## 许可

插件自身代码使用 [MIT](../../LICENSE)。
