# 班级任务管理 · MVP 产品开发文档

| 项目 | 内容 |
|---|---|
| 版本 | v1.0（可直接进入开发） |
| 日期 | 2026-09-23 |
| 上游文档 | 《MVP 需求与可行性方案 v1.0》《高保真 UI 设计提示词 v1.0》、Ardot 设计稿（fileId 728829434260513，12 Frame + 6 弹层） |
| 前端 | 微信小程序原生（WXML / WXSS / JS / JSON），基础库 ≥ 2.30.4 |
| 后端 | 腾讯云 CloudBase：云函数（Node.js 18）+ 云开发 MySQL + 云存储 + 定时触发器 |
| 规模假设 | 单班级 ≤ 60 人，单学期 18 周，管理员 1–4 人 |

---

## 1. 文档说明与范围基线

### 1.1 本文档与上游文档的关系

- 可行性方案 v1.0 锁定的是「零 UGC」，设计稿据此绘制。本次开发需求**新增**了：无感登录、图片与音频上传、音频格式与时长校验、小程序码生成、Canvas 图片合成、内容安全审核。
- 因此本文档对范围做一次**受控扩容**：引入最小 UGC 面（见 1.2），其余设计决策（单班、学号后 4 位 + 班级口令绑定、不拍照打卡、不做多租户）全部维持。
- 所有与设计稿/上游方案的冲突，集中在 **第 3 章「冲突清单与修正」** 逐条给出可落地修正，开发以本文档为准。

### 1.2 UGC 扩容后的最小范围（本文档的产品化假设）

| 能力 | 落点 | 规则 |
|---|---|---|
| 图片上传 | 值日完成凭证：本人或管理员在「值日详情」弹层为某次值日上传 1–3 张现场照片 | 全班可见；仅 jpg/png/webp；单张 ≤ 10MB；必须通过内容审核后展示 |
| 音频上传 | 管理员「语音通知」：录制 ≤ 60s 语音，全班在首页收听 | 仅管理员可发；仅允许端上录音（mp3/aac），不开放任意文件上传（原因见 3.2）；必须过审后展示 |
| 小程序码 | 管理员生成「班级邀请海报」：小程序码 + 班级名 + 口令，Canvas 合成后保存/分享 | 扫码 → 自动带入口令进入绑定流程 |
| Canvas 合成 | ① 邀请海报（第 12 章）② 本周值日长图导出（第 13 章） | 均为端上 Canvas 2D |
| 内容安全 | 全部 UGC（照片、语音、名单/课表文本）审核后入库/展示 | 文本同步审，媒体异步审（第 14 章） |
| 无感登录 | `wx.cloud.callFunction` 云函数侧静默取 openid，已绑定用户免一切登录动作 | 未绑定仍走 P1.1–P1.3 绑定流（防冒名，设计稿一致） |

> 如需调整 UGC 落点（例如音频改为请假附言），仅影响第 10/11 章的挂载位置，技术链路不变。

---

## 2. 总体架构

```
┌───────────────────────────────  小程序端（原生） ───────────────────────────────┐
│  pages/*   components/*   utils/request(统一封装)   utils/cloud(cloud.call封装) │
│  Canvas 2D(海报/长图)  RecorderManager(录音)  InnerAudioContext(播放)            │
│  wx.addPhoneRepeatCalendar  wx.requestSubscribeMessage  wx.scanCode             │
└───────────────────────────────────────┬─────────────────────────────────────────┘
                        wx.cloud.callFunction（每次调用自带 openid，无需 code2Session）
┌───────────────────────────────────────▼─────────────────────────────────────────┐
│  CloudBase 云函数（Node18，全部分业务逻辑与鉴权）                                  │
│   auth / member / course / schedule / duty / adjust / media / poster / export /  │
│   audit-receiver(消息推送回调) / cron-weekly(定时触发器) + common 公共模块         │
└──────┬───────────────────────┬───────────────────────┬──────────────────────────┘
       │ mysql2（VPC 内网互联）  │ 云调用 openapi          │ 云存储
┌──────▼──────┐   ┌────────────▼───────────────┐   ┌───────▼─────────────┐
│ 云开发 MySQL │   │ msgSecCheck / mediaCheckAsync│   │ 照片/语音/海报/CSV   │
│ (InnoDB)    │   │ wxacode.getUnlimited / 订阅消息│  │ （仅创建者可读写，    │
└─────────────┘   └────────────────────────────┘   │  展示走临时 URL）     │
                                                    └─────────────────────┘
微信消息推送（wxa_media_check 审核结果） ──► mp 后台配置 ──► 云函数 audit-receiver
```

**四条铁律**

1. 端上**永不**直连 MySQL，所有读写走云函数；权限（角色）判断全部在云函数内完成。
2. 每个云函数入口校验 `cloud.getWXContext()` 的 `openid` 与 `APPID` 存在且等于本小程序 AppID，防环境 ID 泄露后被刷库。
3. 媒体文件统一传云存储、目录化、权限「仅创建者可读写」，对外展示一律使用云函数签发的临时 URL（7200s，端上缓存）。
4. 所有 UGC「先审后显」：文本同步 `msgSecCheck` 通过才入库；照片/语音入库即 `AUDITING` 状态，过审才对非上传者可见。

---

## 3. 设计稿 / 上游方案 与微信平台能力冲突清单（含修正，开发必读）

| # | 冲突点 | 冲突说明 | 可落地修正 |
|---|---|---|---|
| C1 | 设计稿「零 UGC、无上传入口」 vs 新增图片/音频上传 | 设计稿 12 个 Frame 没有任何上传 UI | 按第 3.1 节做**最小 UI 增量**（新增 1 页 + 4 处局部改动），其余页面零改动 |
| C2 | 「上传音频」 vs 小程序无音频选择 API | `wx.chooseMedia` 仅支持 image/video；`wx.chooseMessageFile` 只能从**聊天会话**选文件，用户须先把音频发到某聊天里，体验断裂 | 主路径改为**端上录音**（RecorderManager，scope.record，格式锁定 mp3/aac，60s 自动截断）；`chooseMessageFile` 仅作为管理员「导入已录好的音频」备选路径（extension 过滤 mp3/wav/m4a/aac），云端同样做魔数+时长校验 |
| C3 | 音频时长校验 vs `onStop` 时长机型差异 | RecorderManager `onStop` 返回的 `duration` 在部分安卓机型可能为 0 或不准 | 三层校验（第 11.4 节）：端上计时器为主 + onStop 兜底 + 云函数 `music-metadata` 解析真实时长（超限拒绝入库） |
| C4 | 小程序码 page 校验 vs 未发布 | `wxacode.getUnlimited` 传入 `page` 时要求该页面**已在线上版本存在**（体验版/开发版均不行），未发布调用报 41030 | 双阶段：发布前开发联调时传 `check_path:false`（仅内部测试）；**正式入班码在审核发布成功后生成**。同时 `scene ≤ 32 字符`、page 不带前导 `/` |
| C5 | 设计稿自定义 NavBar 右侧按钮/姓名牌 vs 微信胶囊 | 自定义导航下右上角有系统胶囊（右缘约 95px 区域），P2 的「姓名牌」、P3 的「编辑」、P4 的「导出」会被胶囊遮挡 | NavBar 右侧操作一律左移至胶囊左侧（预留 100px 安全区）；P2 姓名牌入口取消（「我的」已是 Tab），P3/P4 的编辑/导出按钮移到周切换条右端 |
| C6 | 设计稿固定状态栏 44 / 底部 34 vs 机型差异 | 全面屏状态栏 44–59px、小屏无 HomeIndicator | 所有安全区尺寸运行时读取 `wx.getWindowInfo()`，设计稿数值仅作 iOS 基线 |
| C7 | 设计稿「保存为图片（PNG 长图）」 vs iOS Canvas 上限 | iOS Canvas 物理尺寸过大（长列表 × 高 dpr）会绘制失败 | 只导出「本周」数据（5 日 × ≤6 行，高度可控）；dpr 封顶 2；单幅高 ≤ 4000px；失败时引导改用 CSV 导出 |
| C8 | 保存/拍照/录音/日历 vs 授权与隐私 | `saveImageToPhotosAlbum`(scope.writePhotosAlbum)、录音(scope.record)、日历(scope.addPhoneCalendar) 均需用户授权，且拒绝后接口直接 fail | 所有授权动作必须由 tap 触发；封装 `ensureAuth()`：拒绝 → 弹说明 Dialog → `wx.openSetting` 引导；mp 后台「用户隐私保护指引」按第 16.3 节逐项声明，缺声明接口在真机上会被拦截 |
| C9 | 媒体异步审核结果 vs 无服务端 | `mediaCheckAsync` 结果 30 分钟内异步推送，必须有接收端 | mp 后台「消息推送」→ 选择**云函数接收**，绑定 `audit-receiver`；CloudBase 云函数天然支持，无需自建 HTTPS 服务 |
| C10 | `mediaCheckAsync` media_url 公网可下载 vs 云存储私有读 | 审核服务器需直接下载待审文件 | 审核时先 `getTempFileURL` 取临时链接（公网可下载）再送审；注意单文件 ≤ 10MB、音频格式限 mp3/aac/wav 等（第 14.2 节） |
| C11 | 「无感登录」预期 vs 个人主体能力 | 个人主体不可用手机号快捷登录（getPhoneNumber 需非个人主体且付费），也拿不到昵称头像（getUserProfile 已收回） | 无感 = openid 静默 + 绑定态判断，**不承诺「微信一键授权拿身份」**；身份绑定维持「口令 + 名单选人 + 学号后 4 位」（与设计稿一致） |
| C12 | 提醒设计 vs 长期订阅/日历能力 | 长期订阅消息个人主体拿不到；日历 API 无「每两周」周期 | 维持方案 v1.0「三件套」：系统日历 1 条每周提醒 + 一次性订阅消息精确提醒 + 首页卡片兜底（第 15 章） |
| C13 | `msgSecCheck` v2 vs 端上纯文本调用 | v2 要求传用户 `openid` 与 `scene`，只能服务端调用 | 全部文本审核放云函数（`cloud.openapi.security.msgSecCheck`），端上不做审核 |
| C14 | 云函数访问 MySQL vs 默认网络 | 云函数默认无 VPC，直连数据库内网地址不通 | 云函数开启「内网互联」选 MySQL 同 VPC；用 `mysql2/promise` 连接池；开启 VPC 后公网访问受限，所有 openapi 一律走**云调用**（不受影响） |

