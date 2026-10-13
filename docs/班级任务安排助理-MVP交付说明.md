# 班级任务管理 · MVP 交付说明

> 技术栈：**原生微信小程序**（WXML / WXSS / JavaScript / JSON），未使用 UniApp、Taro 或任何网页套壳方案。
> 后端：**腾讯云 CloudBase**（云函数 + MySQL + 云存储），openid 无感登录。
> 设计还原：375×812 设计稿 1:1，1px = 2rpx。

---

## 一、项目结构

```
LZXQ-WorkBuddy/
├── project.config.json              # miniprogramRoot=miniprogram/  cloudfunctionRoot=cloudfunctions/
├── docs/                            # 需求 / 开发 / 设计提示词 / 备案文案
├── scripts/
│   ├── init.sql                     # 14 张表 DDL + 种子数据（12 成员 / 4 课程 / 4 课次 / 12 条值日）
│   ├── gen-icons.js                 # 设计稿图标 → SVG（78 个，24×24，2px 线性）
│   ├── sync-common.js               # 公共模块分发到 11 个云函数目录
│   ├── deploy.md                    # 部署手册（环境 / 步骤 / 触发器 / 上线前调整）
│   ├── check-api.js                 # 自检：前端 api.xxx ↔ 云函数 routes
│   ├── check-wxml.js                # 自检：WXML 事件处理器 / wx:for+wx:if / 标签闭合
│   ├── check-icons.js               # 自检：图标名称引用完整性
│   └── check-icons-cloud.js         # 自检：icons.js 登记路径 ↔ 云存储实际文件
│
├── miniprogram/                     # 前端（约 7,800 行，含组件与样式）
│   ├── app.js                       # 云初始化 / 无感登录 / 场景参数 / 引导绑定
│   ├── app.json                     # 6 页面 + custom TabBar + 录音/相册权限声明
│   ├── app.wxss                     # 设计令牌（品牌色/语义色/字阶 T1-T9/阴影/圆角）
│   ├── sitemap.json
│   ├── custom-tab-bar/              # 自定义 TabBar（4 项，值日红点，安全区适配）
│   ├── utils/
│   │   ├── request.js               # cloud.init / 统一信封解包 / 上传 / 临时链接
│   │   ├── api.js                   # 45 个云函数动作封装
│   │   ├── icons.js                 # 78 个图标的 cloud:// + base64 兜底（自动生成）
│   │   └── util.js                  # 日期/周次/状态机/课程配色/节流等
│   ├── components/                  # 15 个复用组件
│   │   ├── app-icon                 # 图标统一引用（云存储优先，失败降级内联）
│   │   ├── nav-bar                  # 自定义导航（状态栏 + 左/中/右插槽 + 自定义返回）
│   │   ├── avatar-tag               # C14 姓名牌（#F0F5FF/#3370FF，停用态灰）
│   │   ├── status-pill              # 值日状态胶囊
│   │   ├── week-switcher            # C15 周切换器（日期区间 + 第 N 周 + 单双周）
│   │   ├── segmented / stepper / notice-bar / empty-state / skeleton
│   │   ├── bottom-sheet / dialog
│   │   ├── photo-uploader           # 选图 → 裁剪 → 压缩 → 魔数嗅探 → 上传登记
│   │   ├── record-panel             # 15s 录音（波形 / 试听 / 重录 / 发布）
│   │   └── duty-sheet               # 值日详情（含照片、日志、请假换班操作）
│   ├── assets/icons/                # 78 个 SVG 源文件
│   └── pages/
│       ├── bind/                    # P1 绑定三步：口令 → 名单选人 → 学号后四位
│       ├── home/                    # P2 首页：HERO 值日卡 + 语音条 + 提醒卡（快捷入口已下线）
│       ├── timetable/               # P3 课程表：5 行 × 7 列网格（周末列横向滚动）+ 管理员增删改 + 校历
│       ├── duty/                    # P4 值日表：按日/按人 + 导出长图/CSV
│       ├── mine/                    # P7 我的：作品 / 申请 / 成员管理 / 关于
│       └── poster/                  # 邀请海报：Canvas 合成 + 小程序码 + 保存分享
│
└── cloudfunctions/                  # 后端（11 个函数，约 2,200 行业务代码 + 263 行 common）
    ├── common/                      # 源：db(连接池) / guard(openid 鉴权) / resp(信封)
    │                                #     week(周次与状态机) / audit(内容安全)
    ├── auth         181 行          # openid 无感登录、绑定状态、解除绑定
    ├── member       216 行          # 名单（口令换脱敏名单）/ 分组 / 角色 / 导入
    ├── course       214 行          # 课程与课次 CRUD
    ├── schedule     418 行          # 排班生成（轮转/避让/冲突）、发布、撤回
    ├── duty         331 行          # 今日值日、值日详情、确认/请假/换班、语音通知
    ├── adjust       252 行          # 换班 / 请假申请与审批
    ├── media        270 行          # 上传登记、格式过滤、时长校验、内容安全
    ├── export        91 行          # 周表 CSV / 长图数据
    ├── poster        93 行          # 邀请码、小程序码（云存储缓存）
    ├── cron-weekly  169 行          # 定时：生成下周 / 过期扫描 / 超时撤销 / 提醒
    └── audit-receiver 57 行         # 微信内容安全异步回调
```

