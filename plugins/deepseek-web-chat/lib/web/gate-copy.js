/**
 * Bilingual copy for the pre-login gate.
 *
 * Kept apart from `app.js` so the wording (and the four-step guide) can be edited
 * without touching the panel logic. Every string here is rendered as a text node,
 * never as HTML.
 */
export const GATE_COPY = {
  zh: {
    title: '用 userToken 登录',
    subtitle: '不需要密码：按下面四步取一次 userToken。凭证只保存在这台机器上，不会上传。',
    steps: [
      ['打开官网并登录', '打开 chat.deepseek.com，用你的账号登进对话页'],
      ['按 F12 打开开发者工具', '也可右键 → 检查；顶部切到 Application（应用）'],
      ['展开 Local Storage', '左侧选 https://chat.deepseek.com，右侧找到 userToken 那一行'],
      ['复制 value 再粘贴', '双击 Value 或右键 Copy value，粘到下面的输入框'],
    ],
    openSite: '① 打开 chat.deepseek.com 并登录',
    tokenLabel: '粘贴 userToken',
    submit: '登录',
    privacy: '整段 {"value":"…"} 一起贴进来也认得。凭证只写进本机 DSH 凭据库，之后长期免登录；点「退出」会删除它。',
    zoom: '点击图片放大',
    verifying: '正在验证…',
    missingToken: '请先粘贴 userToken',
    welcome: '登录成功',
    opened: '已在浏览器打开，登录后回到这里粘贴 userToken',
  },
  en: {
    title: 'Sign in with a userToken',
    subtitle: 'No password needed. Grab a userToken once with the four steps below; it stays on this machine.',
    steps: [
      ['Open the site and sign in', 'Open chat.deepseek.com and sign in with your account'],
      ['Press F12 for DevTools', 'Or right-click → Inspect; then pick the Application tab'],
      ['Expand Local Storage', 'Choose https://chat.deepseek.com on the left, find the userToken row'],
      ['Copy the value, then paste', 'Double-click the value or right-click → Copy value, paste below'],
    ],
    openSite: '① Open chat.deepseek.com and sign in',
    tokenLabel: 'Paste the userToken',
    submit: 'Sign in',
    privacy: 'A whole {"value":"…"} object is accepted too. Stored only in the local DSH credential file; "Sign out" deletes it.',
    zoom: 'Click an image to enlarge',
    verifying: 'Verifying…',
    missingToken: 'Paste a userToken first',
    welcome: 'Signed in',
    opened: 'Opened in your browser — come back and paste the userToken',
  },
};