### 3.1 UGC 最小 UI 增量（对设计稿的精确改动，共 5 处）

| 位置 | 增量内容 | 规格（沿用设计系统 C1–C18） |
|---|---|---|
| ① 值日详情 BottomSheet（P2 Hero 点击 / P4 行点击） | 底部操作区上方新增「照片凭证」区：横滑 3 格缩略图（80×80 r8）+ 尾格「＋」上传 | 已过审照片全班可见；AUDITING 显示「审核中」占位；违规立即移除 |
| ② P5 排班管理 | 操作区卡下新增 Secondary 按钮「发语音通知」（进入录音面板弹层） | 录音面板：按住说话（≤60s，环形进度）、试听、重录、发布 |
| ③ P2 首页 | 「开启提醒卡」上方条件渲染「班级语音通知卡」（有未读通知时） | C4 卡片：播放/暂停按钮 + 时长 + 发布人 + 时间；听过自动标记已读 |
| ④ P1.1 登录 | 主按钮下新增 Text 按钮「扫码加入（由生活委员邀请）」 | `wx.scanCode` → 解析 scene → 口令预填 |
| ⑤ P7 我的 | 功能卡新增 2 行：「班级邀请海报」（管理员）、「我的值日照片」（跳历史照片列表，V1.0 简化为只读列表） | 海报页为新增页面 `pages/mine/poster`（Canvas 合成，见第 12 章） |

---

## 4. 页面路由与导航

### 4.1 app.json 页面与分包

主包 ≤ 2MB 完全够用，**不做分包**。

```json
{
  "pages": [
    "pages/bind/step1",      // P1.1 班级口令
    "pages/bind/step2",      // P1.2 名单选人
    "pages/bind/step3",      // P1.3 学号后4位验证
    "pages/home/index",      // P2 首页·今日        [Tab]
    "pages/timetable/index", // P3 课表周视图       [Tab]
    "pages/timetable/edit",  // P3.1 新增/编辑课次
    "pages/duty/index",      // P4 本周值日表       [Tab]
    "pages/schedule/manage", // P5 排班管理
    "pages/members/index",   // P6 成员与分组
    "pages/mine/index",      // P7 我的             [Tab]
    "pages/mine/adjust",     // P7.1 换班/请假
    "pages/mine/poster",     // 班级邀请海报（新增）
    "pages/about/index"      // P8 关于与备案
  ],
  "tabBar": {
    "custom": false,
    "color": "#C9CDD4", "selectedColor": "#3370FF",
    "list": [
      { "pagePath": "pages/home/index",      "text": "首页" },
      { "pagePath": "pages/timetable/index", "text": "课表" },
      { "pagePath": "pages/duty/index",      "text": "值日" },
      { "pagePath": "pages/mine/index",      "text": "我的" }
    ]
  },
  "window": {
    "navigationStyle": "custom",
    "backgroundColor": "#F5F6F8"
  },
  "renderer": "webview",
  "lazyCodeLoading": "requiredComponents",
  "permission": {},
  "requiredPrivateInfos": []
}
```

> 4 个 TabBar 图标（首页/课表/值日/我的）需要本地 png（24×24 选中/未选两态 ×4 = 8 张），非 emoji，线性风格与设计稿 C2 一致。

### 4.2 路由表（含传参与守卫）

| 路由 | 进入方式 | 传参 | 守卫 |
|---|---|---|---|
| `/pages/bind/step1` | 未绑定 redirectTo；扫码带 scene 进入 | `scene`（邀请码，可选） | 已绑定 → switchTab home |
| `/pages/bind/step2` | navigateTo | `token`（口令，步骤间内存传递，不落 storage） | 未过 step1 校验 → redirect step1 |
| `/pages/bind/step3` | navigateTo | `memberId`（临时） | 同上 |
| `/pages/home/index` | switchTab | — | 全局绑定守卫 |
| `/pages/timetable/index` | switchTab | `week`（可选，实际用页面内状态） | 同上 |
| `/pages/timetable/edit` | navigateTo | `sessionId`（编辑时传，新增不传） | 管理员守卫（非管理员 redirectTo home + Toast） |
| `/pages/duty/index` | switchTab | — | 绑定守卫 |
| `/pages/schedule/manage` | navigateTo | `week`（可选） | 管理员守卫 |
| `/pages/members/index` | navigateTo | — | 管理员守卫 |
| `/pages/mine/index` | switchTab | — | 绑定守卫 |
| `/pages/mine/adjust` | navigateTo | `tab`(swap/leave，可选)、`focusId`（P2「去处理」定位） | 绑定守卫 |
| `/pages/mine/poster` | navigateTo | — | 管理员守卫 |
| `/pages/about/index` | navigateTo | — | 无 |

### 4.3 全局路由守卫（无感登录的入口，见第 9 章）

- `app.onLaunch`：`wx.cloud.init({ traceUser: true })` → 调 `auth` 云函数 `login` action → 结果写入 `getApp().globalData.session = { bound, role, member }`。
- 每个页面 `onShow` 调用 `guard.bind()` / `guard.admin()`（`behaviors/guard.js`）：绑定态不满足 → `redirectTo /pages/bind/step1`；角色不满足 → Toast「仅管理员可操作」+ navigateBack。
- 守卫期间（session 未就绪）页面渲染骨架屏，禁止发后续业务请求。
- 分享/扫码冷启动：`app.onLaunch(options)` 解析 `options.query.scene`（邀请码）暂存 `globalData.pendingScene`，step1 读取后自动填入口令。

### 4.4 关键跳转（与设计稿第 5 章一致，仅列差异）

- P1.1「扫码加入」→ `wx.scanCode`，不产生页面跳转。
- 发布成功页（P5 publish-success）不做独立页面，做成 P5 内的全屏遮罩层（避免占用页面栈），主按钮触发订阅授权、次按钮触发日历写入。
- 所有写操作按钮：`loading` + 300ms 防抖（`utils/debounce.js`），见第 17.3 节统一封装。

---

## 5. 组件拆分

### 5.1 基础组件（`components/`，与设计系统 C 编号一一对应）

| 组件 | 对应 | 关键 props | 关键事件 | 说明 |
|---|---|---|---|---|
| `nav-bar` | C1 | `title`、`left(text/back)`、`right-slot`、`subtitle` | `bind:right`、`bind:left` | 自定义导航：读 statusBarHeight；右侧插槽自动预留胶囊安全区（C5 修正：内容右缘 ≤ 260px） |
| `avatar-tag` | C14 | `name`、`size(32/36/40)`、`disabled` | — | 姓名首字圆牌；复姓取前两字字号降一级 |
| `status-pill` | C5 | `status` | — | 六态值日胶囊（颜色映射见 7.4） |
| `group-badge` | C5 | `tag('A'|'B')` | — | A 蓝 / B 紫 |
| `week-switcher` | C15 | `week`、`totalWeeks`、`statusPill` | `bind:change` | 左右箭头 + 中间点击弹周次选择；今天圆点 |
| `week-picker-sheet` | C15 | `visible`、`current`、`total` | `bind:pick` | 1–18 周 48×48 chip 网格 |
| `segmented` | C8 | `options`、`value` | `bind:change` | 200ms 动画 |
| `chip-group` | C16 | `chips[]`、`multi`、`disabledSet[]` | `bind:change` | 多选 chips（P1.3 无此需求；P3.1/P6/P7.1 用） |
| `stepper` | C17 | `value`、`min`、`max` | `bind:change` | 值日人数 1–4 |
| `notice-bar` | C18 | `type(warn/danger/info)`、`text`、`actionText` | `bind:action` | 待办条/未发布条/导入错误条复用 |
| `bottom-sheet` | C9 | `visible`、`title`、`maxHeight` | `bind:close` | 把手 + 遮罩点击 + 下拉关闭；内部滚动 |
| `dialog` | C10 | `title`、`content`、`mainText`、`subText`、`danger` | `bind:main`、`bind:sub` | 替代多处 wx.showModal，保证视觉一致 |
| `empty-state` | C12 | `icon`、`title`、`desc`、`actionText` | `bind:action` | 单色线稿插画（本地 svg 转 png） |
| `skeleton` | C13 | `type(hero/list/grid)` | — | ≥300ms 才显示，防闪烁 |
| `toast` | C11 | — | — | 封装 `utils/toast.js`（成功勾/失败叹号），不再用 wx.showToast 默认样式 |

### 5.2 业务组件

| 组件 | 用在 | props | 事件 | 职责 |
|---|---|---|---|---|
| `duty-hero` | P2 | `duty`(或 null)、`state` | `bind:confirm`、`bind:tap`、`bind:supplement` | Hero 卡 7 态（未开始/进行中/已完成/已请假/已换出/无值日/过期待补录），含撤销完成二次确认 |
| `course-cell` | P3 | `session`、`weekType`(单/双) | `bind:tap` | 56×68 课表格：学科色 S1–S5 循环、2 行截断、分组角标、非本周置灰 |
| `today-course-row` | P2 | `session` | `bind:tap` | 首页今日课次行 |
| `duty-row` | P4/P5 | `duty`、`variant(member/admin)`、`isMine` | `bind:tap`、`bind:action(换人)` | 值日行：头像+姓名+节次教室+状态胶囊；我的行高亮 |
| `duty-day-card` | P4/P5 | `date`、`duties[]`、`variant` | `bind:rowTap` | 日卡（卡头统计 + duty-row 列表 + 卡脚） |
| `duty-person-row` | P4 按人 | `member`、`weekStats` | `bind:tap`（展开） | 按人视图行 + 迷你进度块 |
| `member-row` | P6/P1.2 | `member`、`variant(pick/manage)` | `bind:tap` | 成员行（已绑定置灰不可选 / 管理态带状态标签） |
| `photo-uploader` | 值日详情 | `attachments[]`、`editable` | `bind:add`、`bind:remove`、`bind:preview` | 3 格缩略图 + 上传格；AUDITING 占位态 |
| `record-panel` | P5 语音通知 | — | `bind:publish(tempFilePath,durationMs)` | 按住说话环形进度（60s）、试听、重录；封装 RecorderManager |
| `voice-card` | P2 | `notice` | `bind:play` | 语音通知卡（播放/暂停 + 进度 + 已读标记） |
| `poster-canvas` | poster 页 | `inviteCode`、`className`、`qrFileId` | `bind:ready` | 离屏 Canvas 2D 合成邀请海报（第 12 章） |
| `week-duty-canvas` | P4 导出 | `weekData` | `bind:done(tempFilePath)` | 离屏 Canvas 2D 合成值日长图（第 13 章） |

