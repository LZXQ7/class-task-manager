# 班级任务管理小程序（class-task-manager）

> 微信小程序 + CloudBase 云函数 + MySQL（TDSQL）的班级日常管理工具：值日排班、成员与分组、请假、课表、订阅消息通知；另含一个超管网页后台（admin-web）。

---

## 1. 项目简介

面向班级（本仓库以某高校班级为样板）的日常协作小程序：

- **值日排班**：按序号轮转自动生成值日表，支持调课、换班、手动补录、保洁大扫除等特殊日。
- **成员与分组**：学生/班委/辅导员/超管多角色，A/B 行政班分组，测试账号隔离。
- **请假**：本人申请 + 班委代登，实时/日期双口径，辅导员跨班汇总。
- **课表**：云端课表导入（xlsx / 粘贴青果网页源码），每周自动生成，可删除课次。
- **通知**：微信订阅消息定时提醒（每日 1 条，可切回 2 条）。
- **超管后台 admin-web**：课程表 / 成员 / 账号班级 / 系统配置 / 审计日志（第一期不含排班与请假）。

---

## 2. 技术栈

| 层 | 技术 |
|---|---|
| 小程序前端 | 微信小程序原生（WXML / WXSS / JS），**无前端框架**，无 npm 构建 |
| 后端 | CloudBase 云函数（Node.js，`Nodejs18.15` runtime） |
| 共享逻辑 | `cloudfunctions/common/` 被 12 个业务函数复用（**真源**，改后需同步） |
| 数据库 | CloudBase MySQL（TDSQL） |
| 后台 | `cloudfunctions/admin-web` 单个 HTTP 云函数（Express），同源托管页面 + `/api/*` |
| 脚本 | Node.js（门禁/部署/验证）+ 少量 Python（排班求解、xlsx 解析） |

---

## 3. 目录结构

```
.
├── miniprogram/              # 小程序前端源码
│   ├── pages/                # 页面：bind, classes, doc, duty, home, manual,
│   │                         #       mine, my-timetable, notice, roster,
│   │                         #       timetable, timetable-apply, webview
│   ├── components/           # 自定义组件（avatar-tag 等）
│   ├── utils/                # config.js（APP_VERSION 常量）、各类工具
│   └── data/                 # 静态数据（timetable.js 等）
├── cloudfunctions/           # 云函数
│   ├── common/               # 共享模块（真源）→ 改后 sync-common + 全量重部署
│   ├── adjust/  ai-proxy/  audit-receiver/  auth/  class/  course/
│   ├── cron-weekly/  duty/  export/  media/  member/  poster/  schedule/
│   └── admin-web/            # 超管网页后台（Express）
├── scripts/                  # 门禁 / 验证 / 迁移 / 部署脚本（见 §8、§9）
├── docs/                     # 产品、设计、接入文档
├── i18n/                     # 多语言（base.json）
├── outputs/                  # 发版说明（*.md 入库；构建/验证产物被 gitignore）
├── HANDOFF.md                # 跨 session 状态交接件（主线节点 + 下一步）
├── CHANGELOG.md              # 版本史（对外版本 → 内部版本映射）
├── CHANGELOG-DETAIL.md       # 版本详细改动
├── cloudbaserc.json          # CloudBase 配置（envId、函数清单、部署模式）
├── project.config.json       # 小程序项目配置（appid 等）
└── project.private.config.json  # ⚠️ gitignore：微信 IDE 上传私钥/密钥
```

> `Dawn-Course-ref/`、`preview/`、`miniapp/`、`_tmp_*`、`outputs/**`（非 md）、`.workbuddy/`
> 等均为**衍生物或敏感/大体积目录**，已被 `.gitignore` 排除，**不要提交**。

---

## 4. 环境准备

- **微信开发者工具**（导入 `project.config.json`）
- **Node.js 18.x**（与云函数 runtime 对齐）
- **CloudBase CLI（`tcb`）3.8.x**，已登录且对该环境有部署权限
- 一个 **CloudBase 环境**，envId 见 `cloudbaserc.json`（`envId` 字段）
- （数据库迁移）经 CloudBase CLI 的 `tcb db execute` 特权通道执行 SQL

---

## 5. 本地开发

1. 微信开发者工具 → 导入项目 → 选本目录（`project.config.json` 已就绪）。
2. 前端改动直接改 `miniprogram/`；云函数改动改 `cloudfunctions/<函数名>/`。
3. 前端为原生小程序，**无需 npm install / 构建 npm**。
4. 真机预览 / 上传在开发者工具内完成（见 §9 版本流程）。

