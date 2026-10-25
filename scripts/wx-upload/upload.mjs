#!/usr/bin/env node
/**
 * 微信小程序无头上传（miniprogram-ci）—— 发布体验版/开发版本
 *
 * 用法：
 *   node upload.mjs 1.0.7.1                      # 备注自动取该版「版本更新公告」
 *   node upload.mjs 1.0.7.1 "自定义备注"          # 位置参数：版本号 + 备注（显式指定时优先）
 *   node upload.mjs --version 1.0.7.1 --desc "备注"
 *
 * 项目备注（desc，mp 后台「版本管理」里显示的那列）来源优先级：
 *   1) --desc / 第二个位置参数（显式指定，最高优先）
 *   2) outputs/v<版本>-更新说明.md 的「版本 B 公告版」—— 即超管「我的 → 发送更新公告」
 *      时粘贴的原文（CHANGELOG.md 发版约定：每个版本必须产出该文件；版本 B 为纯文本、
 *      一条一句，正是「每次版本更新的公告」）
 *   3) 都找不到时回退「班级任务管理 <版本>」
 *
 * 环境变量（均可选，有默认值）：
 *   WX_APPID        小程序 AppID（默认 <YOUR_APPID>）
 *   WX_PROJECT_PATH 小程序项目根，即含 project.config.json 的目录（默认本仓库根）
 *   WX_UPLOAD_KEY   上传密钥 .key 的路径（默认 <YOUR_UPLOAD_KEY_PATH>）
 *
 * 密钥获取：mp.weixin.qq.com → 开发管理 → 开发设置 → 小程序代码上传密钥 → 生成并下载（需管理员权限）
 * 注意：密钥放在仓库外，切勿提交到 git。
 */
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// 环境兜底：Git Bash / 精简环境可能缺 APPDATA / HOME / USERPROFILE，
// 会让 miniprogram-ci 的依赖 npm-conf 在 path.resolve(undefined) 处崩（ERR_INVALID_ARG_TYPE）
try {
  const home = os.homedir() || process.env.USERPROFILE || process.env.HOME || ''
  if (!process.env.APPDATA && home) process.env.APPDATA = path.join(home, 'AppData', 'Roaming')
  if (!process.env.HOME && home) process.env.HOME = home
  if (!process.env.USERPROFILE && home) process.env.USERPROFILE = home
} catch {}

const require = createRequire(import.meta.url)
let ci
try {
  ci = require('miniprogram-ci')
} catch (e) {
  console.error('加载 miniprogram-ci 失败：', e && e.message ? e.message : e)
  console.error('若提示缺少依赖，请先在 scripts/wx-upload 目录执行: npm install')
  process.exit(1)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = process.env.WX_PROJECT_PATH || path.resolve(__dirname, '..', '..')
const APPID = process.env.WX_APPID || '<YOUR_APPID>'
const KEY_PATH = process.env.WX_UPLOAD_KEY || '<YOUR_UPLOAD_KEY_PATH>'

// ---- 解析参数 ----
const args = process.argv.slice(2)
const getFlag = (name) => {
  const i = args.indexOf('--' + name)
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined
}
const positionals = args.filter((a, idx) => !a.startsWith('--') && args[idx - 1] !== '--version' && args[idx - 1] !== '--desc')
const version = getFlag('version') || positionals[0]

if (!version) {
  console.error('缺少版本号。用法: node upload.mjs <version> [desc]  或  --version <v> --desc <d>')
  process.exit(1)
}

/**
 * 读取「版本 B 公告版」正文，作为上传的项目备注（desc）。
 * 权威来源：outputs/v<version>-更新说明.md（CHANGELOG.md 约定的发版必备产物，
 * 版本 B = 超管「发送更新公告」时整段粘贴的纯文本，一条一句）。
 *
 * 解析规则：
 *   - 定位「## 版本 B」小节，收集到下一个 ## 标题或 --- 分隔线为止；
 *   - 跳过引用行（> 开头）、空行、「【班级任务管理 · 更新公告】」头行
 *     （该行发群时保留、作备注时省去，保持备注干净）；
 *   - 每行 trim()（JS trim 含全角空格 U+3000），丢弃空行后按 \n 拼接。
 * 文件不存在 / 无版本 B 小节 / 正文为空 → 返回 null，由调用方回退。
 */
function readAnnouncement(ver) {
  const v = String(ver).replace(/^v/i, '')
  const file = path.join(PROJECT_ROOT, 'outputs', `v${v}-更新说明.md`)
  if (!fs.existsSync(file)) return null
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  const lines = text.split(/\r?\n/)
  const start = lines.findIndex((l) => /^##\s*版本\s*B/.test(l))
  if (start < 0) return null
  const out = []
  for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) || /^---\s*$/.test(lines[i])) break
    const t = lines[i].trim()
    if (!t) continue
    if (t.startsWith('>')) continue
    if (/^【.*】$/.test(t)) continue
    out.push(t)
  }
  return out.length ? out.join('\n') : null
}

// ---- 确定项目备注（desc）----
const DESC_MAX = 500 // 安全上限：mp 后台备注列展示空间有限，超长按整段截断
let desc = getFlag('desc') || positionals[1]
let descSource = '命令行显式指定'
if (!desc) {
  desc = readAnnouncement(version)
  descSource = desc
    ? `版本更新公告（outputs/v${String(version).replace(/^v/i, '')}-更新说明.md · 版本 B）`
    : ''
}
if (!desc) {
  desc = `班级任务管理 ${version}`
  descSource = '回退默认（未找到该版更新公告，用「班级任务管理 <版本>」兜底）'
}
if (desc.length > DESC_MAX) {
  desc = desc.slice(0, DESC_MAX - 1) + '…'
  descSource += `（超长，已截断至 ${DESC_MAX} 字符）`
}

console.log(`项目备注来源：${descSource}`)
console.log(`项目备注内容：\n${desc.split('\n').map((l) => '  ' + l).join('\n')}`)

if (!fs.existsSync(KEY_PATH)) {
  console.error(
    `上传密钥不存在: ${KEY_PATH}\n` +
    '请从 mp.weixin.qq.com → 开发管理 → 开发设置 → 小程序代码上传密钥 下载 .key，\n' +
    '放到该路径，或用环境变量 WX_UPLOAD_KEY 指定其它路径。'
  )
  process.exit(1)
}

// ---- 组装并上传 ----
const project = new ci.Project({
  appid: APPID,
  type: 'miniProgram',
  projectPath: PROJECT_ROOT,
  privateKeyPath: KEY_PATH,
  ignores: ['node_modules/**/*', 'scripts/wx-upload/**/*'],
})

console.log(`上传中…  appid=${APPID}  version=${version}  project=${PROJECT_ROOT}`)
ci.upload({
  project,
  version,
  desc,
  setting: {
    es6: true,
    es7: true,
    minify: true,
    codeProtect: false,
    autoPrefixWXSS: true,
  },
})
  .then((res) => {
    console.log('✅ 上传成功：', JSON.stringify(res, null, 2))
    console.log(`\n版本 ${version}（${desc}）已作为开发版本上传。`)
    console.log('如需设为「体验版」：mp 后台 → 版本管理 → 选中该版本 → 设为体验版。')
  })
  .catch((err) => {
    console.error('❌ 上传失败：', err && err.message ? err.message : err)
    if (err && err.stack) console.error(err.stack)
    process.exit(1)
  })