### 5.3 utils / behaviors

| 文件 | 职责 |
|---|---|
| `utils/cloud.js` | `call(name, action, data)`：统一 envelope 处理、错误码 → 中文文案映射、401 未绑定跳转、防重复调用（同 action 进行中直接 reject） |
| `utils/auth.js` | `ensureAuth(scope)`：授权申请 → 拒绝后说明弹窗 → openSetting 引导 |
| `utils/audio.js` | RecorderManager 封装：计时器、格式参数、duration 双保险 |
| `utils/format.js` | 周次/日期计算（`term_start` + 7d × week + day）、单双周判断、节次时间映射 |
| `utils/canvas.js` | 离屏 Canvas 初始化（dpr≤2）、文本截断、分行 |
| `behaviors/guard.js` | 页面级绑定/管理员守卫 + session 就绪前渲染骨架 |
| `behaviors/paginate.js` | 名单/列表上拉加载（60 人内基本一次到位，预留） |

---

## 6. 页面交互与状态明细

> 通用状态约定：每页必有 `loading`（骨架 ≥300ms）/ `error`（C12 重试）/ `submitting`（按钮级 loading）。以下只写页面特有状态与数据来源；「数据来源」列即云函数调用（第 8 章）。

### P1.1 班级口令（pages/bind/step1）
- 状态：`default / typing(≥6位按钮可用) / error(红框+抖动) / loading / scanning`。
- 数据来源：`auth.checkToken({token})`（只验口令，不落库）；成功把 token 放内存 → navigateTo step2。
- 扫码加入：解析 scene → 预填口令并自动触发校验；解析失败 Toast「邀请码无效，请手动输入口令」。
- 口令错误 5 次锁 10 分钟（云函数侧按 openid 计数，见 8.2 auth.checkToken）。
- 协议行点击 → P8（锚点定位到协议区块）。

### P1.2 名单选人（pages/bind/step2）
- 状态：`loading / list / search-empty / picked`；已绑定成员行 45% 透明 +「已绑定」标签不可点。
- 数据来源：`member.list({ public: 'bind' })`（仅返回 id/name/studentNo/groupTag/bound，脱敏）。
- 搜索：姓名前缀 + 学号任意段匹配，本地过滤（60 人无需服务端搜索）。
- 底部条吸底：「就是我」→ navigateTo step3；返回保留滚动位置（页面缓存，不销毁）。

### P1.3 学号后 4 位验证（pages/bind/step3）
- 状态：`typing / error(抖动+剩余次数) / locked(Dialog) / loading / success(Toast→switchTab)`。
- 数据来源：`auth.bind({ token, memberId, studentNoLast4 })`。错误提示「你还有 N 次机会」（服务端返回 `remainAttempts`）；5 次失败锁 30 分钟（`locked`，Dialog 提供「联系生活委员」复制管理员联系方式）。
- 成功后 `globalData.session` 刷新为已绑定。

### P2 首页·今日（pages/home/index）
- 状态：`loading / unbound(守卫兜底) / normal / network-error`；Hero 七态由 `duty` 数据驱动。
- onShow 必拉：`duty.today`（返回：我的今日 duty、今日课次、待办数、未读语音通知、提醒开启态、管理员标志）——单接口聚合，避免 4 个请求。
- 交互：
  - 「确认完成」→ `duty.confirm`（允许提前 10 分钟至当日 23:59；成功后 Hero 变已完成 + 可撤销）。
  - 「撤销完成」→ Dialog 确认 → `duty.undoConfirm`（仅当日 23:59 前可撤销）。
  - 「补录确认」（过期待补录）→ `duty.confirm` 带 `expired:true`（服务端校验补录窗口：过期 ≤3 天）。
  - 「去处理」→ adjust 页定位到待确认申请。
  - 「开启」提醒 → 订阅授权（15.2）+ 日历写入（15.1），两项都完成后置「已开启」。
  - 语音通知卡播放 → InnerAudioContext，`onEnded` 标记已读 `media.markNoticeRead`。
  - 周日 24 点跨周边界：onShow 检测日期变化自动刷新 + Toast「已进入新的一周」。

### P3 课表周视图（pages/timetable/index）
- 状态：`loading / grid / empty-week / no-data / readonly(同学) / edit-mode(管理员多选删除)`。
- 数据来源：`course.listWeek({ week })` 返回该周 session 数组（服务端已按单双周规则展开为「本周实际上的课」）。
- 左右滑动切周（swiper 或 touch 位移 250ms 吸附）；点格子 → 课次详情 Sheet（`session` 直传，含值日人数与当前周值日名单）。
- 编辑模式：格子右上减号多选 → 底部「删除所选」→ `course.delete`（批量）。
- 管理员 FAB ＋ / 格子内「编辑」→ timetable/edit。

### P3.1 新增/编辑课次（pages/timetable/edit）
- 状态：`field-error / conflict / loading / edit-mode`。
- 提交前本地校验：课程名必填、星期≥1、节次必选、全周/单周/双周、值日人数 1–4。
- 冲突检查交给服务端：`course.upsert` 返回 `errCode 50010`（同星期同节次已有课）→ Dialog「该时间已有《xxx》」双按钮「覆盖」（传 `force:true`）/「换个时间」。
- 「保存并复制下周」= upsert 后再对 week+1 复制一条（仅当该周无同格冲突）。

### P4 本周值日表（pages/duty/index）
- 状态：`loading / day-view / person-view / unpublished-student(同学空态) / empty / archived(只读)`。
- 数据来源：`schedule.listWeek({ week })`：管理员返回草稿+已发布全量；同学仅已发布（草稿周返回 `unpublished:true`）。
- 分段「按日/按人」；按人行点击行内展开（高度动画 200ms）。
- 「导出」Sheet：保存为图片（第 13 章 Canvas）/ 导出 CSV（`export.weekCsv` → 云存储 → `wx.shareFileMessage`）。
- 值日详情 Sheet：本人可「确认完成 / 申请换班或请假」；管理员可「换人 / 标记完成 / 取消值日」；照片凭证区（photo-uploader）。

### P5 排班管理（pages/schedule/manage）
- 状态：`loading / generating / generate-fail / no-session / draft / published / unsaved-exit / publish-success(全屏遮罩)`。
- 数据来源：`schedule.listWeek({week, includeDraft:true})`、`schedule.getRules`。
- 「一键生成 / 重新生成」→ `schedule.generate({week, force:false})`：返回告警数组（同日重复/候选不足/请假冲突）→ 告警卡渲染；「候选不足」行点「处理」→ 替补选择 Sheet（候选=同组 ACTIVE 且当日无值日且未请假，按 duty_count 升序）。
- 「沿用上周」→ `schedule.generate({week, fromWeek: week-1})`。
- 行内「换人」→ Sheet 选替补 → `schedule.reassign({dutyId, toMemberId})`。
- 「发布给全班」→ `schedule.publish({week})` → publish-success 遮罩（开启订阅引导 + 日历写入 + 稍后再说）。
- 「撤回发布」→ Dialog 危险确认 → `schedule.unpublish`（仅发布后 24h 内且本周未开始前可撤回）。
- 未保存离开：页面有未发布调整时 `onUnload` 前用 Dialog 拦截（自定义导航返回键 + 物理返回均走 `wx.enableAlertBeforeUnload`）。
- 「规则设置」Sheet → `schedule.setRules`（轮转排序字段开关、同日最多 1 次开关、定时生成开关）。

### P6 成员与分组（pages/members/index）
- 状态：`empty / normal / import-sheet / import-error / unbalanced`。
- 数据来源：`member.list({ public:'manage' })`（全量字段）、`member.stats()`。
- 导入名单 Sheet：分段「粘贴 CSV / 选择文件」（V1.0 文件导入仅 txt/csv，`wx.chooseMessageFile` extension ['csv','txt']）→ `member.importCsv({text})`：服务端逐行解析 + `msgSecCheck` 批量审（第 14.1 节），返回 `{imported, failed:[{line,reason}]}` → 错误行列表最多显示 5 条。
- 成员详情 Sheet：调组（`member.updateGroup`，返回人数不均警告，按钮文案「调至 A/B 组」）、设/撤管理员（`member.setRole`）、停用/恢复（`member.setStatus`，停用不参与排班、保留历史）、解绑（`member.unbind`，危险 Dialog 二次确认，清空 openid）。
  - **选中自己时收敛操作（2026-09-24）**：不渲染「取消管理员 / 停用」——把自己取消管理员或停用会当场丢掉排班、解绑等权限，且只能等别人恢复；只保留「调至 A/B 组」与「解除微信绑定」。
  - **解绑自己的二次确认**：第一次 Dialog 说明后果（立刻失去全部管理权限、需重新用口令绑定），确认后再来一次「再次确认」，通过才调 `member.unbind`；成功后 `app.refreshAuth()` 刷新身份并 `reLaunch` 回绑定页，避免停在已失效的会话里。解绑他人仍是单次确认。
  - 绑定状态（`member.list` 的 `bound`，即 `!!openid`）在成员行**紧随姓名**显示（已绑定绿 / 未绑定灰），统计栏另给「已绑定」人数（`boundCount`，只在未搜索时按整班统计）。

### P7 我的（pages/mine/index）
- 状态：`unbound / normal / no-record`。
- 数据来源：`duty.myStats`（本学期次数/已完成/待确认 + 申请记录数）。
- 「添加值日到系统日历」→ 15.1；「开启微信提醒」→ 15.2；「我的换班/请假申请」→ P7.1；「班级邀请海报」（管理员）→ poster 页；「解除绑定」→ Dialog → `auth.unbind`。
- 我的申请记录列表内嵌 adjust 页（Tab 2），状态胶囊五态 + 「撤销」仅待确认态。

### P7.1 换班/请假（pages/mine/adjust）
- 状态：`no-duty / no-candidate / form / submitted(顶部信息条 24h 自动撤销提示) / submit-fail`。
- 换班：选我的值日 → 选对象（`adjust.swapCandidates({dutyId})`：本周同组、当日无值日、未请假）→ 原因 chips → `adjust.applySwap`。
- 请假：选值日（可多选本周期内）→ 日期范围 → 原因 chips → `adjust.applyLeave`。
- **原因仅预设 chips（有课冲突/身体不适/实习外出/其他），无自由文本**——保持设计稿红线；chips 文本为产品预置常量，不产生 UGC。
- 对方确认/管理员知会 → 15.2 订阅消息；状态机见 7.5。