---

## 二、部署结果

### 2.1 CloudBase 环境

| 项 | 值 |
|---|---|
| 环境 ID | `<YOUR_ENV_ID>`（上海） |
| 关联 AppID | `<YOUR_APPID>` |
| MySQL | TDSQL-C MySQL 8.0，内网 `172.17.0.15:3306`，schema `<YOUR_ENV_ID>` |
| VPC / 子网 | `vpc-c4ga6fms` / `subnet-a5mkrg1l`（云函数已绑定，内网连库） |
| 运行时 | Nodejs18.15，256MB，超时 120s，云端安装依赖 |

### 2.2 云函数（11 个，全部 Active）

`auth` `member` `course` `schedule` `duty` `adjust` `media` `export` `poster` `cron-weekly` `audit-receiver`

- 环境变量：`DB_HOST / DB_PORT / DB_USER / DB_PWD / DB_NAME / WX_APPID`
- 第 1 轮增量部署：`member`（新增口令换名单）、`duty`（语音 URL + `noticeAudio`）、`poster`（放宽为已绑定可用）
- 第 2 轮增量部署（2026-09-23）：`course` / `schedule` / `duty` —— 课次模型由「单双周规则」改为「显式周次 `weeks` 数组 + 分组可见性 `group_scope` 过滤」；`session` 表新增 `weeks` 列（VARCHAR(64)）并通过 `scripts/migrate-weeks.sql` 幂等迁移，旧 `week_rule` 数据按 ODD/EVEN/ALL 回填；新增课次 `duty_count` 默认 2（值日固定两名）。已用 MCP invoke 冒烟测试：`course.listWeek` / `duty.today` 均成功加载（返回 40001 未登录，属预期）。
- 第 3 轮修复（2026-09-23）：修复课表首屏「数据没加载出来」—— 根因是公共模块 `common/week.js` 的 `matchesWeeks`/`parseWeeks` 只加在了函数副本、被 `sync-common` 覆盖，导致云函数 `50000`；已改在**源** `cloudfunctions/common/week.js` 并重新部署 `course`/`schedule`/`duty`（下载线上包 grep 验证 `week.js` 已导出 `matchesWeeks`）。同时修复两处遮挡：`nav-bar` 标题改绝对居中、右侧插槽按 `getMenuButtonBoundingClientRect` 避让微信胶囊按钮；`bottom-sheet` 新增 `tabbar` 让位（默认开），弹层不再被底部自定义 tabBar 遮挡。
- 第 4 轮：自动排班算法改为「**按学号轮转**」（2026-09-23）——`schedule.generate` 的候选排序由「随机 / 最近值日时间」改为 `(duty_count ASC, student_no ASC)`，即**先安排本周期内值日次数最少的人，次数相同时学号靠前者优先**；配合 `session.duty_count = 2`（每节课 2 人）、`avoid_same_day = 1`（当日不重复）与 `group_scope` 过滤，天然得到「A 组课排 A 组、B 组课排 B 组、全体课排全班未安排过的人」的轮转效果。已重新部署 `schedule`（下载线上包 sha256 与本地一致）。
  - 离线仿真复现用户示例（12 人班，尾号奇数=A / 双数=B）：第 1 节 A 组课→**1、3 号**，第 2 节 A 组课→**5、7 号**，全体课→**2、4 号**，B 组课→**6、8 号**，与预期完全一致。
  - 同时修正前端文案：课次表单分组选项由误导性的「单周 A 组 / 双周 B 组」改为「A 组 / B 组」并加注「A 组＝学号尾号单数，B 组＝学号尾号双数」；值日页「一键生成」确认文案改为「已手动调整的保留不动」（实际只删除 `source='AUTO'` 的记录）。
  - DB 侧：`course.duty_count` / `session.duty_count` 默认值由 1 改为 **2**（`ALTER TABLE ... SET DEFAULT 2`，MCP 逐条执行，TDSQL 不支持多语句一次提交）。

