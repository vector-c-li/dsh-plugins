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
| **插入 DSH** | 每条完成的回答下有 **复制** 与 **插入 DSH**：纯文本 markdown 写进 DSH 输入框的光标处，由你自己编辑发送。**绝不自动发送**。 |
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

## 排错

**`组件启用失败 … duplicate prefix route "/deepseek-web"`**
有两行同时启用了、抢同一个 HTTP 前缀 —— 典型情况是之前的本地开发行（`file://…`）和刚装好的组合包都在。
在**插件**页停用其中一个再重载：

- 从检出目录开发：保留 `file://` 那行，把组合包卸掉；
- 从 git 安装：保留组合包，停用（或从 `$DSH_HOME/profiles/desktop/cordis.patch.yml` 删掉）`file://` 那行。

`v0.5.6` 起，这种情况会打印一条可读的警告，而不是让整行启用失败。

**安装时报 `连接 GitHub 超时` / `无法访问 GitHub`**
Host 是通过 **git** 去取 GitHub 的，所以浏览器能开、直连被墙时安装仍会超时。两条出路：

- **配代理**：把 git 指到浏览器在用的那个代理，再用同一段 spec 重试 ——
  `git config --global http.proxy http://127.0.0.1:7897`（端口按你的客户端改；撤销用
  `git config --global --unset http.proxy`）。`~/.npmrc` 里写 `proxy=` / `https-proxy=` 可覆盖
  pnpm 自己的 registry 请求。
- **用压缩包**：本地打一个包，从文件安装，完全不走网络 ——

  ```powershell
  pnpm pack --pack-destination dist        # 在 plugins/deepseek-web-chat 里执行
  ```

  然后把 `<绝对路径>/dist/dsh-deepseek-web-chat-<版本>.tgz` 粘进**添加插件**。压缩包是以副本方式安装的，
  卸载不会动你的源码目录。

**面板能打开，但侧栏没有标签页**
Host 半和浏览器半是分开加载的：把插件关掉再打开，然后刷新 DSH 页面（还不出现就重启一次）。

**`proof-of-work module is missing`**
wasm 会在首次使用时下载到 `$DSH_HOME/cache/deepseek-web-chat/`。这条网络路径不通时，
在插件目录跑 `node scripts/fetch-wasm.mjs`（或把 `wasmPath` 指到本地副本），然后重载。

**升级**
git 安装是快照：再粘一次 spec（或 `dsh plugin --profile desktop add …`）、启用、刷新。

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

## 插入 DSH

每条完成的回答底部有两个动作：**复制** 和 **插入 DSH**。

「插入 DSH」把回答（纯文本 markdown，代码围栏原样保留）写进 DSH 输入框的**光标处**，
写完把光标留在末尾；如果输入框已有内容，会先补一个空行，避免和草稿粘在一起。
**不会自动发送** —— 由你自己过目、编辑、发送，所以回答里即使混进注入指令也无法自行触发工具。

面板与主界面同源，`lib/web/composer-bridge.js` 通过 `window.parent` 直接触达主输入框，
按下列顺序降级，每一级失败都会打印 `composer bridge: …` 说明原因：

| 层级 | 手法 | 何时使用 |
|---|---|---|
| 1 | `element.insertText` | 只有当未来 DSH 在输入元素上暴露该方法时 |
| 2 | 合成 `paste` 事件 | **常规路径**：输入框是 Lexical，这等价于 Ctrl+V，官方粘贴链路 |
| 3 | `execCommand('insertText')` / textarea setter | paste 被忽略时；或输入框是普通 `<textarea>` 时 |
| 4 | 剪贴板 | 找不到输入框、或所有 DOM 层都失败时：复制并弹提示让用户手动粘贴 |

**没有服务/store 层**，这是刻意的：DSH 没有对插件开放草稿写入接口，草稿 store 是按会话
scope 的工厂（`slots.register({ name: 'conversation.session', store })`），`create(scope)`
返回的是另一个实例，写它不会让输入框重渲染。

选择器集中在 `composer-bridge.js` 的 `COMPOSER_SELECTORS` 一个常量里：
`[data-composer-input]` → `[role="textbox"][contenteditable="true"]` → 任意可见可编辑元素。
DSH 自己的类名是 CSS-module 哈希，不作依赖。

## 多选批量插入

任意回答上的 **多选** 会进入多选态：每条完成的回答左侧出现勾选圈，动作行让位，输入框上方浮出
`已选 N 条 · 插入 N 条 · 复制 N 条 · 取消`。用「取消」、`Esc`，或插入/复制完成后自动退出。

选中的回答作为**一整段**插入，按对话顺序（旧的在前）：

- 条与条之间用一个空行 + `---` + 空行分隔；
- 每条可带来源标记 `> 来自 DeepSeek Chat · 第 N 条`（英文 `· #N`），与单条插入一样默认关闭；
- 只选一条时，产出与单条按钮**完全一致**：没有分隔符，序号为 1。

上限在写入前检查，**绝不静默截断**：

| 上限 | 阈值 | 行为 |
|---|---|---|
| 条数 | 超过 8 条 | 先询问：`内容较长，建议分批插入（当前 N 条 / M 字符）`，可选**仍然插入** / **取消** |
| 字符 | 超过 20000 | 同样的询问 |

整批只调用一次 `insertIntoComposer`，所以光标只移动一次，结束后焦点在主输入框。
排序、分隔符、编号与上限都由 `composer-bridge.js` 的 `joinAnswers()` 负责；面板只负责渲染操作条
和把选中项传进去。

## 开发

```powershell
node scripts/selftest.mjs              # 接口解析、PoW 求解、上下文拼接（离线）
node scripts/client-smoke.mjs          # 客户端 bundle 注册 + 插槽注入（假 loader）
node scripts/route-smoke.mjs           # 用假 ctx 跑 HTTP 面
node scripts/wasm-fallback-check.mjs   # 没有 assets 的安装：下载一次、之后复用
node scripts/panel-refs-check.mjs      # panel script reads only declared fields
node scripts/composer-bridge-check.mjs # composer insertion tiers (fake DOM)
node scripts/batch-insert-check.mjs        # multi-select ordering, separators, limits
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