### P8 关于与备案（pages/about/index）
- 纯静态：备案号（`#3370FF` 下划线，点击 `wx.setClipboardData` 复制 + Dialog 引导浏览器打开 `https://beian.miit.gov.cn`；小程序内不允许随意跳外部网页，用复制方案合规且可落地）。
- 「用户协议」「隐私政策」：本地内置长文本页面（`pages/about/agreement?type=privacy|terms`，纯静态 markdown 渲染，无 UGC）。
- 合规红线照设计稿：备案号真实、可点击、主色下划线；页面文案不出现「教育/教学/校园管理」。

---

## 7. 数据表结构（云开发 MySQL）

### 7.0 数据库约定

- 库名 `classassist`，InnoDB + utf8mb4；时间一律 `DATETIME`（东八区，连接参数 `timezone: '+08:00'`）。
- 所有金额/计数用整型；`openid` 全库唯一索引化；删除尽量软删（status/disabled）。
- 云函数统一 `mysql2/promise` 连接池（每实例 `connectionLimit: 5`，全局单例，见附录 A）。

### 7.1 全量 DDL（V1.0 落库版，含 UGC 扩容）

```sql
-- 1. 班级配置（单行）
CREATE TABLE class_config (
  id            INT PRIMARY KEY,                    -- 固定 1
  name          VARCHAR(64)  NOT NULL,
  term_start    DATE         NOT NULL COMMENT '学期第一周周一',
  total_weeks   TINYINT      NOT NULL DEFAULT 18,
  join_token    VARCHAR(32)  NOT NULL COMMENT '班级口令',
  invite_code   VARCHAR(16)  NOT NULL UNIQUE COMMENT '小程序码 scene 用的邀请码(8位随机)',
  period_time   JSON         COMMENT '[{"period":1,"start":"08:00","end":"08:45"}]'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 2. 成员
CREATE TABLE member (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(32)  NOT NULL,
  student_no    VARCHAR(32)  NOT NULL UNIQUE,
  group_tag     ENUM('A','B') NOT NULL,
  role          ENUM('ADMIN','MONITOR','MEMBER') DEFAULT 'MEMBER',
  status        ENUM('ACTIVE','LEAVE','DISABLED') DEFAULT 'ACTIVE',
  openid        VARCHAR(64)  DEFAULT NULL UNIQUE COMMENT '绑定后写入',
  duty_count    INT          DEFAULT 0 COMMENT '累计值日次数(轮转排序用)',
  last_duty_at  DATE         DEFAULT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_group_status (group_tag, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 3. 课程
CREATE TABLE course (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  name          VARCHAR(64)  NOT NULL,
  teacher       VARCHAR(32)  DEFAULT NULL,
  room          VARCHAR(32)  DEFAULT NULL,
  course_type   ENUM('ALL','GROUP') NOT NULL,
  duty_count    TINYINT      DEFAULT 1,
  created_by    INT          NOT NULL COMMENT 'member.id',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 4. 课次（排班原子单位）
CREATE TABLE session (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  course_id     INT          NOT NULL,
  week_rule     ENUM('ALL','ODD','EVEN') DEFAULT 'ALL' COMMENT '全周/单周/双周',
  day_of_week   TINYINT      NOT NULL COMMENT '1=周一',
  period        TINYINT      NOT NULL COMMENT '1-2上午 3-4下午 5晚上',
  group_scope   ENUM('A','B') DEFAULT NULL COMMENT 'NULL=全体课',
  duty_count    TINYINT      DEFAULT 1,
  KEY idx_slot (day_of_week, period, week_rule),
  KEY idx_course (course_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- 说明：原方案把 week 与 class_date 冗余进 session；现按「周规则」建模（更贴合设计稿
-- 单周/双周切换），具体某周的实例化课次由生成排班时计算 class_date，落进 duty 表。

-- 5. 值日
CREATE TABLE duty (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  session_id    INT          NOT NULL,
  week          TINYINT      NOT NULL COMMENT '学期周次 1-18',
  class_date    DATE         NOT NULL COMMENT '实例化日期(含单双周展开)',
  member_id     INT          NOT NULL,
  status        ENUM('PENDING','ONGOING','DONE','LEAVE','SWAPPED_OUT','EXPIRED') DEFAULT 'PENDING',
  source        ENUM('AUTO','MANUAL') DEFAULT 'AUTO',
  done_at       DATETIME     DEFAULT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_duty (session_id, week, member_id),
  KEY idx_date (class_date),
  KEY idx_member_week (member_id, week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
-- 注意：原方案 UNIQUE(session_id, member_id) 在「周规则建模」下会跨周冲突，
-- 改为 UNIQUE(session_id, week, member_id)，幂等语义不变（同周同课次同人唯一）。

-- 6. 值日操作日志
CREATE TABLE duty_log (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  duty_id       INT          NOT NULL,
  operator_id   INT          NOT NULL,
  action        ENUM('CREATE','SWAP','LEAVE','DONE','UNDO','CANCEL') NOT NULL,
  from_member   INT          DEFAULT NULL,
  to_member     INT          DEFAULT NULL,
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_duty (duty_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 7. 换班申请
CREATE TABLE swap_request (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  duty_id       INT          NOT NULL COMMENT '被调整的值日',
  type          ENUM('SWAP','LEAVE') NOT NULL,
  from_member   INT          NOT NULL,
  to_member     INT          DEFAULT NULL COMMENT 'SWAP 必填',
  start_date    DATE         DEFAULT NULL COMMENT 'LEAVE 用',
  end_date      DATE         DEFAULT NULL,
  reason        ENUM('COURSE','SICK','INTERN','OTHER') DEFAULT NULL COMMENT '预设chips',
  status        ENUM('PENDING_PEER','PENDING_ADMIN','DONE','REJECTED','CANCELLED') DEFAULT 'PENDING_PEER',
  expire_at     DATETIME     NOT NULL COMMENT '24h 未响应自动撤销',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_to (to_member, status),
  KEY idx_from (from_member, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 8. 请假单（批量日期，供排班过滤）
CREATE TABLE leave_request (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  member_id     INT          NOT NULL,
  swap_id       INT          DEFAULT NULL COMMENT '来源申请',
  start_date    DATE         NOT NULL,
  end_date      DATE         NOT NULL,
  status        ENUM('PENDING','APPROVED','REJECTED','CANCELLED') DEFAULT 'PENDING',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_member_date (member_id, start_date, end_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 9. 附件（照片/语音，UGC 核心）
CREATE TABLE attachment (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  biz_type      ENUM('DUTY_PHOTO','NOTICE_AUDIO') NOT NULL,
  biz_id        INT          NOT NULL COMMENT 'duty.id / notice.id',
  file_id       VARCHAR(128) NOT NULL COMMENT 'cloud:// 文件ID',
  mime          VARCHAR(32)  NOT NULL COMMENT '客户端声称类型',
  real_mime     VARCHAR(32)  DEFAULT NULL COMMENT '云端魔数校验结果',
  size          INT          DEFAULT 0,
  duration_ms   INT          DEFAULT NULL COMMENT '音频真实时长',
  audit_status  ENUM('AUDITING','PASS','BLOCKED') DEFAULT 'AUDITING',
  audit_trace   VARCHAR(64)  DEFAULT NULL COMMENT 'mediaCheckAsync trace_id',
  uploader_id   INT          NOT NULL COMMENT 'member.id',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP,
  KEY idx_biz (biz_type, biz_id),
  KEY idx_audit (audit_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 10. 语音通知
CREATE TABLE notice (
  id            INT AUTO_INCREMENT PRIMARY KEY,
  publisher_id  INT          NOT NULL COMMENT 'member.id(管理员)',
  audio_id      INT          NOT NULL COMMENT 'attachment.id',
  duration_ms   INT          NOT NULL,
  week          TINYINT      NOT NULL COMMENT '发布时学期周次',
  created_at    DATETIME     DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 11. 通知已读
CREATE TABLE notice_read (
  notice_id     INT          NOT NULL,
  member_id     INT          NOT NULL,
  read_at       DATETIME     DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (notice_id, member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 12. 排班规则（单行可扩）
CREATE TABLE schedule_rules (
  id            INT PRIMARY KEY,                    -- 固定 1
  sort_by_count TINYINT      DEFAULT 1 COMMENT '按 duty_count 升序',
  avoid_same_day TINYINT     DEFAULT 1 COMMENT '同日最多1次',
  avoid_back_to_back TINYINT DEFAULT 0 COMMENT '避免连续两周同一节次',
  cron_enabled  TINYINT      DEFAULT 1 COMMENT '定时自动生成草稿',
  cron_weekday  TINYINT      DEFAULT 0 COMMENT '0=周日',
  cron_hour     TINYINT      DEFAULT 20,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- 13. 绑定尝试限流
CREATE TABLE bind_attempt (
  openid        VARCHAR(64) PRIMARY KEY,
  fail_count    INT          DEFAULT 0,
  locked_until  DATETIME     DEFAULT NULL,
  updated_at    DATETIME     DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
```

### 7.2 云存储目录结构（与表结构配套）

```
photo/{yyyyMM}/{dutyId}/{memberId}_{ts}.jpg        值日凭证照片
audio/notice/{noticeId}/{memberId}_{ts}.mp3        语音通知
poster/{memberId}_{ts}.png                          邀请海报缓存（可再生成）
export/{week}_duty.csv                              CSV 导出
wxacode/{inviteCode}.png                            入班小程序码（发布后生成一次）
```

存储桶权限：**仅创建者可读写**。所有读取经云函数 `media.attachList` / `poster` 签发临时 URL（有效期 7200s，端上内存缓存）。

### 7.3 索引与规模复核

60 人 × 18 周 × ~20 课次 ≈ 2.2 万条 duty/学期；attachment 每学期 ≤ 数千条；所有查询走上面的 KEY，无全表扫描风险。

### 7.4 值日状态机（与设计稿状态色一一对应）

| 状态 | 颜色 | 进入条件 | 退出动作 |
|---|---|---|---|
| PENDING 待完成 | #86909C | 排班生成 | 确认完成→DONE；请假→LEAVE；换出→SWAPPED_OUT；过期任务扫描→EXPIRED |
| ONGOING 进行中 | #3370FF | 课次开始时间 ≤ now ≤ 结束 | 确认完成→DONE；过期→EXPIRED |
| DONE 已完成 | #00B42A | confirm（含补录，补录 ≤3 天） | undoConfirm（当日 23:59 前）→ 回 ONGOING/PENDING |
| LEAVE 已请假 | #FF7D00 | 请假过审 | — |
| SWAPPED_OUT 已换出 | #7C5CFF | 换班完成 | — |
| EXPIRED 过期待补录 | #F53F3F | 次日 06:00 扫描未确认的 PENDING/ONGOING | 补录确认→DONE（≤3 天）；超 3 天保持并计入统计「待确认」 |