### 2.3 数据库（14 张表，已建且已灌种子数据）

`class_config` `member` `course` `session` `duty` `duty_log` `schedule_rules` `schedule_publish`
`swap_request` `leave_request` `notice` `notice_read` `attachment` `bind_attempt`

种子数据：班级 1（计算机 示例班级C，口令 `888666`，邀请码 `<INVITE_CODE>`）、学期 `total_weeks = 16`（2026-09-21 起）、成员 12、课程 4、课次 4、第 1 周值日 12 条（已发布）。

> 学期周次已由 18 改为 **16**（用户确认）：`class_config.total_weeks` 与 `scripts/init.sql` 种子同步为 16；课次编辑的「上课周次」按钮按 `totalWeeks` 动态生成，故渲染 **1–16**，与周切换器、排班生成一致。

### 2.4 云存储

- `icons/`：**78 个 SVG** 全部上传成功，与 `utils/icons.js` 登记路径 **78/78 完全一致**（已脚本校验）。
- 运行时写入目录：`duty/{bizId}/`（现场照片）、`notice/`（15s 语音）、`wxacode/{scene}.png`（小程序码缓存）。

### 2.5 定时触发器（cron-weekly，7 段 cron）

| 名称 | cron | 说明 |
|---|---|---|
| weekly | `0 0 20 * * 0 *` | 每周日 20:00 生成下周草稿 |
| daily | `0 0 6 * * * *` | 每日 06:00 昨日未确认 → EXPIRED |
| hourly | `0 0 * * * * *` | 每小时 超时申请撤销 / 审核超时下架 |
| remind | `0 0 18 * * * *` | 每日 18:00 明日值日提醒 |

---

## 三、已验证项目

| # | 验证项 | 方式 | 结果 |
|---|---|---|---|
| 1 | 小程序 JS 语法 | `node --check` 全量（miniprogram + cloudfunctions） | 通过，0 错误 |
| 2 | 小程序 JSON 语法 | `JSON.parse` 全量 | 通过，0 错误 |
| 3 | 页面/组件文件完整性 | 6 页面 + 15 组件 + TabBar，各自 4 文件齐全 | 通过，0 缺失 |
| 4 | `usingComponents` 路径解析 | 逐条解析到实际文件 | 通过，0 断链 |
| 5 | WXML 事件处理器 | 所有 `bind*`/`catch*` 均能在对应 JS 找到方法 | 通过 |
| 6 | WXML 结构 | 标签闭合平衡；无 `wx:for` + `wx:if` 同标签（小程序禁用语义） | 通过 |
| 7 | 图标引用 | 代码使用的图标名全部在 icons.js 中定义（含变体） | 通过，无 Emoji/色块占位 |
| 8 | 图标云端一致性 | icons.js 78 条 cloud 路径 ↔ 云存储 78 个文件 | 78/78 完全一致 |
| 9 | 接口端到端映射 | 前端 `api.xxx` → `utils/api.js` → 云函数 `routes[action]` | 45 条映射全部命中 |
| 10 | 云函数冷启动与鉴权 | 调用 `auth.login`（无 WX 上下文） | 返回 `{errCode:40001}`，符合预期 |
| 11 | 云函数 ↔ MySQL 内网连通 | 调用 `audit-receiver`（内部执行一次真实查询） | 无异常日志，85ms 返回，VPC 连库正常 |
| 12 | 定时任务 | `listFunctionTriggers` | 4 个触发器在位（本轮补齐 weekly） |
| 13 | 数据库内容与种子 | `SHOW TABLES` / `SELECT COUNT(*)` | 14 表、12 成员、4 课程、4 课次、12 值日 |

### 核心功能链路（代码级已接通，需真机/体验版复核）