---

## 6. `common` 共享模块与同步（极易踩坑）

`cloudfunctions/common/` 是 12 个业务云函数的**共享源码真源**，但云函数部署时各自拷贝一份，
并不运行时共享。

**改了 `common/` 之后必须做：**

1. 跑 `node scripts/sync-common.js` —— 把最新 `common/` 同步进每个业务函数目录；
2. 全量重部署受影响的云函数（`poster` 含在内，`ai-proxy` 豁免）。

> 漏掉同步 → 线上跑的是旧 `common`，本地门禁却全绿，表现为「门禁过了但线上行为旧」。

---

## 7. 部署

### 7.1 已有云函数（单函数）
```bash
cd cloudfunctions/<函数名>
tcb fn code update <函数名> --dir . --deployMode zip -e <envId>
```
（`envId` 取 `cloudbaserc.json` 的值；CloudBase CLI 3.8.4 无 `fn env set`，
环境变量只能由 `cloudbaserc.json` 的 `envVariables` 应用。）

> ⚠️ `scripts/deploy_all.sh` 用的是**已禁用的** `functions:deploy` 写法，已过时，**不要照抄**。

### 7.2 新建云函数
在 `cloudbaserc.json` 的函数清单中加入条目，再：
```bash
tcb deploy --only functions
```
（首次创建只能走 `cloudbaserc.json` + `tcb deploy`，`fn deploy` 不会自动建函数。）

### 7.3 超管后台 admin-web
```bash
node scripts/deploy-admin-web.js
```
该脚本会向每个函数入口注入 `DB_*` 环境变量并部署（凭据从 `.env-course` 临时注入、finally 还原）。

### 7.4 数据库迁移
- 增量迁移脚本在 `scripts/*.sql`（如 `migrate-tuesday-clean.sql`）。
- 经 tcb 特权通道（运行期账号仅有 DML，**DDL 只能走此通道**）：
  ```bash
  tcb db execute -e <envId> -s "<单条 SQL>"
  ```
  > ⚠️ **`tcb db execute` 一次只支持单条 SQL**，不支持 `;` 多语句（多语句会 1064 整体回滚）。
  > `CREATE` 与 `INSERT` 必须拆成两次调用。
- 或批量：`bash scripts/run_sql_file.sh scripts/<file>.sql`。
- **动生产库铁律**：只读探测 → 核行数 → 动手 → 复核。优先在真 MySQL 语义下用
  `scripts/verify-*-db.js`（mysql-memory-server 本地真库）验证后再上线。

---

## 8. 质量门禁与发版复核

| 命令 | 作用 |
|---|---|
| `bash scripts/run_all_gates_bounded.sh` | 全量门禁批跑（**每门禁 60s 超时**，避免某门禁卡死拖垮整轮） |
| `bash scripts/check_closeout.sh` | 发版收尾复核（D1–D7 七项：版本常量 / 文档 / 门禁 / 深色 / 审核后关闭等） |
| `node scripts/check-<xxx>.js` | 单门口禁（批跑红时**必须单跑复核**） |

门禁覆盖 80+ 项：页面注册、wxss 官方 wcsc 真编译、云函数触发器覆盖、班级数据隔离、
权限委托、AI 预算、admin-web 网关前缀 / 导入 DDL、HTML 课表解析器等。

> ⚠️ **批跑偶发非 0（如 `check-wxss`）但单跑必绿**，属已知抖动，不是回归，别据此改代码。

---

## 9. 版本与发布流程（含 GitHub 同步）

- **版本常量**：`miniprogram/utils/config.js` 的 `APP_VERSION`（对外版本号，如 `1.0.6.5`）；
  内部版本号（如 `v0.7.39`）与对外号的映射见 `CHANGELOG.md`。
- **发版 bump 后**，按顺序执行（已建立的 GitHub 同步约定）：
  ```bash
  git add -A
  git commit -m "版本 x.y.z 说明"
  git tag vx.y.z                      # 仅「已上传微信平台」的版本才打 tag
  git push origin main --tags
  ```
- **仓库**：`https://github.com/LZXQ7/class-task-manager.git`（开源脱敏模板，默认分支 `main`）。内部未脱敏版本另存于私有仓库 `class-task-manager-template`。
- **微信端上传 / 送审**：在微信开发者工具或公众平台操作。
  > 🔴 **本仓库无法自动感知你是否上传/送审**。请在上传或送审后**主动告知**，
  > 我会据此更新 `HANDOFF.md`【主线状态】（标记版本上传/送审日期、跑复核、按需开关审核体验入口）。