### 7.5 换班/请假状态机

```
SWAP:  PENDING_PEER（待对方确认,24h） → 对方同意 → PENDING_ADMIN(知会管理员,立即生效*)
                                      → 对方拒绝/超时 → CANCELLED
LEAVE: PENDING_PEER →（本人申请即视为提交，管理员知会）→ APPROVED（写入 leave_request 生效）
撤销：PENDING_* 状态下申请人可 cancel
* 生效即写 duty：SWAP → from 改 SWAPPED_OUT、新建 to 的 duty(source=MANUAL)；LEAVE → duty 改 LEAVE，
  并把日期范围写入 leave_request 供后续排班过滤；全程写 duty_log。
```

---

## 8. 云函数清单与接口契约

### 8.1 通用约定

- 调用：`wx.cloud.callFunction({ name, data: { action, payload } })`。
- 响应 envelope：`{ errCode: 0, errMsg: 'ok', data }`；业务错误 `errCode > 0`（错误码表见 17.1）；系统异常 try/catch 兜底 `errCode: 50000`。
- 鉴权中间件（common/authGuard.js）：取 `getWXContext()` → 校验 `openid`、`APPID === process.env.WX_APPID` → 查 `member.openid` 得 session → 按 action 声明要求（`BIND` / `ADMIN`）校验角色 → 注入 `ctx = { openid, member }`。
- 日志：关键写操作 `console.log(JSON.stringify({action, member, target, result}))`，出问题可回放。

### 8.2 函数清单（11 个）

| # | 函数名 | 角色 | action | 入参（payload） | 出参（data） | 说明 |
|---|---|---|---|---|---|---|
| 1 | `auth` | 任意 | `login` | — | `{bound, role, member{id,name,groupTag}, config{name,termStart,totalWeeks}}` | 无感登录主入口；openid 无绑定记录时 bound=false |
| | | 绑定 | `checkToken` | `{token}` | `{ok}` | 校验口令；错误按 openid 记入 bind_attempt，5 次锁 10 分钟 |
| | | 绑定 | `bind` | `{token, memberId, studentNoLast4}` | `{remainAttempts?}` | 校验学号后 4 位；写 openid；成功清零尝试表 |
| | | 绑定 | `unbind` | — | — | 清 openid；管理员解绑他人走 member.unbind |
| | | | `resolveScene` | `{scene}` | `{token?}` | 邀请码 → 口令（仅口令本身，防枚举：无效返回 errCode 40004） |
| 2 | `member` | 绑定 | `list` | `{public:'bind'}` | `[{id,name,studentNoMasked,groupTag,bound}]` | 绑定态脱敏（学号打码） |
| | | 管理员 | `list` | `{public:'manage', kw?}` | 全量字段 | |
| | | 管理员 | `stats` | — | `{total, groupA, groupB}` | |
| | | 管理员 | `importCsv` | `{text}` | `{imported, failed:[{line,reason}], groupA, groupB}` | 逐行解析+文本审核+尾号分组；全量替换前 Dialog 确认（追加模式默认） |
| | | 管理员 | `updateGroup` | `{memberId, groupTag}` | `{warn?}` | 返回人数不均警告 |
| | | 管理员 | `setStatus` | `{memberId, status}` | — | ACTIVE/LEAVE/DISABLED |
| | | 管理员 | `setRole` | `{memberId, role}` | — | ADMIN/MONITOR/MEMBER |
| | | 管理员 | `unbind` | `{memberId}` | — | 清该成员 openid |
| 3 | `course` | 全员 | `listWeek` | `{week}` | `[{sessionId,name,teacher,room,dayOfWeek,period,groupScope,dutyCount,duties?}]` | 已按周规则展开本周实际课次；含该课次已排值日名单 |
| | | 管理员 | `upsert` | `{sessionId?, course:{name,teacher,room,courseType,dutyCount,weekRule,dayOfWeek,period,groupScope}, force?}` | `{sessionId}` | 冲突返回 50010 + 已存在课程名 |
| | | 管理员 | `delete` | `{sessionIds[]}` | — | 关联未发布周草稿一并删；已发布周需先撤回 |
| | | 管理员 | `copyFrom` | `{fromWeek, toWeek}` | `{copied}` | 复制上周（按课次全周规则展开） |
| 4 | `schedule` | 管理员 | `listWeek` | `{week, includeDraft}` | `{status:'DRAFT/PUBLISHED/ARCHIVED', days:[{date,duties[]}], warnings[]}` | 同学不带 includeDraft；草稿周对同学返回 unpublished:true |
| | | 管理员 | `generate` | `{week, fromWeek?}` | `{created, warnings[]}` | 轮转算法（8.3）；幂等：先删本周 AUTO |
| | | 管理员 | `reassign` | `{dutyId, toMemberId}` | — | 手动换人（校验候选资格） |
| | | 管理员 | `addManual` | `{sessionId, week, memberId}` | — | 空槽手动添加 |
| | | 管理员 | `remove` | `{dutyId}` | — | 取消值日 |
| | | 管理员 | `publish` | `{week}` | — | 草稿→已发布；触发全员订阅消息（15.2） |
| | | 管理员 | `unpublish` | `{week}` | — | 24h 内且本周未开始 |
| | | 管理员 | `getRules/setRules` | — / `{rules}` | `{rules}` | |
| 5 | `duty` | 绑定 | `today` | — | `{myDuty, sessions[], pendingSwapCount, unreadNotice, reminderOn, isAdmin}` | 首页聚合接口 |
| | | 绑定 | `confirm` | `{dutyId, expired?}` | — | 补录窗口校验（过期 ≤3 天） |
| | | 绑定 | `undoConfirm` | `{dutyId}` | — | 当日 23:59 前 |
| | | 绑定 | `myStats` | — | `{termCount, doneCount, pendingCount}` | |
| | | 绑定 | `detail` | `{dutyId}` | `{duty, attachments[], logs[]}` | 值日详情 Sheet 数据 |
| 6 | `adjust` | 绑定 | `swapCandidates` | `{dutyId}` | `[{id,name,groupTag,dutyCount,lastDutyAt}]` | |
| | | 绑定 | `applySwap` | `{dutyId, toMemberId, reason}` | `{swapId}` | |
| | | 绑定 | `applyLeave` | `{dutyIds[], startDate, endDate, reason}` | `{swapId}` | |
| | | 绑定 | `listMine` | — | `[{swapId,type,duty,date,to,status,createdAt,expireAt}]` | |
| | | 绑定 | `confirm` | `{swapId, agree:true/false}` | — | 对方操作 |
| | | 绑定 | `cancel` | `{swapId}` | — | 申请人撤销 |
| 7 | `media` | 绑定 | `attachList` | `{bizType, bizId}` | `[{id,url(temp),status,durationMs}]` | 供 photo-uploader/voice-card 展示 |
| | | 绑定 | `registerUpload` | `{bizType, bizId, fileId, mime, size, durationMs}` | `{attachmentId}` | 见第 10.3/11.5 时序；触发审核 |
| | | 绑定 | `deleteAttachment` | `{attachmentId}` | — | 本人或管理员；同时删云存储对象 |
| | | 绑定 | `markNoticeRead` | `{noticeId}` | — | |
| | | 管理员 | `publishNotice` | `{fileId, durationMs}` | `{noticeId}` | 建 notice + attachment；触发审核 |
| 8 | `poster` | 管理员 | `getInviteCode` | — | `{inviteCode, token}` | |
| | | 管理员 | `getQrcode` | — | `{fileId, url}` | wxacode.getUnlimited（scene=invite_code）；缓存至 wxacode/；发布前返回 errCode 50030 并提示（C4） |
| 9 | `export` | 绑定 | `weekCsv` | `{week}` | `{fileId, url}` | 生成 CSV 上传云存储（BOM 头，Excel 兼容） |
| 10 | `cron-weekly` | 系统 | （定时触发） | — | — | ① 每周日 20:00 生成下周草稿（幂等）② 每日 06:00 过期扫描（PENDING/ONGOING 且日期 < 今日 → EXPIRED）③ 每小时：swap_request 超时撤销、attachment 审核超 24h 未回调 → 置 BLOCKED（下架兜底）④ 每日 18:00 扫明日值日 → 订阅消息提醒 |
| 11 | `audit-receiver` | 系统 | （消息推送） | 微信推送的 `wxa_media_check` 事件 | `{}` | 按 trace_id 更新 attachment.audit_status（PASS/BLOCKED），BLOCKED 同时删云存储文件；5 秒内返回，不做重活 |

> 订阅消息发送不单独设函数：`schedule.publish` 与 `cron-weekly` 内直接 `cloud.openapi.subscribeMessage.send`。

### 8.3 排班生成算法（cron-weekly 与 schedule.generate 共用同一实现）

```
generateDuty(week):
  1. 实例化课次：week_rule 匹配（ALL / week%2==1→ODD / week%2==0→EVEN）
     class_date = term_start + (week-1)*7 + (day_of_week-1)
  2. 事务开始：
     删除本周 source=AUTO 的 duty（幂等，MANUAL 保留）
     for each session（按 class_date, period 排序）:
       candidates = group_scope 为 NULL ? ACTIVE 全员 : ACTIVE 且 group_tag=scope
         排除：当日已有非 SWAPPED_OUT duty 的人（avoid_same_day 开启时）
         排除：leave_request APPROVED 且日期覆盖 class_date 的人
         排除：status=DISABLED
       if candidates.length < duty_count → 记 warning{type:'SHORTAGE', sessionId, left}（不中断）
       sort by (duty_count ASC, last_duty_at ASC ASC, rand())  取前 N
       insert duty(source=AUTO)  -- UNIQUE(session_id,week,member_id) 兜底防重
       update member.duty_count++, last_duty_at=class_date
       insert duty_log(action=CREATE)
  3. 提交事务；返回 warnings
```

---

## 9. 无感登录与身份安全

### 9.1 为什么可以「无感」

- `wx.cloud.callFunction` 每次调用由微信网关注入调用者 openid，云函数 `cloud.getWXContext().OPENID` 直接可读——**不需要 `wx.login` + `code2Session`，也不需要 `wx.checkSession`**，没有 token 过期与续期问题，全程无感。
- 身份 = `member.openid`（一人一绑定，UNIQUE 索引强制）。
- 个人主体拿不到手机号/昵称/头像（C11），不引入任何授权弹窗即完成登录。