| 功能 | 实现位置 | 关键实现 |
|---|---|---|
| 照片选择与裁剪 | `components/photo-uploader` | `chooseMedia` → `wx.editImage` 裁剪 → `compressImage`(1280/80) → 客户端魔数嗅探（JPEG/PNG/WEBP）→ ≤10MB → 上传 `duty/{bizId}` |
| 15 秒录音 | `components/record-panel` | `RecorderManager` `format:'mp3'`，15s 自动停，最短 1s，`onFrameRecorded` 驱动波形 |
| 音频上传与格式过滤 | `cloudfunctions/media` | 服务端魔数复检 + `music-metadata` 时长校验（≤15s）+ `AUDIO_MAX_MS` |
| Canvas 合成 | `pages/duty`（值日长图）/ `pages/poster`（邀请海报） | Canvas 2D (`type="2d"`)，dpr=2，`canvasToTempFilePath` |
| 保存与分享 | 同上 | `showShareImageMenu` 优先，失败回落 `saveImageToPhotosAlbum` |
| 扫码播放 | `pages/home` + `duty.noticeAudio` | 扫码识别 `N{id}` / 纯数字 → 拉取语音临时链接 → `InnerAudioContext` |
| 我的作品 | `pages/mine` + `media.myPhotos` | 九宫格预览，`previewImage` |
| 无感登录与鉴权 | `app.js` + `common/guard.js` | `getWXContext().OPENID` → member 会话；`needBind` / `needAdmin` 分级 |
| 自定义 TabBar | `custom-tab-bar` | 4 项、图标 on/off、值日红点、`env(safe-area-inset-bottom)` |
| 邀请与小程序码 | `pages/poster` + `cloudfunctions/poster` | `wxacode.getUnlimited`，云存储缓存，未发布时降级口令海报 |

---

## 四、上线前待办（P0 → P2）

### P0 · 不完成不能提审

1. **备案号**：`pages/mine` 关于页当前为占位「苏ICP备00000000号-1」，必须替换为真实备案号，且可点击跳转工信部系统。
2. **内容安全改严格**：环境变量 `MEDIA_AUDIT` 由 `auto_pass` 改为 `strict`；mp 后台「消息推送」绑定 `audit-receiver` 云函数。
3. **小程序码页面校验**：`poster.getQrcode` 的 `checkPath: false` 是开发期开关，正式发布后需去除；`envVersion` 由 `trial` 切 `release`。
4. **清空演示数据**：`scripts/init.sql` 中的 12 名演示成员、课程、值日记录需替换为真实班级数据（当前是让首屏"有内容"的临时种子）。
5. **隐私协议**：`app.json` 已声明录音/相册权限，需在 mp 后台配置《用户协议》《隐私政策》并同步小程序端入口（关于页两个入口当前仅关闭弹层）。

### P1 · 影响体验，建议随首版一起做

6. **订阅消息模板**：申请模板后，ID 要**同时**填两处 —— 云函数环境变量 `TEMPLATE_REMIND` 与端上
   `miniprogram/utils/config.js` 的 `SUBSCRIBE_TEMPLATE_ID`（另两个模板 `TEMPLATE_PUBLISH` / `TEMPLATE_SWAP` 按需）。
   漏填端上那处，用户侧不会弹授权框，提醒不会真正下发。完整步骤见 `docs/微信订阅消息接入指引.md`。
   > 2026-09-24 已把整条链路（21:00 定时触发器 + 前端授权入口 + 服务端发送）做好并上线，只差模板 ID。
7. **真机回归**：录音（iOS/Android 音量与格式）、裁剪（`wx.editImage` 在部分机型缺失，已有降级但需实测）、保存相册权限拒绝路径。
8. **性能**：`schedule`(418 行) 排班生成走事务，20 人以上班级需压测；建议给 `member.duty_count`、`duty.class_date` 补复合索引。
9. **并发与幂等**：值日确认/换班在高并发下依赖 `INSERT IGNORE` + 事务，建议补充乐观锁版本号。

### P2 · 可延后

10. 导出 PNG 长图在值日条数极多时会生成超高画布，需加高度上限与分页。
11. `wxacode` 缓存永不失效，班级改名/换邀请码后需清理 `wxacode/{oldScene}.png`。
12. 未使用的图标（`calendar-check / chevron-down / chevron-up / settings / logout / lock / more / copy / tag / crown / trash / edit`）已生成上传，可在后续页面接入时直接引用，或清理以节省存储。
13. 管理员「一键生成」目前每次重排，建议加二次确认与生成预览。

---

## 五、本地自检命令

```bash
node scripts/sync-common.js        # 改云函数后必跑（公共模块分发）
node scripts/check-api.js          # 接口映射自检
node scripts/check-wxml.js         # WXML 事件/结构自检
node scripts/check-icons.js        # 图标名称自检
node scripts/check-icons-cloud.js  # 图标云端一致性（需先更新 .icons-storage-list.txt）
```

打开微信开发者工具 → 导入项目（目录选 `LZXQ-WorkBuddy`）→ 云开发右键「上传并部署」剩余函数即可预览。