- **审核体验入口（review-demo）**：提审前按 `outputs/vX-更新说明.md` 的「提审前必做」
  开启入口 / 换口令 / 置演示标记；审核通过后跑 `scripts/disable-review-demo.sql` 关后门。
  > 演示态**不是纯只读**：拦截的是不可逆/授权/全站级写，值日/换班/请假/排班等可逆日常写仍放行。

---

## 10. 安全与 `.gitignore`

`.gitignore` 已排除以下内容，**切勿提交，也切勿把敏感信息写进仓库或文档**：

- `.workbuddy/` —— 生产数据备份（含学生隐私 PII）+ 记忆密钥，**体积大且敏感**；
- `project.private.config.json` —— 微信 IDE 上传私钥 / 密钥（可重生成）；
- `.env-*` —— 数据库明文口令（`DB_*`）；
- `Dawn-Course-ref/`、`preview/`、`miniapp/`、`_tmp_*`、`outputs/**`（非 `*.md`）—— 衍生物 / 大体积 / 临时。

本仓库是**开源脱敏模板**：`envId`、`appid`、真实姓名、学号、班级名、令牌等均已模板化为占位符（如 `<YOUR_ENV_ID>`、`<YOUR_APPID>`、`示例班级A`、`示例成员01`）。
部署前请：
1. 在 `project.config.json` / `cloudfunctions/cloudbaserc.json` 中填入你自己的 `appid` 与 `envId`；
2. 在 `miniprogram/utils/config.js`、`cloudfunctions/common/config.js` 等位置替换占位符；
3. 用你自己的微信 AppID 与 CloudBase 环境重新走一遍 §4–§7 的初始化。
内部未脱敏的版本（含真实数据、私钥、`.workbuddy/` 备份）请放在**私有仓库**，切勿推送到公开仓库。

---

## 11. 重要约定与坑（速查）

- **触发器是「整体覆盖」语义**：`config.json` 的 `triggers` 部署时整体覆盖云端，漏一条 = 删一条。
  改前先 `tcb fn detail <fn> -e <envId>` 查线上真值，改完同改两边。
- **判据必须收进「目标块」**：同一报错文案可能出现在多个云函数，全文件 grep 会在目标被删后仍搜得到 ⇒ 静默假通过。
- **门禁批跑会假红**：批跑红必须单跑复核。
- **改 `common/` 后必须 `sync-common` + 全量重部署**（见 §6）。
- **`tcb db execute` 只支持单条 SQL**（见 §7.4）。
- **WXML 注释里禁出现 `-->`**（真机编译失败，报错落后面几十行）。
- **判「接口是否上线」不能靠 401**：鉴权是全局中间件、跑在路由匹配前，打不存在的路由也返 401；
  只能靠线上包 `diff`（`tcb fn code download`）或登录实操。

---

## 12. 常用命令速查

```bash
# 门禁 / 复核
bash scripts/run_all_gates_bounded.sh     # 全量门禁（带超时）
bash scripts/check_closeout.sh            # 发版收尾 7 项复核（建议 300s 超时）

# 部署
node scripts/sync-common.js               # common 同步进各函数
tcb fn code update <fn> --dir . --deployMode zip -e <envId>   # 单函数部署
node scripts/deploy-admin-web.js          # 后台部署

# 数据库
tcb db execute -e <envId> -s "<单条SQL>"  # 特权通道执行（一次一条）
bash scripts/run_sql_file.sh scripts/<file>.sql

# 版本
git add -A && git commit -m "..." && git tag vx.y.z && git push origin main --tags
```

---

## 13. 文档索引（`docs/`）

| 文档 | 内容 |
|---|---|
| `班级任务安排助理-MVP产品开发文档.md` | 产品整体设计 |
| `自动排班规则与后台操作指引.md` | 排班算法与后台操作 |
| `微信订阅消息接入指引.md` | 订阅消息接入 |
| `网页管理后台-使用说明.md` | admin-web 使用与架构 |
| `用户协议与隐私政策.md` / `隐私保护指引-填写说明.md` | 合规 |
| `备案-服务内容备注文案.md` | ICP 备案 |
| `AI 一键生成值日表-提示词与配置说明.md` | AI 排班提示词 |

版本细节另见根目录 `CHANGELOG.md` / `CHANGELOG-DETAIL.md`；跨 session 状态见 `HANDOFF.md`。

---

*本 README 不含任何密钥、令牌、openid 或学生隐私数据。*