### 9.2 启动时序

```
app.onLaunch
  ├─ wx.cloud.init({ traceUser:true })
  ├─ await call('auth','login')            # 唯一登录动作，静默
  └─ globalData.session = { bound, role, member, config }
页面 onShow → guard.bind() / guard.admin()
  ├─ session 未就绪 → 骨架屏等待
  ├─ !bound → redirectTo /pages/bind/step1
  └─ role 不符 → Toast + navigateBack
```

- 冷启动竞态：login 与首个页面请求并发时，`utils/cloud.js` 内置「session 未就绪 → 排队等 login 完成再发」的 1s 超时兜底。
- 会话失效兜底：任何云函数返回 `40001 未绑定` 时清空 session 并 redirect 到 step1（例如后台被解绑）。

### 9.3 防冒名与防刷

- 绑定凭证：口令 + 名单选人 + 学号后 4 位（服务端比对，端上只显示打码学号）。
- 失败限流：bind_attempt 表按 openid 计数，5 次失败锁 30 分钟；口令错误 5 次锁 10 分钟。
- 调用方校验：每个函数校验 `APPID` 与环境匹配，拒绝非本小程序调用（C 铁律 2）。
- 解绑后历史 duty 保留（member 行不删），重新绑定不影响统计。

---

## 10. 图片上传（值日凭证照片）

### 10.1 端上采集

- `wx.chooseMedia({ count: 3 - 已有张数, mediaType: ['image'], sizeType: ['compressed'], sourceType: ['album','camera'] })`。
- 客户端校验：格式 jpg/png/webp（取 `tempFiles[].type`）；单张 ≤ 10MB（>10MB 用 `wx.compressImage({quality:60})` 后重取 size）；数量 ≤3。
- 授权：`chooseMedia` 系统面板自带；保存到相册场景见第 12/13 章（writePhotosAlbum）。

### 10.2 上传与存储

```
wx.cloud.uploadFile({
  cloudPath: `photo/${yyyyMM}/${dutyId}/${memberId}_${Date.now()}.jpg`,
  filePath: tempFilePath
}) → fileID
```

### 10.3 上传时序（先传文件、后登记、审核异步）

```
1. uploadFile → fileID
2. call('media','registerUpload',{bizType:'DUTY_PHOTO',bizId:dutyId,fileId,mime,size})
   → 云函数：
     a. 魔数校验（下载头 16 字节）：JPEG FFD8FF / PNG 89504E47 / WEBP RIFF..WEBP，
        不符 → errCode 41002「文件内容与格式不符」并删除对象
     b. getTempFileURL → cloud.openapi.security.mediaCheckAsync
        { version:2, scene:3, openid:上传者openid, media_type:2, media_url }
     c. INSERT attachment(audit_status='AUDITING', audit_trace=trace_id)
3. 端上立即展示「审核中」占位；回调（audit-receiver）→ PASS 后全班可见
```

- 失败重试：uploadFile 网络失败重试 1 次；registerUpload 失败则删除已传对象（避免孤儿文件）。
- 删除：`media.deleteAttachment` 同时删 DB 行 + `cloud.deleteFile`。

### 10.4 展示与隐私

- 展示 URL 全部来自 `attachList` 的临时链接；`wx.previewImage` 直接用临时 URL。
- 隐私指引声明「选中的照片或视频信息」（16.3）；不做 EXIF 剥离（MVP 风险接受，隐私政策中声明照片用途仅值日凭证）。

---

## 11. 音频上传（语音通知）与格式/时长校验

### 11.1 采集主路径：端上录音（C2 修正）

```js
const rm = wx.getRecorderManager();
rm.start({
  duration: 60000,          // 60s 自动 onStop（上限 600000，业务锁 60s）
  sampleRate: 16000,
  numberOfChannels: 1,
  encodeBitRate: 48000,
  format: 'mp3'             // iOS/Android 通用； AAC 为备选（部分安卓对 wav 支持不稳，不采用）
});
```

- 录音授权 `scope.record`：`ensureAuth` 拒绝 → openSetting。
- 录音面板（record-panel）：按住说话、松开停止、环形进度 60s、取消上滑；`onStop` → 试听（InnerAudioContext）→ 「发布」。

### 11.2 备选路径：导入已录音频（管理员，可选开启）

`wx.chooseMessageFile({ count:1, type:'file', extension:['mp3','wav','m4a','aac'] })`——只能从聊天会话选择（C2），产品上注明「请先把音频文件发送到任意微信聊天再选取」；云端校验同主路径。

### 11.3 时长双保险（端上）

- `onStart` 起本地计时器，UI 显示实时秒数；到 60s 强制 `rm.stop()`。
- `onStop(res)`：`duration = res.duration || 本地计时值`；两者差 > 1.5s 时以云函数解析结果为准（见 11.4）。

### 11.4 云端校验（最终裁决，防改后缀/超时长）

`media.registerUpload`（NOTICE_AUDIO）/ `media.publishNotice` 内：

1. **魔数校验**（下载头 32 字节）：
   - mp3：`ID3` 前缀 或 `FF Ex/FF Fx` 帧同步；m4a：`....ftypM4A`；wav：`RIFF....WAVE`；aac(ADTS)：`FFF1/FFF9`。与声称 mime 不符 → `errCode 41002`，删对象。
2. **真实时长解析**：`music-metadata`（纯 JS，云函数可用）解析 `format.duration`。
   - 时长 > 60s（含 2s 容差）→ `errCode 41003「语音不能超过 60 秒」`，删对象。
   - 时长 < 1s → `errCode 41004「语音太短」`。
3. **大小校验**：> 5MB 拒绝（60s/48kbps ≈ 360KB，正常远小于该值；防滥用上限）。
4. 通过 → 送 `mediaCheckAsync`（`media_type:1` 音频；微信支持 mp3/aac/wav 等，单文件 ≤10MB，C10）→ `AUDITING`。

### 11.5 播放

- `voice-card` 用 `wx.createInnerAudioContext()`（src=临时 URL）；播放完成 `onEnded` → `media.markNoticeRead`。
- 注意：临时 URL 7200s 过期，播放失败时先刷新 `attachList` 再重试一次。

---

## 12. 小程序码生成与邀请海报（Canvas 合成 ①）

### 12.1 小程序码（服务端）

- 接口：`cloud.openapi.wxacode.getUnlimited({ scene, page, checkPath, envVersion, width })`：
  - `scene = invite_code`（8 位随机串，≤32 字符）；`page = 'pages/bind/step1'`（不带前导 `/`）；
  - **发布前**：`envVersion:'trial', checkPath:false`（仅供内测，扫码提示未发布属正常，C4）；**发布后**：默认 release 全量生成，结果缓存到 `wxacode/{inviteCode}.png`，一次生成终身复用。
  - `config.json` 权限声明：`"wxacode.getUnlimited"`（附录 A）。
- 未发布时调用返回 41030 → `errCode 50030`，端上 Toast「小程序发布后才能生成正式入班码，可先用体验码内测」。

### 12.2 邀请海报合成（端上离屏 Canvas 2D）

```
pages/mine/poster
  onReady → poster.getQrcode() 拿码图临时 URL → wx.cloud.downloadFile → tempFilePath
  createSelectorQuery().select('#poster').fields({node,size})
  canvas.width = 690 * dpr(dpr≤2)   // 690×976 设计稿尺寸（345×488 @2x）
  绘制：白底 r24 → 标题「班级任务管理」→ 班级名（P6 配置）→
        码图 320×320 居中 → 口令文本「入班口令：XXXXXX」→ 页脚「扫码或搜索小程序加入」
  wx.canvasToTempFilePath({ canvas }) → 预览大图
  「保存到相册」→ ensureAuth(writePhotosAlbum) → wx.saveImageToPhotosAlbum → Toast 成功
  「转发」→ wx.showShareImageMenu({ path })  # 直接转发图片，无需开放分享能力
```

- 失败兜底：canvas 绘制失败 → 降级提供「复制邀请文案」（含口令），保证可传播。
- 同样的合成管线复用于第 13 章长图（组件 week-duty-canvas 与 poster-canvas 共用 utils/canvas.js）。

---

## 13. 值日表长图导出（Canvas 合成 ②）

- 数据：`schedule.listWeek({week})` 当前视图，仅「本周」，防超长（C7）。
- 尺寸：宽 750 物理像素（dpr≤2），高度按行数动态（预算 ≤ 4000px，超限截断 + 页脚注明）。
- 版式：标题（班级 + 第 N 周 · 日期范围）→ 按日 5 组（日期行 + duty 行：姓名/节次/教室/状态）→ 页脚「由班级任务管理生成」。
- 保存：`canvasToTempFilePath` → `saveImageToPhotosAlbum`；授权拒绝 → 说明 Dialog → openSetting（C8）。
- 失败：Toast「导出失败」+ 引导改用「导出为表格（CSV）」。
- iOS 真机必测项：dpr=3 机型、深色壁纸相册预览、60 人全排满的极端周。

---

## 14. 内容安全审核

### 14.1 文本（同步，入库前）

| 文本 | 时机 | 接口 | 参数 |
|---|---|---|---|
| 成员名单（姓名） | member.importCsv | `security.msgSecCheck` | `{openid:管理员, scene:2, version:2, content:全文拼接}`（整批一次审；命中则整批拒绝并报首行） |
| 课程名/教师/教室 | course.upsert | 同上 | `{content: 拼接字段}` |
| 班级名/口令 | 初始化配置 | 同上 | |
| 换班原因 | 固定 chips，**不审** | — | 无自由文本 |

- 命中（`result.suggest != 'pass'`）→ `errCode 43001「内容包含违规信息，请修改后重试」`。

### 14.2 媒体（异步，先审后显）

- 图片：`mediaCheckAsync {version:2, scene:3, media_type:2, media_url:临时URL, openid:上传者}`。
- 音频：同上，`media_type:1`；仅支持 mp3/aac/wav 等（微信侧限制），单文件 ≤10MB —— 与 11.4 的格式锁定天然一致。
- 频率限制：2000 次/分钟、20 万次/天（60 人场景远低于阈值）。

### 14.3 回调接收（audit-receiver）

1. mp 后台「开发 → 开发设置 → 消息推送」：启用，**接收方式选云函数**，绑定环境与 `audit-receiver`。
2. 事件体：`Event=wxa_media_check`，含 `trace_id / isrisky(0/1) / status_code`。
3. 处理：按 trace_id 更新 attachment；`isrisky=1` → `BLOCKED` + `cloud.deleteFile` 删源文件 + 上传者下次进值日详情 Toast 告知「照片未通过审核已移除」。
4. 必须 5 秒内 ack 返回；本函数只做单行 UPDATE，满足。

### 14.4 兜底与时序保证

- 「先审后显」：AUDITING 仅上传者与管理员可见 → 审核窗口内内容不会外泄。
- 审核超时：cron-weekly 每小时扫描 AUDITING 且 created_at > 24h → 置 BLOCKED（下架），人工在 mp 后台运维中心核查。
- status_code = -1008（链接无法下载）：重试 1 次（重新取临时 URL 送审），仍失败置 BLOCKED。

---

## 15. 提醒三件套落地

### 15.1 系统日历（tap 触发）

- `wx.addPhoneRepeatCalendar({ title:'查看本周值日', startTime, endTime, alarm:true, alarmOffset:900, repeatInterval:'week', repeatEndTime:学期末 })`；需 `scope.addPhoneCalendar`（C8）。
- 只写 1 条每周提醒（不表达单双周，C12）；入口：P7 功能行、P5 发布成功遮罩次按钮。已写入状态存本地 storage（`calendar_added`）。

### 15.2 订阅消息（一次性）

- mp 后台申请 3 个一次性模板：
  1. 「本周值日已发布」（变量：班级名、周次、我的节次数）——`schedule.publish` 全员下发（有额度才发）。
  2. 「明日值日提醒」（变量：日期、节次、教室）——cron-weekly 每日 18:00 扫明日 duty 逐人下发。
  3. 「换班/请假申请确认」（变量：申请人、内容、状态）——申请/同意/拒绝时对相关人下发。
- 端上攒额度时机（必须用户点击）：P2「开启」、P7「开启微信提醒」、P5 发布成功页主按钮。`wx.requestSubscribeMessage` 返回后记录 `subscription_on=true`（本地标记 UI 用）。
- 发送端错误处理：`43101`（用户未订阅/额度耗尽）静默跳过并计数；`send` 失败不阻塞主流程（publish 事务外异步）。
- 点击消息落地页：模板 1/2 → 值日表 Tab；模板 3 → adjust 页。

### 15.3 首页卡片

即 P2 Hero + 待办条 + 语音通知卡，`duty.today` 聚合返回，无需额外通道。

---

## 16. 权限与隐私合规

### 16.1 角色权限矩阵（服务端执行，端上仅控制渲染）

| 能力 | 同学 | 班委/管理员 |
|---|---|---|
| 课表/已发布值日 读 | ✓ | ✓ |
| 未发布草稿 读 | ✗（不可见） | ✓ |
| confirm / undoConfirm（本人） | ✓ | ✓ |
| 补录确认（≤3 天） | 仅本人 | ✓（任何人） |
| 换班申请/确认、请假申请 | ✓ | ✓ |
| 标记完成/换人/取消值日 | ✗ | ✓ |
| 课次增删改 | ✗ | ✓ |
| 排班生成/发布/撤回 | ✗ | ✓ |
| 名单导入/调组/停用/解绑/设角色 | ✗ | ✓ |
| 语音通知发布 | ✗ | ✓ |
| 邀请海报/入班码 | ✗ | ✓ |
| 导出 CSV/长图 | ✓ | ✓ |
| 删除他人附件 | ✗ | ✓ |

### 16.2 小程序运行时权限（scope）清单

| scope / API | 触发点 | 拒绝策略 |
|---|---|---|
| `scope.record`（录音） | P5 录音面板首次按住 | 说明 Dialog → openSetting |
| `scope.writePhotosAlbum`（保存海报/长图） | 保存按钮 tap | 同上 |
| `scope.addPhoneCalendar`（日历写入） | 「添加到日历」tap | 同上 |
| `wx.chooseMedia` 相册/相机 | 照片上传 | 系统面板内选择，无额外预授权 |
| `wx.scanCode` | P1.1 扫码 | 无需 scope；失败仅 Toast |
| 订阅消息授权 | 各开启按钮 tap | 拒绝则置 false，可再次点开（系统限频，须接受） |

### 16.3 「用户隐私保护指引」必配条目（mp 后台）

1. 微信 openid（登录与绑定）；
2. 学号/姓名（班级成员名单，由管理员代为录入，用于身份校验与值日安排展示）；
3. 相册（仅写入）——保存海报与值日长图；
4. 选中的照片或视频信息——上传值日凭证；
5. 麦克风——录制语音通知；
6. 日历（仅写入）——添加值日提醒。

### 16.4 平台合规项（沿用方案 v1.0，开发期同步推进）

- ICP 备案第 1 天提交（工信部短信核验 24h 内完成）；备案号在 P8 展示并可跳工信部。
- 类目「工具 → 效率」；文案统一「班级日程与值日安排工具」，规避教育类措辞。
- 测试账号 1 个（可登录的测试学号）随提审材料提交。
- 零支付、零营销、无位置信息 —— 不触发额外前置审批。

---

## 17. 异常处理

### 17.1 错误码总表（云函数 → 端上映射文案）

| errCode | 含义 | 端上表现 |
|---|---|---|
| 0 | 成功 | — |
| 40001 | 未绑定 | 清 session → redirectTo step1 |
| 40003 | 权限不足（非管理员） | Toast「仅管理员可操作」 |
| 40004 | 口令/邀请码无效 | step1 红框抖动 |
| 40005 | 验证次数超限（锁定） | locked Dialog（含剩余/解锁时间） |
| 40006 | 重复绑定（该成员已被其他微信绑定） | step2 该行不可点（列表态已拦截，此处兜底） |
| 40007 | 补录超窗（过期 > 3 天） | Toast「已超过可补录时间」 |
| 40008 | 撤回窗口关闭 | Toast |
| 41001 | 参数错误 | Toast「操作有误，请重试」（开发期带 detail 日志） |
| 41002 | 文件内容与格式不符 | Toast（图片/语音同码） |
| 41003 | 语音超过 60 秒 | 录音面板提示 |
| 41004 | 语音太短 | 录音面板提示 |
| 42001 | 网络超时/失败 | 整页 C12 重试 / 局部 Toast |
| 43001 | 内容审核未通过 | Toast「内容包含违规信息，请修改」 |
| 43101 | 订阅额度不足 | 静默（仅日志） |
| 50001 | 排班候选不足 | warnings 渲染告警卡（非异常） |
| 50010 | 课次时间冲突 | conflict Dialog（覆盖/换时间） |
| 50030 | 小程序码需发布后生成 | Toast 引导 |
| 50000 | 服务端未知异常 | Toast「服务开小差了，请稍后重试」+ 上报 |

### 17.2 端上统一封装（utils/cloud.js）

- 超时 10s（callFunction 无原生超时参数 → 用 `Promise.race`），超时按 42001 处理。
- 同 action 请求去重（进行中重复点击直接忽略）+ 300ms 防抖（写操作）。
- `errCode 40001` 全局拦截；`42001` 区分「页面级」与「按钮级」。
- 灰度开关：`globalData.config` 支持关停语音/照片功能（服务端开关，出问题可热关闭 UGC 面）。

### 17.3 可观测性

- 云函数日志按 `action + member + 耗时` 结构化输出；CloudBase 控制台告警：函数错误率 > 5%、cron 未按时执行。
- 端上 `App.onError` / `onUnhandledRejection` → `media` 外的轻量日志函数 `util.report()`（写 MySQL log 表，V1.0 仅管理员可见，可不建表直接云函数日志）。

---

## 18. 部署流程

### 18.1 环境准备（一次性）

1. 微信小程序注册（个人主体）→ 类目「工具-效率」→ 提交 ICP 备案（并行推进，最长路径）。
2. CloudBase 控制台创建环境（推荐上海）→ 开通**云开发 MySQL** → 记录内网连接地址。
3. 云函数「网络配置」→ 开启**内网互联**，选择 MySQL 所在 VPC/子网（C14）。
4. mp 后台：消息推送 → 云函数接收（先占位，audit-receiver 部署后绑定）；申请 3 个订阅消息模板并记录模板 ID。

### 18.2 数据库初始化

- 在 CloudBase MySQL 控制台（或临时开公网 + 白名单）执行第 7.1 章 DDL。
- 初始化脚本 `scripts/init.sql`：插入 `class_config`（id=1，name/term_start/total_weeks/join_token/invite_code）、`schedule_rules`（id=1）；管理员首次绑定后用 `member.setRole` 提权（或 init 时手工 UPDATE）。
- 密钥管理：MySQL 账号密码放**云函数环境变量**（每个业务函数同一组），禁止写死在代码。

### 18.3 云函数部署（微信开发者工具 / CLI 二选一）

- 开发者工具：`cloudfunctions/` 右键逐个「上传并部署（云端安装依赖）」；每个函数目录含：
  - `index.js`、`package.json`（`wx-server-sdk`、`mysql2`；media 函数加 `music-metadata`）、
  - `config.json`：

```json
{
  "timeout": 20,
  "envVariables": { "DB_HOST": "", "DB_USER": "", "DB_PWD": "", "DB_NAME": "classassist", "WX_APPID": "" },
  "permissions": {
    "openapi": [
      "security.msgSecCheck",
      "security.mediaCheckAsync",
      "wxacode.getUnlimited",
      "subscribeMessage.send"
    ]
  },
  "triggers": []          // 仅 cron-weekly 配置：
                          // [{ "name":"weekly", "type":"timer", "config":"0 0 20 * * SUN *" },
                          //  { "name":"daily",  "type":"timer", "config":"0 0 6 * * * *" },
                          //  { "name":"hourly", "type":"timer", "config":"0 0 * * * * *" },
                          //  { "name":"remind", "type":"timer", "config":"0 0 18 * * * *" }]
}
```

- CLI（CI 可选）：`@cloudbase/cli` → `tcb fn deploy <name> --env <envId> --dir cloudfunctions/<name>`。

### 18.4 小程序端发布

1. `project.config.json` 填 AppID + `cloudfunctionRoot: "cloudfunctions/"`；`app.js` 环境仅用 `cloud.DYNAMIC_CURRENT_ENV`/默认环境。
2. 开发版自测 → 传体验版 → 邀请 ≤14 名体验成员内测（个人主体上限）。
3. 完成隐私保护指引配置（16.3）→ 提审（附测试账号）→ 发布。
4. **发布成功后**：管理员进「邀请海报」页生成正式入班码（此时 getUnlimited 才可用，C4）→ 全班扫码入班。

### 18.5 回滚与应急

- 云函数：保留上一版本目录/zip，异常时重传旧版（5 分钟内完成）；UGC 功能异常 → 服务端开关热关闭（17.2）。
- MySQL：每日 CloudBase 自动备份；误操作用备份恢复到临时实例再导回差量。
- 配置项（口令/学期起点）改动直接改 class_config，无需发版。

---

## 19. 测试用例

> 「工具」= 微信开发者工具 + 真机（iOS/Android 各 1 台）+ 云函数本地调试/云端日志。

### 19.1 登录与绑定

| # | 用例 | 步骤 | 预期 |
|---|---|---|---|
| A1 | 无感登录 | 已绑定用户冷启动 | 直接进 P2，无任何授权弹窗；云函数日志可见 openid |
| A2 | 未绑定跳转 | 未绑定用户进任意 Tab | redirectTo P1.1 |
| A3 | 口令校验 | 输错口令 ×1 | 红框抖动；bind_attempt 计数 |
| A4 | 口令锁定 | 连错 5 次 | 第 6 次返回锁定，10 分钟后恢复 |
| A5 | 名单脱敏 | P1.2 查看列表 | 仅姓名/打码学号/分组/已绑定标记 |
| A6 | 已绑定拦截 | 选择已被绑定成员 | 行不可点 +「已绑定」 |
| A7 | 学号校验成功 | 输正确后 4 位 | Toast 绑定成功 → P2 |
| A8 | 学号校验失败 | 输错 | 抖动 + 剩余次数递减；1s 清空重新聚焦 |
| A9 | 验证锁定 | 连错 5 次 | locked Dialog；30 分钟内再试被拒 |
| A10 | 扫码进入 | 扫邀请海报码 | step1 口令自动预填 |
| A11 | 解绑重绑 | P7 解绑后重绑 | 历史值日与统计保留 |
| A12 | 重复绑定自身 | 已绑定再进 step1 | 守卫直接回 P2 |

### 19.2 成员与课表

| # | 用例 | 预期 |
|---|---|---|
| B1 | CSV 导入 60 人 | 导入成功；A/B 按尾号奇偶分组；错误行逐条列出 |
| B2 | 名单含违规词 | 整批拒绝，errCode 43001 |
| B3 | 调组不均警告 | A/B 相差 ≥2 时 P6 出警告条 |
| B4 | 课次冲突 | 同星期同节次再次保存 → 50010 Dialog；「覆盖」后旧课次被替换 |
| B5 | 单双周渲染 | ODD 课次在偶数周置灰斜纹；列表按周规则展开 |
| B6 | 复制上周 | 课次完整复制且不覆盖已有冲突格 |
| B7 | 文本审核 | 课程名含违规词 → 43001 |

### 19.3 排班与值日

| # | 用例 | 预期 |
|---|---|---|
| C1 | 一键生成 | 每课次 duty_count 人；duty_count 排序公平；同日 ≤1 次 |
| C2 | 幂等 | 同一 `week` 连续 generate 3 次，duty 行数不增、无 MANUAL 丢失 |
| C3 | 请假排除 | APPROVED 请假成员不出现在其请假区间 duty |
| C4 | 候选不足 | A 组全员请假时返回 warning，不中断生成 |
| C5 | 草稿可见性 | 同学 P4 显示「本周值日还没发布」；管理员可见草稿 |
| C6 | 发布/撤回 | 发布后同学可见；24h 内可撤回，超窗 40008 |
| C7 | 确认完成 | 状态 PENDING/ONGOING→DONE；统计 +1；duty_log 记录 |
| C8 | 撤销完成 | 当日 23:59 前可撤销；次日不可 |
| C9 | 补录 | 昨日 EXPIRED 可补录；>3 天返回 40007 |
| C10 | 过期扫描 | cron 后未确认昨日 duty 自动 EXPIRED |
| C11 | 定时生成 | 周日 20:00 触发生成下周草稿；重复触发不产生脏数据 |
| C12 | 换人/添加/取消 | 管理员操作后 duty_log 完整、统计正确 |

### 19.4 换班与请假

| # | 用例 | 预期 |
|---|---|---|
| D1 | 换班全流程 | 申请 → 对方确认 → duty 双向变更（from SWAPPED_OUT，to 新增 MANUAL） |
| D2 | 对方拒绝/24h 超时 | 申请 CANCELLED；hourly cron 撤销 |
| D3 | 请假生效 | APPROVED 后 duty→LEAVE；后续排班过滤生效 |
| D4 | 原因仅 chips | 无自由文本输入框；payload reason ∈ 枚举 |
| D5 | 订阅消息 | 各状态变更时相关人收到模板消息（有额度时） |

### 19.5 图片/音频/审核

| # | 用例 | 预期 |
|---|---|---|
| E1 | 照片上传 3 张 | 上传成功、AUDITING 占位、PASS 后全班可见 |
| E2 | 改后缀图片 | txt 改 .jpg → 41002 删除 |
| E3 | 违规图片 | mediaCheck isrisky=1 → BLOCKED + 源文件删除 + 不可见 |
| E4 | 审核超时兜底 | 造 AUDITING >24h 记录 → hourly cron 置 BLOCKED |
| E5 | 录音 60s 截断 | 到 60s 自动停；发布成功；时长入库 ≈60s |
| E6 | 改后缀音频 | wav 改 .mp3 → 魔数不符 41002 |
| E7 | 超长音频 | 本地拼 70s 音频经备选路径 → 41003 |
| E8 | 播放与已读 | 通知卡播放结束标记已读；未读数清零 |
| E9 | 非管理员发语音 | 云函数 40003；端上无入口 |

### 19.6 码/Canvas/提醒

| # | 用例 | 预期 |
|---|---|---|
| F1 | 未发布生成码 | 50030 引导提示；体验码路径可用（checkPath=false） |
| F2 | 发布后生成码 | 正式码生成并缓存；重复生成不重复调 API |
| F3 | 扫码解析 | scene→invite_code→口令预填；伪造 scene → 40004 |
| F4 | 海报保存 | 相册出现海报；拒绝授权 → openSetting 引导后可保存 |
| F5 | 长图导出 | iOS/Android 真机各过；60 人极端周不超 4000px |
| F6 | CSV 导出 | 文件带 BOM，Excel 打开中文不乱码；shareFileMessage 成功 |
| F7 | 日历写入 | 授权后写入 1 条每周重复事件；重复点击不重复写 |
| F8 | 订阅授权 | 点击触发弹窗；同意后次日 18:00 收到明日提醒 |

### 19.7 权限与安全

| # | 用例 | 预期 |
|---|---|---|
| G1 | 越权调用 | 普通同学直调 schedule.publish → 40003 |
| G2 | 端上直连 DB | 小程序内无任何 DB 凭据；抓包无连接串 |
| G3 | 伪造调用源 | 非本 AppID 调用（改 APPID env）→ 拒绝 |
| G4 | 附件越权删除 | 同学删他人附件 → 40003 |
| G5 | 临时 URL 过期 | 7200s 后旧链接失效，前端刷新重取成功 |

---

## 20. 验收清单（上线门槛）

**功能**
- [ ] P1.1–P8 共 13 个页面 + 6 弹层全部可用，状态覆盖设计稿标注的异常/空/加载态
- [ ] 60 人 × 18 周数据量下首页首屏 < 1.5s；排班生成 < 3s
- [ ] 60 人全部绑定成功；冒名绑定、重复绑定被拦截
- [ ] 排班：无同日重复、请假者不排、候选不足有告警、幂等（重复执行 3 次无脏数据）
- [ ] 换班/请假全流程 + 24h 自动撤销；duty_log 完整
- [ ] 照片上传 ≤3 张、审核前后可见性正确、违规即删
- [ ] 语音通知 ≤60s、格式/时长云端校验生效、播放/已读闭环
- [ ] 发布后入班码可扫、海报可存相册、值日长图 iOS/Android 均可导出
- [ ] CSV/长图导出可用；日历写入成功且按周重复；订阅消息至少一条真实送达

**安全与合规**
- [ ] 所有云函数完成角色校验；同学调用管理员 action 返回 40003
- [ ] 端上无数据库凭据；APPID 校验生效
- [ ] 全部 UGC 过审后展示（文本同步、媒体异步 + 超时下架）
- [ ] 隐私保护指引 6 项已配置且与实际调用一致
- [ ] ICP 备案通过；P8 备案号展示且可跳转工信部系统；类目为「工具-效率」

**工程**
- [ ] cron-weekly 四个触发器按时执行且有日志与告警
- [ ] MySQL 自动备份开启；云函数上一版本可 5 分钟回滚
- [ ] 错误码 17.1 全部有端上文案；UGC 热开关可用

---

## 附录 A：云函数目录与公共模块

```
cloudfunctions/
  common/                       # 构建时复制进每个函数目录（脚本 sync.js）
    db.js                       # mysql2 连接池单例（connectionLimit:5, timezone:'+08:00'）
    guard.js                    # getWXContext 校验 + session 解析 + 角色断言
    resp.js                     # envelope {errCode, errMsg, data}
    week.js                     # 学期周次/class_date/单双周计算（与端上 utils/format.js 同源）
    audit.js                    # msgSecCheck / mediaCheckAsync 封装（trace 落库）
  auth/ member/ course/ schedule/ duty/ adjust/ media/ poster/ export/
  cron-weekly/                  # 含 triggers 配置
  audit-receiver/               # 消息推送接收端（无 DB 写以外逻辑）
scripts/
  init.sql  sync.js  deploy.md
```

## 附录 B：环境变量清单（每个业务函数相同）

| 变量 | 说明 |
|---|---|
| `DB_HOST` / `DB_PORT` | MySQL 内网地址 |
| `DB_USER` / `DB_PWD` | 数据库账号（最小权限：仅 classassist 库） |
| `DB_NAME` | `classassist` |
| `WX_APPID` | 用于调用方校验 |
| `TEMPLATE_*` | 3 个订阅消息模板 ID |

## 附录 C：开发排期对齐（沿用方案 v1.0，微调）

W1 绑定+名单（含 CSV 审核链路）→ W2 课表+周视图 → W3 排班+值日+首页 → W4 提醒三件套+统计+导出（Canvas）→ W4.5 UGC 增量（照片/语音/审核回调/海报）→ W5 备案号页+隐私+提审。UGC 增量约 3 人日，已并入 W4–W5。
