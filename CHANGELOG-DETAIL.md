# 更新日志（详细版）

> **用途**：记录每一版的**背景 / 根因 / 改动文件 / 影响面 / 门禁 / 部署状态**，供回溯与排查。
> **与简版分工**：`CHANGELOG.md` 面向「用户能感知的变化」；本文件面向「改了什么、为什么、影响谁、怎么验」。
> **与 DETAILS 分工**：`.workbuddy/memory/DETAILS.md` 是开发过程流水（按主题编号 §1…）；本文件按**版本号**归档，一个版本一节。
> **写法**：每个版本一节，条目用「问题 → 根因 → 改动 → 影响 → 验证」结构；能贴文件路径就贴。

---

## v0.7.44 · 2026-10-16（后台修复 2026-10-18 收官） · 对外 1.0.7.0
**主题：移除失效提醒入口 + 头像可更换 + 后台使用统计**

> 口径：三块小程序端改动（提醒入口移除 / 头像可换 / 埋点+统计页）+ 后端新增 `stat` 云函数与 `usage_event` 表。2026-10-18 当天对统计功能做了四轮修复并全部部署验证，一并纳入本版。门禁 **87/87 全绿**。

### ① 移除失效提醒入口
- **问题**：「添加值日到系统日历」「值日微信提醒」两个入口从未生效（订阅消息链路未打通），首页还有「打开微信通知页」悬浮胶囊，留着会造成误导。
- **改动**：删 WXML/WXSS/JS 全链路（含 `legal.js` 的微信能力说明）；后端 `remind_block` / `remind_reopen` 字段**保留**（删列风险大于收益），门禁 `check-clean-label.js` 改为看守这两个字段而非 UI 文案。
- **影响**：纯前端删除，无数据面变化。

### ② 「我的」头像可更换（2026-10-18 二次修正：button 退出文档流）
- **问题**：原实现是「透明 `<button>` 叠在自定义头像组件上 + z-index 抬层」，真机偶发收不到点击。
- **改动**：`miniprogram/pages/mine/index.wxml` 改用 `<button open-type="chooseAvatar">` 触发换头像；`binderror` 兜底隐私拒绝（不再红屏）。
- **第一次修正（`c010544`，用户报「头像占位太大了」）**：初版把 `<avatar-tag>` **自定义组件**放进了按钮内，真机上它被渲染到按钮**右侧外面**、按钮按「内容宽 + 默认 padding」撑大、头像右移。改为按钮内只放**内置组件**（`<image class="avatar-img">` 80rpx 圆 + `<view class="avatar-fallback">` 姓氏色块），头像回到 80rpx 圆内。回落字符由 JS `_avatarChar()` 预计算（WXML 不支持方法调用，`slice()` 会静默失效，`check-wxml.js` 抓出），5 处 setData profile 同步带 `avatarChar`；图片加载失败记 `avatarErrSrc` 回落色块，换头像后 src 变化自动恢复。
- **第二次修正（2026-10-18 晚，用户复报「占位还是太大、头像要往左，不是只变小」）**：截图二次量化（464×937，卡宽 686rpx ≈ 376px ⇒ **1rpx≈0.548px**）——
  - 卡片左边缘 x=51，内容左边界（+32rpx padding）x≈68.5；
  - **头像左边界 x=137**，即两者之间有 **68.5px ≈ 125rpx 纯空区**；该空区 7000+ 像素里 46 种颜色全为 `#e8f3ff` 系（卡片底色），**没有按钮底色也没有描边** ⇒ 空框不是「看得见的框」，而是按钮占掉的布局宽度；
  - 姓名被顶到 x≈268（≈365rpx），`示例成员01` 因此折成两行。
  - **结论：`button` 只要参与布局就必然被撑宽（≈80rpx 内容 + 微信默认 14px×2 padding），与里面放自定义组件还是内置 `<image>` 无关。** 所以第二次改成**按钮彻底离开文档流**：`.avatar-slot`（80rpx 定宽 + `position:relative`）里放正常流的头像图/回落色块，`<button class="avatar-btn">` **留空**、`position:absolute; left:0; top:0; width/height:80rpx`、`padding:0`、`box-sizing:border-box`，只当点击层。按钮不占布局 ⇒ 撑不大、推不动兄弟元素，头像必然贴左、姓名回归一行。
  - 门禁 `check-tap-layer-zindex.js` **整份重写**：判据从「button 内必须有 image」翻转为「button 必须留空 + 必须 absolute + 槽位必须 relative + padding 归零」，并抽成「共享判据 + 变异自证」结构（真跑与变异走同一份 `checks()`，避免判据漂移）；变异 6 组：M1 去 `open-type`、M2 去 `bind:chooseavatar`、M3 去 `binderror`、M4 去掉 `position:absolute`（回文档流 ⇒ 空框复现）、M5 往空按钮塞 `<image>`、M6 去掉槽位 `position:relative`。**6/6 全抓**，全量门禁 **87/87**。
  - 渲染验证：Chrome 无头 harness 先注入**微信 button 默认样式**（padding 14px / `::after` 描边 / line-height 2.55）再叠页面 wxss，三场景（有头像 / 「宋」/ 「我」）**18 条断言全过**：槽位贴内容左边界、头像贴槽位左上、按钮与槽位零偏移且 40px 不膨胀、无描边、信息区紧邻 12px。⚠️ Chrome 无法复现微信真机的按钮膨胀（层叠行为不同），故 harness 只能作「新结构正确」的证据，不能当「旧结构会变红」的负对照 —— 旧结构的红由门禁变异 M4/M5 保证。

### ③ 后台使用统计（新增，含 2026-10-18 四轮修复）
- **新增**：小程序端 `utils/track.js`（内存队列 + 防抖 1.5s + 批量上限 30 条，失败静默丢弃）+ `app.js` 挂 `getApp().track`；各页 `onShow` 调 `pageView`，首页班费/团费/通知/班级/名册/请假与「我的」关于/切换账号入口调 `action`（一律 `if (getApp().track)` 防御，防 mock 环境崩页面）。云函数 `stat` 的 `track` action 批量落 `usage_event(openid,class_id,kind,event,ref,ts)`；建表 SQL = `scripts/migrate-usage.sql`。后台 admin-web 新增 `lib/mod-usage.js`（`/api/usage`：按 event 聚合 PV/UV + 每日趋势 + 成员明细）、`index.html` 「使用统计」页签、`public/app.js` `renderUsage`、`admin.css` 柱状样式。
- **四轮修复（2026-10-18，均只影响网页后台）**：
  1. **Error 1052（选班级即 500）**：members 查询 `LEFT JOIN member` 后裸列名 `class_id` 二义（member 也有该列）——自建带 `e.` 前缀条件；根因是首轮只验了 `classId=0`（无该条件不触发）。
  2. **刷新不保留现场**：localStorage 键 `admin.web.view` / `admin.web.classId` / `admin.web.usageAll` / `admin.web.usageDays`；`showMain` 读回（班级不在列表回退第 1 个、view 不在 `VIEWS` 回退 overview）。
  3. **刷新闪现登录页**：`index.html` 的 `#login-view` 默认可见 + `boot()` 才异步分流 ⇒ 接口返回前一直挂登录页。改为登录页默认 `hidden` + 新增 `#bootstrap` 加载态（与登录页同渐变）+ 内联 5s 兜底定时器（app.js 挂了放行登录页，不卡死）；`boot()` 清定时器，`showLogin`/`showMain` 两个分流出口都撤加载态。
  4. **绑定页文字不对齐 + 统计布局/「全部」失效**：`.summary` 类在 `admin.css` 里没有规则（card-hd 有 16px 左距、summary 为 0）⇒ 补样式对齐；统计工具栏两行改一行左右布局（时间范围左 / 班级范围右），「仅当前班级」去班名后缀（右上角已有）；「全部」按钮失效根因是 `if (!state.usageDays)` 把 **0 当 falsy** 改回 30 ⇒ 改 typeof 判断，后端 `trendDays = days || 30` 的回显撒谎同批修。
- **验证**：`node --check` + 门禁 87/87；无头 harness（真实 app.js + 复刻 DOM + mock fetch）12 项断言先红后绿；`days=0` 新路径 `tcb db execute` 等价 SQL 四连验（total/rows/members/daily）全过；线上 `/admin`=200、`/api/usage?days=0`=401（未登录）、Code size 2233618、Modification time 2026-10-18 12:09:53、日志无 `[api-error]`。
- **部署状态**：`usage_event` 表已建（生产库）；`stat` / `admin-web` 已部署（`fee` 同批重部署，无改动）。

### ④ 值日页去掉按日 / 按人切换，仅留按日（收尾，随 1.0.7.0 前端上传一并生效）
- **问题**：值日页原先有「按日 / 按人」两种视图切换（segmented 控件），按人视图长期无人使用、且增加维护与门禁成本。
- **改动**：`miniprogram/pages/duty/index.wxml` 删除 segmented 切换控件、按人视图整块（dt-personcard / dt-person / expandId / onExpand / cnt-num / dt-progress / dt-block）、`mode`/`persons`/`expandId` 数据与 `onMode`/`_flipMode`/`_toPersons`/`onExpand` 方法；`index.json` 移除 `segmented` 组件声明；`index.wxss` 清除纯按人样式、`.dt-modebar` 改 `justify-content:flex-end`（仅剩「已结束」pill 右对齐）；`index.js` 移除 `listTransition` 依赖。
- **门禁**：`check-duty-ended.js`（A 节改全文件 `wx:for="{{activeDays}}"` 且无 `wx:for="{{days}}"` 断言、A3 去按人符号、B1 改判「不再带 mode==='day'」、G 删整周取数随按人视图移除的判据）、`check-count-align.js`（duty 的 COUNT_SITES 由 `[1,1]` 改 `[0,0]`、`.cnt-num` 校验包进 `if (nDuty+nWeek>0)`）、`check-permission-delegate.js`（canSchedule 入口期望 6 → 5）同步改写；三者及 duty 相关 16+ 门禁全绿。

### ⑤ 手动排版放开重复排班（2026-10-21）
- **问题**：手动排班（P5）时，当天或当周已有值日的人员被硬拦截，无法再次被安排——超管想灵活补排时被卡。
- **根因**：`cloudfunctions/schedule/index.js` 的 `addManual` 与 `reassign` 各有一段 `busy` 查询（按 `class_date` + `member_id` 查当天已有值日）并 `throw BizError(41001, '该同学当天已有…值日')`；前端 `miniprogram/pages/manual/index.js` 的 `_openPicker` 用 `busyIds` 算 `sameDay` 把这些人置灰、标「当天已有值日」。
- **改动**：云函数两处 `busy` 查询 + 同天 throw 整段移除（保留「同一课次同一周不重复」的 `existing`/`uq_duty` 判据、分组课分组、请假三条硬规则）；前端移除 `busyIds`/`outgoing`/`sameDay` 计算与「当天已有值日」badge，`disabled` 仅剩 `inThis || onLeave || groupBad`。`duty` 页「加值日生」入口（`onAddPickMember`）原本只挡同课次、不挡同天，随云函数放开一并允许。
- **补（2026-10-21 用户实测仍报「不可安排」，遗漏路径）**：值日页 / 值日详情弹层「选人换班 / 换人 / 添加」走 `components/duty-sheet` → `adjust.swapCandidates` 取候选，原 `cloudfunctions/adjust/index.js` 的 `swapCandidates` 用 `busySet`（查当天已有值日）把这些人从候选列表剔除，导致弹层根本选不到当天已排的人。已移除该 `busy` 查询与 `busySet` 过滤，候选仅保留「请假（onLeave）」剔除；`miniprogram/pages/manual/index.wxml` 文案「/ 当天已有值日」一并删除。该组件对 SWAP/REASSIGN/ADD 三种动作均取 `swapCandidates`，故改这一处即让三个动作都能选到当天已排的人（执行侧 `applySwap`/`confirm`/`reassign`/`addManual` 均无同天拦截，同课次同周由 `uq_duty` 兜底）。
- **影响**：`duty` 表唯一键为 `uq_duty(session_id, week, member_id)`（非 `(class_date, member_id)`），移除后同一人同天不同课次可共存，无唯一键冲突；`duty_count` 仍按手动 +1（轮转位置由自动排班决定，事后手动补排不回滚，与既有口径一致）。
- **验证**：`node --check` 三文件（`adjust`/`schedule`/`manual/index.js`）通过；全仓 grep 无残留同天硬拦截；`check-committee` / `check-duty-columns` / `check-duty-ended` / `check-duty-marker-symmetry` / `check-duty-rotation` / `check-duty-stats-source` / `check-duty-week-sync` / `check-round-robin` / `check-schedule-generate-runtime` / `check-session-shift` / `check-shift-move` 11 个相关门禁全绿。

---

## v0.7.42 · 2026-10-15 · 对外 1.0.6.9
**主题：课表编辑与周次细节 + 值日页精简**

> 口径：本次同时纳入工作区里一批已完成的功能改动（班费/团费、课表编辑弹层、审核体验入口改为超管开关、部署脚本改造等），与本轮三次修复合并为一个版本上传。前端待上传。门禁 **84/84 全绿**。

**① 背景与用户诉求（均来自用户实锤）**
- 「课程表页加载特别慢」→ 量化诊断见 `outputs/课表页加载慢-诊断报告.md`（**诊断完成，修复未实施**，线上已回滚）。
- 「删除这个提示」（班费弹层的「仅查看，无法修改或删除」横幅）。
- 「值日页不要加值日」。
- 「书香校园没显示 / 多了一节空行 / 没按我写的时间」→ 三轮修复（周次区间、行数自适应、短课归位）。

**② 改动一：课表页新增编辑课次**

- 弹层 `formShow` 复用为「新增课次 / **编辑课次** / 添加选修课 / 编辑选修课」四态（标题按 `formMode` + `sessionId` / `electiveId` 切换）。
- 可编辑字段：课程名称、教师、教室、星期、大节、每节值日人数（与后台 `admin-web` 的课次编辑同口径）。
- 后端 `course` 云函数对应 action 已上线。

**③ 改动二：周次区间写法 `6-13`（端上 / 后端同口径）**

| 位置 | 原实现 | 对 `6-13` 的结果 |
|---|---|---|
| `miniprogram/data/timetable.js matchesWeeks` | `split(',') + Number()` | `Number('6-13')` = NaN ⇒ **整批周次全丢** |
| `cloudfunctions/common/week.js parseWeeks` | `parseInt('6-13')` | = **6** ⇒ 第 7~13 周静默丢弃 |
| `admin-web/public/app.js normalizeWeeks`（课表导入器） | 支持区间 | ✅ 一直正常 |

- 根子：**三条录入入口里只有「添加课次」没做区间归一化** ⇒ 两对一错。
- 修：三处统一为 `^(\d+)\s*-\s*(\d+)$` 区间展开（自动纠正 `13-6` 反写）；`mod-course.addSession` **落库前先 `parseWeeks` 归一化**，库里不再出现裸区间。

**④ 改动三：allSessions 回传 duty_count**

- `course.allSessions` 的 SQL **漏取 `duty_count`** ⇒ 端上 `data/timetable.js` 两处只能写死 `dutyCount: 2` ⇒「不排值日」（`duty_count=0`）的课在课表详情显示成 2 人。
- 修：SQL 补 `s.duty_count`、返回补 `dutyCount`；端上改 `(s.dutyCount === 0 || s.dutyCount) ? Number(s.dutyCount) : 2`（**不能用 `|| 2`，会把 0 吃掉** —— 与 duty_count=0 通道同一个坑）。

**⑤ 改动四：课表行数随周次自适应**

- 平时一天五节大课，第 6 节是短课特殊时段；原实现无条件按 `period_time` 画满 ⇒ 没有第 6 节课的周次多出一整行空格子。
- 改为 **`nPeriods = max(1, tt.periodCount(), maxUsedPeriod)`**，`maxUsedPeriod` = 本周全部课次里出现的最大 period（排除「调出」的课）。
- ⚠️ 判定按整周 `courses` 而非当前分组视图，与同页 `hasWeekend`（周末列）**同口径** —— 否则切 A/B 组时网格在 5↔6 行间跳动。

**⑥ 改动五：短课归位（产品口径，用户拍板）**

- 短课时间与既有大节**重叠**时 ⇒ **归到时间重叠的那个节次**，不新增第 N 行大节。
- 生产库修正三班 5 条「书香校园」：示例班级A 周四 6→4；2601 周二/周四 6→1；示例班级B 周四 6→3；示例班级B 周一 7→1。同批删除三班 `period_time` 的第 6/7 行（已无课次使用，`JSON_LENGTH` 复核 = 5）。
- ⚠️ 以后加短课：**不要**新增大节配置行，直接归到时间重叠的大节（**一格两课是预期行为**）。

**⑦ 改动六：值日页隐藏「+ 加值日生」**

- `pages/duty/index.js` data 加开关 `showAddDutyBtn: false`；`index.wxml` 的 `wx:if` 改 `{{canSchedule && showAddDutyBtn}}`。
- **保留** `onAddOpen` 等全部逻辑与 `bottom-sheet`、后端接口 ⇒ 恢复只需把开关改回 `true`。
- `check-permission-delegate` ④段判据同步：接受两种形态，**总数 6 仍是硬要求**。

**⑧ 改动七：班费弹层去重**

- 删除 `.fee-viewonly-hint` 横幅（wxml + wxss）。它与标题「班费 · 仅查看」重复，而「增加消费」按钮本就受 `feeCanManage` 控制不渲染 ⇒ 双重提示反而像坏了。
- 🔴 权限口径不变：非管理者仍无增删改入口，身份提示仍在卡片「查看」标签与弹层标题里。

**⑨ 门禁与部署**

- 全量门禁 **84/84 全绿**（84 项含 `check-period-count` 24 项、`check-admin-web` 46 项）。
- `check-admin-web` 因宿主 `fs.rmSync` 垫片单次 ~9s 而累计 71s 超批跑阈值 ⇒ 改为整轮统一清理（`cleanupMutDir`），71s→18s，批跑 9min→35s。

**⑩ ⚠️ 未实施的诊断（课表页慢）**

- 结论：端上计算 0.058ms/次、网络 25–31ms 均正常，**推断**主因是云函数包体积（`class` 线上 11.77MB）。
- 🔴 踩坑记录：`--install-dependency false` 会把 `node_modules` 一起丢掉（线上依赖全缺失、函数崩溃），**已回滚**。详见 `outputs/课表页加载慢-诊断报告.md`。

---

## v0.7.41 · 2026-10-15 · 对外 1.0.6.8
**主题：班费 / 团费模块（新云函数 + 两表）+「我的 → 更多」入口收纳 + 首页刷新与课次行视觉修复**

> 口径：新增 **`fee` 云函数（已部署，含 VPC + 5 个 DB_* 环境变量）**，新增 **`class_fund` / `class_fund_record` 两张表（生产已建）**；其余为前端改动，前端待上传。门禁 **84/84 全绿**。

**① 背景与用户诉求**
- 「首页要有班费、团费卡片，能看到余额、能记消费、能设总额」——新增整个班费/团费模块。
- 「『我的』页面增加『更多』选项，把切换测试账号、班级绑定入口、AI 排班设置、手动排班都放在更多里面」（`grill-me` 四轮拍板：bottom-sheet 弹层 / 只移这 4 项 / 放「更多」弹层 / 同弹层双视图）。
- 「设置总额不放在首页弹层，放在『我的』页面；首页弹层显示消费记录 + 增加消费按钮」。
- 「合并成班/团费总额，点进去可像值日上面的动效一样滑动切换班费团费」。
- 线上报障：`FUNCTION_NOT_FOUND`(-501000) `getSummary` 刷屏；「设置了班费，但是首页班费更新很慢」。
- 首页课次行视觉四连改（实机截图驱动）：间距太大 → 两行显示 → 居中 → 「靠上吧还是」→ 「间距再大一点点，两个字符」。

**② 改动一：新增 `fee` 云函数 + 两张表**

| 文件 | 改动 |
|---|---|
| `cloudfunctions/fee/index.js` | 新建。路由 `getSummary` / `setTotal` / `addExpense` / `deleteRecord`；`auth: { needBind: true }` |
| `scripts/migrate-fee.sql` | 新建。`class_fund(class_id, type, total)` + `class_fund_record(id, class_id, type, amount, note, images JSON, operator_*)`，`CREATE TABLE IF NOT EXISTS` 幂等 |
| `cloudbaserc.json` | 新增 fee 条目（Nodejs18.15 / 20s / 256MB / installDependency / vpc-c4ga6fms + subnet-a5mkrg1l） |
| `scripts/deploy-fee.js` | 新建。临时注入 `envVariables` → `tcb fn deploy fee` → 还原（抗中断安全备份、只动 fee） |
| `miniprogram/utils/api.js` | `feeSummary` / `feeSetTotal` / `feeAddExpense` / `feeDeleteRecord` |

- **余额不落库**：`余额 = 总额 − 已消费`，每次 `getSummary` 运行时算。
- **图片**：客户端 `wx.chooseMedia` → 直传云存储拿 fileID → 服务端只存 `cloud://` 字符串数组；删除记录时先删云存储文件再删行。
- **踩坑**：`CreateFunction InvalidParameterValue.Description` —— description 含全角减号 `−`，改为普通标点版本后通过。

**③ 改动二：权限单一真源 `util.feeRights()`**

- `miniprogram/utils/util.js` 新增 `feeRights(m)`，返回 `canManageClass / canManageLeague / canSetTotalClass / canSetTotalLeague / showLeagueCard / hasAny`；首页与「我的」页**都调它**，后端 `fee/index.js` 的 `feeManager` / `feeTotalSetter` 与之**逐字同口径** —— 改权限只改这一处。
- 口径：班费管理 = 超管 | 班长兼团支书 | 副班长 | 生活委员；团费管理 = 超管 | 班长兼团支书；班费总额设置 = 超管 | 生活委员；团费总额设置 = 超管 | 班长兼团支书；团费卡可见 = 团费管理权（其余角色只看班费，普通成员班费卡仅展示不可点开）。

**④ 改动三：首页班费卡 + 双视图弹层**

- `pages/home/index.wxml`：班费弹层改为**双视图** —— 列表视图（余额 + 「总额/已消费」只读小字 + 消费明细 + 「增加消费」按钮）⇄ 表单视图（金额 / 备注 / 凭证图 + 提交 / 返回）；**设置总额入口已移除**，避免同一值两处编辑。
- `pages/home/index.js`：`feeView: 'list'`、`onFeeAddOpen` / `onFeeFormBack`；`onFeeClose` 复位 list；提交 / 删除成功后强制重拉。
- 管理员入口卡（成员与分组 / 发布通知）整体移到「本班请假」**之后**（`st-7`），班费块 `st-7` → `st-6`。

**⑤ 改动四：「我的 → 更多」+ 班/团费总额分段切换**

- `pages/mine/index.wxml`：`page-meta` 的 `page-style` 补 `moreShow || feeTotalShow`（`check-scroll-lock` 判死）；管理卡保留「换班待确认 / 发送更新公告」，其余 4 项收进新增「更多」行（`wx:if="{{showMore}}"`）。
- 「更多」弹层：切换测试账号 / 班级绑定入口 / 手动排班 / AI 排班设置 + 一行「班/团费总额」（行尾 `feeTotalRowText`）。
- 总额弹层：`segmented` 组件（`items=[{key,text}]`、事件负载 `e.detail.key`），**仅当 tabs > 1 时渲染**（只有一档权限时不显示分段控件）；双草稿 `feeInputClass` / `feeInputLeague` 分开保存，切 tab 不串值；保存后置 `app.globalData.feeDirty = true`。
- `_afterMoreClose(fn)`：先关弹层、200ms 后再推进目标页（避免页面跳转与弹层关闭动画打架）。
- `pages/mine/index.json` 注册 `segmented`；`index.wxss` 新增 `.mn-more`。

**⑥ 改动五：首页班费刷新滞后修复**

- **根因**：`_loadFee` 只挂在 `load().then(...)` 里，而 `load()` 有 `STALE_MS = 20000` 早退 —— 数据新鲜时**连请求都不发**，挂在其后的刷新被整段跳过。
- **改动**：`onShow` 独立拉一次（`_loadFee(feeDirty)`），不受 STALE_MS 影响；`_loadFee(force)` 内加 2 秒去重窗口，`force` 时跳过去重；写操作（点开卡片 / 提交 / 删除）一律 `_loadFee(true)`；跨页用 `app.globalData.feeDirty` 脏标记（同 `swapDirty` / `rosterDirty` 套路）。
- 与既有铁律一致：**每次进页面都要准的数据（班费余额、通知角标）必须在 `onShow` 独立拉**。

**⑦ 改动六：首页课次行视觉（4 轮实机迭代终版）**

- 结构重构（今日两份 + 明日共 3 处）：`<view class="course-side">`（时间 + 教室）与 `<text class="course-name">` 并列为 `.course-row` 直接子元素。
- `.course-time` 宽度 216rpx → **152rpx**（实测只需 ~140rpx，写死 216 是间距过大的根因）；`.course-name` `margin-left: 48rpx`、`align-self: flex-start`（靠上）、`-webkit-line-clamp: 2` 两行截断。
- 已删除 `.course-info` / `.course-line1` 中间层（无残留）。

**⑦ 改动七：审核体验入口改为超管开关 + 开启即自动生成新口令**

- **背景**：老流程是「我在更新说明里手写一条口令 → 用户跑 `UPDATE class SET review_demo_on=1, review_demo_code='...'` → 提审」，**每个版本都要来一遍**，且手写口令存在「复用旧口令 / 抄错 / 随仓库泄漏」三个方向的风险。用户要求：入口在「我的」页加开关、且**每次更新版本自动换一条仅预览的新口令**。
- **拍板口径**（三问）：① **仅超管** · 管理卡平铺一行（不收进「更多」）；② **开启时后端自动生成**新口令并回显，开启期间可再看、关闭即作废；③ **沿用现有演示态**（功能可完整体验、只拦破坏性动作）—— 不改成全只读，否则审核员点哪都「不能操作」会被判功能不可用而驳回。
- **后端**（`cloudfunctions/auth/index.js`）：

  | 项 | 实现 |
  |---|---|
  | 口令生成 | `crypto` + `newReviewCode()` ⇒ `LXQ-XXXX-XXXX-XXXX-XXXX`（4 组 × 4 位）。字符表**刻意去掉 0/O/1/I** —— 审核员要手抄，这 4 个字形最容易看错 |
  | `reviewDemoStatus` | `auth: { needSuper: true }`，返回 `{ on, code }`（开启期间可再看一次） |
  | `reviewDemoSet` | `auth: { needSuper: true }`；`on=true` = 生成新口令，`on=false` = 作废 + 踢下线 |
  | 开启顺序 | 先自检 `ctx.member.class_id`（拿不到就报错、**先别动手**）→ 踢演示身份 → **把所有班的开关清一遍** → 再写自己班 |
  | 关闭 | 踢演示身份（`UPDATE member SET openid=NULL, is_review_demo=0 WHERE is_review_demo=1`）+ 全表清开关 |

  - ⚠️ **为什么开启要先清所有班**：`reviewDemoRow` 是**全表扫描取第一条开着的**（`WHERE review_demo_on=1 ... LIMIT 1`）。只要别班残留一行开着的，就会出现「我以为关掉了，其实另一道后门还开着」—— 关不干净比不关更危险。
  - ⚠️ 与「口令永不回传前端」那条铁律**不冲突**：铁律约束的是 `login` 下发给所有人的布尔位、以及面向未绑定审核员的 `reviewDemo` 返回体；这两个新路由要求 `needSuper`，口令只回给本人是超管的调用者。
- **演示态拒绝清单**（`common/review-demo.js`）：新增 `'auth.reviewDemoSet'` 与 `'auth.reviewDemoStatus'` —— 演示身份不得自己换一条口令出来。`sync-common.js` 同步 **14 份**副本。
- **前端**（`pages/mine`）：管理卡新增一行（`wx:if="{{isSuper}}"`）；关闭态行尾「开启」按钮，开启态「已开启 · 点此关闭」+「口令」按钮；口令弹层可点可复制（`wx.setClipboardData`）。
  - ⚠️ **「口令」按钮只回显（走 `status`）、不换口令（走 `set`）** —— 换口令会踢掉正在体验的审核员。
  - `page-meta` 补 `reviewShow`（`check-scroll-lock` 判死）。
- **门禁**：`check-review-demo.js` 扩到 **12 组变异自证全被抓**（新增：去掉 `needSuper` / 口令写死 / 随机源换 `Math.random` / 前端去掉 `wx:if isSuper` / 从拒绝清单删 `auth.reviewDemoSet`）。
  - 🔴 顺带修掉一处**假自证**：原 M7 变异锚点 `is_review_demo = 1` 被新增的「踢演示身份」语句顶掉 ⇒ 改了个不相干的地方、测的还是原文件。判据已收进 `rd[0]`（reviewDemo 块内），锚点改为 `is_review_demo = 1 WHERE id = ?`。
  - 🔴 `check-staff-bind.js` 会 eval `auth/index.js` 并桩化 require，新 `require('crypto')` 不在桩表 ⇒ 报「门禁未桩化 require：crypto」。已补（用真模块，别桩成定值）。

**⑧ 部署状态**

| 项 | 状态 |
|---|---|
| `fee` 云函数 | ✅ 已部署（`fn detail` 复核 VPC + 5 个 DB_* 环境变量 + Auto install dependencies=TRUE） |
| `class_fund` / `class_fund_record` | ✅ 已建（`tcb db execute` 跑 `migrate-fee.sql`，`SHOW TABLES` 复核） |
| `auth` | ✅ 已重新部署（`fn code download` + `diff -r` 复核线上 == 仓库） |
| 其余 11 个含 common 副本的函数 | ✅ 已重部署（`deploy_all.sh`；`admin-web` / `fee` 需 VPC 与环境变量，走各自脚本，本轮无需动） |
| 前端 | ⏳ 待上传 |

---

## v0.7.40 · 2026-10-14 · 对外 1.0.6.7
**主题：值日状态口径 + 保洁主教室 + 课表节次放开（含 duty_count=0 通道）**

> 口径：本版**云函数已全部部署生效**（7 个函数 + 1 条 DDL）；前端待上传。门禁 **84/84 全绿**，admin-web e2e **75 项全绿**。

**① 背景与用户诉求（均为用户实锤）**
- 「下午 13:30 了，上午第二节课还显示进行中」—— 值日状态机翻转点设错了。
- 「2601/示例班级B/示例班级A 都要加一门『书香校园』课，**仅 45 分钟**，并且不排值日」——需要能排到第 6 个大节，且该课次不排值日。
- 「首页今日课次的课程名称没有对齐」「后台『第 x 节』折成多行」。

**② 改动一：值日状态改为「下课 10 分钟」（`common/week.js`）**

| 文件 | 改动 |
|---|---|
| `cloudfunctions/common/week.js` | `effectiveStatus` 的 COURSE 分支由「下一节课开始才 DONE」改为 **下课 10 分钟宽限**；删 `flipTimeOf`，新增 `addHHmm(hhmm, minutes)`（跨天取模回绕，如 23:59+10 → 00:09）。**CLEAN 保洁口径不变**（18:00 前 PENDING / 18:00 起 DONE，对应「18 点前打扫完」） |
| `cloudfunctions/*/common/week.js` × 13 | `sync-common.js` 同步 |
| `cloudfunctions/course/index.js` | `listWeek` 原来给 `effectiveStatus` 传 `period: 0` ⇒ 取不到真实时间窗（8:00 前 PENDING、8:00 后直接 DONE）⇒ 改 `JOIN session s ON s.id = d.session_id` 取 `s.period` |

- **根因**：旧口径靠 `flipTimeOf`（下一节课起始；最后一节兜底 21:00）。下午无课时，当天所有上午课次一路 ONGOING。cron 每日 06:00 只把**昨天**的置 EXPIRED，救不了当天。
- **验证**：`_dbg_room/verify-duty-flip.js` 18/18（注入时刻覆盖课前/课中/下课瞬间/+5min/+10min/用户场景 13:30/晚间/CLEAN/非 PENDING/昨天/明天/period 缺测）。

**③ 改动二：duty_count=0 = 不排值日（为「书香校园」铺路）**

- 🔴 `Number(x) || N` 会把 **0 当「未填」** ⇒ duty_count=0 反而排 1~2 人。全部改 `??`（只让 undefined/null 回落默认）：
  - `schedule/index.js` `Math.max(0, Number(s.duty_count ?? 1) - alreadyFilled)`（generate 一键生成）；`cron-weekly/index.js` 同式；`buildCleaningPlan` 的 `const need = Number(s.duty_count ?? 2) - taken.size`；两处 `dutyCount:` 展示字段。
  - `course/index.js` `upsert`：由 `Math.min(Math.max(Number(c.dutyCount) || 2, 1), 4)`（钳死 1..4）改为 `Math.min(Math.max(Number.isFinite(dcRaw) ? dcRaw : 2, 0), 4)`。
  - 小程序课表表单 `stepper min` 1→0；`_openForm` 的 `(cell && cell.dutyCount) || 2` 会把 0 弹回 2 ⇒ 改显式判 undefined/null。
  - `admin-web` 的 `mod-course.addSession` 早本就允许 0（`>= 0 && <= 20`），前端 number input 也 `min="0"` —— 后台侧本来能录 0，只是云函数会吃掉。
- 门禁：`check-schedule-generate-runtime` 新增 **D6**（源码形态 + 运行时双断言：duty_count=0 的课次 generate 后 `inserted=0` 且 `created=0`）；D4 与 `check-tuesday-clean` 的 C/G 段判据同步新写法。**变异自证**：改回 `|| 1` ⇒ D6a/D6c 双红（"实际追加 1 人 / created=1"）。

**④ 改动三：大节数跟随班级 `period_time`（不再写死 5）**

- 背景：线上三班 `period_time` 是 5 个 **100 分钟大节**，而 `period_time` **每班可配**、后台也能加行，小程序端却全链路写死 5（`upsert` 校验 / 前端 grid / 节次选择器 / `replaceSessions` 校验 / admin-web 解析器 / admin-web 下拉）。
- 改动：
  - `cloudfunctions/common/week.js` 新增 **`periodCount(config)`** = max(兜底 5, 数组长度, 最大 period 号)，上限 10；**必须吃 JSON 字符串**（`class.period_time` 是 JSON 列，mysql2 返回字符串；早前只认数组 ⇒ 字符串走「非数组」分支 ⇒ **无声兜底成 5**）。
  - `course/index.js` 的 `upsert` / `applyTimetable` 两处 `period<=5` → `week.periodCount(cfg)`，报错回显「1-N」。
  - `miniprogram/data/timetable.js`：新增 `setPeriods` / `periodCount` / `MAX_PERIOD(10)`；**`replaceSessions` 校验上限 5 → MAX_PERIOD**（最硬的一道：写死 5 会让整批课次被拒收 ⇒ 课表空白）。
  - `miniprogram/pages/timetable/index.js`：class.list 的 chips 带 `periodTime`；新增 `_syncPeriodCount`（**初载 + `onTimetableClass` 两条切班路径都要调**）；网格行数与 `p > nPeriods` 过滤读 `tt.periodCount()`。wxml 节次选择器读 `periodChips`、骨架屏读 `periods`，去掉写死的 `[1,2,3,4,5]` 与「1-2 上午 · 3-4 下午 · 5 晚上」。
    - 🔴 **行数二次调整（同日，用户实锤「多了一节空行」）**：平时一天就是**五节大课**，第 6 节是「书香校园」这类 45 分钟短课的特殊时段；无条件按 `period_time` 画满 ⇒ 没有第 6 节课的周次多出一整行空格子。改为
      **`nPeriods = max(1, tt.periodCount(), maxUsedPeriod)`**，`maxUsedPeriod` = **本周全部课次里出现的最大 period**（排除「调出」的课）。
      判定同样按整周 `courses` 而非当前分组视图，与同页 `hasWeekend`（周末列）**完全同口径** —— 否则 A 组有第 6 节、B 组没有时，切组会让网格在 5↔6 行间跳动（与 §43 报障过的周末列跳动同款）。
  - `admin-web/lib/mod-course.js`：新增 `classPeriodCfg(pool, classId)`；`addSession` **与 `updateSession` 两条路径同口径**（后者曾漏改 ⇒「编辑比新增更严」，用户只能删除重加；并容错 `max(nPeriods, before.period)`，配置后来改小时仍可保存其它字段）。
  - `admin-web/public/app.js`：解析器上限 5→10（否则第 6 节**整行被丢**）；新增 `periodOptions(cls, mustInclude)` 生成大节下拉（编辑弹层必须传 `mustInclude`，防「配置后来改小」时 select 落到第一项、静默改掉节次）。
- 门禁：新增 `scripts/check-period-count.js`（**20 项，含 2 条变异自证**：replaceSessions 上限写回字面量 5、前端 `p>5` 硬编码都必须被抓）。`check-timetable-local` 的「节次收口 1-5」是**旧铁律**（当年就为挡第 6 节）⇒ 按新需求翻转，并放宽其 `periodGuardMax` 正则（报错文案现在带动态「1-N」回显）。

**⑤ 改动四：课堂主教室（`880a7c6`，本版已上线）**

- `class.main_room VARCHAR(32) NULL`（`scripts/migrate-main-room.sql` 幂等加列）；`mod-class.js` 收 `patch.mainRoom`（限长 32 / 禁换行 / 可清空），仅当值变化才调同步。
- `mod-course.js` 新增 **`syncMainRoomCleaning(pool, classId, newRoom)`**：按名规则改名（含「大扫除」→ `newRoom+'大扫除'` 前缀式；含「打扫」→ `'打扫'+newRoom` 后缀式）并 UPDATE `course.room`；只碰 CLEAN、幂等、不碰普通课次。值日/通知靠 session→course 运行时读 name/room ⇒ **改名后历史值日显示自动跟上**，不需重排/退草稿。
- 生产上线：`tcb db execute` 加列（先探测 `has_col=0` → 单条 ALTER → 复核 `IS_NULLABLE=YES`）；示例班级A 落 `main_room='410'`，5 条 CLEAN 复核与 410 完全一致（同步为 no-op）。线上复核 17/17 过。

**⑥ 改动五：两轮 bug 修复（用户两次实锤）**

- **「配了第 6 节，添加课次下拉仍只有 5 项」**（3 病根）：
  1. 🔴 `/api/me` 的 `classes: classes.map(c => ({id,name,isActive}))` **只回传 3 字段，把 `maskClass` 解析好的 `periodTime` 丢在服务端** ⇒ 前端 `state.classes` 里没有该字段（改前端时没核对接口字段白名单 = 疏漏）。
  2. 🔴 `reload()` 只 `go(state.view)` 重渲染、**不重拉 `/api/me`** ⇒ 配置保存后当次不生效（用户以为"保存没生效"）。新增 `refreshClasses()`。
  3. 顺带发现自相矛盾：课表页 `.filter(r => r.kind !== 'CLEAN')` 已过滤保洁，却仍留「保洁」标签分支 ⇒ 永不命中的死代码，已删。
- **「编辑课次报『大节应为 1-5』」**：直接病根 = `updateSession` 漏改（见 ④）；深层病根 = `periodCount` 不吃 JSON 字符串（见 ④）。
- 🔴 **mock 隐蔽缺陷（差点误判）**：`verify-admin-web.js` 的 `rowMatches` 正则强制要求「表名.列名」，而 `WHERE id = ?`（无前缀）解析不出任何条件 ⇒ `conds` 为空 ⇒ 直接 `return true` ⇒ **过滤完全失效、返回全表第一行**。症状与真代码 bug **一模一样**（「加第 6 节课报 1-5」）。已改为 `(?:\w+\.)?(\w+)` 前缀可选；并在 e2e 里加「mock 保真度自检」断言把桩与代码的责任分开。

**⑦ 改动七：周次区间写法 `6-13` 端上/后端同口径（同批发布）**

> 用户上传体验版后反馈「第 6 行网格已出现，但书香校园仍不显示」——**上一轮「只需重传前端」的结论不完整**，漏查了 `weeks`。

| 位置 | 原实现 | 对 `6-13` 的结果 |
|---|---|---|
| `miniprogram/data/timetable.js matchesWeeks` | `split(',') + Number()` | `Number('6-13')` = NaN ⇒ **整批周次全丢** |
| `cloudfunctions/common/week.js parseWeeks` | `parseInt('6-13')` | = **6** ⇒ 第 7~13 周静默丢弃 |
| `admin-web/public/app.js normalizeWeeks`（课表导入器） | 支持区间 | ✅ 一直正常 |

- **根子**：三条录入入口里，**只有「添加课次」这条没做区间归一化** ⇒ 两对一错。
- 修：三处统一为 `^(\d+)\s*-\s*(\d+)$` 区间展开（自动纠正 `13-6` 反写），1..53 过滤与去重排序保持；`mod-course.addSession` **落库前先 `parseWeeks` 归一化**，库里不再出现裸区间。
- **顺带修**：`course.allSessions` 的 SQL **漏取 `duty_count`** ⇒ 端上 `data/timetable.js` 两处只能写死 `dutyCount: 2` ⇒ 「不排值日」的课在课表详情显示成 2 人。已在 SQL 补 `s.duty_count`、返回补 `dutyCount`；端上改 `(s.dutyCount === 0 || s.dutyCount) ? Number(s.dutyCount) : 2`（**不能用 `|| 2`，会把 0 吃掉** —— 与本轮 duty_count=0 通道同一个坑）。
- **存量数据**：`tcb db execute` 把 id=436 的 `weeks='6-13'` 展开为 `6,7,...,13`；另 4 条本就是逗号写法（`UPDATE` 返回 `Affected rows: 0` 属正常，已 SELECT 复核 5 条全对）。
- 门禁 `check-period-count` 扩到 **24 项**（F1 后端区间 / F2 端上同口径 / F3 落库归一化 / F4 `dutyCount` 回传且端上不许写死 2）。
- 回路 `_dbg_room/repro-sxxy-real.js`：用**线上真实数据**（id=436 周四 / 第6节 / 全体 / weeks=6-13）+ 用户场景（第 6 周）复现，修复前红「第 6 周 0 条」，修复后第 6~13 周命中正确。
- 🔴 **排查教训**：查「课表看不到某节课」必须查全 `period / day_of_week / group_scope / weeks / week_rule`，并连用户当时看的周次一起对 —— **weeks 是「按周生效」课的决定性字段**。

**⑧ 改动八：门禁提速（宿主环境问题，非业务改动）**

- `check-admin-web` 批跑被判「卡死 >60s」而**单跑秒过**。实测：宿主给 `fs.rmSync` 套的「安全删除」垫片**单次约 9 秒**，而该门禁 14 个变异自证用例各自在 `finally` 里删一次临时目录 ⇒ 累计 ~71s，超过 `run_all_gates_bounded.sh` 的 `timeout 60`。
- 修：临时目录改为**整轮结束统一清一次**（`cleanupMutDir`），**71s → 18s**，46 项仍全绿；全量批跑 9min → 5.5min。
- 💡 教训：任何带变异自证的门禁都**不要在每个用例 `finally` 里删临时目录**；遇到「批跑卡死但单跑秒过」先量化单跑耗时再下结论，别急着改业务代码。

**⑩ 改动十：值日页隐藏「+ 加值日生」入口**

- 用户要求去掉值日页每天下方的「+ 加值日生」虚线按钮（v0.7.16 需求③）。
- 改法：**只挡入口、不删功能** —— `pages/duty/index.js` 的 `data` 加开关 `showAddDutyBtn: false`，`index.wxml` 的 `wx:if` 由 `{{canSchedule}}` 改为 `{{canSchedule && showAddDutyBtn}}`。
  `onAddOpen / onAddBackSession / onAddPickSession` 与整个 `bottom-sheet`、后端 `scheduleAddManual` **全部保留** ⇒ 恢复只需把开关改回 `true`。
- ⚠️ 为什么不直接删 wxml 的 `wx:if`：删了以后想恢复得翻 git 找历史；一行开关就能表达「暂时不想露出这个入口」。
- 布局核对：`.dt-dayfoot`（「本日 N 次值日」）是**固定 64rpx**、不依赖下方按钮；按钮是 `.dt-daycard` 最后一个子元素 ⇒ 隐藏后卡片视觉完整、无孤立留白。
- 与既有门禁的关系：`check-duty-ended.js` 的 C2「弹层内不含加值日生」只管 `pastDays` 弹层（`index.wxml` L406 附近），与本次改的主列表页入口**不冲突**，两条门禁全绿。

**⑨ 改动九：两处显示修正**

- 首页 `pages/home/index.wxss`：`.course-time` 固定 `width:216rpx; flex-shrink:0`；`.course-name` 加 `flex:1; min-width:0` + 省略号截断。
- `admin-web/public/app.js`：课表「第 x 节」td 加 `class="td-period"` + `.tbl td.td-period{white-space:nowrap}`（**只给这一列加**，别动全局 `.tbl td` —— `td-weeks` 依赖 `word-break:break-all` 换行）。

**⑧ 门禁与部署**

- 全量门禁 **84/84 全绿**（83 + 新增 `check-period-count`）；`check-schedule-generate-runtime` 加 D6；`check-timetable-local` 判据翻转。
- `verify-admin-web.js` e2e **75 项全绿**（夹具三班 `period_time` 由 null 改真实配置，让「大节下拉」这条链路**首次被测到**；新增 [6.2] 5 项 / [6.2b] 保存后立即生效 / [6.2c] 保洁死代码 / [6.2c-2] 新增与编辑第 6 节不被拒 5 项）。顺手收掉两条**长期假红**（「保洁课次可见并标记」与「删除前课表有 4 行」——均与过滤口径矛盾，用 `git stash` 对比基线确认是既有失败）。
- **变异自证**：`updateSession` 改回写死 5 ⇒ [6.2c-2] 如期红；还原用「事前存原文 / 事后写回」，**未用 `git checkout`**（会连带丢该文件其它未提交改动）。
- 部署：DDL 1 条 + 云函数 7 个（admin-web / duty / adjust / schedule / course / export / cron-weekly，其中 admin-web 与 course 因两轮修复二次部署）；线上复核 17/17 + 13/13；`verify-admin-web-online.js` 14/14。

---

## v0.7.39 · 2026-10-13 · 对外 1.0.6.5
**主题：值日卡视觉优化 + 首页请假按时段自动刷新（纯前端）**

> 口径：本版为**纯前端优化**（值日页 `pages/duty/index.{js,wxml,wxss}` + 首页 `pages/home/index.js`），云函数未改动、无需重部署。门禁 **全量 83/83 全绿**。

**① 背景与用户诉求**
- 值日页合并行（同一课次多人值日）原本把姓名挤在末尾 `namesText`、序号牌（`avatar-tag` 的 `seqText`）横排一排，4 人保洁（周二「410大扫除」）时一行排不开、姓名对不齐，且姓名不够醒目。
- 首页「x 人当前请假」卡片按固定边界（12:00/18:00/00:00）定时翻面，但真实请假时段（如 19:00–20:40）起止都不落在边界上 ⇒ 到点不重拉，卡片数字停在旧值，与课堂情况页口径分叉。

**② 改动（3 文件）**

| 文件 | 改动 |
|---|---|
| `miniprogram/pages/duty/index.js` | 合并行 `g.avatarSize` 56 → **48**（序号牌收小；字号随 `avatar-tag` 的 `FS_MAP` 自动收小，免 `!important`）。`g.namesText` 仍生成（其它模板可能用到），仅合并行不再渲染 |
| `miniprogram/pages/duty/index.wxml` | 两处合并行模板（主「按日」列表 + 「已结束」弹层，`replace_all` 同步）：每人直接一个 `.dt-nm` 格（序号牌 `<avatar-tag text=seqText>` + `<text class="dt-nm-name">姓名</text>`，无内层 wrapper），序号牌居中于姓名正上方；移除 `{{g.namesText}}` 渲染；保洁角标 `410` 保留 |
| `miniprogram/pages/duty/index.wxss` | `.dt-names` 改 `flex-wrap:wrap; width:192rpx; justify-content:flex-start`；`.dt-nm { width:96rpx; box-sizing:border-box; flex-direction:column; align-items:center; padding:6rpx 0 }`（固定宽格、内容居中 ⇒ 序号牌与姓名共中线、2/3 字姓名整列齐平）；`.dt-nm-name` 22rpx→26rpx / `font-weight:600` / `#4E5969`→`#1D2129` / `text-align:center` / `white-space:nowrap`；`.dt-row.merged` 取消 `border-bottom`，改 `.dt-row.merged + .dt-row.merged { border-top:2rpx solid #E5E6EB }` |
| `miniprogram/pages/home/index.js` | `_scheduleLeaveWindowTimer()` 候选刷新点 = 三固定边界 ∪ 当天请假 `startTime`/`endTime`（零补 `HH:MM` 字符串比较）；`onShow` 在 `_scheduleDoneTimer()` 后补调本定时器 |

**③ 关键权衡**
- **课次间分割线为什么用 `border-top` + `+` 而非 `border-bottom`**：本页 `.dt-row:last-child { border-bottom:none }` 从不命中（末行之后还有 `.dt-dayfoot` 小结）；若沿用 `border-bottom` 改色，会在末行与「本日 N 次值日」之间冒出一条多余线（截图里用户没画那条）。改用相邻兄弟 `+` 只画在「课次行 vs 紧邻的下一课次行」之间，首行之上与末行之下都不画。`.dt-row.merged ~ .dt-row.merged` 的 `~` 在真机编译 fatal，故只用 `+`。
- **序号牌收小不靠 `!important`**：`avatar-tag` 圆大小与其中数字字号由内部 `FS_MAP` 绑定（56→字 24，48→字 22 再按位数微调），缩 `avatarSize` 即缩字，天然同步。
- **首页翻面不动既有逻辑**：仅扩充候选刷新点集合 + `onShow` 补调，setTimeout 链 / `util.clockNow` / `waitMs` 下限 / 到点 `_loadLeaveHome` / 旧定时器清理 / `onHide`·`onUnload` 清理一字未动，避免引入新竞态。

**④ 门禁**
- 值日页：`check-wxss.js`（duty 页 class 全定义，无 `~`）、**`check-wxss-compile.js`（官方 `wcsc` 真编译 29/29）**、`check-wxml.js`、`check-tuesday-clean.js` 全绿。
- 首页：`check-leave-realtime-courseinfo.js` 扩变异覆盖「时段翻面」，**14/14 变异全抓**，exit 0。
- `node --check` 两个 js 文件均通过。

**⑤ 影响面与部署**
- **纯前端**：仅展示/刷新逻辑，无 DB 变更、无云函数改动、无需重部署。
- **前端待上传**：微信开发者工具打开仓库根目录 → 先点「编译」→ 再点「上传」。
- ⚠️ 周二「410大扫除」4 人布局的**人数**由后端 `session.duty_count=4` 驱动（见 `scripts/migrate-tuesday-clean.sql` 待上线项）；本版前端 2×2 布局在 duty_count=2 时退化为 2 人并排、=4 时 2×2，两种情形都正确，前端可先随版上传、后端迁移随后上线互不阻塞。

---

## v0.7.38 · 2026-10-12 · 对外 1.0.6.4
**主题：小程序备案通过 —— 「关于」页展示 ICP 备案号；审核体验入口「演示身份降权」**

> 口径：本版含两项 —— ①**备案展示**（纯前端）；②**审核体验入口演示身份降权**（云函数 `member`/`class`/`auth`/`media`/`course` 需重部署）。门禁全量 **82/82 全绿**（新增 `scripts/check-icp.js`；`check-review-demo.js` 扩到 7 组变异）。

**① 背景与合规要求**
- 小程序备案 2026-10-12 通过：主体备案号 `<ICP_NO>`，服务备案号 `<ICP_NO>-1X`，服务名称「班级任务管理」。
- 工信部/微信要求：备案号须在小程序**显著位置真实展示**（本项目定点 = 「我的 → 关于」弹层，见 `docs/班级任务安排助理-高保真UI设计提示词.md` P8）。
- ⚠️ 历史坑：2026-09-24 曾因「关于」页挂的是**假占位号** `苏ICP备00000000号-1`，把整块删除（记于 `docs/隐私保护指引-填写说明.md`）。**这次必须用真号，且不能再被静默删掉**。

**② 改动（4 文件）**

| 文件 | 改动 |
|---|---|
| `miniprogram/utils/config.js` | 新增 `ICP_NO = '<ICP_NO>'` / `MIIT_URL = 'https://beian.miit.gov.cn'` 并导出；`APP_VERSION` 1.0.6.3 → **1.0.6.4** |
| `miniprogram/pages/mine/index.js` | data 加 `icpNo: config.ICP_NO`；新增 `onIcp()`（点击复制工信部地址） |
| `miniprogram/pages/mine/index.wxml` | 「关于」弹层在协议卡与页脚之间插入 `ab-icp` 块（`{{icpNo}}` + `bindtap="onIcp"`） |
| `miniprogram/pages/mine/index.wxss` | 新增 `.ab-icp` / `.ab-icp-l` / `.ab-icp-v`（值 = `#3370FF` + `text-decoration: underline`） |

**③ 关键权衡：为什么点击是「复制」而不是「跳转」**
- 设计要求「备案号可点击跳转工信部」，但小程序**无法** `web-view` 打开 `beian.miit.gov.cn`：`web-view` 只能打开**自己已备案的业务域名**，工信部域名不可能进业务域名白名单。
- 故取「**点击 = 复制 `https://beian.miit.gov.cn` 到剪贴板**」：用户可粘贴到浏览器核对，是可行且诚实的等价替代（微信对小程序只要求「展示」，未强制「跳转」）。

**④ 门禁**
- 新增 `scripts/check-icp.js`：钉死「真源在 config / 必须是真号（非占位）/ 关于页确实渲染且可点击 / 点击复制工信部地址 / 值为主色加下划线」，**4 组变异全抓**（换回占位号 / 去掉备案号块 / 工信部地址写错 / 值改灰字去下划线）。
- 页面既有门禁（`check-wxss` / `check-wxml` / `check-tab-enter` / `check-glass` / `check-scroll-lock`）全绿。

**⑤ 待办**
- 前端上传（微信开发者工具「上传」，上传前先点一次「编译」）。
- **再次提审前**：重新开启审核体验入口 + 换新口令 + 给演示账号置 `is_review_demo=1`（见 `outputs/v1.0.6.4-更新说明.md`）。

**⑥ 演示身份降权（本版新增，云函数改动）**
- **背景**：审核入口（`auth.reviewDemo`）绑的是 99 段**测试超管**（`role=ADMIN, is_super=1`）⇒ 前端所有入口都能渲染、功能完整，但也意味着**它本身就是一个完整超管**：口令一旦泄露即可删成员、改权限、清空通知…。用户 2026-10-12 拍板：「演示身份改制度，但功能都展示」。
- **口径**：演示身份**照旧绑超管**（前端入口不变、功能都能演示），但演示态下**拦截「不可逆 / 授权 / 全站级」写操作**，只放行可逆的日常业务写。即把「**看得见、点得动**」与「**能真改生产**」切开。
- **实现（新增 `cloudfunctions/common/review-demo.js`）**：
  - `DENY_ACTIONS` 拒绝清单（29 条 action，唯一真源）；`isReviewDemo(member)` = `member.is_review_demo === 1`；`denyDemo(member, action)` 命中抛 `BizError(40010, '演示模式：该操作不会真实执行')`。
  - 在 **5 个受影响云函数**（`member`/`class`/`auth`/`media`/`course`）的 `exports.main` 里、取到 `ctx` 之后、鉴权之前调用 `reviewDemo.denyDemo(ctx.member, action)`。
    **为什么不挂在 needSuper 上**：⚠️ `media` 的 main 根本没有 `needSuper` 分支（`clearNotices` 只靠学号前缀兜底），且破坏性动作散落在 `needSuper`/`needAdmin`/`needBind` 多种声明里 ⇒ 只挂某一类必漏。逐函数在 ctx 之后显式判，覆盖面最可控。
  - 前端**零改动**：`miniprogram/utils/request.js` 对非 0 错误码本就会 `wx.showToast(errMsg)`（40001/40002 除外）⇒ `40010` 自动弹出「演示模式…」。
  - 演示标记：`auth.reviewDemo` 绑定成功时 `UPDATE member SET openid=?, bind_time=NOW(), is_review_demo=1`；DDL 新增 `member.is_review_demo TINYINT NOT NULL DEFAULT 0`（`scripts/migrate-review-demo.sql`）。
- **验证**：`check-review-demo.js` 扩到 **7 组变异全抓**（+M5 去掉某函数拦截 / M6 从清单删一条 / M7 绑定不置标记）；`check-staff-bind`/`check-staff-pin` 的 vm 沙箱补 `./common/review-demo` 桩；全量 **82/82 全绿**。

---

## v0.7.37 · 2026-10-11 · 对外 1.0.6.3
**主题：整改微信审核「存在登录受限问题」（运营规范 3.3.3）—— 首页新增审核体验入口**

> 口径：本版为**审核合规整改版**（三段式 1.0.6.3）。`auth` 云函数**已部署**（用 `fn code update`，线上包已 `fn code download` 逐行核验含 `reviewDemo`）；`class` 表 DDL 已执行并开启开关。门禁 **全量 80/80 全绿**（新增 `scripts/check-review-demo.js`）。

**① 报障与诊断**
- 微信审核驳回：「**存在登录受限问题**，违反《微信小程序平台运营规范及服务条款》3.3.3」——「【首页】暂无『无法体验功能』时，需在首页填写有效账号及密码**或**上传小程序完整功能截图」。
- **为什么「加一个口令输入框」解决不了**：常规绑定是三步（`pages/bind/index.wxml` step0/1/2 + `auth.bind`）——
  ① 班级口令（生活委员线下发放，审核员没有）；② **从名单选自己**（名单里只有本班学生，**没有审核员**）；
  ③ 学号后 4 位。审核员在第 ① 步就断了，给了口令也过不了第 ② 步 ⇒ 必须是一条**一键直达**的旁路。
- 「以前没这问题」：大概率是早期审核员未深究（版本描述里可能给过口令），3.3.3 本身是老规则，**不可依赖运气**。

**② 落库选择（关键权衡）**
| 方案 | 关闭成本 | 泄露面 | 结论 |
|---|---|---|---|
| 环境变量 | 关闭需**重新部署**云函数 | 不落库，安全 | ✗ 审核通过后才能改，运营上不可接受 |
| 写进代码 | — | **随小程序包可被反解** | ✗ 等于公开后门 |
| **`class` 表两列** | 一条 UPDATE | 只有超管能读写 | ✓ **选中** |

DDL：`class` 加 `review_demo_on TINYINT NOT NULL DEFAULT 0` + `review_demo_code VARCHAR(64) NOT NULL DEFAULT ''`
（`scripts/migrate-review-demo.sql`，先备份 `bak_class_pre_reviewdemo_20261011`）。
⚠️ TDSQL **没有** `ADD COLUMN IF NOT EXISTS`，执行前必须先查 `information_schema`（本次查得 0 行）。

**③ 后端 `cloudfunctions/auth/index.js`（已部署）**
- 新增 action `reviewDemo`（`auth: null`，与 `bind`/`bindStaff` 同级）：
  - 开关双要素 `review_demo_on = 1 AND review_demo_code <> ''`，任一不满足 ⇒ 40009「体验入口未开放」；
  - 口令**恒定时间比较**（`safeEqual`：按字节全量比对，不按前缀早退，防时序侧信道）；
  - 失败仍计入 `bind_attempt` 且 5 次锁 30 分钟（复用现有防爆破闸），但**不调 `assertGlobalOk`**——
    学生爆破的失败计数不该把审核旁路一起熔断（与 `bindStaff` 同一思路）；
  - 目标账号用 `IS_TEST()} AND role = 'ADMIN' AND is_super = 1` **三重锁死**（否则会绑到「测试成员/测试管理员」）；
  - **绝不顶掉真人**：当前微信已绑真人时报 40006 要求先解绑（真人被顶 = 该同学当场掉线且可能被冒用）；
    只有「上一个体验者占用了演示账号」才会顶掉——它本就是测试账号。
- `login` 的 `config` 增 `reviewDemo: !!(await reviewDemoRow(pool))` —— **只给布尔位，口令永不回传前端**。
- 未改 `common/`（逻辑全收敛在 auth 内），故**只需重部署 auth 一个函数**。
- ⚠️ 线上验证：`tcb fn invoke` 返回 40001，**不能**据此判断路由是否注册（鉴权是全局中间件、跑在路由匹配前，
  跑不存在的路由同样返 40001）。改用 `tcb fn code download auth <dest>` 核包，线上包第 409 行确有该 SQL。

**④ 前端**
- `utils/api.js`：`reviewDemo: C('auth', 'reviewDemo')`；
- `pages/bind/index.wxml`：step0 底部（协议上方）新增 `wx:if="{{reviewOn}}"` 的审核体验区块；
- `pages/bind/index.js`：可见性读法**完全复用 `bindClosed` 的时序**（onLoad 读一次 + `app.ready()` 后补查，
  因为 onLoad 这一刻 `login` 可能还没回来）；成功后 `refreshAuth()` 再 `switchTab` 并**先置 `_leavingBind`**
  （否则迟到的 ready 回调会把人又拉回绑定页）；
- `pages/bind/index.wxss`：颜色一律走 `app.wxss` token（`--text-1`/`--text-2`/`--bg-fill`/`--r-md`），深色模式自动跟随；
  口令输入框**不复用** `.bind-input-code`（那是 8 位绑定码的「居中 + 8rpx 字距 + 等宽」形态）。

**⑤ 门禁（新增 `scripts/check-review-demo.js`，4 组变异全抓）**
- 钉死：口令永不回传前端 / 开关默认关闭 / 目标锁死 `is_super=1` / 不顶掉真人 / 恒定时间比较 / 颜色走 token。
- **本轮门禁自身踩了两次坑**（都靠变异自证暴露，不是靠猜）：
  1. 判据写成「`reviewDemo` action 体里不许出现 `review_demo_code`」⇒ **假闸**。action 必须**读**这一列
     才能做口令比对，把「读取」当成「泄露」会永远判红。已改为只检查 `return` 语句。
  2. 判据写成「全文件 grep『当前微信已绑定』」⇒ **静默通过**。`bindStaff` 里有**完全同名**的同一句报错，
     删掉 `reviewDemo` 那份后全文件照样搜得到（M4 变异没被抓到暴露了它）。已收进 `reviewDemo` 块内并改用
     该块独有的 `mine[0].id` 形态定位。**与「变异锚点不唯一 = 假自证」同族。**
- `scripts/check-test-account-hidden.js`：新增白名单条目（`auth.reviewDemo` 是唯一一条「按测试段反查身份」的 SQL）。

**⑥ 影响面 / 待办**
- 仅影响未绑定用户看到的首页；关闭态下线上表现与现在**完全一致**（`reviewOn` 恒 false ⇒ 不渲染）。
- 审核通过后**必须**执行关闭脚本（否则等于留了一个公开的超级管理员通道）：
  `UPDATE class SET review_demo_on=0, review_demo_code='' WHERE id=3;` + `UPDATE member SET openid=NULL WHERE id=69;`

---

## v0.7.36 · 2026-10-10 · 对外 1.0.6.2
**主题：纯前端热修 —— 值日页周次同步 + 请假多天假误标**

> 口径：本版为**热修小补丁**（三段式 1.0.6.2），**仅前端改动**（`pages/duty/index.js` / `pages/home/index.js`），云函数无需重部署。门禁 **全量 79/79 全绿**（新增 `scripts/check-duty-week-sync.js`；`scripts/check-leave-realtime-courseinfo.js` 加 M15 变异）。

### §0 改动清单

| 分类 | 文件 | 改动 |
|---|---|---|
| **前端** | `miniprogram/pages/duty/index.js` | 新增 `_syncWeek()`（:338）；`onLoad` 置 `this._weekManual=false`（:137）；`onShow` 调 `_syncWeek()` 纠回当前周并强刷（:184）；`app.ready().then` 补纠回（:174）；`_applyWeek` 置 `_weekManual=true`（:531） |
| **前端** | `miniprogram/pages/home/index.js` | `markOver` 改按 `endDate` 收口（:406） |
| **门禁** | `scripts/check-duty-week-sync.js` | 新增（vm 桩直调 `_syncWeek`/`_paint`，13 项 + 变异自证） |
| **门禁** | `scripts/check-leave-realtime-courseinfo.js` | markOver 判据改日期区间口径；新增 M15 变异（删 `today<d1` 守卫），14/14 变异全抓 |
| **反馈回路** | `outputs/debug/probe-markover.js` | 新增（vm 桩 + 冻结时钟 `2026-10-10 23:44` 直调 `_setLeaveHomeClass`，4 场景；修复前红、修复后绿） |
| **发版件** | `outputs/v1.0.6.2-更新说明.md` / `CHANGELOG.md` / `CHANGELOG-DETAIL.md` / `HANDOFF.md` / `scripts/check_closeout.sh` | 更新说明；v0.7.36 节；交接；收尾体检脚本同步口径 |

### §1 值日页「已结束」失效 + 默认显示第 1 周

**问题** → 值日页（Tab 3）「已结束 N 天」入口经常空白消失，须重启小程序才恢复；失效时进入值日页默认显示第 1 周而非当前周。
**根因** → `App.onLaunch` 的 `_bootstrap()`（`api.login()`）异步写入 `globalData.config.currentWeek`；Tab 页 `onLoad`（`pages/duty/index.js:124`）在它之前运行，读到 `null` → `week/current` 兜底成 `1`；`onLoad` 只跑一次、`onShow` 从不重读 `currentWeek` → 页面永久停在「week=1，current=真实周」。`_paint`（:376）`isCurrentWeek=(week===current)` 恒 false → `pastDays=[]` → 「已结束」入口（`wxml:56` `wx:if="pastDays.length"`）整块消失；显示的是 `week=1`。
**改动** → 新增 `_syncWeek()`（:338）：每次 `onShow` 先把 `current` 纠回真实当前周（仅用于折叠判定）；仅当 `!this._weekManual` 时把 `week` 也纠回当前周并 `return true` 让 `onShow` 走 `load(true)` 强刷。`onLoad` 置 `this._weekManual=false`（:137）；`_applyWeek` 手动切周时置 `this._weekManual=true`（:531，保留用户选择不被冲掉）；冷启动极端场景（config 在首屏 onShow 仍未就绪）在 `app.ready().then(...)` 补一次纠回（:174）。`onShow` 改「`const corrected=this._syncWeek(); this.load(corrected||dutyDirty)`」。
**影响** → 仅值日页周次折叠与「已结束」入口；不改任何云函数、不改值日数据口径（`pastDays` 计算逻辑未变，只是恢复正确输入）。
**验证** → 门禁 `scripts/check-duty-week-sync.js` 13 项（4 场景 + 静态断言 `onShow` 含 `_syncWeek`）+ 变异自证（临时 `if(false)` 关 week 纠正 → 判死 4 项，证非假绿；还原全绿）。`check-duty-ended`/`check-duty-columns`/`check-duty-stats-source`/`check-duty-rotation`/`check-duty-marker-symmetry`/`check-week`/`check-week-swipe`/`check-weeks-semantics` 全绿（无回归）。`node --check` 通过。

### §2 请假「已过时段」把多天假误标

**问题** → 10-10~10-11 下午的假（每天 13:00-18:00），10-10 晚 23:44 首页请假弹层就显示「已过时段」。
**根因** → `pages/home/index.js` `_setLeaveHomeClass` 内的 `markOver` 只比 `util.clockNow()` 与 `x.startTime/endTime`，**完全丢了日期区间** —— 只要「今天时钟过了 endTime」就标 `over=true`，没看 `endDate` 还有没有明天。多天假（班委按日期区间代登，2026-10-08 上线）必中招。旧语义「over = 此刻不在 [startTime,endTime] 内」是当天口径，对跨天假错误。
**改动** → 按 `endDate` 收口：「已过时段」= 该请假不再有任何未来时段 —— `today<endDate → false`（明天还要请）；`today>endDate → true`；`today===endDate` 且整天假 → `false`；`today===endDate` 且有时段 → `now2 > String(endTime)`。⚠️ 整天假那行刻意逐字保留以复用门禁 M4 锚点。
**影响** → `over` 只驱动「已过时段」徽标（+ 已废弃的 `leaveHomeNowList`）；课堂情况缺席判定走 `_buildCourseInfo` 内**自己的 `overlap`**（不用 `over`）⇒ 不受影响；卡片大数字走后端 `now`（实时口径，未改）。
**验证** → 反馈回路 `outputs/debug/probe-markover.js`（vm 桩 + 冻结时钟 `2026-10-10 23:44`，4 场景：A 多天假 10-10~10-11 / B 同天半天假 / C 多天整天假 / D 最后一天下午假已过）。修复前场景 A 判红（over=true=用户症状），修复后全绿。门禁 `scripts/check-leave-realtime-courseinfo.js` 加 M15 变异（删 `today<d1` 守卫）→ 被抓（1 条判据翻红）；基线 0、14/14 变异全抓。`check-leave-register`/`check-leave-delete`/`check-leave-tag-realtime`/`check-courseinfo-absentee`/`check-today-course` 全绿。`node --check` 通过。

### §3 门禁 / 部署

- 全量门禁 **79/79 全绿**（新增 `check-duty-week-sync.js`；`check-leave-realtime-courseinfo.js` 加 M15 变异）。
- 本版**仅前端改动**：云函数未改、无需重部署；无表结构变更。
- ⚠️ **前端需重新上传**：开发者工具打开仓库根目录 → 先点「编译」→ 再点「上传」。

---

## v0.7.32 · 2026-10-08 · 对外 1.0.6
**主题：请假 v2 —— 假条图片 / 历史请假记录 / 可选时段（半天假）+ 首页两处修复**

> 口径：本版为**新功能版**。六条需求经 `grill-me` 拷问定案，中途用户**撤回「彻底解耦」决议**（见 §5）。
> 云端 `adjust`、`cron-weekly` 已部署；**前端待上传**。门禁 **64/64 全绿**。

### §0 改动清单

| 分类 | 文件 | 改动 |
|---|---|---|
| **库** | `leave_request` | 新增 4 列：`start_time TIME` / `end_time TIME` / `leave_image VARCHAR(128)` / `cancelled_at DATETIME`（建备份表 `bak_leave_request_20261008`，10/10 行核对） |
| **云端** | `cloudfunctions/adjust/index.js` | 新增 `normTime` / `normTimePair` / `inLeaveWindow` / `addDays` / `diffDays` / `imageArchiveState` / `clampLeft`；新增路由 `leaveHistory` / `leaveImageSet`；`applyLeave` / `addLeave` 写时段；`addLeave` 幂等**同时比时段**；`cancelLeave` 写 `cancelled_at`；`leaveBoard` 返回 `now`（实时口径）；`leaveSummary` 辅导员分支改实时口径 |
| | `cloudfunctions/cron-weekly/index.js` | 新增 `purgeLeaveImages(pool)`，挂 **daily 6:00** 与 **hourly / 手动**两个分支 |
| **前端** | `miniprogram/pages/home/index.wxml` | 请假卡「查看名单」补 `bindtap="onLeaveHomeOpen"`；「查看班级」卡补 `st-item st-7` |
| | `miniprogram/pages/roster/index.{js,wxml,wxss}` | 登记弹层加「今日 / 历史」tab、半天假开关 + 两个 time picker、每行「传假条 / 看假条」、历史三态标记 + 归档角标 |
| | `miniprogram/utils/api.js` | 新增 `leaveHistory` / `leaveImageSet` |
| **改动脚本** | `scripts/migrate-leave-v2.sql` | 新增（4 条 ALTER + 列语义文档） |
| **门禁** | `scripts/check-leave-register.js` | 判据 ② 改为容忍拼接（幂等 SQL 折行）+ 新增「幂等必须比时段」断言 |
| **发版件** | `outputs/v1.0.6-更新说明.md` / `CHANGELOG.md` / `HANDOFF.md` / `.workbuddy/memory/2026-10-08.md` | 更新说明；v0.7.32 节；交接；本日志 |

### §1 首页「查看名单」点了没反应

**问题** → 首页本班请假卡上「查看名单 ›」点了没反应，只有点「N 人请假」才能打开，容易误导。
**根因** → 该 `view` 只写了文案，**没有 `bindtap`**；点击冒泡不到任何处理函数。
**改动** → `miniprogram/pages/home/index.wxml` 第 229 / 240 行补 `bindtap="onLeaveHomeOpen"`（与「N 人请假」同一弹层）+ `hover-class`。
**影响** → 仅首页请假卡，无副作用。
**验证** → 目测 + 页面运行时门禁（`check-pages-runtime.js`）。

### §2 首页「查看班级」卡无入场动画

**问题** → 首页 7 张卡都有逐级上浮入场，「查看班级」卡直接显示。
**根因** → 该卡**漏标 `st-item` 与档位类**（第 7 块起封顶 → `st-7`）。
**改动** → `class="card mt16 notice-card st-item st-7"`。
**验证** → `scripts/check-tab-enter.js`（JS↔CSS 档位双向比对）通过。

### §3 假条图片 + 历史请假记录 + 回收站

**问题** → 请假只有文字记录，看不到假条；登记过的假查不到历史；假条图片需要到期清理。
**根因** → `leave_request` 无图片列、无「含撤销」的历史查询、无清理任务。
**改动** →
- 图片：复用 v0.7.14 通知配图链路 —— 前端 `chooseMedia` 压缩 → `request.uploadFile('leave/…')` **直传云存储**拿 fileID → `api.leaveImageSet` 存列（**二进制不经云函数**：云函数绑 VPC，拉云存储极慢）。权限 = `requireLeaveRegister`（仅班委 / 超管传），查看 = `requireLeaveView`。换图时 `cloud.deleteFile` 删旧图。
- 历史：新增 `leaveHistory` 路由（`requireLeaveView` + `resolveClassId`，查 `APPROVED` + `CANCELLED`，倒序 100 无筛选；状态**现算** ONGOING / ENDED / CANCELLED / UPCOMING，不存列 —— 请假结束是时间推移的自然结果）。
- 回收站：**不建独立页**，只做「归档态 + `N 天后清除` 角标」。`end_date` 次日 0 点归档、`+7 天` 由 `cron-weekly.purgeLeaveImages` 物理删云存储并置 NULL；撤销的假条按 `cancelled_at + 7 天` 同口径清除。
**验证** → 生产库只读实跑 `leaveHistory` SQL 无报错；`cron-weekly` 部署后包复核一致。

### §4 可选时段（半天假）

**问题** → 请假最少一天，半天假无法登记。
**根因** → `leave_request` 只有日期列。
**改动** → 加 `start_time` / `end_time`（`TIME`）。语义 = **区间内每天相同时段**（跨天也支持），两空 = 整天。`normTimePair` 校验：只给一半或 `end <= start` 抛 41001。`addLeave` 幂等**同时比时段** —— 只比日期会让「整天假」把「半天假」吞掉（登记不进去）。
**影响** → 值日标记仍按**整天**处理（用户定：半天假也整天免）；排班规则一行未动。
**验证** → 门禁 50 新增「幂等必须比时段」断言（判据加强而非改业务代码迁就旧正则）。

### §5 口径分层（本版最关键的一条设计）

**背景** → 本项目有「顶部数字 ≠ 弹层明细条数」的旧伤（门禁 49）。
**定案** →
- **日期口径**（`leaveBoard` / `leaveHistory` 的 `list` + `stat`）：当天有生效请假的全列（含已过时段的半天假）→ 弹层「今日请假 · N 人」与名单行数**恒等**。
- **实时口径**（`now` / `leaveNow`）：此刻真在请假时段内 → **只给在位统计与辅导员各班汇总**用。
- 前端 `leaveNow` **从过滤后的 list 现算**，不用后端那份（否则串班过滤后两个口径又对不上）。

**🔴 用户中途反转**：原定「彻底解耦（请假零碰 duty 行）」**撤回** —— 现有「自动标记已请假 + 撤销恢复」逻辑与弹层提示**原样保留**，**排班规则一律不动**（不论是否请假一律排班）。

### §6 踩的坑

1. **门禁 50 首轮 FAIL** —— 我把幂等 SQL 折成多段拼接 + 加时段条件，旧正则匹配不到。**修门禁而不是改业务代码迁就旧正则**。
2. **归档倒计时出现 `-1 天后清除`** —— 清理按 **datetime** 触发（hourly / daily），展示按 **date** 计算，两者差不到一天；加 `clampLeft()` 夹到 ≥ 0。
3. **`fn code download adjust` 报 `Invalid URL`**（同期 `cron-weekly` 正常）—— 下载通道偶发失效。改用两条替代核验：① `fn invoke` 冒烟（真 action 回 40001 ≠ 未知 action 回 41001）；② `fn detail` 回显线上源码全文直接 `grep` 关键符号。

### §7 门禁 / 部署

- 全量门禁 **64/64 全绿**（改动后复跑两次均 64/64）。
- `check-wxss-compile.js`（wcsc 真编译）全过；`check-wxml-expr-depth.js` 10/10。
- 部署 `adjust` + `cron-weekly`：部署**前**下载线上包与「开工前基线」比对 = 逐字一致（无热修）；部署**后**下载包 diff = `index.js` 与 `common` 均一致。
- ⚠️ **前端需重新上传**：开发者工具打开仓库根目录 → 先点「编译」→ 再点「上传」。

---

## v0.7.26 · 2026-09-27 · 对外 1.0.4.1
**主题：本批全部内容 —— 轮转游标单向漂移修复（主修）+ 微信提醒字段对齐 + 模拟态护栏 + 通知一次性弹窗 + 值日次数口径 + 课表隔离与入口修复**

> 口径（2026-09-27 用户定）：**原计划的「1.0.5」批次取消，本批全部归入 1.0.4.1**；将来新加功能时才 bump。
> 相对线上的 **1.0.4** 发布态：前一批 **修改 29 / 新增 4 / 删除 1**；
> **需求 D（权限下放）追加 修改 34 / 新增 1**（第 45 个门禁），见 **§6**。
> §1~§4 是**主修**（轮转游标漂移）的详录；本批其它内容见 **§5**。

### §0 改动清单

| 分类 | 文件 | 改动 |
|---|---|---|
| **主修** | `cloudfunctions/schedule/index.js` | `remove` 路由：回滚条件由 `source === 'AUTO'` 改为 `status !== 'SWAPPED_OUT'`（值日真被删就无条件减回） |
| | `cloudfunctions/course/index.js` | 新增 `rollbackDutyMarkers(conn, ids)`；在 OFF / MOVE-dup 两处 `DELETE FROM duty` **之前**调用 |
| **同批** | `cloudfunctions/member/index.js` | `list(manage)` 的 `dutyCount` 由轮转游标改为 `COUNT(*) FROM duty WHERE member_id = ?`（与 `duty.myStats.term` 同源） |
| | `cloudfunctions/media/index.js` | 通知「一次性弹窗」：`msgList` 加 `LEFT JOIN notice_popup_seen`（整条 SQL 12 参数）+ 新增 `msgPopupSeen`（INSERT IGNORE）；提醒字段映射对齐 thing1/thing5/thing8 |
| | `cloudfunctions/cron-weekly/index.js` | 提醒字段映射对齐 thing1/thing5/thing8 |
| | `miniprogram/app.js` | 接入 `wx.getUpdateManager`（`onUpdateReady` → 「立即重启」；`checkForUpdate` 60s 节流；回调只绑一次） |
| | `miniprogram/utils/config.js` | `APP_VERSION` 单一来源（原 wxml 硬编码收编）`1.0.4` → **`1.0.4.1`**；新增 `TIMETABLE_CLASS_ID` |
| | `miniprogram/utils/impersonate.js` | **新增**：模拟态护栏（`isImpersonating` / `clearImpersonation` / 横幅文案） |
| | `miniprogram/utils/api.js` | 新增 `appNoticePublish` / `appNoticeLatest` / `appNoticeSeen` / `msgPopupSeen` 等前端封装 |
| | `pages/home/index.{js,wxml}` | 模拟态红色横幅 + 通知一次性弹窗（`_loadPopups` 优先级：通知弹窗 > 更新公告，一次只弹一层） |
| | `pages/mine/index.{js,wxml}` | 模拟态横幅（删掉与之重复的旧恢复行）+ 公告版本号自动取 `APP_VERSION`、标题固定 |
| | `pages/duty/index.{js,wxml}` | 模拟态红色横幅 |
| | `pages/timetable/index.{js,wxml}` | 模拟态横幅 + 课表按班隔离（非课表班空态）+ 切周条/校历守卫补 `!isCounselor`（**真回归**，§76） |
| | `pages/notice/index.js` | 通知入口文案修正（「我的 → 通知」→「首页 → 查看通知」） |
| **门禁/脚本** | `scripts/check-impersonate-guard.js` | **新增第 43 个门禁**（6 段断言 + 7 组变异） |
| | `scripts/check-duty-marker-symmetry.js` | **新增第 44 个门禁**（5 段断言 + 8 组变异自证） |
| | `scripts/check-today-course.js` | 判据改为锁意图（原写死「今日无课」，界面早已「今天无课🎉」→ 长期假红） |
| | `scripts/check-timetable-local.js` | 同步真回归修复（守卫须同时含 `hasTimetable` 与 `!isCounselor`） |
| | `scripts/check-clean-label.js` / `scripts/deploy.md` / `scripts/init.sql` | 门禁与表结构登记（合计 **44** 个门禁） |
| | `scripts/migrate-notice-popup.sql` | **新增**：建表 `notice_popup_seen(notice_id, member_id)` |
| | ~~`scripts/_fix_gate_cleanlabel.js`~~ | **删除**（一次性修补脚本，已并入 `check-clean-label.js`） |
| **数据库** | 新表 `notice_popup_seen`；**业务数据零改动** |

### §1 现象与只读取证

- **现象**（用户报）：第 6 周值日名单里**没有 1 号**（`duty` week6 = 48 行：55, 56, 02~47）。
- **线上只读取证 7 条**（不改库）：
  1. `duty` 按周分布：w3 = 25~48 / w4 = 01~08 + 49~56 / w5 = 09~54 / w6 = 55,56,02~47（共 134 行，全 `AUTO` / `PENDING`）；
  2. 生成前游标：`55/56 = 1`、`02~54 = 2`、**`01 = 3`（全班唯一进度 3）**；
  3. 队列 `[55,56,02,…,54,01]` 取前 48 → 1 号恰好被切在队尾；
  4. 漂移沿序号：1 号漂移 2、02~24 各漂移 1、25~56 漂移 0；
  5. `duty_log`：1 号 = 12 次 `CREATE` / 3 次 `CANCEL`（**全班最多**），而 `CANCEL` 全仓**只由 `schedule.remove` 写出**；
  6. 1 号 `last_duty_at = 2026-09-28`（w3 周一）却**没有任何 w3 存活行** → 典型「手动加进 w3 后又取消」留下的化石；
  7. 1 号无请假、w6 全 `AUTO`/`PENDING`、库内**无 `MANUAL` / `SWAPPED_OUT` 行**。

### §2 根因：游标读写不对称

`member.duty_count` 是**轮转游标**（决定「下一个排谁」），不是「实际值了几次」。它的增减从来不成对：

- **加**（无条件）：`schedule.addManual` 直接 `duty_count + 1`；`schedule.reassign` 把该行 `source` 改成 `'MANUAL'` 时也给换上的人 +1。
- **减**（挑食）：`schedule.remove` 旧实现**只对 `source === 'AUTO'` 才 −1** ⇒「手动加人 → 取消」这条路径**只加不减**，每走一次该成员游标**永久 +1**，反复几次即被排到队尾。
- **第二条泄漏通道**：`course.syncDutyForShift` 的 OFF（整节取消）/ MOVE-dup（撞上同日重复）两处裸删 `duty`，**从不回滚游标**。

⇒ 1 号 = 幽灵 1 + 真实 1 + 泄漏 1 = **3**（全班唯一），在第 6 周 48 个名额的队列里被挤到第 56 位，整周消失。

### §3 修法（零数据改动）

- **`schedule.remove`**：回滚条件改为 `status !== 'SWAPPED_OUT'` —— 只要这条值日真的被删掉，就**无条件减回一格**；
  换人产生的 `SWAPPED_OUT` 行是「原地替换、人仍在排」，不回滚。
- **`course`**：新增 `rollbackDutyMarkers(conn, ids)`（按 `member_id` 汇总 `COUNT(*)`、`status <> 'SWAPPED_OUT'`，
  逐人 `GREATEST(duty_count - n, 0)`），在 **OFF / MOVE-dup 两处 `DELETE FROM duty` 之前**调用。
- **不改数据、不重排第 6 周**：游标 3 在「波次」语义下本来就是**正确的**（01~47 已 3 次 / 48~56 已 2 次），
  强行清零或回改会让第 7 周从 1 号重排 —— 反而制造新错误。

### §4 验证 · 部署 · 发布口径

- `node --check` × 3 OK；**44/44 门禁全绿**（项目首次 44 个）；备份 `20260927-160351-修值日轮转游标泄漏：remove-仅对-AUTO-回滚-+-course-临时调`。
- `schedule` / `course` 已 `updateFunctionCode` 部署；`tcb fn code download` 下载线上包**逐字节一致**
  （sha256 `1070678e…` / `813bea94…`，`diff -rq` 无差异）；探针调用返回 **41001（未知操作）**而非 40001，证明路由已是新版。
- 新增第 44 个门禁 `check-duty-marker-symmetry.js`：按**所在函数体**审计每一处 `DELETE FROM duty` 是否配了游标回滚
  （不做「前后 N 字符窗口」扫描 —— 那会把注释里的示例 SQL 当成真站点，实测造成 2 个假红）。
- **版本口径（用户 2026-09-27 定，两次澄清后的最终口径）**：① 原计划的「1.0.5」批次**取消**，本批全部功能**统一归入 1.0.4.1**；
  ② 本次**前端代码不重新上传**（后端已在线上生效），前端相关项与「关于」页版本号待下次上传时生效；③ 将来**新加功能**时才 bump 版本号（1.0.5、1.0.6…）。
  `APP_VERSION` 已在代码内置为 `1.0.4.1`。
- 细节全貌见 `.workbuddy/memory/DETAILS.md` **§77**。
- ⚠️ **连带影响（版本号可见性）**：更新公告的版本号由**客户端**读 `APP_VERSION`（`pages/mine/index.js` 的 `onAnncSend`）后传给云函数落库
  → 前端未重传期间，超管发公告时 `app_notice.version` 仍写 **1.0.4**（正文可手写 1.0.4.1 补足）；要发出真正的 v1.0.4.1 公告，
  须等下一次上传小程序代码。「关于」页同理。

### §5 本批其它内容（同属 1.0.4.1，详见 `.workbuddy/memory/DETAILS.md` §74~§76）

| # | 内容 | 问题 → 修法 | 落点 |
|---|---|---|---|
| 1 | **值日次数口径**（§74） | `roster` 页「值日次数」用轮转游标 `member.duty_count`，与值日页口径不一致（线上 60 人中 25 人对不上、游标合计 116 vs 实际 86）→ 改为 `COUNT(*) FROM duty WHERE member_id = ?` 实时计数（与 `duty.myStats.term` 同源）。**影响面仅 roster 页**；`schedule.manualBoard`「本轮已排」与 `adjust.swapCandidates` 仍是游标（算法公平排序依赖），**有意保留** | `cloudfunctions/member` + `pages/roster` |
| 2 | **模拟态护栏**（§75） | 先答清「切到已绑微信的辅导员**不冲突**」（`impersonation` 键 = 调用者自己的 openid）→ 新增 `utils/impersonate.js` + 4 个 tab 页 `</nav-bar>` 后、**`<spring-scroll>` 之外**的 `notice-bar type="danger"` 横幅（「恢复本人」→ 清 impersonation → refreshAuth → **reLaunch 首页**，不能原地补丁） | 4 个 tab 页 + 新门禁 43 |
| 3 | **通知一次性弹窗**（§74） | `notice_msg.popup=1` + 新表 `notice_popup_seen(notice_id, member_id)` **逐条**记已读；**故意不复用** `app_notice`（全局表 + 单游标 → 会越权可见 / 两种弹窗互相盖过而静默丢失）。前端 `_loadPopups` 一次只弹一层 | `cloudfunctions/media` + `pages/home`/`mine` |
| 4 | **真回归：课表守卫**（§76） | 课表隔离把切周条守卫写成 `{{hasTimetable}}`，而辅导员主班就是 `class_id=1` → 恒 true → **辅导员照样看到切周条 / 校历** → 改 `{{hasTimetable && !isCounselor}}` | `pages/timetable` + `check-timetable-local.js` |
| 5 | **门禁对齐**（§76） | `check-today-course` 长期假红 = **门禁过时**（写死「今日无课」，界面早已「今天无课🎉」）→ 改锁意图 + 4 项自证。**教训：门禁红不得默认当漂移，须三步定性**（① 意图是否成立 ② 被产品决策取代→改门禁 ③ 仍成立而代码偏离→改代码） | `scripts/check-today-course.js` |
| 6 | **强制更新 + 版本号单一来源** | 微信只在冷启动检查更新 → 「已发布却仍跑旧包」→ 接 `wx.getUpdateManager`（「立即重启」）；`APP_VERSION` 从 wxml 硬编码收编到 `utils/config.js`，并由 `pages/mine/index.js` 透传 | `miniprogram/app.js` + `utils/config.js` |
| 7 | **提醒字段对齐** | 值日提醒 / 班级通知的推送字段与真实模板关键词不符 → 被微信拒收（表现为「授权了却收不到」）→ env + 源码统一 thing1（日程主题）/ thing5（备注）/ thing8（课程名称） | `media` / `cron-weekly` |
| 8 | **课表按班隔离** | 非课表班也渲染课表 → 改为按 `TIMETABLE_CLASS_ID` 隔离，其余班显示「课表待接入教务系统」空态 | `pages/timetable` |

### §6 需求 D：权限下放（2026-09-27 晚，同属 1.0.4.1）

**背景**：`member.position`（职务）原先是**纯展示字段**，「生活委员」「班长兼团支书」只是称号，实际无任何操作权限 ——
排班、名册维护全部压在超级管理员一人身上。本批把它**升格为授权依据**，把作业分给两个班委。

**三域口径**

| 域 | 能力位 | 判定式 | 覆盖范围 |
|---|---|---|---|
| 排班域 | `canSchedule` | 超管 \| 本班**生活委员**（`position='生活委员'` 且 `group_tag<>'X'`） | 生成 / 发布 / 撤回发布 / 调整值日 / 处理换班申请 |
| 名册录入域 | `canRosterEdit` | 超管 \| 辅导员 \| 本班**班长兼团支书** | 添加成员 / 导入名单 / 调整分组 / 撤回导入（**不含**移出与停用） |
| 职位授予域 | `canGrantPosition` | **仅超管** | 任免「生活委员」「班长兼团支书」 |

**关键决策（四条，均非显而易见）**

1. **能力位单一来源 = `auth.login`**，前端经 `app.js` 三个同名方法读，**不自算 position 字面量**
   （判定式散落两处必然漂移）。前端只决定入口显隐，**不是安全边界**；真拦截在云函数
   `guard.requireScheduleAuth` / `requireRosterEdit` / `requirePositionGrant`。
2. **授予权必须比使用权更严**：这两个职务是排班权与名册编辑权的**授权来源**，谁能任命就等于谁能发权限。
   原先 `setPosition` 由「超管 + 辅导员」把守 ⇒ 辅导员可自行任命生活委员 = 间接授予排班权。
   现收紧为**仅超管**，且必须同时判「目标当前职务」（只判新值会留「辅导员改掉已有生活委员」的间接撤权后门）。
   ⚠️ 凭据类（`ai_setting` 的 key）**不得因撤职清除** —— 明文只存一次、接口只回掩码，清掉**不可逆**；
   可用性完全由 `position` 判定（撤职立即失效、重新任命立即恢复）。
3. **新增越权口的封堵（实施中新发现，定案时未察觉）**：`member.applyImport` 的 `mapping`
   （{ 班级标签 → classId }）是**前端回传、可伪造**的，而函数只认 `g.classId`，**此前无人校验调用者班级**
   ⇒ 放开到「班长」后就是**跨班批量改姓名 / 分组**的越权通道。已加本班作用域校验：
   非超管 / 非辅导员只允许写本班，越界分组**整组剔除**并计入 `skippedRows` 回报原因（**不静默**）。
4. **AI 落库沿用 `source='AUTO'` + `duty_log.action='AI_APPLY'`** —— 新增枚举会让 7 处
   `source='AUTO'` 判据（`schedule` 的 247/703/710/718/721/1385 等）集体漏删。

**改动清单**：`cloudfunctions/common/guard.js`（+74 行：`isDutyAdmin` / `isMonitor` / `requireScheduleAuth` /
`requireRosterEdit` / `requirePositionGrant` / `isGrantedPosition` + 两个职务常量，**纯增量**、既有导出零改动）；
`auth`（下发三个能力位）；`schedule`（16 条路由改 `scheduleAuth` + 派发器接线 + 空集守卫 + AI 动作）；
`adjust`（2 条 `scheduleAuth` + 班级作用域）；`member`（`requireRosterEditCheck` × 4 + `setPosition` 授予权 +
`applyImport` 跨班兜底）；`app.js`（三个能力位方法）；`pages/duty`（5 处入口改按 `canSchedule`）；
`pages/mine`（新增 `canSchedule` 数据位并在 `onShow` / `app.ready()` / `_afterSwitch` 三处补算）；
`pages/roster`（导入批次改按 `canRosterEdit` + 授权职位置灰）；`utils/util.js`（`GRANTED_POSITIONS`）。

**刻意未改**：`pages/timetable` 的三处 `isSuper`（校历 / 临时调课 / 长按提示）——
那是**课表域**，不在排班域内，是有意划的边界。

**影响面**：不涉及数据结构变更，不改动任何已有业务数据。新增可操作人群 2 类；收紧 1 处（两职务任免）。

**验证**：新增第 **45** 个门禁 `check-permission-delegate.js`（三域能力位 / 排班域路由覆盖 16+2 /
名册守卫 4 处 / 跨班兜底 / 前端入口按能力位，**6 组变异自证**）；`check-positions-sync.js` §③
由「整文件匹配」重写为**限定 `setPosition` 函数体内**（旧判据靠 else 分支侥幸绿，授予权被整段删掉也查不出）
+ 4 组变异自证；`check-committee.js` §② 新增「授权职位置灰 + 仅超管授予」。**全量 45/45 全绿**。

**部署**：`common/guard.js` 为纯增量，按 `deploy.md` §2.1 硬规则**全 12 个带副本的函数**重新部署。
部署前先下载线上版与改动前备份基线比对（11 个逐字节一致）以证明「仓库即真源」、排除静默回滚；
部署后重新下载 `diff` **12/12 一致**，并复核 env / VPC / `cron-weekly` 的 5 个触发器均未被动。

**⚠️ 线上错配状态（前端未重传期间）**：后端已生效、前端仍为 1.0.4 ⇒
生活委员 / 班长**看不到**新入口（无新功能，亦无回归）；**唯一会碰到人的收紧**是辅导员此时任命两职务
会收到 40003「该职位由超级管理员任命」—— 预期内，前端重传后该两项置灰即不再出现。

### §7 需求 D（下半）：AI 排班自带密钥（2026-09-27 晚，同属 1.0.4.1）

**背景**：AI 生成值日表原先只能用平台统一配置的密钥（存在 `ai-proxy` 的 `DEEPSEEK_API_KEY` 环境变量里），
大家共用一份额度。本批允许每人**自带**接口地址与密钥，谁用谁付。

**⚠️ 口径纠偏（实施中发现问题后改的）**：初版按 `class_id` 建表（一班一把钥匙），
但与定案的两条生命周期规则对不上 —— 定案是「**撤销职位保留**、仅**删除成员**时清行」，
而 schedule 的注释写得更直接：「模拟态下会消耗**被模拟者本人**的 key 额度」。
这两条只有**配置跟随本人**才说得通。已改为 `member_id` 唯一（一人一条），
表为空时 DROP 重建（已先 `SELECT COUNT(*)` 确认为 0）。

**为什么 ai-proxy 连不了库**：它是全环境**唯一不绑 VPC、有公网出口**的函数，
而库在 VPC 内 ⇒ 读不到 `ai_setting`。所以流程是：**schedule（有库）读出配置 → 通过 event 传给 ai-proxy → ai-proxy 校验后使用**。

**三道闸（缺一不可，否则是内网探测通道）**

| 闸 | 内容 | 为什么 |
|---|---|---|
| ① | 复用 `assertPublicUrl`：`http/https` 白名单 + `isPrivateIp` 直判（0/10/127/172.16-31/192.168/169.254/::1）+ 域名 **DNS 解析后复判** | 自定义地址 = 可被配置成访问任意地址 |
| ② | 禁 `?` 与 `#` | 密钥拼进 URL 后，fetch 失败时 Node 会把**完整 URL**写进 `error.message`，本函数又会把 `e.message` 打进日志 ⇒ 密钥落日志 |
| ③ | 自定义地址出错**不回显上游响应体**，只回状态码 | 「任意地址请求 + 内容回显」= 一条可借道的内网探测通道；官方域名保留回显，否则排查不了「密钥无效 / 模型名写错」 |

**附带补的两条**（同样是绕过 ① 的路子）：
- **禁跟随跳转**：自定义地址一律 `redirect: 'manual'`，遇到 3xx 直接报错 —— 否则可 302 到内网绕过「解析后复判」。
- **端口白名单**：仅 80 / 443 / 8080 / 8443。

**纵深防御**：schedule 保存时先用 `assertBaseUrlLite` 做**不需要 DNS** 的快拦（协议 / 禁参数 / 端口 / 内网 IP 字面量），
ai-proxy 出口再做一次 DNS 级终拦 —— 本函数绑 VPC **没有公网 DNS**，做不了解析，所以必须分工。

**其它口径**
- **只回掩码**：`aiSettingGet` 返回 `keyMask`，**永不回传明文**。明文在库里只存一次 ⇒ 清掉不可逆。
- **平台密钥仅超管兜底**：本人没配密钥时，只有超管能回落平台那一份（否则生活委员一键借走平台额度且无法归因）。
  在 `resolveAiCfg` 与 `aiSettingSave` / `aiSettingTest` 三处都卡。
- **生命周期**：撤销「生活委员」**不清**密钥（职位频繁调整，清了不可逆）；仅 `member.removeMember` 与 `staffDelete` 两处删人时清（防孤儿钥匙行 + id 复用挂错人）。
- `ai-proxy` 的 `ping` 也支持带自定义地址与密钥，用于前端「测试连通」；`aiSettingTest` 并入 `AI_ACTIONS`（禁模拟态）。

**验证**：新增第 **46** 个门禁 `check-ai-proxy-guard.js`（A 文本层 + B 行为层抽生产源码 eval 真跑 + C 5 组变异自证 + D 口径）。
**线上实测**（部署后直接 invoke）：官方地址 `ping` → `egress=ok, HTTP 200`；
`http://169.254.169.254/...` / `https://api.deepseek.com/v1?key=sk-secret` / `http://10.0.0.5:8080`
三者均返回 `41002` 并给出具体原因 —— 三道闸在真实环境确认生效。

**部署**：`schedule` / `member` / `ai-proxy` 三个函数；下载后 `diff` **3/3 逐字节一致**，
且部署前后 env / VPC / 触发器**完全未变**（ai-proxy 的 `DEEPSEEK_API_KEY` 等 4 个密钥类变量完好）。

---

## v0.7.27 · 2026-09-28 · 对外 1.0.4.2（合并发布）

**主题：合并发布 —— 1.0.4.1 全部前端随版上传 + AI 排班设置增强（接口预设 / 拉取模型列表）+ 设置弹层按钮并排与观感修复**

> 口径（2026-09-28 用户定）：**1.0.4.2 为合并发布版** —— 把 v0.7.26（1.0.4.1）虽开发完成但**一直未上传的前端**随本版一并上传，并叠加本批新增。1.0.4.1 的后端改动此前已在线上生效；本版前端上传后，1.0.4.1 阶段累积的全部前端能力真机可见，「关于」页与公告版本号统一为 1.0.4.2。后续新加功能再 bump（1.0.5…）。

### §0 改动清单

| 分类 | 文件 | 改动 |
|---|---|---|
| **新增（本批）** | `miniprogram/pages/mine/index.js` | 新增 `AI_PROVIDERS` 常量（deepseek / glm / qwen 三家的 baseUrl + 默认 model）；data 加 `aiProvider` / `aiModels`；新增 `onAiPreset` / `onAiFetchModels` / `onPickModel` |
| | `miniprogram/pages/mine/index.wxml` | 预设 chips 行（三 chip，选中高亮）+ 模型名行内「获取」按钮 + 模型选择列表（scroll-view） |
| | `miniprogram/pages/mine/index.wxss` | 新增 `.an-presets` / `.an-preset(.on)` / `.an-model-row` / `.an-fetch(.busy)` / `.an-models-scroll` / `.an-model(.on)`；`.an-input` 改 `padding:0 24rpx`（修文字靠下）；`.an-fetch` 改 flex 双轴居中（修文字不居中）；`.an-actions` / `.an-btn.ghost` 按钮并排 |
| | `miniprogram/utils/api.js` | 新增 `aiSettingModels` 映射（`schedule` 的 `aiSettingModels` 路由） |
| **后端（本批）** | `cloudfunctions/ai-proxy/index.js` | 新增 `listModels(baseUrl, apiKey)`（走 resolveEndpoint 三道闸 + 禁跳转，只回模型 id 列表、不消耗额度、自定义地址出错不回显响应体）；`exports.main` 新增 `action === 'models'` 分支（失败回 `fail(41002)`） |
| | `cloudfunctions/schedule/index.js` | 新增路由 `aiSettingModels`（scheduleAuth，调 ai-proxy `models`；非超管无密钥抛 40009）；`AI_ACTIONS` 集合扩入 `'aiSettingModels'`（模拟态禁调，与 `aiSettingTest` 同口径） |
| **门禁/脚本** | `scripts/check-permission-delegate.js` | 排班域路由数硬编码 `20` → `21`（新增 `aiSettingModels`）；注释同步「+5（aiSettingGet / Save / Test / Clear / Models）」 |
| **合并发布** | 前端 `pages/{home,mine,duty,timetable}` 各 js+wxml、`utils/impersonate.js`、`app.js`、`utils/config.js` 等 | v0.7.26（1.0.4.1）已开发的前端，**随本版上传**后真机可见（此前仅后端生效、前端未传） |
| **数据库** | 无新增；业务数据零改动 |

### §1 本批新增：AI 排班设置增强（接口预设 + 拉取模型列表）

**背景**：1.0.4.1 已落地「AI 排班自带密钥」（每个人填自己的接口地址 / 模型 / 密钥）。本批降低填写门槛：
- **接口预设**：DeepSeek / 智谱 GLM / 通义千问 三家 OpenAI 兼容端点 + 默认模型，点 chip 即填好，之后仍可手改或由「获取」覆盖。
- **拉取模型列表**：填完密钥点「获取」，后端经 `ai-proxy` 打服务商的 `/models`，只回模型 id 列表（去重排序限 200），**不消耗额度**；自定义地址出错不回显响应体（守三道闸之③）。

**链路**：前端 `onAiFetchModels` → `api.aiSettingModels` → `schedule.aiSettingModels`（scheduleAuth）→ 云函数内 `cloud.callFunction({name: AI_PROXY, data:{action:'models',baseUrl,apiKey}, timeout:30000})` → `ai-proxy.listModels` → 服务商 `/models`。非超管且本人无密钥 → 抛 `40009`（与 `aiSettingTest` 同口径）。

**安全口径**：`listModels` 复用 `resolveEndpoint`（三道闸：公网校验 / 禁 `?#` / 不回显响应体）+ 禁跟随跳转 + 端口白名单；自定义地址出错只回状态码、不上游正文 —— 与 1.0.4.1 的 `check-ai-proxy-guard` 门禁同口径，未放宽。

### §2 本批修复：设置弹层按钮并排 + 两处观感

- **按钮并排**：「测试连通 / 保存」原各占满一行、零间距，糊成一片且分不出主次。新增 `.an-actions`（flex 行容器、相邻兄弟 `margin-left:20rpx`、`.an-btn{flex:1}` 平分宽度）+ `.an-btn.ghost`（描边留白白底、品牌色 `#EC4899` 文字、2rpx 边框）作次要行动；公告弹层单按钮不受影响。纯布局，无逻辑变更。
- **「获取」按钮文字不居中**：原 `.an-fetch` 用 `line-height:84rpx` 撑高，真机偏移。改 `display:flex; align-items:center; justify-content:center; line-height:1`（与 `.an-btn` 同款）。
- **输入框文字靠下**：`.an-input` 原 `padding:20rpx 24rpx` —— 小程序 input 内层输入域被 padding-top 下推、内部文字仍按自身高度居中 → 视觉靠下约 20rpx。改标准写法 `padding:0 24rpx`（居中交给 `height:88rpx`）。

### §3 验证 · 部署 · 合并发布口径

- **门禁**：全量 **46/46 门禁退出码口径全绿**（初跑 grep 关键词误报 8 个「失败」，经退出码复核为假阳性）；`check-permission-delegate.js` 排班域路由计数 20 → 21 同步；相关 WXSS 经官方 `wcsc.exe` 真编译 28/28 通过；`check-wxml` 通过。
- **部署（本批后端）**：`schedule` + `ai-proxy` 两函数按 deploy.md 三件套（`cd 函数目录` + `--dir . --deployMode zip` + 管道送 Enter）部署；部署前下载线上版与本地 diff → 差异仅本次新增两处，线上无热修可回滚；部署后重新下载逐字节 diff **2/2 一致**；env / VPC / 触发器完全未变（ai-proxy 的 `DEEPSEEK_API_KEY` 等密钥变量完好）。
- **线上冒烟**：① `schedule{action:aiSettingModels}` → `40001 无法获取用户身份`（路由存在、模块图正常；修好前是 41001「未知操作」）；② `ai-proxy{action:models,baseUrl:api.deepseek.com}` → `errCode 0`，**真实拉回 DeepSeek `/models` 列表**。端到端连通。
- **合并发布口径**：本版将 v0.7.26（1.0.4.1）的前端一并上传。此前该批前端（权限下放入口 / AI 自带密钥设置页 / 模拟态护栏 / 通知一次性弹窗 / 课表隔离 / 自动检测更新 / 值日次数口径）在线上旧前端（1.0.4）上均不可见；本版上传后真机可见，「关于」页版本号显示 1.0.4.2、公告版本号由客户端读 `APP_VERSION` 落库为 1.0.4.2。
- **⚠️ 真机复测待办**：① 上传前端后真机验证本批三项（接口预设 / 获取模型 / 按钮并排 / 输入框与获取按钮观感）；② 一并验证 1.0.4.1 阶段的前端能力（生活委员 / 班长入口、模拟态横幅、通知弹窗、课表空态、自动更新提示）。
- 备份：v0.7.26 阶段以 `node scripts/backup.js` 留痕（改动前基线）；本批改动属小程序前端 + 两云函数，遵循铁律 1（改动前先备份、收工 `--diff` 复核）。

---

## v0.7.30 · 2026-09-29 · 对外 1.0.5
**主题：班委请假登记 + 在位统计（需求④，新功能）+ 三项修复（需求①②③：安卓底栏贴底 / 添加值日弹层不能滚 / 待值日数字对不上）**

> 口径（2026-09-29 用户 grill-me 四轮定案）：整批 bump **1.0.5**（新功能 + 修复一次上传、一次提审）；
> 四条全部门禁都加；顺带修 `applyLeave` 的 class_id 隐患。

### §0 改动清单

| 分类 | 文件 | 改动 |
|---|---|---|
| **需求④ 后端** | `cloudfunctions/common/guard.js` | 新增 `isCommittee()`（学生班委：role∈{ADMIN,MONITOR} **且 group_tag<>'X'**）+ `requireLeaveRegister()`，并导出 |
| | `cloudfunctions/adjust/index.js` | 新增三路由 `leaveBoard` / `addLeave` / `cancelLeave`；**顺带修 `applyLeave` 的 `class_id` 漏写**（swap_request + leave_request 两处） |
| | `cloudfunctions/auth/index.js` | `login` 增加能力位 `canLeave = isSuper \|\| isCommittee` |
| **需求④ 前端** | `miniprogram/app.js` | 新增 `canLeave()` 读取 `profile.canLeave` |
| | `miniprogram/utils/api.js` | 新增 `leaveBoard` / `leaveAdd` / `leaveCancel` 三个封装 |
| | `pages/roster/index.{js,wxml,wxss}` | 统计第二行（请假/在位四项）+ 「请假」入口 + 名单「请假中」标签 + 请假登记弹层（日期区间 / 选人 / 已登记可撤销）+ `leaveShow` 进 page-meta |
| **需求①** | `custom-tab-bar/index.{js,wxml}` | 新增 `TABBAR_LIFT_PX = 32`；`tabbarPad = Math.max(safeBottom, LIFT)` |
| | `app.js` | `globalData.tabbarLiftPx = 32`（单值来源）；`sheetMetrics().tabbarPx` 叠加无安全区兜底 |
| | `home/index.wxss` / `timetable/index.wxss` / `duty-sheet/index.wxss` | 4 处让位值各加一行 `max(env(safe-area-inset-bottom), 32px)`，**并保留原 `env()` 行做老引擎回退** |
| **需求②** | `components/bottom-sheet/index.wxml` | `{{height …}}` 与 `{{capStyle}}` 之间**补 `;`**（此前粘连 → 整条声明被丢弃） |
| **需求③** | `cloudfunctions/duty/index.js` | 抽出唯一派生链 `deriveMyDuties()` + 分桶 `dutyBucket()`；`myStats` 与 `myList` 都改走它（不再 SQL 数 `duty.status`） |
| **门禁** | `scripts/check-inline-style-join.js` | **新增第 48 个**（内联 style 拼接） |
| | `scripts/check-duty-stats-source.js` | **新增第 49 个**（值日统计同源；含 `dutyBucket` 行为层自证） |
| | `scripts/check-leave-register.js` | **新增第 50 个**（请假登记权限 / class_id / 撤销对称） |
| | `scripts/check-tabbar-liquid.js` | 扩展 ⑤ 段：兜底留白的单值来源 + 4 处让位值 + 变异自证 |
| | `scripts/deploy.md` | 登记 48/49/50；修正部署清单**漏掉 `poster`**（11→12）；合计 47→50 |

### §1 需求① 安卓底栏贴底（修复）

- **现象**：同一页面，iPhone 底栏与屏幕底有一段留白，安卓紧贴屏幕底。
- **根因**：`.tabbar-wrap` 的 `padding-bottom` **只取** `safeBottom`（= `screenHeight − safeArea.bottom`）。
  iPhone（有 Home Indicator）≈34 ⇒ 有留白；安卓绝大多数无安全区 ⇒ 0 ⇒ 胶囊贴底。**全站没有任何兜底**。
- **改动**：组件新增 `const TABBAR_LIFT_PX = 32`，施加值 `tabbarPad = Math.max(sb, TABBAR_LIFT_PX)`
  —— 用 `max` 而不是三元：iPhone 取安全区（**完全不动**，正是用户选的口径），安卓/小手势条兜底到 32。
- **让位值联动**（否则安卓上悬浮按钮与页脚会被抬高后的胶囊压住）：
  `app.js` 加 `globalData.tabbarLiftPx`（与组件常量必须相等，门禁守）；`sheetMetrics().tabbarPx` 叠加 `(safeBottom>0?0:lift)`；
  4 处 `calc(Xrpx + env(safe-area-inset-bottom))` 各补一行 `max(env(...), 32px)`。
- ⚠️ **`max()` 在本项目首次使用** —— 先用**官方 wcsc 真编译**验证过（29 个 wxss 全过），
  且**保留原 `env()` 行做回退**：老引擎不认 `max()` 时整条声明会被丢弃 → `bottom` 退回 `auto`（元素乱飞），
  有了回退行就不会。
- 页脚空高（`.page-foot-space` 168rpx=84px vs 胶囊顶沿 81px）经核算仍够用，**未改**，避免无谓的 iOS 留白变化。

### §2 需求② 弹层不能上下滑动（修复 · 我上一批引入的真回归）

- **现象**：手动排班「添加值日」弹层 59 人列表**滚不动**。
- **根因**：`components/bottom-sheet/index.wxml` 的面板写法是
  `style="…;{{height ? 'height:'+height+'rpx' : ''}}{{capStyle}}"`；
  1.0.4.4 给胶囊安全上限加了 `{{capStyle}}`（值形如 `max-height:calc(100vh - 68px);`）时**漏了中间的 `;`** ⇒
  传了 height 的弹层拼出 `height:1040rpxmax-height:calc(100vh - 68px);` ⇒ **长度值非法 ⇒ 整条声明（连同 max-height）被丢弃**
  ⇒ 面板固定高度失效、高度落到 wxss 的 78vh，长列表滚不动。
- **受影响面**：**四个传 height 的弹层** —— 添加值日 1040 / AI 生成 1280 / 导入 1180 / 加值日生 1240。
  没传 height 的弹层不受影响（插值为空串，`;{{capStyle}}` 合法）——这是「只有个别弹层坏掉」的原因。
- **定位手法**：对比 1.0.4.4 **之前**的基线（`20260928-214852-1.0.4.4`）确认那时没有 `{{capStyle}}` ⇒ 锁定为本批引入。
- **改动**：补 `;`。门禁第 48 条按「规则」而非「这一次的具体值」守护。

### §3 需求③ 待值日/已结束数字与明细对不上（修复 · 口径分叉）

- **现象**：截图 —— 顶部「待值日 4 / 已结束 0」，点开弹层却是 3 条待值日 + 1 条已过期。
- **根因**：状态是**读时派生**的（`common/week.js` 的 `effectiveStatus`），库里 `duty.status` **恒为 'PENDING'**。
  弹层（`myList`）走派生 ⇒ 3/1 正确；顶部（`myStats`）却自己写 SQL 数那列：
  `SUM(status IN ('PENDING','ONGOING')) AS pending, SUM(status IN ('EXPIRED','DONE')) AS past`
  ⇒ 恒得「pending = 全部、past = 0」。**两套口径，谁改谁错。**
- **改动**：抽出**唯一**派生链 `deriveMyDuties(pool, classId, memberId)`（SQL + `effectiveStatus` + 字段映射）
  和**唯一**分桶 `dutyBucket(status)`（PENDING/ONGOING→pending；EXPIRED/DONE/**LEAVE**→past；SWAPPED_OUT→other 并整体剔除）。
  `myList` 按 type 过滤它、`myStats` 数它 ⇒ **顶部数字 = 弹层条数** 恒成立（且 `term === pending + past`）。
- **口径澄清**：`LEAVE`（已请假）计入「已结束」（该值日已了结），并**同步进 `myList` 的 past**——
  否则数字又会对不上（这正是本次要根治的病）。当前库里无 LEAVE 行，行为与线上一致。

### §4 需求④ 班委请假登记 + 在位统计（新功能）

- **入口与权限**：落「成员与分组」页；可操作者 = **全体学生班委**（`role ∈ {ADMIN,MONITOR}` 且 `group_tag <> 'X'`）| 超管。
  新增能力位 `canLeave` 由 `auth.login` 单一来源下发（前端经 `app.js.canLeave()` 读，不自算角色）。
  ⚠️ `isCommittee` 必须按 `group_tag` 排除教职工 —— 辅导员也是 `role=ADMIN/MONITOR`，只判 role 会把教职工放进来。
- **粒度**：**日期区间**（起~止，默认今天，上限 31 天）。区间内 `status ∈ {PENDING,ONGOING}` 的已排值日 → 置 `'LEAVE'`；
  未排的只登记（后续 AI 排班 / 手动加人已按 `leave_request` 跳过）。
- **可撤销**：`cancelLeave` 置 `CANCELLED` 并恢复值日；**恢复前必须复查「同一天是否仍被另一条生效请假覆盖」**，
  否则撤一条会把另一条的效力一起抹掉。
- **只给学生**：目标必须是本班在读学生（`status<>'DISABLED'` + `group_tag<>'X'` + 排除测试账号前缀
  `0000000000`），与「总人数 / A组 / B组」一贯口径一致。
- **统计**：顶部统计新增一行 —— 请假人数 / A组在位 / B组在位 / 全体在位，**按今天**；
  在位 = 名册人数 − 当天请假人数（前端用 `memberStats` − `leaveBoard.stat` 算，两处数字同源）。
- **不写 `swap_request`**：那是「本人申请」的载体，代登记不是学生本人的申请；且 `swap_request.duty_id` 是 **NOT NULL**，
  区间请假没有唯一 duty 可挂。因此 `leave_request.swap_id` 留空。
- **多班隐患（顺带修）**：线上 `leave_request.class_id` 是 `NOT NULL DEFAULT 1`，而 `applyLeave` 的 INSERT 不带它
  ⇒ **只有 1 班正确**；而 `schedule` / `adjust` 都按 `class_id` 过滤请假 ⇒ 其它班「请了假照样被排到值日」。
  已改为显式写 `guard.classIdOf(ctx)`（`swap_request` 同款一并修）。

### §5 部署

- `common/guard.js` 变更 ⇒ **12 个带 common 副本的函数全部重部署**（`ls -1d cloudfunctions/*/common | wc -l` = 12）。
- **部署前**：下载线上 12 个函数与改动前基线 `20260929-133520` 比对 —— 6 个函数（auth/member/class/media/cron-weekly/audit-receiver）
  的 `common/week.js` 有差异，逐行核对确认是「线上更早的 7.4 草稿状态机」被本版**完整覆盖**（无热修丢失）。
- **部署后**：回填 `diff` **12/12 一致**。
- ⚠️ **部署清单漏了 `poster`**（deploy.md 原先只列 11 个函数，而实际有 12 个带 common）——
  本次险些让 poster 停在旧 guard 上；已补进清单并加「先跑 ls 对齐」的注释。

### §6 门禁（50/50）

- 新增 **48** `check-inline-style-join.js`：全仓 `style="…"` 里 `'}}{{` 形态判死 + bottom-sheet 的 `{{capStyle}}` 前必须有 `;`；
  自证 3 组（删 `;` 必判死 / 好样本不误报 / 注释里的坏样本不被误判）。
- 新增 **49** `check-duty-stats-source.js`：`myStats` 不得再出现 `SUM(status` / `COUNT(*) AS term`，
  且 `myStats`/`myList` 都必须走 `deriveMyDuties()` + `dutyBucket()`；行为层抽 `dutyBucket` 真跑（六种状态 + 复刻截图 4→3/1）+ 变异自证。
- 新增 **50** `check-leave-register.js`：三路由守卫、`class_id` 显式写、只给学生、幂等、撤销对称、`isCommittee` 排除 X 组、
  能力位单一来源、roster 接线 + `leaveShow` 进 page-meta；变异自证（删守卫必判死）。
  - ⚠️ **本门禁当场抓出我自己的失误**：`guard.js` 的**真源是 `cloudfunctions/common/guard.js`**（`sync-common.js` 再复制进 12 个目录），
    我先改了 `adjust/common/guard.js` 这份**副本**，随后 `sync-common.js` 把它覆盖掉了 —— 改动等于没做，
    而 `auth` 已经在调用 `guard.isCommittee`（真上线就是 `undefined is not a function`）。门禁第一次运行即红，才暴露出来。
- 扩展 `check-tabbar-liquid.js` ⑤：`TABBAR_LIFT_PX` ↔ `app.js tabbarLiftPx` 必须相等、`tabbarPx` 叠加 lift、
  4 处让位值带 `max(env(...), 32px)` 且保留 `env` 回退行；变异（常量改成 40）必判死。
  - ⚠️ 该段第一版用一条大正则描述整行 `tabbarPx:…`，因 `Math.round(98 * (g.windowWidth || 375) / 750)` 有**嵌套括号**
    导致 `[^)]*` 提前截断 → **假红**；改为「取行 + 按要素判」。

### §7 真机复测待办

① 安卓机：底栏与屏幕底有留白、胶囊不被裁；iPhone：与改动前**无变化**；
② 安卓/iPhone：「手动排班 → 添加值日」列表可上下滑动、面板高度正常；AI 生成 / 导入名单 / 加值日生三个弹层一并看一眼；
③「我的」页「待值日 / 已结束」数字与点开后的明细条数一致；
④ 班委身份进「成员与分组」：顶部第二行统计、名单「请假中」标签、「请假」入口 → 选日期 + 点人登记 → 值日页该生当天显示「已请假」→ 撤销后值日恢复；
⑤ 非班委（普通同学）看不到「请假」入口与第二行统计（第二行仅 `canLeave` 可见）。

### §8 追加三项（搭车同号不 bump，2026-09-29 收尾）

> 决策④（grill-me 三轮定案）：三条追加直接并入 1.0.5，更新说明与提审 / 公告条目由 **5 条扩到 8 条**，版本号不动（APP_VERSION 仍 1.0.5）。

#### §8.1 改动清单（追加）

| 分类 | 文件 | 改动 |
|---|---|---|
| **后端** | `cloudfunctions/adjust/index.js` | 新增 `leaveSummary` 路由（辅导员只读视图：`requireLeaveView` + `resolveClassId` 班级隔离；mode='counselor' 返各班总数 / mode='class' 返本班明细） |
| | `cloudfunctions/common/guard.js` | 早已导出 `requireLeaveView`（真源；`sync-common` 已同步进 12 份副本，含 poster） |
| **门禁** | `scripts/check-leave-register.js` | 拆：查看类（leaveBoard/leaveSummary）→ `requireLeaveView`；写类（addLeave/cancelLeave）→ `requireLeaveRegister` |
| **前端 home** | `pages/home/index.{js,wxml,wxss}` | `_applyIdentity` 算 `showLeaveHome = isCounselor \|\| canLeave` + `leaveHomeMode`；新增 `_loadLeaveHome` / `onLeaveHomeOpen` / `onLeaveHomeClassTap`（辅导员点某班拉只读）/ `onLeaveHomeClose` / `onLeaveHomeCancelTap`（班委撤销）；请假卡（st-item st-7）+ 查看弹层（A/B 两组，可撤销）；补 `.lv` 容器样式 |
| **前端 roster** | `pages/roster/index.{js,wxml,wxss}` | `_loadLeaveBoard` 改为 `canLeave \|\| isCounselor` 都可拉看板；新增 `onLeaveViewOpen`（辅导员只读分支）/ `onLeaveViewClose`；只读名单弹层（A/B 组，无撤销）；补头像网格 `.lv-grid/.lv-cell*/.lv-grp/.lv-grp-t` 样式（前轮 WXML 改头像网格漏加样式，`check-wxss` 抓出） |
| **发版件** | `outputs/v1.0.5-更新说明.md` / `CHANGELOG.md` / `HANDOFF.md` / `.workbuddy/memory/DETAILS.md` §80 / `2026-09-29.md` | 更新说明 8 条；v0.7.30 同节合并；本日志；§80 |

#### §8.2 三条内容

1. **首页请假人数卡片**：班委 / 超管主页显本班当日请假人数，点开 A/B 组名单可撤销；辅导员主页显所带各班总请假人数，点开只读名单（无撤销）。
2. **辅导员班级页精简**：辅导员进具体班级的成员与分组页只显请假人数、不显在位；名单只读（登记权仍在班委 / 超管）。
3. **请假登记选人改头像网格**：选人列表由「一人一行」改为头像网格（每行 4 个），前轮 WXML 已改、本批补样式。

#### §8.3 关键修正

- ⚠️ 修 `home/index.js` 一处语法错误：`onLeaveHomeCancelTap` 收尾缺逗号 → 与 `onPinTap` 对象字面量报错，补逗号后 `node --check` 通过。
- `node scripts/sync-common.js` 已跑 → **12 个函数副本同步**（含 poster）；`adjust/common/guard.js` 已含 `requireLeaveView`。
- 全量门禁 **50/50 全绿**（含 `check-wxss` / `check-wxss-compile` 28 个真编译全过）。

#### §8.4 部署与状态（追加批次）

- **待办**：追加批次需**全量重部署 12 个云函数**（`adjust` 新路由 + `common` 同步）+ 前端重传（`home` / `roster` 改动）；通道见 `scripts/deploy.md` §2.1b。
- 真机复测补充 ⑥ ⑦ ⑧ 见 `outputs/v1.0.5-更新说明.md` 备注。

---

## v0.7.29 · 2026-09-28 · 对外 1.0.4.4
**主题：值日体验修复 —— 课次时间统一 / 明细排序修正 / 值日状态自动变更（已值日·进行中）/ 同课次合并一行 / 换班后实时刷新 + 弹层胶囊遮挡 + 序号牌缩小与左空收窄 + myList 崩溃修复**

> 口径（2026-09-28 用户定）：**本批为体验修复，搭车 1.0.4.4**（不另 bump）。1.0.4.3 为上一功能新增版。

### §0 改动清单

| 分类 | 文件 | 改动 |
|---|---|---|
| **主修（追加）** | `cloudfunctions/duty/index.js` | `myList` SQL `d.kind` → `s.kind AS sessionKind`（**1054 崩溃**）；`today` / `detail` 同类写法一并显式化 |
| | `cloudfunctions/schedule/index.js` | `loadWeekDuties` 改 `s.kind AS sessionKind`；`decorateDuty` 读 `d.sessionKind` |
| | `miniprogram/pages/mine/index.js` | `dutyMyList` 的 `catch` 补 `console.error`（保留真实错误，文案不变） |
| **同批（后端）** | `cloudfunctions/{duty,schedule,adjust,export,course}` | 状态机 `common/week.js` 的 `effectiveStatus` 落地（值日状态自动变更） |
| **同批（前端）** | `pages/duty/index.{js,wxml,wxss}` | 同课次合并一行 + 序号牌 72→56rpx + 去合并行 24rpx 左缩进 + 本人行竖条移位 + 移除导出入口 |
| | `pages/mine/index.{js,wxml}` / `pages/home/index.js` / `app.js` | 换班后置脏标记 → 下次 `onShow` 强刷；`sheetCapStyle` 胶囊安全上限 |
| | `components/bottom-sheet` | `capStyle` 串接（面板 `max-height` 动态收缩到胶囊下方） |
| | `utils/config.js` | `APP_VERSION` → `1.0.4.4` |
| **门禁/脚本** | `scripts/check-duty-columns.js` | **新增第 47 个门禁**（duty 表列名白名单） |
| | `scripts/check-clean-label.js` | kind 判据由「锁死字面量 `d.kind`」改为**锁意图**（从 `s.kind AS <别名>` 解析别名再数读取点） |
| | `scripts/deploy.md` | 登记第 47 个门禁；合计 46 → 47 |

### §1 myList 崩溃修复（主修 · 本轮追加）

- **问题**：真机「我的」页点「待值日 / 已结束」，弹出弹层显示「加载失败，请重试」，下方列表「暂无相关值日」。
- **根因**：`duty.myList` 的 SQL 写成 `SELECT ... d.kind ...`，但 **`duty` 表没有 `kind` 列**（只有 10 列：id/class_id/session_id/week/class_date/member_id/status/source/done_at/created_at；`kind` 属于 `session` 表）→ MySQL 抛 `1054 (42S22) Unknown column 'd.kind' in 'field list'`，整个明细查询失败。
- **隐蔽性（为什么长期没被发现）**：`today` / `detail` / `schedule.loadWeekDuties` 三处写的是 `s.kind`，SELECT 产出的**结果对象属性名恰好就是 `kind`**，代码读 `d.kind` **碰巧正确**；一旦给 `duty` 表加 `kind` 列，这三处会**静默取到错值**（而不是报错）。这类「d/s 列混读」是隐患根源。
- **改动**：`myList` 改 `s.kind AS sessionKind` + 代码读 `d.sessionKind`；其余三处一并 `s.kind AS sessionKind` 显式化（消除属性名歧义）；前端 `catch` 补 `console.error('[mine] dutyMyList 加载失败', err)`，便于日后排查（给用户的仍是可读文案，不暴露后端细节）。
- **影响面**：`duty.myList`（「我的」页待值日 / 已结束明细）、`duty.today`（首页今日值日）、`duty.detail`（值日详情）、`schedule.loadWeekDuties`。全部为**只读查询**，不涉及写库 / 游标 / 权限。
- **验证**：① 线上库实证 —— `SHOW COLUMNS FROM duty` 确认 10 列无 `kind`；`SELECT d.kind FROM duty d` 复现 `1054`；修复版 SQL 返回正常记录（`sessionKind=COURSE`）。② 新增门禁 `check-duty-columns`：扫描全仓云函数里 `FROM/JOIN duty <别名>` 的列引用必须 ∈ duty 真实列，剥注释 + 4 组双向自证（含内存变异 `s.kind AS sessionKind`→`d.kind AS sessionKind` 必抓）。③ `check-clean-label` 的 kind 判据改锁意图后，5 组变异自证 5/5（三种真回归全抓、换别名不误红）。
- **部署**：`duty` / `schedule` 两函数按 `scripts/deploy.md` §2.1b 三件套部署；**部署前**下载线上版与改动前基线 `20260928-232226` 逐文件 `diff` → 零差异（证明「仓库即真源」，无热修可回滚）；**部署后**下载回填 `diff` → 零差异。

### §2 同批其它内容（1.0.4.4 主体）

- **课次时间统一**：课表大节时间改为五个班统一配置，消除班级间时间不一致导致的课次错位。
- **明细排序修正**：`duty.myList` 由按日期排序改为按课次（星期 / 节次）排序，与值日页顺序一致。
- **值日状态自动变更**：`common/week.js` 新增 `effectiveStatus` 状态机 —— 普通课次下课后至下一节开课前进入打扫时段、到点翻转「已值日」；保洁课次 18:00 起显示「已值日」；过期日期显示「已结束」。纯派生、不回写库，不影响轮转游标与统计口径。
- **同课次合并一行**：同一节课两 / 三人合并为一行（双 / 多名牌 + 汇总状态），点整行弹成员列表可分别操作；按人视图不受影响。
- **换班后实时刷新**：「我的」页同意 / 拒绝 / 撤销换班后置脏标记，值日页 / 首页 / 我的下次 `onShow` 自动强刷。
- **弹层顶部被胶囊遮挡**：`bottom-sheet` 面板 `max-height = 100vh − 胶囊底沿 − 12px`，取不到胶囊信息时回退原档位。
- **序号牌缩小**：序号圆牌 72rpx（36px）→ 56rpx（28px），「按日合并行 / 按人视图行 / 合并行成员弹层行」三处统一（子明细行与选人列表保持 64rpx）。
- **合并行左侧空位收窄**：去掉名牌区多余 24rpx 缩进，序号牌左沿 56rpx → 32rpx，与按人视图 / 子明细行 / 成员弹层统一；本人行蓝竖条 `left` 32rpx → 14rpx 移入行左留白。
- **移除导出入口**：值日页导出选择弹层与长图 / CSV 能力移除（`export` 云函数保留）。

### §3 门禁

- **合计 47 个门禁全绿**（含 WXSS 真编译 28 个文件）。
- 新增第 47 个：`check-duty-columns.js`（duty 表列名白名单；守本次 `d.kind` 事故）。
- 随改动更新：`check-clean-label`（kind 判据锁意图）、`check-week-swipe`、`check-scroll-lock`、`check-wxml`、`check-count-align`、`check-notice`、`check-permission-delegate`。
- **门禁红 ≠ 漂移（本次实例）**：改动 `s.kind AS sessionKind` 后 `check-clean-label` 翻红 —— 三步定性：①「后端回传 kind」意图仍成立；②代码是有意重构、且是唯一正确写法（`d.kind` 现在会取到 undefined）；③故**改门禁**（判据从锁字面量改为锁意图）。同时用 5 组变异自证确认新判据仍能抓住真回归。

### §4 发版件状态

- **后端**：duty / schedule / adjust / export / course 五云函数已部署（本轮 myList 修复另单独重部署 duty / schedule），下载回填 diff 零差异。
- **前端**：待用户在微信开发者工具上传（`pages/duty` / `pages/mine` / `pages/home` / `app.js` / `components/bottom-sheet` / `utils/config.js`）。上传后「关于」页与公告版本号统一显示 1.0.4.4。
- **提审版 / 公告版**：各 10 条（见 `outputs/v1.0.4.4-更新说明.md`）。

### §5 真机复测待办

① 值日页合并行与课次分割、点整行弹成员、分别操作；② 状态自动变更随真实时间正确；③ 换班同意后三页实时刷新；④「我的」页待值日 / 已结束弹明细；⑤ 整页递进动画（封顶第 7 块）；⑥ 成员详情等高弹层顶沿低于胶囊、× 可点；⑦ 序号牌三处尺寸一致变小；⑧ 合并行左侧无多余空位、本人行竖条可见；⑨ 修复后点「待值日 / 已结束」不再报「加载失败」（**后端已修，可先单独复测**）。

---

## v0.7.28 · 2026-09-28 · 对外 1.0.4.3（补录）
**主题：Tab 页整页递进入场动画（封顶放宽至第 7 块）+ 「我的」页待值日 / 已结束可点开查看明细**

> 补录说明：本节在 v0.7.29 收尾时补写（原 v0.7.28 未及时登记 DETAIL）。

- **新增「我的」页统计可点开明细**：「待值日」「已结束」两项数字新增点击，弹出底部详情列表，逐条展示日期、时间段、课程、教室与状态标签（只读）；「本学期」保持纯展示。后端新增 `duty.myList`（按 `member_id` 查 duty 并 JOIN session / course，经临时调课解析真实节次，按 `effectiveStatus` 推导状态，`type=pending|past` 过滤）；`utils/api.js` 新增 `dutyMyList`。⚠️ **正是这个新增的 `duty.myList` 埋下了 v0.7.29 的 `d.kind` 1054 崩溃**（写 SQL 时误以为 `kind` 在 duty 表）。
- **Tab 页整页递进入场动画**：首页与「我的」页内容块由仅前几块上浮，扩展为全部内容块按文档顺序递进淡入上浮；封顶档位第 4 块 → 第 7 块，错峰保持 20ms / 14ms，总时长 240ms → 300ms（仍在 300ms 导航预算内）。`utils/page-anim.js` 的 `ST_CAP` 4 → 7（首次 300ms / 回访 224ms）；`app.wxss` 补 st-5 / st-6 / st-7 档位延迟与 reduced-motion 清零；`scripts/check-tab-enter.js` 同步放宽上限。
- **首页 / 我的 / 值日页档位重排**：按文档顺序重排 `.st-item` 档位号，保证连续且封顶 st-7（值日页含三个原 st-4 块，顺延为 st-4 / st-5 / st-6）。
- **门禁**：Tab 入场动画门禁（封顶 st-7，首页 8 块 / 我的 5 块 / 值日 6 块序列连续）、滚动穿透门禁（新增 `dutyListShow` 纳入 page-meta 锁）、WXSS 真编译（28 个 wxss）均通过。
- **部署**：已 bump `APP_VERSION` → 1.0.4.3 并部署 `duty` 云函数（下载回填 diff 零差异）；前端待上传。

---

## v0.7.25 · 2026-09-27
**主题：换班申请「提醒有、列表无」双根因根治 + 更新公告推送 + 成员备注独立滚动**

### §0 改动清单

| 文件 | 改动 |
|---|---|
| `cloudfunctions/duty/index.js` | today 的 pendingSwapCount：JOIN duty（过滤幽灵申请）+ 去掉按班过滤（与 pendingList 口径一致） |
| `cloudfunctions/adjust/index.js` | pendingList：超管默认跨班可见（JOIN class 取班名、按班加载 shifts）；confirm：按 duty_id 直取，去掉 class_id 匹配 |
| `cloudfunctions/media/index.js` | 新增 appNoticePublish / appNoticeLatest / appNoticeSeen |
| `miniprogram/utils/api.js` | 上述 3 个 action 的前端封装 |
| `miniprogram/pages/mine/index.{wxml,js,wxss}` | 「发送更新公告」入口 + 表单弹层（page-meta 表达式同步 anncShow） |
| `miniprogram/pages/home/index.{wxml,js,wxss}` | 公告弹层（未读才弹、关闭即标记已读；page-meta 同步 anncSheetShow） |
| `miniprogram/pages/roster/index.{wxml,wxss}` | 成员备注列表独立滚动（scroll-view + flex 链，表单固定底部） |
| 数据库 | 新表 `app_notice`；`member.app_notice_seen` 列；3 条幽灵申请置 CANCELLED |

### §1 换班「提醒有、列表无」——两个根因

- **现象**：主页提示「有 3 条换班申请待确认」、值日 tab 红点常亮；「我的 → 换班待确认」为空。
- **根因①幽灵申请**：`swap_request` 3 行（id 2/4/5）引用的 `duty` 933/934/936 **在库里不存在** ——
  排班生成是「删旧插新」式重建，duty_id 全部变化，重建前提交的申请引用悬空。
  `duty.today` 的计数 `COUNT(*) FROM swap_request WHERE status IN (...)` 不 JOIN duty → 幽灵也计数 → 红点永远不灭；
  `adjust.pendingList` JOIN duty → 幽灵被过滤 → 列表空。
- **根因②口径不一致**：计数不按班、列表按 `d.class_id = classIdOf(ctx)`（当前班）→ 跨班申请永远两边对不上；
  `adjust.confirm` 还要求「申请所在班 = 当前班」，跨班即使列表可见也无法拍板（41001 原值日不存在）。
- **修法**：计数 JOIN duty + 去班过滤；列表超管默认跨班（显式传 classId 仍可单班）+ 返回 className；
  confirm 按 duty_id 直取（超管已过 requireSuper，天然可跨班）；存量 3 条幽灵置 CANCELLED（只读核实影响面后执行，rowsAffected=3）。
- **验证**：订正后 rawPending=0 / validPending=0（红点熄灭）；新版 SQL 直查库验证 JOIN class 正常；
  三个函数部署后 `tcb fn code download` 下载线上包逐字节 diff 一致。

### §2 更新公告

- **产品口径**（用户确认 2026-09-27）：纯文字（版本号 + 标题可选 + 正文 ≤2000）；不做历史回看；
  超管在「我的」页发送；所有人**下次打开主页**时弹窗、每人仅一次（`member.app_notice_seen` 只增不减，GREATEST 写入）。
- 不走订阅消息（一次性订阅额度留给值日提醒）；拉取失败静默、不阻塞首屏（首屏渲染完再查）。
- 弹层正文用 scroll-view（max-height 560rpx）—— 与既有弹层滚动先例同款，`check-scroll-lock` /
  `check-count-align` 的 page-meta 表达式已同步（anncShow / anncSheetShow）。

### §3 验证与部署

- 42/42 门禁 exit 0（含官方 wcsc 真编译）；备份 `20260927-020618-v0.7.25-…`。
- 部署 `duty` / `adjust` / `media` 三个函数（`updateFunctionCode` 不动 env，TEMPLATE_NOTICE 待用户提供后仅补配置）。

### §4 续（02:4x）：订阅消息接通 + 备注按钮终版

**微信通知接通（用户提供模板 ID）**

- `TEMPLATE_NOTICE` = `TEMPLATE_REMIND` = 同一条「日程提醒」模板（用户重开模板后 env 两键同值）——
  **通知与值日提醒共用一条模板**，关键词 3 格：日程主题(thing1) / 备注(thing2) / 课程名称(thing3)。
- ⚠️ **微信要求 data 覆盖模板全部关键词，缺格 = 47003**。四处推送点核对：
  - `media.pushNoticeMsg`：原发 thing1/thing2 → **代码补 course 格**（`NOTICE_FIELDS.course` 默认 thing3，值落「班级通知」占位）；
  - `cron-weekly` 值日提醒 + `media.testRemind`：字段映射原为旧模板的 thing1/thing5/thing8 → **env 覆写** `TEMPLATE_REMIND_F_DIGEST=thing2`、`TEMPLATE_REMIND_F_COURSE=thing3`（两个函数都配）；
  - `schedule.publish`：用独立 `TEMPLATE_PUBLISH`（未配置 → 静默跳过），不动。
- 前端授权 `utils/config.js SUBSCRIBE_TEMPLATE_ID` 已是新 ID（此前已更新）✓。
- 部署：media 代码重发 + media/cron-weekly env 更新（`updateFunctionConfig` 合并式，其余变量原样核对）。

**「保存备注」按钮终版（用户复测反馈：能滑但按钮被裁）**

- **根因**：`sheet-body` 本身就是 `<scroll-view scroll-y>`（整弹层滚动容器）—— 在其内层再嵌 scroll-view +
  `height:100%`/`flex:1` 链，% 高度在内层不可靠 → 表现「列表能滑、按钮被裁」。
- **修法（结构级）**：bottom-sheet 组件扩展两个向后兼容能力 —— ① `tall`（max-height 92vh，成员详情启用）；
  ② `footer` 属性 + `footer` 具名插槽（panel 的第三个 flex 子项，`flex-shrink:0` 结构级固定）。
  roster：撤嵌套 scroll-view，「保存备注」按钮移入 footer 槽 → **任何列表长度下常驻可见可点**。
- ⚠️ 不用 `position:fixed` 做「固定底栏」：panel 带过渡 transform 会建包含块（MEMORY 铁律②），fixed 的基准会漂移。
- 42/42 门禁（组件路径 / wxss 真编译 / 弹层规则全过）。

---

## v0.7.24 · 2026-09-27
**主题：通知卡四角灰斑根治（裁切层圆角与卡片对齐 + 卡片外投影上提）+ 半透明卡片不再透出后方删除区粉底 + 回收站空态图标居中**

### §0 改动清单

| 层 | 文件 | 内容 |
|---|---|---|
| 前端 | `miniprogram/pages/notice/index.wxss` | `.nt-item` 补 `border-radius: var(--r-md)` + `box-shadow: var(--glass-shadow)`；`.nt-card` 只留 `var(--glass-highlight)`；`.nt-del-zone` 加 `opacity:0` / `.on{opacity:1}` / `.nt-del-zone.nt-del-hover{opacity:.65}`；`.rc-empty` 改 `display:flex;flex-direction:column;align-items:center` |
| 前端 | `miniprogram/pages/notice/index.wxml` | `.nt-del-zone` 的 class 加 `{{item.offset ? 'on' : ''}}` |
| 前端 | `miniprogram/pages/classes/index.wxss` | `.cl-swipe` 同上补圆角 + `box-shadow: var(--shadow-1)`；`.cl-card` 去掉 `box-shadow`；`.cl-del` 加 `opacity:0` / `.on` / `.cl-del.cl-del-hover` |
| 前端 | `miniprogram/pages/classes/index.wxml` | `.cl-del` 的 class 加 `{{item.offset ? 'on' : ''}}` |
| 门禁 | `scripts/check-corner-clip.js`（新增，第 42 个） | C1 裁切层↔卡片圆角一致 + 投影归属（含跨文件取有效圆角）；C2 删除区显隐驱动 + 静止透明；C3 块级图标居中（含前提复核）+ 5 条变异自证 |
| 云函数 | — | **无改动**（纯前端）→ 无需 `updateFunctionCode` |

### §1 问题与取证

用户报两个现象（附 3 张真机截图）：

| 用户原话 | 实测（像素级） |
|---|---|
| ①「收到的通知卡片**四个角有灰色**」 | 卡片 bbox `(48,41)-(415,174)`；逐行扫左边界得 `dx: 13→10→8→7→5→4→4→3→2→2→1→1→1→0`（收在 `dy=13`）= 16px 圆角。四角**圆角外侧**的缺口区比同 y 容器外背景低 **−3.5 L** → 一圈方形暗肩 |
| ②「通知回收站图标错位」 | 面板 `x 22..423`（中心 222.5）；图标 bbox `x 45..74`（中心 59.5）= **面板左起 3%** 处，而两行文字居中（中心 222.0）→ 图标与文字明显不对齐 |

另在实拍中发现第三个未报现象：**卡片右三分之一泛粉**。量化：卡内右侧 1/3 `R−B = +17.7`、左侧 `= −23.0`；
粉区 `x ≈ 343..415`（`.nt-del-zone` 的 `right:8px + width:72px` 投影位置），贯穿卡片全高。

### §2 根因

**① 裁切层与卡片的圆角边界不重合，把卡片的外投影关进了四个角。**

- `.nt-item { position:relative; overflow:hidden }` = **方形**裁切区，**无 `border-radius`**；
  内层 `.nt-card.card` 自带 `border-radius: var(--r-md)`（在 `app.wxss`）。
- 卡片外投影画在卡片**自身边界之外** → 落在方形裁切区内；被卡片本体盖住的部分看不见，
  唯独**四个圆角缺口**（那里没有卡片本体）把投影**留了下来** → 四块方形暗肩。
- 与 `app.wxss` 玻璃令牌处早已写下的铁律同族：「模糊与圆角必须由同一个元素承担，
  `overflow:hidden` 不会裁 `backdrop-filter`」。本条是它在**投影**上的对偶。

**② 半透明卡片透出后方删除区的粉底。** `.nt-del-zone`（`#FFECE8`）按设计永远在卡片后方
（`z-index:1` vs 卡片 `2`），卡片不透明白时静止态天然看不见；换成 `--glass-bg: rgba(255,255,255,.35)`
后粉底隔着玻璃渗上来。

**③ `text-align:center` 管不了块级子元素。** `<app-icon>` 渲染为
`<image class="app-icon" style="display:block">`（`components/app-icon/index.wxss: display:block`）
→ `.rc-empty` 只写 `text-align:center` 时，图标贴左、下面两行 `<text>` 居中。

### §3 修法与实证（无头 Chrome 真渲染，令牌逐字抄 `app.wxss`）

**关键方法**：把改前 / 改后做成**同一张图内的两个样本**（同 y、同宽、只差 x），**纯色底**消除渐变干扰
（渐变会让「同 y 不同 x」取到不同色，无法比较）。判据 = 「容器方形角内、卡片圆角外」的肩区亮度 − 容器外同 y 背景。

| 样本 | 左肩区 − 容器外背景 | 卡内右侧 R−B（右−左） |
|---|---|---|
| 用户实拍 | **−3.5 L** | **+15.8** |
| 改前（现状） | **−4.5 L** | **+27.8** |
| 只修四角（裁切补圆角 + 投影上提） | **−0.8 L** | +27.8 |
| 全修（含删除区静止透明） | **−0.8 L** | **−1.4** |

→ 「改前」与「用户实拍」同号同量级；两处修法各自把对应指标打到 ≈0。

**为什么不换别的修法**：
- 不给 `.nt-item` 去 `overflow:hidden` —— 左滑时卡片要能被容器边界切出干净的一条；
- 不把玻璃调实心 —— 会推翻 v0.7.17 的「冰态果冻」视觉语言并连带重做整套令牌；
- 不动 `--glass-shadow` 数值 —— 投影本身没问题，是**归属**错了。

### §4 影响面

- `.nt-item` / `.nt-card`：通知页全部通知卡（含左滑删除、飞行入回收站动画）—— 圆角与投影的观感对齐，
  几何尺寸一字未动（`margin`/`padding`/`border-radius` 值不变），故飞行轨迹与动画时序不受影响。
- `.cl-swipe` / `.cl-card` / `.cl-del`：班级管理页左滑删除 —— 同族问题一并修（该页卡片是不透明的
  `rgba(255,255,255,.55)`，粉底渗出比通知页弱，但四角灰肩同样存在）。
- `.rc-empty`：回收站空态图标居中。**只影响空态**，有数据时仍是 `.rc-clear` + `.rc-item` 列表。
- **无外溢**：未改任何共用组件（`bottom-sheet` / `app-icon` / `empty-state` 原样），
  通知页与班级页的 wxss 不跨页共享（页面样式不共享是既有约定）。

### §5 验证

- 新增门禁 `node scripts/check-corner-clip.js`：C1/C2/C3 全 PASS + 5 条变异自证全 PASS。
- `node scripts/check-wxss-compile.js`：28 个 wxss 全部通过**微信官方 `wcsc.exe`** 真编译。
- **全量 42 个门禁**批跑：**42 通过 / 0 失败**。
- `node scripts/backup.js --diff <备份ID>`：改动 **4 个前端文件 + 1 个新增门禁**，无云函数改动。
- 无头 Chrome 三维对照（用户实拍 / 改前 / 只修四角 / 全修）指标见 §3 表。

---

## v0.7.23 · 2026-09-27
**主题：轮转「满一轮」判据被跨轮态误判 → 第 5 周从 1 号重排（代码 + 数据双修）**

### §0 改动清单

| 层 | 文件 | 内容 |
|---|---|---|
| 云函数·schedule | `cloudfunctions/schedule/index.js` | **删除** `generate` 里「`roster.every(r => r.mark > 0)` → 全班 `mark = 0`（`roundReset = true`）」清零块，改为解释性注释；保留 `roundFix = repairRoundMarks(roster)` |
| 部署 | `schedule` 单函数 `updateFunctionCode` | 部署后下载线上包逐文件 diff **一致** |
| 门禁 | `scripts/check-round-robin.js` | 新增「第 6 部分：跨轮态必须从 09 号接续」+ 变异自证 + 剥注释文本判据 + **线上真实第 5 周 23 节课次形状复刻** |
| 脚本 | `scripts/gen-week5-fix.js`（新增，一次性） | 用生产 `rotationPick` 在修复态名册上复跑第 5 周 → 生成订正 `INSERT` SQL |
| 数据 | `duty`（week=5）/ `member.duty_count` / `member.last_duty_at` | 删旧 46 行 → 重插正确 46 行 → 进度标记同步 |

### §1 问题与取证

用户反馈：10/9（第 5 周）那批已排 **1、3、5、7 号**，而 10/12 一键生成「按序号轮转」**又从 1 号开始排**（截图①②）。

查库取证（只读）：

| 项 | 事实 |
|---|---|
| `duty` week=3 | 24 行 / 24 人 / member_id 37–60（序号 25–48） |
| `duty` week=4 | 16 行 / 16 人 / member_id 13–68（序号 **49–56 + 01–08**） |
| `duty` week=5 | **46 行（错误）**，序号 01–46 —— 其中 01–08 与第 4 周重复 |
| `member.duty_count`（修复前） | 序号 **01–08 = 2 次**，**09–56 = 1 次** → **全员 > 0** |
| 课次 | 第 5 周恰 **23 节**（含 4 节保洁）= 46 行 ÷ 2 ✓ |

关键：**第 4 周那批「49–56 接着 01–08」正是上一轮修复后的正确结果** —— 它把班级带进了一个「一轮已排满、
又开始排新一轮开头」的状态，也就是**跨轮态**。

### §2 根因：`every(mark > 0)` 被当成了「一轮刚排满」

`schedule/index.js` 的 `generate` 里原有一段：

```js
roundFix = repairRoundMarks(roster);
// 全员本轮已排完 → 开启新一轮：标记清零，重新从 1 号开始轮转
if (roster.length && roster.every(r => r.mark > 0)) {
  roster.forEach(r => { r.mark = 0; });
  roundReset = true;
}
```

`repairRoundMarks` 把 `duty_count` 折算成 `mark`（本轮已排次数，`mark = max(0, duty_count - 本周 AUTO 数)`）。
第 4 周结束时 `duty_count` = 「01–08 → 2、09–56 → 1」→ 折算后 **全员 `mark > 0`** →
被判成「一轮刚排满」→ 全班清零 → 第 5 周从 01 重排。

**`every(mark > 0)` 不等价于「一轮刚排满」**：它还覆盖「一轮排满后又多排了新一轮开头几个人」的跨轮态。
这个跨轮态是**上一轮修复自己制造**的（`scripts/fix_round4_rotation.sql` 可证）—— 也就是说，这段清零块
在「单轮没排满」时不会触发、触发时恰好都是跨轮态，属于**必然误判**。

### §3 修法：删掉清零块（分级取人天然完成新一轮）

`rotationPick` 的取人规则是「**标记最小档优先 + 序号升序**」。当一轮排满时，所有人的标记同时 +1 →
下一轮取到的**正是序号最小的那批**。即：**「分级取人」在数学上已经等价于「满一轮后从 1 号重开」**，
不需要真的把标记清零。清零不仅多余，还会**抹掉「谁排到了哪」的位置信息** → 下周从 1 号重排。

- **删块**，保留 `roundFix = repairRoundMarks(roster)`。
- `cron-weekly`（周日 20:00 自动生成）**从建立起就没有这块** → 顺带消除了「手动 / 自动两条链路口径不一致」。
- 铁律固化：**轮转位置的唯一来源是 `member.duty_count` 的相对大小，任何路径都不得整体归零**
  （与 `clear` 那条同源：清空值日表只按周回滚 `GREATEST(duty_count-n, 0)`）。

### §4 门禁：`check-round-robin.js` 第 6 部分（跨轮态）

- **行为级断言**：构造跨轮态名册（`01–08 → mark 2`、`09–56 → mark 1`），跑第 5 周首节 → 必须 = **09/10**；
  整周 = 09~48 起继续；`01–08` 一个都不能再出现；且无重复。
- **变异自证**：把旧清零块原样搬回（`legacyClearAll`）→ 必被打回 01 号（证明该段测试真的在测清零行为）。
- **文本级判据（先剥注释）**：`/roster\.every\([^)]*mark\s*>\s*0/` 不得命中 `schedule` / `cron-weekly` 源码。
  ⚠️ **必须剥注释**：本次的修复说明注释里就写着「全员 mark > 0」这串字（第 6 次踩，定式见 §68-C）。
- **线上真实形状复刻（校准）**：把线上第 5 周那 23 节课次（含 4 节保洁）与「谁配哪节课」的 46 行**逐行复刻**，
  分两个断言：① **清零态**逐节课复现线上那 46 行（证明复刻没走样）；② **修复态** = 清零态 **+8**（整体后移 8 个序号）。
  ⚠️ 复刻时 `week5Sessions()` 易漏 `dutyCount` 字段 → `rotationPick` 拿到 `undefined` 时一节都不选，
  表现为「复刻 =（空）」而不是报错 —— 门禁自身的假阴性，已修（`.map(s => Object.assign({ dutyCount: 2 }, s))`）。

### §5 数据订正（生产库，一次性）

生产环境无法远程调 `generate`（MCP `invokeFunction` 无 WX 上下文 → 业务 action 一律 40001），
故用**生产内核离线复跑**生成 SQL（`scripts/gen-week5-fix.js` → `.workbuddy/week5-fix.sql`，46 行，序号 09–54）：

1. `DELETE FROM duty_log WHERE duty_id IN (SELECT id FROM duty WHERE class_id=1 AND week=5)`（46 行，先子表）
2. `UPDATE member SET duty_count = CASE WHEN RIGHT(student_no,2) >= 55 THEN 1 ELSE 2 END ...`（56 行）
3. `DELETE FROM duty WHERE class_id=1 AND week=5`（46 行）
4. 重插 46 行（09–54，member_id 21–66）
5. `UPDATE member m JOIN (SELECT member_id, MAX(class_date) md FROM duty GROUP BY member_id) t ...`（37 行）

**验证（只读复查）**：`duty` week=5 = **46 行 / 46 人 / member_id 21–66**；
`member.duty_count` = 「**01–54 → 2 次（54 人）**、**55–56 → 1 次（2 人）**」——
与门禁「修复态 = 清零态 + 8」的预期**完全一致**；另有 3 行 `duty_count = 0` 是测试账号
（学号 `…749991/92/93`，角色 测试超管/测试管理员/测试成员），按设计不参与轮转。

### §6 影响面 / 未决

- **影响面**：仅 `schedule` 手动生成路径；`cron-weekly` 行为不变（原本就正确）；前端与文案零改动。
- ⚠️ 第 6 周及以后尚未生成，本次订正后从 **55 号**接续，届时可在真机验一次「接着序号往下排」。
- ⚠️ 第 3、4 周的既有安排**未动**（历史数据保持原样，只订正本轮报告的第 5 周）。

---

## v0.7.22 · 2026-09-26
**主题：一键生成 50000 根治 + 教职工跨班口径澄清 + 日期卡 UI + 「我的」页通知入口下线**

### §0 改动清单

| 层 | 文件 | 内容 |
|---|---|---|
| 云函数·公共 | `cloudfunctions/common/db.js`（+12 份副本） | 连接池三层防御：`enableKeepAlive` / `pool.query` 瞬时连接错误重试一次 / `getConnection` 借出前 `ping()` 验活 |
| 云函数·schedule | `cloudfunctions/schedule/index.js` | 外层 catch 对**超管**透出真实错误码 / 消息片段（排障不再只看到「服务器开小差了」） |
| 部署 | 12 个云函数 `updateFunctionCode` | adjust / audit-receiver / auth / class / course / cron-weekly / duty / export / media / member / poster / schedule；部署后已下载线上包逐文件 diff **12/12 一致** |
| 组件 | `components/week-switcher/index.wxss` | 日期卡圆角 28 → 40rpx；`.ws` 底部留白 2 → 16rpx（三页共用） |
| 页面 | `pages/mine/index.{wxml,js}` | 通知入口整块下线（跳转 / 角标 / 缓存拉取一并删除） |
| 工具 | `utils/notice.js` | 注释同步：缓存写入方收口为「仅首页」 |
| 门禁 | `scripts/check-db-resilience.js`（新增）、`check-notice.js`、`check-notice-v2.js` | 新增 db 韧性门禁；两个通知门禁判据按新意图改写 |
| 预览 | `preview/v0.7.21-segmented-week-header.html` | 重新生成（含 40rpx 圆角与新间距） |

### §1 需求① 一键生成报 `[50000] 服务器开小差了`（两个根因，先后落网）

**根因 A（确定性，主凶）—— `roundFix` 作用域错误**：第二轮用户反馈「依旧无法使用」，但超管 toast
这次带上了诊断透出的真实错误开头「（roundFi…」→ `ReferenceError: roundFix is not defined`。
`schedule.generate` 里 `const roundFix = repairRoundMarks(roster)` 声明在 **try 块内**（块级作用域），
而 try/finally **之后**的 `console.log` 与 `return` 都引用它 → 每次生成都是
「事务成功 commit（`duty` 落 16 行）→ 下一行抛 ReferenceError → 外层 catch 兜成 50000」。
**为什么此前没发现**：算法探针只抽了 `rotationPick`/`repairRoundMarks` 纯函数，没跑完整 handler；
文本正则门禁查不出「声明在 try 内、引用在 try 外」的作用域边界。
**修法**：声明提到 try 外（与其它计数器同层 `let roundFix = {cursor:0, filled:[]}`），try 内纯赋值。
**验证**：新增 `scripts/check-schedule-generate-runtime.js` —— 生产源码 eval + 桩
（wx-server-sdk / db / guard）+ 假连接池（全空快照）**真跑 generate**：修后 resolve 返回
`{created:0, roundFixed:0,…}`；变异（声明搬回 try 内）必须 reproduce
`errCode 50000 + errMsg 带 roundFix`；并锁 cron-weekly 的同名声明在其 try 之前。

**根因 B（偶发，次凶）—— 冻结容器死连接**（第一轮已修）：23:42 失败 / 23:46:18 重试成功的时间线 +
线上包 diff 一致 + 表列无缺列 → `common/db.js` 三层防御（`enableKeepAlive` / 连接类错误重试一次 /
`getConnection` 借出前 `ping()` 验活），由 `check-db-resilience.js` 守着。

**诊断透出立功**：第一轮加的「超管 toast 附真实错误码」是本轮 5 分钟定位根因 A 的关键 ——
修复可见性 → 拿到真实错误 → 直查根因，闭环成立。

**部署**：`schedule` 单函数重部署 → 下载线上包 diff 一致。（其余 11 个函数在第一轮已带新 db.js 部署。）

### §2 需求② 教职工跨 5 班（澄清为主，数据已就位）

- **数据已就位**：`staff_class` 已有 staff_id=72（示例成员57）× 全部 5 个班（id 1/2/3/9/10）共 5 行（2026-09-26 16:29 建立）。
- **代码路径已支持**：`guard.staffClassIds()` 读 `staff_class` 映射；`resolveClassId` 放行教职工到绑定集合内；「班级管理」页辅导员可见全部班级 → 「查看人员」带 `classId` 进 roster；各班名册口径**一贯排除** `group_tag='X'`（member.list / 统计均为 `group_tag <> 'X'`）—— 教职工从不占用任何班的名册。
- **本版改的是文档口径**：此前交接件把教职工写成 示例班级A名册的「+1 教职工」，让人误读为她属于 示例班级A —— 已改为「跨班账号，绑定关系看 `staff_class`」。
- 备注：该账号 `status='LEAVE'`（成员状态合法值之一）；鉴权链（`guard.getContext`）不检查 status，教职工管理列表也只排除 `DISABLED` —— 此状态不影响其任何功能，保持原样未动。

### §3 需求③ 日期卡 UI（两轮反馈）

- 第一轮：圆角 28 → 40rpx、底部留白 2 → 16rpx —— 用户回「再圆一点」；
- 第二轮：圆角直接拉满 **999rpx（胶囊形，随高度自适应）**，不再手工估档位；间距 16rpx 维持。
- 组件三页共用（课程表 / 值日 / 手动排班）一起受益；观感预览已重生成
  （预览里是换算后的 px：999rpx → 499.5px —— **grep 预览件要用换算后单位**）。

### §4 需求④ 「我的」页通知入口下线

- `pages/mine/index.wxml`：删除整块「任务」卡（唯一内容就是通知行）；`index.js`：删除 `goNotice` / `_loadNoticeBadge` / `noticeUnacked` 数据字段与 `utils/notice` 依赖。
- **缓存职责收口**：`utils/notice` 的列表缓存（通知页 onLoad 同步渲染依赖它）改由**首页独力写入**（首页本就 `notice.write(list)`），通知页后台刷新仍写 —— 已核对首页调用在位。
- 门禁同步：`check-notice.js` 的 mine 断言按**新意图**点名改写（mine 无通知入口 / 首页必须拉 `msgList`）；⚠️ 期间第 5 次踩「判据命中注释」——mine 的说明注释里提到 `_loadNoticeBadge` 函数名，判据已改为**先剥注释再断言**（`check-notice.js` 内联了剥注释定式）。

### §5 门禁与部署状态

- 全量门禁 **40/40 exit 0**（新增 `check-db-resilience.js`，总数 39 → 40）。
- 12 个云函数已全部重新部署并经线上包 diff 验证一致；**前端改动需开发者工具重新编译生效**。

---

## v0.7.21 · 2026-09-26

主题：切周骨架同构 + 一键生成「点了没反应」的静默守卫 + 课表入口合并成一个按钮 + 成员详情调亮 + 列表过渡统一。

> 需求原文（用户同一批给了五条）：
> ① 「值日页切换下一页时会有三个很明显的框，很难看」
> ② 「一键生成值日无法使用」+「点『按序号轮转』后没有任何反应」
>   +「目前已经通过 ai 生成第三周的值日表，a 组安排到了 47 号，b 组安排到了 48 号，第四周一键生成中的
>     按序号轮转是接着上一周继续生成。而不是从 1 号重新生成。」
> ③ 「课程表页 a 组 b 组切换按钮和左下角临时调课放在一起，在现在临时调课的位置改成按钮，点击展开，
>     里面是选 a 组、b 组和调课。」
> ④ 「普通管理员，『成员与分组』中成员详情界面比较暗，调亮一点」（不需调整 A/B 组按钮）
> ⑤ 「『成员与分组』页上方标签从『全班』切换为『仅班委』时，里面的成员不要直接加载出来，而是从原来
>     全班列表将筛选的人员保留，从下方飞上来。」+ 大任务：所有「同一数据源、切换视图或筛选」的页面统一加列表过渡。
>
> **本版纯前端**（组件 / 页面 / 样式 / 工具 + 门禁与文档），**不涉及云函数 → 无需部署**，数据库无变更。
> 生效方式：开发者工具重新编译。
> 备份：`20260926-225929-v0.7.21`（开工基线，417 文件 / 3.31M）。

### 0. 改动清单

`node scripts/backup.js --diff 20260926-225929-v0.7.21` → **修改 20 / 新增 1 / 删除 1**：

| 类别 | 文件 |
|---|---|
| 新增 | `miniprogram/utils/list-transition.js`（需求⑤公共模块） |
| 组件 | `components/skeleton/index.{wxml,wxss}`、`components/bottom-sheet/index.wxss`、`components/segmented/index.{js,wxml,wxss}` |
| 页面 | `pages/duty/index.{js,wxml}`、`pages/roster/index.{js,wxml,wxss}`、`pages/timetable/index.{js,wxml,wxss}` |
| 其它 | `utils/util.js`（新增 `confirmStrict`）、`custom-tab-bar/index.wxss`（让位值注释同步） |
| 脚本 | `scripts/check-duty-rotation.js`、`scripts/check-tabbar-liquid.js`、`scripts/check-timetable-local.js`、`scripts/gen-anim-preview.js` |
| 删除 | `scripts/_probe_generate.js`（上一版遗留的一次性探针） |

---

### 1. 需求① —— 骨架屏必须与真实版式**同构**

**问题**：值日页切到下一周时，先闪出**三个高度不一的大空白块**。

**根因**：值日页用的 `<skeleton type="list" rows="{{6}}">` 是「6 行小单元」的通用列表骨架，
而值日「按日」的真实版式是**日期卡**（标题条 + 2 行「头像 + 两行文字」，整卡 32rpx 外边距 / 24rpx 间距）。
两者**不同构** → 骨架总高度、块数与真内容都对不上，切周时先给用户看了一屏**不存在的内容**，
数据回来时再整块跳变。

**改动**：
- `components/skeleton/index.wxml` 新增 `type="day"`：`.sk-day`（一张卡）+ `.sk-dayhead`（标题条，46% 宽 × 28rpx）
  + 两行 `.sk-dayrow`（`.sk-avatar` + `.sk-line-1` / `.sk-line-2`，复用既有类）。
- `components/skeleton/index.wxss`：`.sk-day` 卡片间距沿用 24rpx、圆角 24rpx，与真实版式对齐；
  `.sk-dayhead` 并入共用 shimmer 动画的 `background-image` 组（否则标题条不会闪）。
- `pages/duty/index.wxml`：`<skeleton wx:if="{{loading}}" type="list" rows="{{6}}" />` → `type="day" rows="{{2}}"`。

**影响面**：仅值日页切周等待态。其它页的 `type="list"` / `type="card"` / 默认态未动。

**验证**：`check-wxss-compile`（微信官方 `wcsc`）真编译通过。

---

### 2. 需求② —— 一键生成「点了没反应」

用户给了**两条症状**：「一键生成值日无法使用」+「点『按序号轮转』后没有任何反应」，
并附带一条**期望**：「第 4 周按序号轮转是接着上一周继续生成，而不是从 1 号重新生成」。

#### 2.1 先证明「算法本身是对的」（否则会误改核心逻辑）

用**线上只读快照 + 生产函数探针**两条独立证据锁死（2026-09-26）：

| 证据 | 内容 |
|---|---|
| 线上 `duty` 表 | week=3 共 **24 行**（distinct member 24）；week=4 共 **0 行**；第 3 周序号严格 **25–48**，**A 组最后 47 / B 组最后 48**（与用户描述逐字吻合） |
| 线上 `member` 表 | `duty_count=1` 的 **48 人**（序号 01~48）、`=0` 的 **8 人**（**49~56**） |
| 生产函数探针 | 把 `rotationPick` / `repairRoundMarks` **从生产源码抽出**（`new Function`）+ 上述真实快照跑第 4 周选人循环 |

探针输出：`cursor=48`、`filled=[]`（01~48 本身连续已排，无需补）、**首节取到 49 号**、
共 **16 条**（第 4 周 10/5~10/7 国庆 OFF，`holidaySkipped=13`，只剩周四 10/8 + 周五 10/9 = 8 节次 × 2 人）、
A 组课只排 A 组 / B 组课只排 B 组、一周内无人重复 —— **全部 PASS**。

**结论**：用户要的「接着上一周继续生成」**在算法上本来就是对的**。
第 4 周正确结果就是 `49~56` 排完后 `wrapped=true`，**接着序号**进入下一轮（01~08 每人本周第二次）。
所谓「无法使用」的可证成因只落在**静默**这一层。

#### 2.2 两个真实的静默点（都是「不报错、只是没动静」）

| # | 静默点 | 表现 |
|---|---|---|
| A | `utils/util.js` 的 `confirm()` 把「用户点了取消」与「弹窗**根本没弹出来**」压成同一个 `false`，调用方一律 `if (!ok) return;` | 弹窗失败（有别的弹层占着 / 页面正在转场 / 系统弹窗配额用满）时，界面上与「点了没反应」**完全无法区分**，既不报错也无提示 |
| B | `busy` 守卫：生成进行中 `busy=true`，入口点击被**静默忽略** | 第一次点击的请求若卡住（云函数 60s 上限），后续点击全部无声无息；卡住期间用户只会觉得「按钮坏了」 |

#### 2.3 改动

- `utils/util.js` 新增 **`confirmStrict(content, title)` → `Promise<'confirm'|'cancel'|'fail'>`**：
  把「没弹出来」单独回传，调用方**必须**给用户一句话。原 `confirm()` 保留不动（其余调用点不受影响）。
- `pages/duty/index.js`：
  - `onGenerate` 改用 `confirmStrict`，`fail` 分支明确提示；
  - `onGenerate` / `onPublish` / `onUnpublish` / `onClear` 统一走 `_busyGate` / `_busyStart` / `_busyEnd`；
  - 新增 **`BUSY_TIMEOUT_MS = 15000` 看门狗**：超时自动复位 `busy`，不会永久卡死；
  - 全部改为 `.catch((e) => { this._busyEnd(); util.toast(this._errText(e)); })` —— **不吞错误**。

**影响面**：仅值日页 4 个超管入口 + `util` 新增一个导出（纯增量，不破坏既有调用点）。

---

### 3. 需求③ —— 课表页两个入口合并成一个按钮

**改动**：
- **移除顶部 A/B 分段**（用户选择「全部收进新按钮」），左下角 `.fab-shift`（临时调课）改名 **`.fab-menu`**：
  按钮上显示**当前正在看的组**，点开向上展开「A 组 / B 组 / 临时调课」。
- `.fab-menu` 展开/收起**只用 `opacity` + `transform` 过渡，不写 `animation`** —— 随时能反着播，
  不会出现「展开到一半再点一下卡住/点了没反应」。
- ⚠️ **`.fab-menu` 是 `fixed` 元素，必须留在 `.wk-swipe` 动画容器之外**（`transform` 会给子元素建**包含块**，
  fixed 会失效）—— 由 `check-tab-enter.js` 守着。这是本项目第四次踩「动画容器里的 fixed」。

**同步改动（改名引发的连带）**：
- `custom-tab-bar/index.wxss`：让位值注释里 `.fab-shift` → `.fab-menu`（底栏占位 98rpx 的让位清单是**双向绑定**的，改名必须同步）。
- `scripts/check-tabbar-liquid.js`：`RPX_SPOTS` 里 `\.fab-shift` → `\.fab-menu`（不改选择器门禁就找不到这个点）。
- `scripts/check-timetable-local.js`：原判据「`!isCounselor` 出现 ≥4 次」在顶部 A/B 分段并入 `.fab-menu` 后
  **合法地**降为 3 次 → 换成**逐入口点名**（切周条 / `.fab-menu` / `.fab` 三个开标签**各须**带 `!isCounselor`，
  即辅导员看不到任何切换/调课/编辑入口）+ **双向自证**（原样必过 / 摘任一守卫必被抓）。

---

### 4. 需求④ —— 成员详情面板调亮

**根因（算出来的，不是感觉）**：遮罩是 `rgba(0,0,0,.45)`，把背后的极光压到 ≈`#85858A`；
`bottom-sheet` 面板白度只有 52% → 合成 ≈ **`#C4C4C6`**，一块**灰板**。
内容越少的弹层越明显 —— 普通管理员的成员详情只有「头像 + 三行字 + 一两个按钮」，整屏就一块灰。

**改动**：
- `components/bottom-sheet/index.wxss`：面板 `rgba(255,255,255,.52)` → **`.72`**（合成 ≈`#DCDCDE`，
  干净的近白，同时仍留 28% 底色透上来保住玻璃感）。原注释里写的 0.66 一直没落到代码，一并改成真实值。
- `pages/roster/index.wxss`：详情三行主信息 `color: #4E5969` → **`#1D2129`**（一级文字色）。
- ⚠️ **只动底色与文字，`.mb-abtn`（「调至 A / B 组」）保持原样** —— 用户明确要求（已 diff 核对：该规则零改动）。

**影响面（必须说清的外溢）**：`bottom-sheet` 是**共用组件** —— 值日「加值日生 / 选课次 / 选人」、课表「调课」、
成员详情等多处弹层都走它。**所有弹层一起提亮了**，不只是成员详情。方向与需求一致，但属于共用组件改动的必然外溢。

---

### 5. 需求⑤ —— 列表过渡统一（新增公共模块）

**新文件 `miniprogram/utils/list-transition.js`**，三条页面共用一份。两种机制：

| 机制 | 适用 | 做法 |
|---|---|---|
| `flip()` | 布局**整体换掉**（值日按日 ⇄ 按人、课表 A 组 ⇄ B 组） | 量旧位置 → 换数据 →（同帧）量新位置 → 反向位移把元素「按」回原位 → 下一帧放开过渡飞回新位置 |
| `filterSwap()` | 布局**只增只减**（成员全班 ⇄ 仅班委） | 三阶段 setData：A 钉起点（**不带 transition**，这一拍不会动）→ B 挂过渡 + 目标值 → C 动画播完才真删 / 松钳 |

> 为什么两种都留、不一律 FLIP：增删场景里**塌缩本身就在连续改布局**，此时再给保留行叠一层反向位移
> = 同一段位移算两遍，行会「先被按住再动」，反而顿一下。**选对机制比统一机制重要。**

**规格 → 实现对照（逐条）**：

| 用户规格 | 实现 |
|---|---|
| ① 保留项 FLIP 飞到新位置（≈260ms ease-out、收尾轻微过冲） | `MS.FLIP=220ms` `cubic-bezier(.22,.61,.36,1)`（纯减速，**不含过冲**）+ 尾段 `MS.SETTLE=70ms` 越过目标 `SETTLE_Y=4px` 再落回 → 合计 **290ms**；行程 < `SETTLE_MIN=24px` 不补沉降（补了像抖一下） |
| ② 移除项渐隐 + 行高塌缩**同步** | 阶段 B 把 `max-height:0` / `opacity:0` / `padding 0` / `margin 0` 写在**同一条** style 里一起过渡（`MS.OUT=240ms`），不留白再跳位 |
| ③ 新增项从下方 16px 淡入上移 ≈200ms | `IN_Y=16`、`MS.IN=200`，从 `max-height:0` 展开 |
| ④ 分段滑块绝对定位 + `transform: translateX()` | `components/segmented`：`.seg-ind { left: 0 }`（恒定），位移由内联 `transform:translateX(Nrpx)` 下发；`stretch` / `settle` 两拍的过渡属性从 `left` 改为 `transform`（走合成器，不触发重排）；`scripts/gen-anim-preview.js` 同步 |
| ⑤ 列表项用稳定 `wx:key` | roster `wx:key="id"`、duty `wx:key="id"`、timetable `wx:key="sessionId"`（均为既有，已核对） |
| ⑥ 可打断 | `flip` / `filterSwap` 都新增 `guard`：页面每轮**自增令牌**（`_flipToken` / `_ltToken` / `_ttFlipToken`），模块内 4~5 处 `setTimeout` 链点醒来先问 `guard()`，令牌变了就**丢掉整条后续链**；三页 `onUnload` 也自增令牌 → 不会对已销毁实例 `setData` |

**禁止项自查（逐条）**：
- ✅ 未做「整列表 opacity 0→1」；
- ✅ 离场**真的塌缩高度**（同时收掉 padding / margin），不留白再跳位；
- ✅ **无 stagger**，全部同时开始；
- ✅ **切换期间不锁点击**（纯 `setData` + CSS transition，随时能再点一次）；
- ✅ 过冲用**两段真实位移**实现，**没有**用 `cubic-bezier` 伪造弹性曲线。

**⚠️ 已知边界（写下来免得下次当 Bug）**：`filterSwap` 只对「只减不增 / 只增不减」是最优；
**既增又减**走兜底（以当前列表为骨架、新增项插在第一个离场项之前），不追求最优位置，只保证不崩不跳。
本项目三处用法（①全班→仅班委、②仅班委→全班、③单独重排）都落在前两种。

---

### 6. 门禁

- **全量 39 个 `scripts/check-*.js` exit 0**（含 `check-wxss-compile.js` —— 微信官方编译器真编译，本版改了 4 个 wxss）。
- **`check-duty-rotation.js` 新增文本级断言 + 双向自证**：
  - ⚠️ 判据**必须先剥注释**（块注释 + 行注释）—— `duty/index.js` 的注释里**正是为了说明这件事而引用了旧措辞**，
    不剥注释就会「自己把自己抓了」（**「判据命中注释」本项目已栽过三次**，见 §65 与门禁规则）。
  - 断言：剥注释后**不得**出现 `/从\s*1\s*号重新开始/`，且 `roundReset` 那句**必须**含「接着序号」。
  - 自证：注入旧措辞**必被抓**、原样**必过**。
- **`check-timetable-local.js`**：判据换成逐入口点名 + 双向自证（见 §3）。
- **`check-tabbar-liquid.js`**：选择器随 `.fab-menu` 改名同步（见 §3）。

---

### 7. `roundReset` 文案陷阱（本版发现）

后端 `cloudfunctions/schedule/index.js` 与 `cron-weekly/index.js` 用**一个标志** `roundReset`
表示**两种情形**：

1. 生成开始时全班 56 人本轮**都已排满** → 服务端清零标记，**本轮从头开**；
2. 本周名额**多于**「本轮还没排的人」（第 4 周：只剩 49~56 八人，却要排 16 个名额）
   → 排完 49~56 后 **`wrapped=true`，接着序号**进入下一轮（01~08）。

旧前端文案「本轮已排满，**已从 1 号重新开始**」**正好把情形②说反了** ——
在用户恰好最关心的第 4 周场景下，这句提示会让人以为 Bug 复现。

**改动**：`pages/duty/index.js` 的 `roundReset` 分支文案改为
「**本轮 56 人已轮完，接着序号继续往下排**」，并附整段注释说明「一个标志两种含义」。
两种情形的**共同事实**只有一条：*本轮 56 人已经走完一遍，之后是顺着序号继续，不是重头来* —— 新文案对两者都成立。

**无需改云函数 / 重新部署**（纯前端文案）。

---

### 8. 部署

**无云函数与数据库改动 → 不需要部署。** 生效方式：开发者工具重新编译。

⚠️ **待真机验证**：① 切周骨架与真内容高度是否齐（`type="day" rows="2"`）；
② 「按序号轮转」在弹窗被占用时是否给出明确提示、生成中再点是否有反馈；
③ 课表 `.fab-menu` 展开/收起**连点**是否跟手；④ 成员详情面板亮度够不够（0.72）；
⑤ 三处列表过渡的**打断手感**（连点两次筛选 / 分段）。

---

## v0.7.20 · 2026-09-26

主题：分段切换改为与底栏一致的液态指示器 + 日期头改气泡箭头 + 课表左右切换有动画。

> 需求原文（用户同一批给了三条，① 在上一版处理）：
> ② 「课程表页上面的 ab 组 … 切换太僵硬，动画改为和底部导航栏一样。选到的选择稍微变大。
> 例如现在是 A 组，A 组二字稍微大一点，切换到 B 组，B 组变大、A 组变回原始大小。
> 值日页上面的按日和按人也是一样修改。」
> ③ 「课程表和值日页上面的日期 … 修改样式，目前的太丑了，左右箭头改为单独的气泡箭头。
> 课程表左右切换添加动画。」
>
> **本版纯前端**（组件 / 页面 / 样式 / 文档 + 一个预览生成脚本），**不涉及云函数 → 无需部署**，数据库无变更。
> 生效方式：开发者工具重新编译。

### 1. 需求② —— 把「和底栏一样」落成具体数值

用户只说「和底部导航栏一样」，没有给参数。**底栏的液态指示器是本项目已经迭代 6 轮的既有实现**
（`custom-tab-bar`，见 §60），所以本版不是另创一套曲线，而是**逐条对齐它的几何与节奏**，
把底栏那套「先冲过去、再弹回来」的语言搬到分段控件上。

| 项 | 底栏（`custom-tab-bar`） | 分段控件（`components/segmented`） |
|---|---|---|
| 指示器载体 | 独立胶囊 `.tab-ind` | 独立胶囊 `.seg-ind` |
| 定位方式 | `position:absolute` + JS 下发 `left/width` | 同 |
| 拍 1 `stretch` | `140ms`，前缘预冲 `OVER_RPX=14` | `140ms`（`IND_MS`），前缘预冲 `OVER_RPX=8` |
| 拍 2 `settle` | `220ms` `cubic-bezier(.32,1.5,.64,1)` | 同一条曲线 |
| 越界裁切 | 底栏自身 `overflow` 裁 | `.seg` `overflow:hidden` 沿圆弧裁 |
| 降级 | `prefers-reduced-motion` → `transition-duration:.01ms` | 同 |

- 预冲量从底栏的 14rpx 收到 **8rpx**：分段控件（72rpx 高、~116rpx 宽的单格）比底栏胶囊小一圈，
  同样的绝对预冲在窄格上会显得「甩出去」。
- 常态两侧内缩 **`INSET_RPX=3`**：底栏是满格贴边，分段控件轨道本身更薄，
  留 3rpx 才不至于让白块和轨道边缘糊在一起。

### 2. 两个几何约定（改了就会错位）

- **`.seg` 一律不写 `padding` / `border`**：格宽必须**精确等于** `width / n`，
  指示器的 `left/width` 才能和文字格同轴。旧版有一层 `padding`，是靠 wxml 里内联
  `width:{{(width-8)/items.length}}` 把 padding 减掉的 —— 这次把这套补偿整条删了，
  格宽交给 `.seg-item { flex:1 }` 等分，组件 JS 只按 `width / n` 算指示器。
- **指示器满高 + 圆角 = 轨道半径（36rpx = 72/2）**：首格左缘 / 末格右缘与轨道圆角同心，
  预冲冲出轨道时由 `overflow:hidden` 沿圆弧裁掉，既不露直角白边也不用额外留白。
  ⚠️ 这条与「`backdrop-filter` 不受父级 `overflow` 圆角裁切」是同一族问题的两面 ——
  **圆角要写在被裁的元素自己身上**（`.seg-ind` 自带 `border-radius:36rpx`）。

### 3. 需求② 真正难的一处：父级重复通知会打断两拍

- **现状**：6 个使用点全部把 items 写成**内联数组字面量**，例如
  `<segmented items="{{[{key:'A',text:'A 组'},{key:'B',text:'B 组'}]}}" …>`。
  父级每次 `setData` 都会**生成一个新数组对象** → 组件的 `observers['items, value, width']`
  即使在「选中项没变」时也会再响一次。
- **如果不设防**：这第二次通知会在两拍播到一半时把 `indCls` 清成 `''` 并直接落到目标格
  → 表现是**「点了没反应 / 白块瞬移」**（耗时 140ms 的 stretch 拍被抹掉，肉眼只剩一次跳变）。
  这类 bug 不会报错、门禁也抓不到，只能靠真机看出来。
- **修法**：用 `_curIdx` 记住**上一个选中下标**，取代「上次的 left 值」做判据，分三种情况：

  | 情况 | 判据 | 行为 |
  |---|---|---|
  | 首次定位 | `typeof prev !== 'number'` | **直接落位**，不做「从最左边滑过来」的假动画 |
  | 下标真的变了 | `prev !== idx` | 清旧定时器 → 播两拍 |
  | 下标没变（重复通知） | `prev === idx` | `if (this._indTimer) return;` —— **两拍进行中一律不插手**；空闲时才补几何 |

- `detached` 里 `clearTimeout(this._indTimer)`：组件销毁后定时器还在，会对已销毁实例 `setData`。

### 4. 需求② 「选到的选择稍微变大」

- `.seg-item` 字号 **26 → 30rpx**、`font-weight:600`、颜色 `#86909C → #1D2129`。
- **为什么可以直接过渡 `font-size`**：格宽是**等分固定**的，文字变大只会撑在格内，
  不会把邻项挤开 —— 所以这里不需要 `check-chip-anim` 那套「让位动画」，
  直接 `transition: font-size .18s ease` 即可（这也是 `check-chip-anim` ③ 有意排除 segmented 的原因）。
- 白底从「选中项自己画的」搬到 `.seg-ind`，所以 `.seg-item.on` 不再需要 `background`；
  但 `.seg-item` **保留了带 background 的 transition**（`background .2s, color .2s, font-size .18s ease`），
  因为 `check-chip-anim.js:148-153` 用文本断言守着「切换不是硬切」。

### 5. 需求③ —— 日期头：从「通底白条」改成「气泡箭头 + 日期卡」

- **「丑」的根因不是配色，是结构**：旧版 `.ws` 是一条**通底白条**（左右铺满、带底色），
  它在视觉上把页面横切一刀，与下面的卡片不属于同一层。所以这次不是调参数，是**换形态**：
  - 删掉整条底色 → `.ws` 只剩 `display:flex` + 一点内边距，三段件各自悬浮；
  - 左右箭头从裸 `app-icon` 改成 **76rpx 圆形玻璃气泡**（半透明白 + 白描边 + 靛蓝投影 + 内高光），
    按下 `transform:scale(.92)`，与底栏 / FAB 的按下语言统一；
  - 中间 `.ws-card`：上行日期区间放大到 **32rpx/600**（升为视觉主体），
    下行 22rpx 放「第 N 周 · 单/双周」+ 本周圆点 + 状态标签。
- `week<=1` / `week>=total` 时对应气泡加 `.off` 压暗到 `opacity:.36`。
- 删掉了旧 `.ws-placeholder`（它只是用来在没有状态标签时占位对齐）；
  现在状态标签只有值日页 / 手动排班页传，课表页不传时下行自然居中。
- ⚠️ **`.ws-bubble` 所在容器不设 `overflow:hidden`**：按下态 `scale(.92)` 不需要裁，
  而通底白条已经删了，没有要裁的东西。
- ⚠️ **不用 `backdrop-filter`**：本组件压在页面极光渐变上，渐变本身平滑，模糊没有收益，
  却会连锁触发 `check-glass` 的两条降级要求 —— 半透明白 + 白描边 + 靛蓝投影已经够。

### 6. 需求③ —— 课表左右切换动画：**借动画、不借手势**

- **复用**已有的 `utils/swipe.js`（它本来是给二级页的横滑手势用的）：
  `shift(page, delta, go)` 先 `setData({swipeCls: animOut(dir)})` → `setTimeout(OUT_MS=160)` →
  `setData({swipeCls: animIn(dir)})` 并执行 `go(wk)`；越界只播 `animEdge` 再清空；`cancel(page)` 清定时器。
  动画 class 与 keyframes 在 `app.wxss`（`.wk-out-left` / `.wk-in-right` / `.wk-edge-*`，只动 `transform/opacity`）。
- **只借动画，不借手势** —— `check-week-swipe.js:102` 明确断言课表页**不得**出现 `onSwipeStart`：
  课表页本身是 `scroll-x` 横向滚动容器，再挂横滑手势会抢横向滚动。所以：
  - `pages/timetable/index.js` 只 `require('../../utils/swipe')` + `swipe.shift(...)` + `swipe.cancel`；
  - `onWeekChange`（箭头 / 时间轴点击）与 `onPickWeek`（周次选择器）两条入口都走动画路径，
    真正改数据统一收口到 `_applyWeek(wk)`（清 `_offDays` → `setData({week})` → `load()`）；
  - `onUnload` 里 `swipe.cancel(this)` 清定时器（二级页离开时不清会导致对已卸载页 setData）。
- ⚠️ **`.wk-swipe` 容器 `.fab` 必须留在外面**：`.fab` 是 `position:fixed`，
  动画容器带 `transform` 会建立**包含块** → fixed 元素随动画飞走（这一族坑项目里已踩过一次，
  见 §65 与 `check-fixed-in-scroll`）。`check-week-swipe` 4.6 节也断言了这一点。
- ⚠️ `.st-item` 的兄弟关系与 `st-1/2/3` 档位在改 wxml 时**不能被打乱**（`check-tab-enter` 守着），
  本版只在外层加了一层 `div`，未动档位。

### 7. 影响面

| 文件 | 改动 |
|---|---|
| `miniprogram/components/segmented/index.js` | 重写：两拍液态指示器 + `_curIdx` 防打断 |
| `miniprogram/components/segmented/index.wxml` | 新增 `.seg-ind`；删内联 `(width-8)/n` |
| `miniprogram/components/segmented/index.wxss` | 重写：`.seg` / `.seg-ind` / 两拍 / `.on` 字号 |
| `miniprogram/components/week-switcher/index.wxml` | 重写为气泡 + 日期卡；删 `.ws-placeholder` |
| `miniprogram/components/week-switcher/index.wxss` | 重写：去通底白条，气泡与卡片分件 |
| `miniprogram/pages/timetable/index.js` | 接 `utils/swipe`；`_applyWeek` 收口；`onUnload` 清定时器 |
| `miniprogram/pages/timetable/index.wxml` | 数据区套 `.wk-swipe`；固定元素留容器外 |
| `scripts/check-chip-anim.js` | 仅注释更新（`width:(width-8)/n` → `flex:1` 等分） |
| `scripts/gen-anim-preview.js` | 新建：从真实 wxss 生成预览页 |

**自动受益，无需改动**：`<segmented>` 6 处使用点（`duty:40`、`home:340`、
`timetable:29/230/314/330`）全部改为新观感；`<week-switcher>` 在 `timetable` / `duty` / `manual` 三页共用。

### 8. 验证

- `node --check` 4 个改动 JS 全过。
- **全量 39/39 门禁 exit 0**，其中与本版直接相关的：
  - `check-segmented`：6 处 `bind:change` 的 handler 全读 `e.detail.key`（契约一字未动）；
  - `check-chip-anim`：`.seg-item` 带 background 过渡仍在；
  - `check-week-swipe`：4.6 容器 + fixed 在外、4.7 从源码 eval 抽 `onWeekChange`/`_applyWeek` 执行、
    102 行「课表页不得挂手势」断言；
  - `check-tab-enter`：`.st-item` 兄弟关系与档位未被打乱；
  - `check-wxss` / `check-wxml` / `check-scroll-lock` / `check-glass` / `check-component-paths` / `check-fixed-in-scroll`。
- **`check-wxss-compile`（微信官方 `wcsc.exe` 真编译）28 个 wxss 全过** ——
  本项目两次栽在「门禁全绿但编译不过」，所以每次动样式都必须跑真编译，不以文本门禁为准。
- **预览页**：`scripts/gen-anim-preview.js` 从**真实组件 wxss** 抽取 CSS（仅 rpx→px ÷2）生成
  `preview/v0.7.20-segmented-week-header.html`，避免「预览和实现漂移」。
  ⚠️ 抽 CSS 的判据必须**同时看选择器与块体**（`/\bwk-/.test(b.text) || /\bwk[A-Z]/.test(b.sel)`）——
  只看选择器会漏掉 `@media (prefers-reduced-motion){ .wk-out-left… }` 整块。
  ⚠️ 本机无头浏览器截图**不可作为证据**：Chrome `--headless=new` 直接退出、`--headless` 落进既有会话
  只得 16KB 非目标页、Edge 无产物；后一次重试虽产出两张 1760×3120 的 PNG，
  但**本会话模型不具备读图能力**（`Read` 图片报 `does not support reading images`），
  无法核验其内容 → 一律不作为验收依据，改为**静态校验**：CSS 括号配平（depth=0）、内联 `<script>` 过 `node --check`、两拍常量与组件一致。
- **备份**：`20260926-221351-v0.7.20-需求②③-液态分段控件-+-日期头气泡箭头-+-课表切周动画`（414 文件 / 3.21M）。

### 9. 门禁覆盖不到的部分（待真机确认）

- **物理手感**：两拍 140+220ms 的总时长、`cubic-bezier(.32,1.5,.64,1)` 的过冲幅度、8rpx 预冲量 —— 
  这三项只能肉眼看，文本与编译门禁都无法覆盖。
- **中间态中断观感**：快速连点 A→B→A 是否跟手（CSS transition 理论上从当前插值续接，需实测）。
- **日期头三段的视觉平衡**：76rpx 气泡 vs 32rpx 日期主字，是否「气泡抢戏」。

---

## v0.7.19 · 2026-09-26

主题：配色回到蓝色系 + 值日页滑动阻尼手感 + 三处「固定定位失效」类故障修复 + 权限与跨周轮转修正。

> 本节为**补记**：v0.7.19 的多次修复此前只落在 `.workbuddy/memory/2026-09-26.md`，未同步进 CHANGELOG。
> 该版经历了 4 个备份批次（spring-scroll 组件路径 → 移出弹层 → 成员页权限 → 轮转跨周），此处合并为一条。

### 1. 配色回退（Req1）

- 把 v0.7.18 的 Auroraqua 粉紫**全量映射回原蓝**（Arco `#3370FF` 系，覆盖 wxss + js + json + wxml 四类文件）。
- **保留**：玻璃材质、大圆角、极光渐变背景、靛蓝投影 —— 回退的只是**色相**，不是结构。
- 复核：`verify-colors` 零残留。

### 2. 值日页边界阻尼（Req2，本版技术含量最高的一处）

- **旧做法**：`<scroll-view bounces="{{false}}">` —— 到顶/到底**硬停**，手感生硬。
- **新做法**：自研 `components/spring-scroll/index.{js,wxml,wxss,json}`，四点：
  1. **spring 物理回位**：`stiffness=250 / damping=30 / mass=1`（ζ≈0.95，近临界、不过冲）；
  2. **边界橡皮筋**：指数衰减 `RUBBER_MAX=80px` / `RUBBER_SCALE=60`，临界阻尼回位不过冲；
  3. **全程 momentum**：松手用**真实速度**作为 spring 初速度惯性滑行 + 自然衰减；
  4. **可打断**：`touchstart` 立刻停掉动画，接住当前速度与位置继续跟手。
- 子元素原生 `bindtap` / `picker` 不受影响：未达 `DRAG_THRESHOLD=6px` 视为 tap，不进拖拽。
- 降级：`wx.getSystemSetting().reducedMotion === 'enable'` 时不做惯性/橡皮筋，直接吸附边界。
- 防滚动穿透：viewport 用 `catchtouchmove`；`check-scroll-lock` 同步新增 spring-scroll 分支（带双向自证）。

### 3. 三处「`position:fixed` 失效」—— 同一个根因，犯了三次

`spring-scroll` 的 `.ss-content` 带 `transform: translate3d(...)`，**会给内部所有 `position:fixed`
元素建立包含块**，fixed 不再以视口为基准。三处表现：

| 表现 | 位置 | 修法 |
|---|---|---|
| 顶部导航栏随滚动位移 | `home` / `duty` / `mine` | `nav-bar` 移出 `spring-scroll`；根容器 `display:flex;flex-direction:column`；滚动容器 `display:block;flex:1;min-height:0` 填满导航栏以下 |
| 「AI 生成 / 导出 / 加值日生」面板跑到页面上方 | `pages/duty` | 全部 `bottom-sheet` / `duty-sheet` 移到 `</spring-scroll>` 外 |
| 同上（历史） | — | 见 §64/§65 的 `check-fixed-in-scroll` |

- **新增门禁 `check-fixed-in-scroll`**：扫 `pages/**/index.wxml`，`<spring-scroll>` 内出现
  固定定位覆盖层组件（`nav-bar` / `bottom-sheet` / `duty-sheet` / `dialog`）即 FAIL，带双向自证。
- **`modal` 组的替代方案**：这条约束与 v0.7.20 的 `.wk-swipe` 容器是同一族 ——
  **把 fixed 元素放在带动画/位移的容器外面**，而不是试图用 `transform:none` 去救。

### 4. 组件路径写错（新增门禁）

- **现象**：模拟器启动失败。`pages/home/index.json` 里 `"spring-scroll": "../spring-scroll/index"`
  从 `pages/home/` 解析到 `pages/spring-scroll/index`，但组件实际在 `components/spring-scroll/index`。
- **修法**：三页统一改 `"../../components/spring-scroll/index"`；
  `components/duty-sheet/index.json` 里的 `"../spring-scroll/index"` 本就在 `components/` 下，保持不动。
- **新增门禁 `check-component-paths`**：扫各 `index.json` 的 `usingComponents`，
  **按相对路径真实解析**并检查 `.json/.js/.wxml` 是否存在。
- ⚠️ **为什么 37 门禁都没拦住**：现有门禁覆盖 WXSS 编译、WXML 结构、玻璃、滚动穿透、Tab 入场等，
  但**没有一条校验 `usingComponents` 路径是否真实存在** —— 这是门禁的**覆盖缺口**，不是判据太松。

### 5. 成员页权限收紧

- **需求**：① 普通管理员进「成员与分组」不显示「是否已绑定」；② 详情不显示「微信已绑定/未绑定」；
  ③ 「停用」仅超管与辅导员可见。
- **前端** `pages/roster/index.{js,wxml}`：新增 `isCounselor` data 字段（此前只是 `onMemberRow` 的局部变量），
  `onLoad` / `app.ready` / `onMemberRow` 三处同步赋值；列表行 `mb-bind` 徽标、顶部「已绑定」统计格、
  详情「微信 已绑定/未绑定」行 → 全部 `wx:if="{{isSuper || isCounselor}}"`；
  「停用/恢复」条件 `!mDetailIsSelf` → `!mDetailIsSelf && (isSuper || isCounselor)`。
- **后端** `cloudfunctions/member`：`setStatus` 原本只 `auth:{needAdmin}`，普通管理员仍可**直接调 API 停人**
  → handler 顶部加 `requireSuperOrCounselor(ctx)`（member 本地守卫；与前端口径一致）。
  ⚠️ 与 §64 同一条铁律：**前端藏起来的按钮，后端必须自己再卡一次**。
- 部署：`updateFunctionCode(member, isWaitInstall)` + CLI 下载线上包 diff 逐字节一致。

### 6. 三个业务 Bug

1. **一键生成跨周不接续（第 4 周从 1 号重排）—— 根因是 `schedule.clear`**
   - 旧实现 `UPDATE member SET duty_count = 0 WHERE class_id=?` 把**全班**轮转标记清零。
     用户清空第 1/2 周（测试）→ 全班标记被抹 → 第 4 周生成时按序号取最小 → 从 1 号重排。
   - **修法**：clear 改为「先数本周每人占用数（AUTO+MANUAL，排除 `SWAPPED_OUT`）→ 删日志/值日 →
     逐人 `GREATEST(duty_count - n, 0)` 回滚 + `last_duty_at` 重算」。
     想全量归零就把每周都清空（各自回滚，自然合成全零）。
   - **数据修复**：按 `duty` 表重算 `duty_count` / `last_duty_at`（24 人 = 1，其余 = 0）。
   - ⚠️ 与 MEMORY 铁律一致：**轮转进度唯一来源是 `member.duty_count`，任何写 duty 的路径都必须同步它**。
2. **入班码生成失败（system error -604101）**：`poster.getQrcode` 两个缺陷 ——
   `getUnlimited` 未传 `checkPath:false`（正式版未发布时页面校验报 41030，微信网关有时给 `-604101`）；
   重试逻辑「非页面错误就 break」导致 release 失败后 **trial 根本没机会试**。
   修法：加 `checkPath:false` + 两个 `envVersion` 都试完再报错。
3. **已绑定者扫码落口令页（恶性）**：bind 页 `onLoad` 无「已绑定」分流。
   修法：`app.ready().then(g => { if (g.bound && !this._leavingBind) wx.reLaunch('/pages/home/index') })`
   + `onUnload` 置 `_leavingBind`。

### 7. 骨架屏与其它

- `roster` 加 `membersLoaded` 标志，加载期间出 `<skeleton>`，
  空态改 `wx:if="{{membersLoaded && !viewMembers.length}}"` —— 消除「没有匹配成员」闪烁。
- `manual` 页 `.card` 纯白覆写为全局玻璃材质（含 `@supports not` + `prefers-reduced-transparency` 双降级）。
- `duty` 分组标题 crossfade：`_fadeGroupHeadersOut(next)` 先 60ms 淡出旧标题再 `_flipMode`；
  `_flipMode` 改为共享行 FLIP + 新标题/新行淡入上移 8px。
  ⚠️ 总时序约 440ms，**略超用户初提的 150–250ms**，但可打断且 FLIP 主体在 180ms 内；待真机观感确认。

### 8. 验证与踩坑

- 门禁从 37 → **39**（新增 `check-component-paths`、`check-fixed-in-scroll`）。
- ⚠️ **`check-count-align` / `check-committee` 的旧断言在 spring-scroll 重构与骨架屏改动后已过时**
  （`.dt min-height:100vh` 页面级滚动前提、`!viewMembers.length` 判空、`!mDetailIsSelf` 分支），
  已按新架构更新判据。**教训：重构布局后必须全量跑门禁，不能只跑「看起来相关」的那几个。**
- ⚠️ **CLI 参数顺序**：`tcb fn code download <名> <目录> -e <env>` —— **`-e` 必须放在后面**，
  放前面会报「No valid identity information」。
- 备份：`20260926-213720-v0.7.19-轮转跨周接续修复+入班码修复+已绑定扫码直进`。

---

## v0.7.18 · 2026-09-26

主题：整站重制为 Auroraqua-UI「冰态果冻」+ 主页关注收紧为仅辅导员 + 解释性文字去底色。

> 决策方式：grill-me 一轮 3 问（第④点是哪一行 / 主色是否连换 / 是否做暗色）；**本次会话的模型不具备读图能力**，
> 所以第④点由用户从「全站带底色的说明文字」候选清单里确认 —— 裁决记录见 `.workbuddy/memory/2026-09-26.md`。
> 裁决结果：① 解释性提示**全部**去底色 ② 主色**全部**换成粉紫 ③ 本次不做暗色模式。

### 1. 视觉来源与令牌（不是凭印象调色）

参考项目 `micromimo/Auroraqua-UI` 的令牌来自它仓库里的 **`src/index.css`（1050 行）与 `tailwind.config.js`**，
逐条抄下来的真实值（`git clone` 被拦，走 `raw.githubusercontent.com` 单文件取）：

| 用途 | 值 |
|---|---|
| 背景 | `linear-gradient(135deg, #FFF0F5 0%, #FFE4E1 40%, #E6E6FA 100%)` |
| 品牌 | `--color-primary #ec4899` / `--color-secondary #8b5cf6` / `--color-accent #f472b6` |
| 中性阶 | `#faf5ff → #f3e8ff → #e9d5ff → #d8b4fe → … → #581c87`（紫阶） |
| 文字 | heading `#1e1b4b` / body `#312e81` / secondary `#6366f1` / muted `#818cf8` |
| 玻璃 | `.glass`＝`rgba(255,255,255,.35)` + 描边 `rgba(255,255,255,.5)` + `0 8px 32px rgba(31,38,135,.15)` + `inset 0 1px 0 rgba(255,255,255,.6)` |
| 玻璃（小元素） | `.glass-shortcut`＝`.5` + 描边 `.6` + `blur(12px)` |
| 主按钮 | `.btn`＝`linear-gradient(135deg, secondary, primary, accent)` |
| 模糊档位 | 8px / 12px / 24px |
| 圆角 | 12px / 16px / 20px + 9999px（胶囊） |
| 动效 | float 6s、pulse-glow、shimmer、gradient-drift、slide-in-up/left |

- **投影色相是关键细节**：他们的投影统一用 `rgba(31, 38, 135, α)`（靛蓝），不是中性黑。换成靛蓝后
  「重阴影 + 大模糊」才有他们说的「冰絮果冻」质感 —— 这条最容易被当成可有可无，其实是观感差异的大头。
- ⚠️ 他们的 `.glass` **本身没有 backdrop-filter**（只有 `.glass-shortcut` 有）。本项目保留 24px 模糊：
  小程序里玻璃压在极光渐变上，模糊能吃掉渐变的色带，观感更润。

### 2. 换色怎么落地（可审计、可回滚）

手工改 829 处硬编码色值不可靠 → 写成**一次性迁移脚本**（映射表就是唯一事实来源）：

- `scripts` 外的一次性脚本放在 `.workbuddy/tmp/retheme.js`（不进仓），支持 `--dry / --write / --colors-only`。
- **颜色不只在 wxss 里** —— 第一次只扫了 wxss，结果 111 处漏网：`utils/util.js` 的头像色板与值日状态色、
  `avatar-tag` 姓名牌、`dialog`/`roster`/`timetable`/`classes` 的 `wx.showModal({confirmColor})`、
  `duty`/`poster` 的 canvas 出图色、`app.json` 与各页 `.json` 的 `backgroundColor`。
  漏掉的表现就是「整体变粉了，但点开弹窗蹦出一个蓝按钮 / 导出图的标题还是蓝的」。
  → 第二轮把 `js / json / wxml` 一并纳入（`--colors-only`）。
- ⚠️ **圆角替换不是幂等的**（16rpx→32rpx 再跑一次会变 40rpx）→ 第二轮必须 `--colors-only` 关掉圆角段。
- 迁移后复核：旧调色板（`#3370FF / #1D2129 / #86909C / #F2F3F5 / #F53F3F / #00B42A / #FF7D00 …`）
  在 wxss 与 js/json/wxml 里**均为 0 处残留**（只留 `#FFFFFF` 白，是有意的）。

### 3. 「表面玻璃、控件实心」的界线

把「实心白底」无差别玻璃化会伤可读性 → 定了一条界线，并写成白名单脚本 `.workbuddy/tmp/glassify.js`：

- **玻璃化（12 条规则）**：`.cl-card`（班级卡）、`.picked-card`、`.dc-sec`（文档条卡）、`.agree-box`、
  `.ws`（周次切换条）、`.cl-fchip` / `.cl-bchip` / `.dt-fchip`（筛选标签）、`.cl-import`、`.cl-staff-btn`、`.cl-pick`。
- **保持实心**：输入框、验证码格、复选框、骨架屏、二维码底、小圆点。二维码尤其不能透明（要保证扫码对比度）。
- ⚠️ 玻璃化后**又撤掉了这批元素上的 backdrop-filter**：它们的背后只是**平滑的极光渐变**，
  模糊前后像素几乎一致（没有收益），却会触发 `check-glass` 的「用了模糊就必须给降级」要求 ——
  那条要求是给**浮层**准备的（浮层背后是正文，不兜底就是字压字）。真正浮在内容之上的面
  （底栏 / 导航 / 弹层 / 悬浮按钮）继续保留模糊 + 两条降级。

### 4. 需求①「关注的学生仅辅导员可见」

- 上一版口径是 `isSuper ∨ isCounselor` → 超管也会看到这张卡。本版收紧为**仅 `group_tag='X'` 的教职工**。
- 改动点（前后端必须同口径，否则会出现「能钉却看不到」）：
  - `member.pinList`：`if (!guard.isCounselor(me)) throw 40003`；**顺带删掉了超管的特权分支**，
    现在一律走 `staff_class` 收窄（超管走不到这里了，留着分支只会误导）。
  - `member.pinToggle`：**单独**再卡一次 `isCounselor` —— 它复用的 `noteScopeOk` 是允许超管的
    （备注的可见范围是「教职工 + 超管」，与关注不是一套口径），不能拿它当这道门。
  - 首页 `showPins = isCounselor`（不再跟 `canViewClass` 走）；成员详情新增 `pinVisible = isCounselor`。
- ⚠️ **不要连坐备注**：`noteVisible`（备注）仍是「教职工 + 超管」，用户从未要求改它。
- 门禁 `check-staff-pin` 同步改判并加强：静态断言两个路由都自己卡了「仅辅导员」；
  运行时新增超管被拒（40003）、**且被拒时根本没发查询**（不是「查了再藏」）。运行时断言 17 → 19 条。

### 5. 需求④「这一行字不要背景底色」

- 会话模型读不了图 → 先**全站搜出所有「带背景底色的说明性文字」**并列出原文，由用户确认。
  实际处理 5 处：`.dt-admin-tip`（值日页权限提示，原暖黄底）、`.ai-tip`（值日页 AI 说明，原灰紫底）、
  `.ms-tip`（手动排班说明，原粉底）、`.mn-unbind-hint`（我的页解绑提示，原灰紫底）、
  `.nt-tipbar`（通知页开启提示，原粉底）。
- 处理方式：**只删 `background` 与 `border-radius`，连内边距一起去掉**（留着 padding 会变成看不见的框），
  保留字号 / 行高 / 字色 —— 语气靠字色区分（权限提示暖褐、说明靛蓝、排班提示品牌粉）。
- `.nt-tipbar` 里含一个「开启」按钮：去底后按钮仍是实心粉胶囊，可点性不受影响。

### 6. 踩到并修好的两个工程坑

1. **行尾事故（我的锅）**：用 Python 文本模式批量改 wxss 时，12 个文件的换行被写成 CRLF（原本全是 LF）。
   后果不是报错而是**门禁误报** —— `check-glass` 的自证正则用的是 `\n}\n`，遇到 CRLF 匹配不到，
   于是「删掉兜底」的变异变成空操作、自证翻红。
   - 定位方式：写 `.workbuddy/tmp/eol-check.js` 数各文件的 CRLF/LF，再用 `.workbuddy/tmp/eol-fix.js`
     与**开工基线**逐文件比对，只还原「基线是纯 LF、现在是纯 CRLF」的那 12 个（不误伤本来就 CRLF 的 3 个）。
   - 教训：**本项目里不要用 Python 文本模式改写源码**（Node 的 `fs.writeFileSync` 不翻译换行，用它）；
     另：门禁里所有 `\n` 相关的正则都应意识到行尾差异。
2. **画布/弹窗配色不在 wxss 里**（见 §2），只换样式文件会留下「半新半旧」。

### 7. 影响面与验证

- 云函数：**仅 `member`**（需求①的权限收紧）→ 重新部署，`tcb fn code download` + `diff` **逐字节一致**；
  路由实证 `pinList` = 40001、对照组未知 action = 41001。
- 前端：26 个 wxss + 14 个 js/json/wxml 改动，需在微信开发者工具**重新编译上传**。
- 门禁：**36/36 全绿**（`check-staff-pin` 改判并加强到 19 条运行时断言；`check-glass` 未改判据，
  靠「撤掉流内模糊」满足）。
- 数据库：无变更（本轮不涉及表结构）。

### 8. 「编译 .wxss 文件错误」事故与两道新门禁（2026-09-26 追加）

**现象**：用户在开发者工具刷新后报错，IDE 提示
`Error: 编译 .wxss 文件错误，错误信息如上，可在控制台查看更详细信息`。

**定位过程（不靠猜、不依赖看图）**：会话模型读不了截图 → 改从**工具链自身**取证：
1. 在开发者工具的会话日志里捞到了确定的报错时刻与编译目标：
   `<DevTools>\...\WeappLog\logs\2026-09-26-13-36-58-187.log`
   → `[ERROR][devtools] webview on error Error: 编译 .wxss 文件错误`，紧邻的
   `[CompileCache] cacheify executor { cacheKey: 'miniProgramWxssLazyload', cacheSubKey: '__APP__' }`
   把范围指到**应用级 wxss 打包**。
2. **找到官方编译器本体**：`<DevTools>\resources\app.asar.unpacked\node_modules\wcc-exec\wcsc.exe`
   —— 无依赖的独立 exe，命令行用法 `wcsc.exe [-lc] [-o OUT] <file.wxss>`。
   ⚠️ 路径含中文 → Git Bash / cmd 传参会乱码（实测：写 UTF-8 的 `.cmd` 会因 cmd 按 GBK 读而报
   「命令语法不正确」）→ **先把它拷到 ASCII 路径再调用**。
3. 用它对全部 27 个 wxss 逐个真编译 → 精确定位：
   `pages/classes/index.wxss(461:41): unexpected '1' at pos 12713`。

**根因（我自己的脚本 bug）**：`glassify` 的替换正则用了
`(background\s*:\s*)(#FFFFFF|#FFF|var\(--bg-card\)|white)` ——
**`#FFF` 会前缀匹配任何以 FFF 开头的 6 位色值**。于是 `background: #FFF1F2;` 被改成
`background: rgba(255,255,255,.55);` 且**把 `1F2;` 留在原地**：

```css
background: rgba(255, 255, 255, 0.55);1F2;   /* ← 真编译器 fatal */
```

- **门禁为什么没拦住**：`check-wxss` 的判据是**按行**看的，而这一行以 `;` 收尾、格式完全合法。
  这是铁律「门禁只跑文本正则，跑不了 WXSS 编译器」的又一次实例。
- 影响面：全站仅 **1 处**（其它 `#FFFxxx` 值在更早的换色步骤里已规范化，白名单规则里只有这一条是 `#FFF...` 背景）。

**修法**：
1. 该处恢复为 `background: #FFF1F2;`（**警告态是语义色，故意不玻璃化**，并在代码里写明原因）。
2. **新增门禁 `check-wxss-compile`（真编译）**：按已知路径查找官方 `wcsc.exe` 并逐个真编译全部 wxss；
   找不到则明确 SKIP（退出码 0，避免没装开发者工具的机器误报红），支持环境变量 `WX_WCSC` 覆盖。
   自带 3 组自证：残留 hex 尾巴必抓 / 孤立 `}` 必抓 / 好样本不误报。
3. **`check-wxss` 加「声明形状」判据**：规则体按 `;` 切开后每段必须含冒号 —— 文本层兜底
   （不依赖开发者工具存在），并带双向自证（含「走 `checkFile` 主入口也会判死」）。
   上线前已确认 wxss 里不存在 `data:` / `url(...;...)` 这类**值里带分号**的写法，判据无假阳性。

**一条重要覆盖边界（实测，不是推测）**：本版 `wcsc` **接受** `~` 选择器，但真机会
`unexpected token ~` 并 fatal。所以两门禁**互补**：`check-wxss-compile` 管「能不能编译过」，
`check-wxss` 段③ 的文本级禁 `~` 管「真机跑不跑得动」——
**文本级禁令不可因「有了真编译门禁」而删除**（该结论已写进门禁 ③ 段输出与 `deploy.md`）。

**顺带修掉的一处文档缺陷**：本轮发现 `CHANGELOG.md` / `CHANGELOG-DETAIL.md` 里
**v0.7.17 与 v0.7.16 的版本标题被我自己吃掉了**（原因：写新版本时用「下一版的标题行」当 Edit 锚点，
替换后没有把标题补回去，导致那两版内容被并进 v0.7.18 节）。
已恢复两文件共 4 个标题，版本序列现在连续（v0.7.18 / v0.7.17 / v0.7.16 / v0.7.15 …）。
**教训**：拿标题当锚点做插入时，新内容里**必须原样回吐该标题**，否则就是「静默吞结构」——
这类错误不会报错，只会让文档结构悄悄错位。

**门禁总数**：36 → **37**（全绿，含真编译）。

---

## v0.7.17 · 2026-09-26

主题：全站液态玻璃材质 + 绑定名单提速 + 解绑后自动回口令页 + 辅导员关注学生固定到主页。

> 决策方式：grill-me 一轮 3 问（玻璃范围 / 环境背景 / 关注卡片展示），裁决记录见 `.workbuddy/memory/2026-09-26.md`。
> **用户已预设**「若不好看则等我消息回退为原本效果」→ 完成态已单独备份（见 §6）。

### 1. 全站液态玻璃材质（需求②③）

- **背景**：底栏从 v0.7.14 起就是「液态玻璃胶囊」，但页面主体仍是纯白卡片。本轮把材质铺到全站。
- **口径（参考 Kyant0/AndroidLiquidGlass · Apple Liquid Glass）**：一次「玻璃」= ①半透明 tint ②背景模糊 + 饱和度提升 ③1rpx 亮边 + 顶部内高光（厚度感）④大半径低透明度外投影（浮起来）。
  - 令牌集中在 `app.wxss` 的 `page` 块：`--glass-bg / --glass-bg-strong / --glass-blur / --glass-edge / --glass-shadow / --glass-highlight`。
  - 各组件（nav-bar / bottom-sheet / dialog / duty-sheet / custom-tab-bar）都是 `addGlobalClass: true`，且 CSS 自定义属性会继承进组件 → 令牌在组件里可直接引用。
- **⚠️ 玻璃「像不像」取决于背后有没有东西可模糊**：页面原本是纯色底，`blur()` 的结果还是那个纯色 → 玻璃和白卡肉眼无差别（这是历史反馈「不像玻璃」的另一半根因，v0.7.14 只解决了「底色不够透」这一半）。
  - 因此 `page` 垫了三团极淡的环境色晕（蓝 / 紫 / 青，alpha .10~.14），并把 `.page` 改成 `background: transparent` 让色晕透上来。
  - 色晕用 `background-attachment: fixed` + 固定高度；不支持该属性的机型退化为「色晕只在页面顶部」，因为三团都是渐隐到完全透明，退化后看不出接缝。
- **只有材质变，版式一律没动**（用户裁决「只换材质」）：圆角仍是 `--r-md`、外边距与内层结构不变。
- **降级必须写**（新增门禁 `check-glass.js` 强制）：
  - `@supports not (backdrop-filter…)` → 底色加厚到 0.9~0.95（不支持模糊的安卓 WebView 上，半透明白 + 无模糊 = 正文透上来压字；这种故障在 iOS 上永远复现不了）。
  - `@media (prefers-reduced-transparency: reduce)` → 直接实心、关掉模糊。
  - ⚠️ nav-bar 的底色是 **inline style**（`style="background:{{bg}}"`），类选择器赢不过它 → 降级块里的 `background` 必须带 `!important` 才生效。
  - ⚠️ `backdrop-filter` 的模糊**不受父级 `overflow:hidden` 的圆角裁切**（模糊的是元素背后的内容），所以圆角必须写在玻璃元素自己身上。
- **底栏**：`.tabbar` 底色 `rgba(255,255,255,.5)` → `.34`，`blur(30px)` → `blur(38px)`、`saturate(180%)` → `200%`；不支持模糊时降级 `.88`。**几何与占位一律未动**（`check-tabbar-liquid` 仍全绿）。
- **FAB / 悬浮胶囊**：`.remind-fab`、`.fab-shift` 换成玻璃白；`.fab`（主操作）保留品牌蓝但改成「半透明蓝 + 模糊 + 顶部高光」，白色「＋」的可读性由 tint 保底。

### 2. 绑定页名单加载慢（需求①）

- **根因**：绑定页 `onNext` 是**串行**两跳 —— `auth.checkToken`（拿规范口令）→ `member.list{public:'roster'}`（拉名单）。两次云函数冷启动叠加，用户第一次打开小程序时 `member` 还是冷的（1~3s），表现为「进到选人页要干等好几秒才出名字」。
- **改动**：
  - 两条请求**并行**：后端 `member.list{public:'roster'}` 的解析条件是 `join_token = ? OR invite_code = ?`，与 `checkToken` 完全一致 → **用户原始输入**即可直接换名单，不必等规范口令回来。
  - `ROSTER_CACHE`（模块级内存缓存，按 token 落）：返回上一步 / 输错重试 / 二次进入都同帧出名字；两个键都写（原始输入 + 规范口令）。
  - `onLoad` **预热 member 云函数**：用一个必然不存在的口令打一次（走到「口令不正确」就返回，**不计入爆破失败数** —— 计数只在 `auth.checkToken` 里）。
  - 扫码进入（`_resolveScene`）时提前把名单拿到手上。
  - `onBack`（step1 → step0）连 `roster` 一起清：否则换口令后会拿**上一个班**的名字顶着新口令的骨架。
  - 并行那一路失败/为空 → 仍用规范口令补拉一次（保底，宁可慢也不出错）。

### 3. 解绑后必须回到输入口令页（需求④）

- **现象**：被解绑后首页确实显示「未绑定」，但「我的」页还挂着原账号；只有**杀掉小程序重进**才会进绑定页。
- **根因（两个，都是真的）**：
  - `utils/request.js` 收到 40001/40002 时会 `emit('needBind')`，但**一个监听者都没有** —— 事件发出去就蒸发（`grep -rn needBind miniprogram` 只有那一行 emit）。
  - App 只在 `onLaunch` 判一次身份，**回前台不重新核对**；而 `pages/timetable` 是 100% 本地渲染、一次云调用都不发 → 停在课表上被解绑时永远没有信号。
- **改动（四环链路，缺一不可）**：
  1. `request.js` 继续在 40001/40002 时 `emit('needBind')`（未改）；
  2. `app.onLaunch` 补 `req.on('needBind', …)`；
  3. `_handleUnbound()`：置空 `bound/profile/switched` + **清 `mem` / `notice` 缓存** + `_goBind()`（reLaunch 到绑定页）。缓存必须清：解绑后换个人绑定，不能让他看到上一位成员的值日与通知。带 `_unbinding` 去重（一次失效会引发多个并发请求各报一次 40001）。
  4. `app.onShow` → `_recheckAuth()`：回前台补一次 `auth.login`（**20s 节流** + `_authChecking` 并发去重），未绑定即 `_handleUnbound()`。首次启动不归它管（`authChecked` 还是 false，由 `_bootstrap` 负责）。
- **验证**：新增门禁 `check-unbind-route.js`（四环 + 4 组变异，其中「摘掉监听」= 历史真实故障）。

### 4. 辅导员「我的」页去噪（需求⑤）

- 统计块（本学期 / 待值日 / 已结束）加 `!isCounselor`；同时**连那一次 `duty.myStats` 请求也省掉**（`load()` 里直接置 `stats: null`）。
- 顺手修两个「空壳卡片」：`任务` 卡片（内含的「通知」行本就对辅导员隐藏）与 `提醒` 卡片（值日日历 / 微信提醒都是学生功能）对辅导员整块不渲染 —— 否则会留一张只有背景、没有内容的卡片。
- ⚠️ 保留内层 `wx:if="{{!isCounselor}}"`：`check-notice.js` 用正则断言「通知行带该条件且 `bindtap="goNotice"`」，拆掉会挂门禁。

### 5. 成员备注版式（需求⑤图②）

- 旧版：正文 26rpx + 元信息 22rpx 挤在 14rpx 内边距的浅灰块里（用户反馈「太小了，显得很小气」）。
- 新版：备注整体 = 独立面板（`#F7F9FD` + 20rpx 圆角），标题行含条数 + 一行说明；每条备注 = 白底卡片 + 左侧 6rpx 竖条（自己写的 `#3370FF`、别人的灰蓝）+ 正文 28rpx/行高 1.6 + 元信息独立成行 + 删除按钮带浅红底；书写区独立成块（白底 + 描边 + 字数计数器 + 「取消编辑」），输入框最小高 160rpx。
- 竖条用 `::after`（WXSS 合法伪元素；`~` 非法，本项目禁）。

### 6. 辅导员「关注的学生 · 固定到主页」（需求⑥）

- **新表 `staff_pin(staff_id, member_id, created_at)`**（迁移脚本 `scripts/migrate-staff-pin.sql`，线上已建）。关注是**教职工个人维度**，同一位学生可被多位老师分别关注。
- **member 新路由**：`pinList`（列表，含 `latestNote` / `noteCount` / `avatarUrl` / `className`，并回传 `limit`）/ `pinToggle`（关注或取消，返回新状态与计数）。
- **权限与备注完全同源**：复用 `noteScopeOk(pool, ctx, memberId, '关注')`（超管放行；教职工限绑定班级；学生 / 普通班委 40003）。
- **纵深防御**：`pinList` 读取时**再按 `staffClassIds` 过滤一次**（`AND m.class_id IN (…)`）—— 教职工的班级绑定被改小之后，历史关注不能继续把已不在范围内的学生漏出来；绑定集合为空时**直接返回空列表、根本不发无约束查询**。
- **上限 8 人**（`PIN_MAX`），超出 41001 并提示先取消一个。
- **孤儿清理**：删教职工（`staffDelete`）清 `staff_pin.staff_id`；移出成员（`removeMember`）清 `staff_pin.member_id` **与 `member_note`**（留着就是孤儿行，且 id 复用时可能把旧记录挂到别人身上）。
- **前端**：
  - 成员详情新增「固定到主页」按钮（`noteVisible && !mDetailIsSelf`），已固定态是填充蓝 + 白字（与一排灰按钮区分）；状态由 `api.pinList({})` 拉一次（≤8 条）本地判定，不为布尔值再开接口。
  - 首页新增「关注的学生」卡片（`showPins`，与详情的 `noteVisible` **同源** = 教职工 / 超管）：头像 + 姓名 + 班级 chip + 最新备注摘要（单行省略号）+ 备注条数；点开走 `navigateTo('/pages/roster/index?classId=X&openMemberId=Y&name=…')`。
  - `pages/roster` 新增 `_pendingOpenId` 深链：名单**加载完成之后**按 id 打开详情（`onLoad` 时 `members` 还是空的，不能在那里查），并且只自动打开一次。
  - **st-item 档位整体重排**：首页插入「关注的学生」后，档位序列必须是 st-1 / st-2(关注) / st-3(通知条) / st-4(今日) / st-4(明日，封顶)。
- **验证**：新增门禁 `check-staff-pin.js` —— 静态审计 + **运行时 17 条**（原样 eval `member/index.js` + 假连接池，判据落在**真拼出来的 SQL 与 args**，含越权用例：跨班关注 40003、学生身份 40003、无绑定班不发无约束查询）+ 4 组变异必抓。

### 7. 影响面（本版本）

- 云函数：**仅 `member`** 需要重新部署（`common/` 未改动 → `sync-common` 为内容无变化的幂等操作，`duty`/`auth` 抽检 diff 仍逐字节一致）。
- 数据库：新表 `staff_pin`（线上已建，幂等 DDL）。
- 前端：app.js / app.wxss、bind、home、mine、roster、classes? （未改）、duty?（未改）、timetable、components 四个、custom-tab-bar —— 需在微信开发者工具**重新编译上传**。
- 门禁：33 → **36 个**（新增 `check-glass` / `check-unbind-route` / `check-staff-pin`，均已登记 `scripts/deploy.md` §2.1）；`check-wxss` 修掉一处「判据命中块注释」的误报（详见 §8）。

### 8. check-wxss 判据修正（本轮踩到并修好）

- **现象**：`components/dialog/index.wxss` 被报「第 30 行疑似漏了分号」，那一行其实是块注释里的 `\`overflow:hidden\` 裁不住 backdrop-filter`。
- **根因**：该判据只剥掉 `//` 行内注释，**没有剥 `/* … */` 块注释** → 注释里「属性名:属性值」的形状被当成「未写分号的属性行」。这是项目第三次踩「判据命中注释」（前两次：类名 `indexOf` 命中注释、裸 `COUNT(*)` 命中注释）。
- **修法**：新增 `blankBlockComments()`（把块注释挖成等长空格、保留行号），所有**文本判据**改跑在无注释副本上；并补双向自证（真·漏分号仍必抓 + 注释里的 `overflow:hidden` 不得误报）。


## v0.7.16 · 2026-09-26

主题：教职工体系重构（全局账号 + 多班绑定）+ 调课防呆 + 值日生增减 + 通知准实时 + 成员备注。

> 决策方式：grill-me 两轮盘问，全部 9 条需求无遗留「视情况而定」项；裁决记录见 `.workbuddy/memory/2026-09-26.md`。

### 1. 教职工体系重构（需求①②⑥⑧⑨）

- **旧模型**：教职工 = `member(group_tag='X')`，`class_id` 单值 → 只能从属一个班；入口挂在每个班的卡片下面。
- **新模型**（用户裁决：管理权限**仅超管**；绑定流程 = 录姓名 → 8 位一次性码）：
  - 新表 **`staff_class(staff_id, class_id)`** 多对多；教职工账号 `class_id = 0`（不落单班）。
  - `guard.staffClassIds(pool, member)`：有映射 → 映射集合；无映射 → 回退主班（存量兼容）；都没有 → 空集。
  - `guard.classIdOf`：X 组**不再回退 1**（防无主班教职工越权看到 示例班级A）。
  - `guard.resolveClassId(pool, ctx, payload)`：跨班**查看**类路由统一收口 —— 普通成员恒本班（传入被忽略，防伪造）；超管任意活动班；教职工限 `staffClassIds`。`schedule.listWeek` 已接入（值日班级筛选的读通道）。
  - `member.targetClassId`（跨班**管理**类路由）：教职工的 classId 请求限绑定集合（越界 40003）。
  - `class.list`：教职工只回绑定的班；`media.msgPublish`：教职工的 classIds 过滤到绑定集合，无主班未选班 → 明确报错。
- **member 新路由**（全部仅超管）：`staffBindClasses`（全量覆写映射）/ `staffUnbind`（清微信绑定，账号与班级绑定保留）/ `staffDelete`（删账号，需先解绑；备注保留）。
- **⚠️ 故意不改 `guard.isAdmin`**：教职工 role='ADMIN'，若全局把 X 排除出 isAdmin 会连坐堵死辅导员发通知 / 管名单的 needAdmin 路由；值日页的管理按钮本来就全是 `isSuper` 门 + 后端 needSuper，无需动它。
- **前端**：`pages/classes` 重构（独立「教职工管理」入口 + 行内绑班编辑器 + 顶部筛选标签）；`pages/home` 辅导员隐藏学生块（Hero/今日/明日课次/提醒胶囊），「成员与分组」原位换「查看班级」；`pages/duty` 辅导员顶部班级筛选（缓存键带 classId）。
- **标签挤开动画**（需求②图③规格）：复用 `app.wxss` 的 `.chip-motion` 基类（padding/font-size 过渡 = 布局真变大 → 邻项平滑让位，不是 scaleX 只改绘制），页内 `.cl-fchip` / `.dt-fchip` 定义几何；flex-wrap 支持换行；reduced-motion 显式压到 0.01ms。
- **st-item 档位重排**：duty 页插入筛选块（st-3）后，`dt-admin` 从 st-3 改 st-4（第 5、6 块封顶 st-4，符合 min(N,4)）。`wx:if` 隐藏不影响 check-tab-enter 的静态档位扫描（兄弟关系不变）。

### 2. 调课防呆（需求③前半）

- **根因**：`day_shift` 误留 `10/6 → 9/20`（9/24 由超管测试账号创建），`week.classDateOf` 忠实执行 → 第 4 周值日写到 `class_date=2026-09-20`（已过去 → 全部「已结束」）。**day_shift 表已清空（线上 DELETE 复验 0 行）**。
- **防呆**（`course.saveShift`）：① `to_date` 必须在学期内（原缺失）；② **调入日期不得已过去**（`to < today` → 41001；真实的「假期课提前到未来调休日」不校验先后方向，不受影响）；③ **跨周弹确认**：`fw !== tw` 且未带 `confirm:true` → 返回 `{needConfirm, message}`，`pages/timetable` onShiftSave 弹确认后重发。

### 3. 值日生增减 + 我的页计数（需求③后半）

- **移除**：duty-sheet 原本就有（超管「调整 › 移除」→ `schedule.remove`）。后端补**回滚轮转标记**：删 `source='AUTO'` 的行时 `duty_count - 1`（否则轮转池「少排一个人却被记成已排过」）；手动行直接删。
- **增加**：duty 页日视图天分组底部「＋ 加值日生」（仅超管）→ 弹层选课次（从当天 duties 按 sessionId 去重）→ 本班名单（滤 X/DISABLED，标记已在该课次，本地搜索基于基表 `_addBase` 防过滤子集丢数据）→ `schedule.addManual`。写调用前**乐观作废**缓存（check-perf R6 口径）。
- **我的页计数慢根因**：`load()` 有 20s STALE_MS 静默窗，窗口内切回不重拉 `duty.myStats`。改为 **SWR**：旧值先显示、每次 onShow 后台重拉。`check-notice-v2` R4 判据同步改判（静默窗 / SWR 均为合法形态）。

### 4. 通知准实时 + 回收站清空（需求④⑤）

- **约束**：微信小程序无服务端推送通道（订阅消息只能在微信里弹，刷不了页面内数据），用户裁决**不做轮询**。
- **落地**：`utils/notice` FRESH_MS 60s → **15s** + 新增 `invalidate()`；首页角标改 **SWR**（onShow 后台重拉 `_refreshNoticeBadge`）；发布通知成功后 `notice.invalidate()`。mine 页角标本就每次都拉 ✓；通知页 onLoad 缓存渲染 + 必刷 ✓。
- **回收站清空**（需求⑤）：新路由 `media.msgRecycleClear`（删我自己全部 `notice_msg_delete` 行，按 member_id 隔离）+ 弹层头部「清空回收站（N）」+ 二次确认。

### 5. 成员备注（需求⑦）

- 新表 **`member_note(member_id, author_id, content≤500, created_at)`**；路由 `noteList / noteSave / noteDelete`（作者本人或超管可编辑删除；教职工经 `noteScopeOk` 校验目标成员在绑定班级内；其余身份 40003 —— 学生与普通班委不可见）。
- **决策**：教职工账号删除后备注**保留**（记录跟着学生走）；编辑走「点自己写的备注载入草稿」。
- 前端：`pages/roster` 成员详情弹层底部备注区（列表 + 500 字 textarea + 保存/删除）。

### 6. 门禁改判与部署

- **改判 3 处**（判据守的是旧口径，本轮有意变更）：`check-staff-bind` [add-auth]/[reissue-auth]（接受 requireSuper）与 [cls-gate]（接受 isSuper 新入口 + 变异锚点 staffShow→staffMgrShow）；`check-notice-v2` R4 mine 页（接受 SWR）。
- **部署**：common 变更 → `sync-common.js`（12 函数）→ **12 个 updateFunctionCode** → `tcb fn code download` 全量 diff **逐字节一致** → 路由实证（新 action 无登录 40001，对照未知 action 41001）。
- **DB**：线上已建 `staff_class`（存量 2 条 X 组回填主班）与 `member_note`；`day_shift` 已清空。迁移脚本：`scripts/migrate-staff-class.sql` / `scripts/migrate-member-note.sql`。
- 门禁：**33 个全绿**。前端待微信开发者工具重新编译上传。

---

## v0.7.15 · 2026-09-26

主题：底栏指示块跨页连续滑动 + 值日提醒「当天早上再提醒一次」（带课次与教室）。

### 1. 底栏指示块跨页交接（修「跳着点 = 瞬移」）

- **问题**（用户原话）：「底部 tab 栏，四个按钮两两相邻之间点击，还有动画效果，但是我如果从首页直接点我的，**动画就直接消失了，蓝色遮罩变成瞬间出现在选择的页面位置，而不是滑动过去**。」
- **根因**（一处设计缺陷的两种表现，不是两个 bug）：
  `custom-tab-bar` 是**每个 Tab 页各一份组件实例**（这也是 `getTabBar()` 必须从当前页取的原因）。旧实现把两拍动画起在「点击时所在的那一份实例」上，而 `wx.switchTab` 紧接着就把该页隐藏 —— 动画只播了个开头就随页面一起消失。屏幕上真正显示的是**落地页那一份实例**，它有两种情况都不会播动画：
  1. 该标签**第一次打开**：`attached` 里 `indLeft = normLeft(active)`，首帧就画在终点（初始渲染不带 transition）；
  2. 该标签**之前打开过**（实例被缓存）：`onShow → app.setTabBar(index)` 里那句「`tb.data.active === index` 就跳过」的守卫 —— 但 `active` 早在 click 那一刻就被**乐观预置**成目标格了，守卫恒为真 → `syncActive` 从不执行 → 指示块停在原地（正好是终点）。
  距离**一格**时视觉差只有 116rpx，观众会把「离场实例上播出的前 100ms」当成完整动画，于是看着像「滑过去了」；距离**三格**（首页→我的，348rpx）就暴露成瞬移。
- **改动**（`miniprogram/custom-tab-bar/index.js`，另加 `app.js` 一处）：
  - 新增模块级 `INSTANCES`（实例注册表，`attached` 注册 / `detached` 注销）与模块级 `HANDOFF = {to, from, at}`。**同一份 JS 模块在所有实例间共享** —— 上方 `LIST` 只算一次就是靠这一点，所以模块级变量天然是跨实例的。
  - `attached` 记下自己所属页面的路由 `_route`（`syncActive` 每次 onShow 再校正一次，防止首次 `getCurrentPages()` 未就绪）。
  - `onChange` **不再**在本地起拍：只写 `HANDOFF` + `setData({active})` 乐观选中 + 调 `_preplace(from, to)`。
  - `_preplace` **只把落地页那一份实例**的指示块预先挪到起点格（按 `_route` 匹配目标 URL）。**故意不广播给全部实例**：广播会让隐藏页留下陈旧位置，之后从二级页 `switchTab` 回 Tab 时（例如「查看课程表」按钮）会先闪一下再归位。
  - `syncActive` 先 `_takeHandoff(index)`（消费式、只有目标格相符的那一份取得到）：命中就**分两拍** —— 第一拍 `indCls:''` 无过渡画在起点格（`setData` 渲染回调 = 这一帧已落地），第二拍才挂 `stretch` 起拍，140ms 后 `settle` 回落到格位。若无交接（切失败回退 / 从二级页切回来）则只纠正状态、不播动画。
  - `popIndex`（点按弹跳）也挪到 `syncActive` 里置位 —— 原先置在离场实例上，等于没置。
  - `HANDOFF` 有**过期**语义（900ms）且 `switchTab fail` 时显式作废，否则下一次无关的 onShow 会从旧起点又滑一遍。
  - `app.js setTabBar`：**删掉「active 同值就跳过」守卫**，改为无条件委托 `syncActive`；去重职责下沉到组件内部（它自己判重，性能诉求不丢）。那守卫正是根因 ②。
- **影响面**：仅底栏装饰动画；不动业务逻辑、不动 switchTab 时序（内容切换仍不等动画）。
- **验证**：
  - `check-tabbar-liquid` 的行为自证**整体改写**：原来的自证跑「`onChange` 之后有 stretch」——**旧实现同样满足**，所以它抓不住这个 bug。现在跑完整链路「点击（离场实例不起拍）→ 落地页实例被预置到起点格 → 消费交接播三拍」，并新增**对照反证**（拿掉交接后新建实例必须落在终点格 116rpx ≠ 有交接时的 0rpx，证明断言能区分新旧行为）。
  - 5 组变异必被抓：① 回到旧的「离场实例起拍」② 去掉预置 ③ 两拍并一拍 ④ 交接不作废 ⑤ 交接不过期。全部命中预期断言。
  - `check-perf` 的同值跳过判据**同步改判**（原判据断言的是 bug 本身）：改为「setTabBar 无条件委托 syncActive」+「syncActive 自带判重」。旧写法变异必被抓。

### 2. 值日提醒：一天两条（21:00 预告 + 07:00 当天），都带课次与教室

- **需求**（用户原话）：「发布通知，成员收到通知后就收到微信提醒，应该是服务通知。第二天有值日的同学，会在前一天晚上 21 点和第二天早上 7 点都收到微信提醒，提醒第二天有你的值日，**具体课次和教室**。」
- **现状**：`cron-weekly` 只有一条 `remind`（每日 21:00，`remindTomorrow`），文案是「第2节大学英语」——**没有教室**；也没有当天早上的那条。
- **改动**：
  - `remindTomorrow(pool)` → **`remindDuty(pool, when)`**（`when: 'tomorrow' | 'today'`），两条提醒**同源**，只在「取哪一天」与「今天/明天」用词上不同。分开写两份必然漂移。
  - SQL 补 `c.room AS room`；「备注」格改为 **`第N节` + 教室**（保洁仍走「18点前打扫410」的既有口径），课程名移到模板的「课程名称」格。
    **为什么分格**：模板 17406 三个关键词都是 `thing` 类、**每格限 20 字符**，课次+教室+课名挤一格必然被 `cut20` 补省略号（学生看到「第2节大学英语(4…」）。分装后「第2节410、18点前打扫410」= 16 字仍在限内。
    教室为空时只写节次（不拿课程名去顶 —— 课名在另一格，重复没有意义）。
  - `exports.main` 新增 `trigger === 'remindAM'` 分支；触发器由 **4 个扩到 5 个**（`remindAM` = `0 0 7 * * * *`）。
  - 前端：`miniprogram/pages/mine/index.js` 的「微信提醒」行改口径（见 §3）；`data/legal.js` 隐私政策文案同步（并跑 `scripts/gen-legal-md.js` 重新生成 `docs/用户协议与隐私政策.md`）。
- **⚠️ 额度约束（必须让运营方知道）**：微信**一次性订阅**是「用户同意一次 = 服务端只能发一条」，**没有**「设置一次长期推送」。长期订阅只对政务/医疗/交通/金融/教育等类目开放，本小程序类目是「信息查询」，申请不到。因此**一天两条 = 每人每天消耗 2 条额度**，学生必须靠多攒（弹窗勾「总是保持以上选择」之后，后续调用不再弹窗、每次静默 +1 条）。这是本版把「已开启后点击 = 再攒一条」改回正轨的原因。
- **验证**：`check-clean-label` 新增 ⑥ 段 —— 静态审计（`remindDuty` 同源、`remindAM` 分支、SQL 取 room、部署手册登记 5 个触发器）+ **桩化 `require` 后真跑 `exports.main`**（21:00 取明天 / 07:00 取今天、一人一条合并、教室缺失兜底、43101 计入 refused、无值日不发、无模板安全跳过），另加 2 组变异必抓。

### 3. 「我的 → 微信提醒」：已开启后点击 = 再攒额度

- **问题**：旧实现在 `remindOn` 之后把这一行改成「测试提醒」，每点一次**消耗**一条额度 —— 一天两条的额度永远攒不起来（等于「当天早上那条」永远发不出去）。
- **改动**：已开启后主行点击改为 `subscribe.request()`（再攒 1 条）；「测试微信提醒」拆成**独立一行**（仅已开启时出现），因为它会消耗额度，不能挂在主点击上。
- **影响面**：「我的」页提醒卡片多一行（仅已开启后）。

### 4. 「额度耗尽」回环（remind_block：失效可见、可挽回）

- **需求**（用户补充指令原话）：「并且如果无长期通道提醒就在提醒功能失效后，**提醒用户再次打开通知**。」
- **背景**：一次性订阅拿不到长期通道（见 §2 的额度约束），额度用尽后 `subscribeMessage.send` 抛 43101 —— 旧实现只把它当「正常情况」静默计数，**学生完全无感知**，提醒从此一条都收不到。
- **改动**（闭环四段：写标记 → 回传 → 展示 → 清除）：
  - **写标记**（`cron-weekly/index.js` `remindDuty`）：发送循环收集 `okOpenids` / `refOpenids`（仅 43101 计入，其它错误码不动 —— 可能是模板/权限问题，不是学生的额度问题），循环后批量 `UPDATE member SET remind_block = 0/1 WHERE openid IN (...)`；返回体加 `blockSet` / `blockClear`。
  - **回传**：`duty.today` 与 `auth.login` 的 `member` 对象各补 `remindBlock`（前端两条读取通道）。
  - **展示**：首页悬浮胶囊三态（未开启 / **「微信提醒已失效，点此重新开启」橙色态** / 正常隐藏）；「我的」提醒行三态（**「额度已用完 · 点此重新开启」** / 已开启·攒额度 / 开启按钮）。
  - **清除**：`member.remindReopen` 新路由（只清自己的行，无越权面）—— 学生重新授权成功后前端调用；`utils/api.js` 登记 `remindReopen`。
- **配套**：`scripts/init.sql` 与 `scripts/migrate-remind-block.sql`（member 表加列 `remind_block TINYINT NOT NULL DEFAULT 0`；TDSQL 不支持 `ADD COLUMN IF NOT EXISTS`，重复执行报 1060 属预期）。
- **验证**（`check-clean-label` 额度回环段，2026-09-26 补齐运行时自证）：
  - 静态断言：cron 维护标记 / `member.remindReopen` 存在 / api 登记 / duty.today 与 auth.login 双读取通道 / 首页与我的两处 UI。
  - **运行时自证**：桩化 require 真跑 `exports.main`，校验发送后 `stmts` 里确有 `UPDATE member SET remind_block = 0/1` 且 **openid 集合精确**（成功只清成功者、43101 只标被拒者、单向不互染）。
  - 变异必抓：① 删掉「置 1」写入 → 运行时断言翻车；② member 源码摘掉 `remindReopen` → 静态断言不再命中（证明断言真的在读文件）。

### 5. 部署状态（2026-09-26 实测）

- **本轮范围**：① 底栏跨页指示器交接（纯前端 + 2 个门禁改判）② 值日双提醒（`cron-weekly` + 触发器 + 前端文案/入口）③ 额度耗尽回环。**未碰 `common/`** → 不需要 `sync-common.js`。
- **✅ 已完成（线上核验）**：
  - 迁移：`member.remind_block` 列已加（`SHOW COLUMNS` 复验通过）。
  - `updateFunctionCode`：`cron-weekly` / `duty` / `auth` / `member` / `media` 五个函数已部署（`isWaitInstall: true`，不动 env/VPC）。
  - 触发器：**5 个一次传齐**并 `listFunctionTriggers` 复验 —— `weekly 0 0 20 * * 0 *` / `daily 0 0 6 * * * *` / `hourly 0 0 * * * * *` / `remind 0 0 21 * * * *` / `remindAM 0 0 7 * * * *` 全部在线。
  - 实证：`invokeFunction(TriggerName:'remindAM')` → 路由 OK、东八区取「今天」、周六无人值日 receivers=0（零发送、零额度消耗），函数内 DB 连接正常。
  - **diff 门禁**：`tcb fn code download`（用法是 `tcb fn code download <name> <dest> -e <env>`，**没有 `--dir` 选项**）下载 5 个线上包与本地 diff —— **逐字节一致**。
- **前端**：待微信开发者工具重新编译上传（工作区无小程序上传私钥）。⚠️ 必须重新编译一次确认样式正常（本地跑不了 WCSS 编译器）。
- **待用户提供**：班级通知的服务通知需要**另一个模板**（「通知/公告」类）。`NOTICE_TEMPLATE_ID` 目前为空 → `media.pushNoticeMsg` 直接 `{skipped:'no template'}`，发布通知本身照常、只是不推微信。模板 ID 拿到后需同时填 `miniprogram/utils/config.js` 与云函数环境变量 `TEMPLATE_NOTICE`。
- 门禁：**33 个全绿**（含 `check-clean-label` 新额度回环段）。

---

## v0.7.14 · 2026-09-26

主题：全站动效统一（Apple 式单一节拍）+ 通知配图 + 悬浮液态玻璃底栏。

### 1. Tab 入场重做为「分块淡入 + 轻微上浮」（第 6 次迭代）

- **问题演进**（这段历史值得留着，避免再走回头路）：
  - ① 整页 opacity 0→1 每次 onShow 重播 → 反馈「切页面闪一下」
  - ② 改成只播一次、回访完全静止 → 反馈「直接展示太生硬」
  - ③ 内容分块依次上浮（错峰 / 位移都大）→ 反馈「错峰太碎」
  - ④ 单一整体节拍（整页 14px 上浮）→ 反馈「展开动画不好看」
  - ⑤ 极简 cross-fade（零位移）→ 反馈「看不见；点击首页应该有进入动画」
  - ⑥ **本版（用户明确选择）**：分块淡入 + 轻微上浮 —— 单块 180ms / 8px / 块间 20ms（回访 140ms / 5px / 14ms），延迟封顶第 4 块，整段 240ms。
- **改动**：
  - `app.wxss`：`paInFull / paInLiteA / paInLiteB` 关键帧改为 `opacity 0→1` + `translateY(8px/5px→0)`；`paReduce` 保持零位移。错峰用 **wxml 档位类**（`st-1`~`st-4`，第 4 块起封顶），CSS 侧写成 `.pa-first .st-item.st-N { animation-delay: … }`。
    - ⚠️ 最初实现用的是 CSS 通用兄弟选择器 `.st-item ~ .st-item`（想省掉手工维护档位号），**结果真机编译 fatal**，见 §6。**WXSS 不支持 `~`**，不要再走这条路。
    - 档位选择器必须绑 `.st-item`（权重 0-3-0 > 基档 0-2-0）：`animation` 简写会重置 `animation-delay`，只写 `.st-N`（同权重）时一旦顺序写反就静默失效。
  - `utils/page-anim.js`：恢复 `FULL_Y=8 / LITE_Y=5`，新增 `ST_STEP_MS=20 / LITE_STEP_MS=14 / ST_CAP=4 / FULL_TOTAL_MS=240 / LITE_TOTAL_MS=182`。
  - 四个 Tab 页 wxml：给入场块标 `st-1`~`st-4`（值日页 5 块 → 末块与倒数第二块共用 `st-4`）。**增删块后必须重排档位号**，由门禁校验。
  - `scripts/check-tab-enter.js`：**整文件重写**（见 §6）。
- **两条硬约束**（都写进代码注释 + 门禁）：
  - **`.st-item` 必须互为兄弟**：错峰靠兄弟选择器，一旦有人把一个 `.st-item` 套进另一个里，两层位移会叠成 16px。
  - ⚠️ **`translateY` 会创建包含块 → `fixed` 元素绝不能待在 `.st-item` 内部**。纯 opacity 时代这只是「约定」，现在它是**硬正确性要求**：动画那 180ms 内该元素会改用本块做定位基准而飞走，且肉眼很难发现（只错 180ms）。
- **影响面**：仅入场动画观感；不动业务逻辑。
- **验证**：`check-tab-enter` 全绿；32 门禁全绿。

### 2. 下方 Tab 栏：悬浮式液态玻璃胶囊（六轮：重做 → 收窄 → 观感修复 → 贴边铺满 → 收窄到 500rpx → **整体缩小一号 464rpx**）

- **反馈演进**：
  - 第 1 轮 —— 用户截图指出 tab 栏仍像传统下划线（胶囊 .08、高 64rpx）。做法：胶囊提到 .12、高 48rpx / 圆角 24rpx。
  - 第 2 轮 —— 「**底部栏依旧问题很大，完全重新制作**」，要求悬浮式底栏 + 液态玻璃（参照 `pidanai.com` 顶部导航）。
  - 第 3 轮 —— 截图指出**三处独立缺陷**：① 指示器位置不对；② 底栏整体太宽，要收窄；③ 「蓝色遮罩」比底栏矮、上方露白。
  - 第 4 轮 —— 截图圈出**两侧缝隙**，要求「两边不要留白」。
  - 第 5 轮 —— 「**理解错我的意思了**，底栏整体宽度收缩（圈出红框）；蓝色遮罩边缘和底栏边缘不要有留白，尤其是左边「首页」和右边「我的」」+「底栏应该是液态玻璃，透明的」。
  - 第 6 轮（本版）—— 「**整体都小一点，左右上下，内部图标文字都小一点**」（用户对「胶囊宽度」那条待定项的裁决，见 §9/§10）。
- **⚠️ 第 4 轮那次是我读错了指令**：第 4 轮的「两边不要留白」**不是**「胶囊贴屏幕边」，而是「指示器与胶囊边缘之间的缝」。我当成前者 → 把左右内缩归 0 铺满，反而把胶囊弄宽了。
  - 第 5 轮的「底栏整体宽度收缩」正是对这次误读的纠正。
  - 教训：**「不要留白」要先问清是哪两个东西之间**（外层 vs 屏幕、内层 vs 外层）。两个物体的边缘都可以叫「边」，指令里没主语时不能猜。
- **实测取代目测**（本轮的判定依据，不靠眼睛估）：两张截图都是 485/499×… 的同款设备，**屏宽 ≈403px ↔ 750rpx**（1px ≈ 1.86rpx）。用纯标准库解 PNG 量出：
  - 图1 红框 x 118→387 = **270px ≈ 502rpx**，左右内缩各 ≈128 / 126rpx，红框水平居中 → 用户所指的胶囊宽 ≈ **500rpx**；
  - 图1 当前胶囊 x 49→455 = 满屏 750rpx（印证第 4 轮的铺满），高 ≈54px ≈ 104rpx（印证 104rpx）；
  - 图2 指示器 ≈80px ≈ 149rpx，其左缘离胶囊左缘 ≈14px ≈ **26rpx** —— 这就是第 4 轮那句「不要留白」真正指的缝。
- **改动（`custom-tab-bar/index.wxss` + `index.js`）**：
  - `.tabbar`：`margin: 0 0 8rpx` → **`margin: 0 125rpx 8rpx`**（胶囊内容宽 **500rpx**）。
  - `index.js`：`SIDE_RPX 0 → 125`；`BAR_W_RPX = 750 − 2×125 = 500`；`CELL_RPX = 125`；**`NORM_W_RPX = CELL_RPX`（125rpx，满格）**；删掉 `STRETCH_W_RPX`，新增 **`OVER_RPX = 14`**。
  - **指示器几何口径变了**：`normLeft(i) = i × CELL_RPX`（不再做格内居中）→ 首格 `left = 0` 贴胶囊左缘、末格 `right = 500` 贴胶囊右缘，**两侧零留白**。
  - **液态手感换实现**：原来靠「width 140 → 162 拉长再收拢」，现在 width 恒为整格，改为 **left 预冲**：`stretchLeft(i, from) = i×CELL ± OVER_RPX`（朝移动方向先越过目标 14rpx，settle 拍回落到格位）。首/末格朝外预冲会被胶囊 `overflow: hidden` 沿圆弧裁掉 —— 观感即「贴着边缘流动」，不会露白。
  - **玻璃改成真的半透明**：`rgba(255,255,255,.72)` → **`.5`**，`blur(20px)` → **`blur(30px)`**；`@supports not` 降级 `.94` → **`.82`**（.94 在浅色页面上和纯白栏无从区分，用户反馈的「不像玻璃」有一半来自这里）。
    - 另一半原因是**结构性的**：各 Tab 页都给底栏留了空白（`.foot-space` 168 / `.dt-foot` 240 / `.mn-foot` 180），**没有任何内容会从底栏下面经过** —— 没有背景可模糊时，玻璃再透明也只看得到页面底色。见 §9 待定项。
- **影响面**：底栏视觉与横向内缩、指示器几何与手感；切换逻辑与状态同步不变；底栏总占位仍是 112rpx（6 处让位值无需再改）。
- **验证**：`check-tabbar-liquid` 全绿，其中**几何自证整段重写**：`SIDE_RPX` JS/CSS 双向绑定（125 = 125）、常态宽 = 整格宽、`normLeft` 无居中偏移、**零留白硬断言**（首格 `left` 必须 = 0、末格右缘必须 = 胶囊右缘 500）、预冲幅度 16 组起拍/目标组合恒 = 14rpx、回归保护（内缩算错 125→0 时末格右缘偏 250rpx 能被抓住）。32 门禁全绿。

- **三个根因（各自独立，别混为一谈）**：
  - **① 指示器位置不对 → JS 几何算错**：指示器 `left/width` 按 `750/4 = 187.5rpx` 算格子，但胶囊当时有左右外边距、**内容宽只有 670rpx**；整条右偏，末格「我的」顶到胶囊右缘（偏 84rpx）。→ 改为 `BAR_W_RPX = 750 - SIDE_RPX*2` 四等分，并把 `SIDE_RPX` 与 wxss `margin` **双向绑定**（门禁比对）。⚠️ 第 4 轮 `SIDE_RPX` 归 0 后公式不变，`BAR_W_RPX` 自然回到 750rpx —— 这正是「不把 40 写死」的价值。
  - **② 上方有空白 → `.tab-item` 的 `padding-top: 16rpx`**：内容实高 86rpx 挤在 104rpx 里，被下压后文字贴底、上方空 16rpx。→ 改 `justify-content: center`（上下各 9rpx 均分），**不许再出现 `padding-top`**（门禁断言）。
  - **③ 蓝色遮罩比底栏矮 → 指示器写死高度**：`.tab-ind { top: 8rpx; height: 88rpx }`。→ 改 `top: 0; bottom: 0` **等高铺满**，圆角同步 52rpx；**不许写死 `height`**（门禁断言）。
- **改动（`custom-tab-bar/index.wxss` + `index.js`）**：
  - `.tabbar`：`margin: 0 24rpx 8rpx` → `0 40rpx 8rpx`（第 3 轮）→ **`0 0 8rpx`（第 4 轮，贴边铺满）**；`height 104rpx` / `border-radius 52rpx` / `overflow: hidden` 不变；玻璃三件套不变（`rgba(255,255,255,.72)` + `backdrop-filter: blur(20px) saturate(180%)` 带 `-webkit-` + 亮边高光 + `0 8rpx 28rpx rgba(29,33,41,.12)`）。
  - `.tab-ind`：`top: 0; bottom: 0; border-radius: 52rpx`（不写 height）。
  - `.tab-item`：`justify-content: center`（去 `padding-top`）。
  - `index.js`：第 3 轮 `SIDE_RPX=40 / BAR_W_RPX=670 / CELL_RPX=167.5`，第 4 轮改为 **`SIDE_RPX=0 / BAR_W_RPX=750 / CELL_RPX=187.5`**；`NORM_W_RPX=140 / STRETCH_W_RPX=162` 不变。
- **几何自证（写进注释 + 门禁）**：
  - **胶囊高 104rpx 不是随手取的**：`.tab-item` 实高 = `padding-top 16 + icon 48 + text margin 8 + line-height 30 = 102rpx`；加 `overflow: hidden` 后若沿用 96rpx 会**裁掉最后一行文字 6rpx**，故取 104rpx。
  - 底栏总占位 = `104 + 8 = 112rpx`（原 100rpx，**+12rpx**）。各页底部留白仍够：首页 `.foot-space` 168 / 值日 `.dt-foot` 240 / 我的 `.mn-foot` 180。
- **连带让位值同步（+12rpx 口径，全仓排查过）**：
  - `pages/home/index.wxss` `.remind-fab` `bottom 124→136rpx`
  - `pages/timetable/index.wxss` `.fab` `140→152rpx`、`.fab-shift` `146→158rpx`
  - `components/duty-sheet/index.wxss` `.ds-foot` `padding-bottom 116→128rpx`
  - `pages/timetable/index.js` `_fitHeight()` 的 `reserve 208→220`
  - `app.js` `sheetMetrics().tabbarPx` 换算 `100→112rpx`；`components/bottom-sheet/index.js` 兜底默认 `50→56px`
- **影响面**：底栏视觉与横向内缩、底部留白、弹层让位；切换逻辑与状态同步不变。
- **验证**：`check-tabbar-liquid`（含「不许写死 height」「不许 padding-top」「JS `SIDE_RPX` 与 CSS `margin` 绑定一致」及回归保护「内缩量算错时末格偏心 70rpx 会被抓住」）全绿；`check-wxss` / `check-wxml` 全绿；32 门禁全绿。
  - ⚠️ 回归保护第 4 轮改过写法：`SIDE_RPX=0` 时「按 750/4 算」恰好是正确算法，不能再拿它当坏样本；改为「换一个错的内缩值」构造偏差，两种取值下都验得出校验有效。

### 3. 通知配图（截图② Shared-element Image Expansion）
- **需求**：发布通知可附最多 3 张图，详情查看走「缩略图 → 全屏」连续放大。
- **改动**：
  - 后端 `cloudfunctions/media/index.js`：`normalizeNoticeImages` / `parseNoticeImages`（数组↔JSON，fileID 白名单校验，超量报错）；`msgPublish` 写入 `images`、`msgList`/`msgRecycleList` 回显。
  - `scripts/init.sql`：`notice_msg` 加 `images JSON`；`scope` 枚举补 `POSITION`。
  - 生产库 `ALTER TABLE notice_msg ADD COLUMN images JSON AFTER content` + `MODIFY scope ENUM(...,'POSITION')`（已回查确认）。
  - 前端：发布表单加配图区（最多 3 张，`chooseMedia compressed` 后 `request.uploadFile` 直传云存储）；详情页缩略图行 + `nt-viewer` 全屏查看器（分两拍 setData：先贴缩略图位置、下一帧给目标值起过渡；关闭反向缩回，`page-meta` 锁滚动）。
  - `utils/notice.js` `toItems` 兜底 `images:[]`；`pages/notice/index.wxss` 新增 `.nt-imgs/.nt-img/.nt-viewer/.nt-vimg...` 并补 reduced-motion。
  - 回收站列表改**卡片式**（用户反馈）：每条只显示标题 + **单行**内容（`.rc-content` 单行省略号），移除发布人 / 时间等冗余信息，"恢复"按钮常驻右侧（`.rc-item` 改 flex 横排）。
- **影响面**：通知表新增列（已迁移）；发布/查看交互。
- **验证**：`check-wxss`/`check-wxml` 全绿；生产库 `SHOW COLUMNS` 确认。
- ⚠️ **「通知页看不到图片」（用户反馈 3 次）的真实根因：fileID 白名单正则不含点号**
  - **曾经的错误归因（已推翻，留作教训）**：一度判断为「线上 `media` 还是 v0.7.13、`INSERT` 不含 `images` 列」。但时间线不支持——04:22:46 发布的那条通知是在 04:18:47 部署**之后**产生的，`images` 依然是 `null`；说明写入路径已在跑，问题在**写入前就被丢弃**。
  - **真实根因**：白名单写成 `/^cloud:\/\/[\w-]+\/\S+$/`，而真实 fileID 的 host 段形如
    `<YOUR_ENV_ID>.636c-<YOUR_ENV_ID>-1306168169`（**中间带点号**）。
    `[\w-]` 不含 `.` → 正则整体不匹配 → `normalizeNoticeImages` 里 `.filter(s => FILEID_RE.test(s))` **把每一张合法图片都静默丢掉** → `images` 存 `NULL`。
    表现极具误导性：**发布时不报错、上传也成功（云存储里文件确实在），只是查看时一张图都没有**。
  - **修复**：`FILEID_RE = /^cloud:\/\/[^\s/]+\/\S+$/`（只要求 `cloud://` 协议 + host 不含空白与斜杠 + 至少一段路径）。
  - **实证链（三方互证）**：
    1. `queryStorage(action=list, cloudPath=notice/)` → 3 个文件确实存在（03:57:52 ×2、04:22:45 ×1）→ 排除前端上传环节；
    2. `SELECT id,images FROM notice_msg` → 全表 17 条 `images` 均为 `null`（含 04:22:46 那条）→ 锁定后端写入环节；
    3. 用**从线上包抽出的正则**跑这 3 个**真实 fileID 原文**：旧写法 3/3 丢弃（`\"旧正则把 3 张真实图全丢 = 是\"`）、新写法 3/3 保留，且外链 / 注入串 0/4 放行 → 确认修复生效。
  - **补门禁**：`check-notice-v2.js` 新增 **R7 段**（R6 已被「标题选填」占用）。从 `media/index.js` 抽 `NOTICE_MAX_IMAGES` / `FILEID_RE` / 两个函数体，用 `new Function` 离线跑 11 项断言：真实 fileID 保留、外链丢弃、`null`/`[]` → `null`、>3 张报错、`parseNoticeImages` 回环、`INSERT` 带 `images`、`msgList`/`msgRecycleList` 的 `SELECT` 回显 `n.images`；并含**「旧正则必须被判定为会丢掉真实图」的反向自证**（防止有人把正则改回去还全绿）。
    - 该 bug 之所以逃过此前 32 道门禁：`check-notice-v2` 当时**完全没有覆盖 `normalizeNoticeImages`**——这是本轮最重要的门禁缺口。
    - 顺带修掉门禁自身缺陷：原抽取函数体用的花括号配平正则会**假阴性**，改用 `blockAfter(key, len)`（关键词起 + 固定长度窗口）。
  - **已于本会话部署并核验**：`updateFunctionCode(functionName=media, functionRootPath=cloudfunctions, isWaitInstall=true)` → 线上 `index.js`/`common/*`/`config.json` 与本地**逐字节一致**（`tcb fn code download` + `diff` 无输出）。env 9 项（`AUDIO_MAX_MS/DB_*/MEDIA_AUDIT/TEMPLATE_REMIND/WX_APPID`）与 VPC `vpc-c4ga6fms/subnet-a5mkrg1l` 未被改动（`tcb fn detail` 核对 `Network configuration` 原文），`Triggers=None`，状态 `Deployment completed`。冷启动调用（`invokeFunction(action=msgList)`）返回 `40001`（MCP 调用无微信用户上下文，属预期），模块图与路由正常。
  - **生产库已确认**：`notice_msg.images` = `json` 且可空；`scope` = `enum('ALL','PICK','COMMITTEE','POSITION')`。
  - **仍需的人工动作**：库内现存 17 条通知 `images` 全为 `null`——代码**不会回填历史数据**。需**重新发布一次带图通知**做端到端确认；旧通知的图不会自动出现。
  - **链路其余三段均已复核无误**（所以改动只需落在正则这一处）：前端 `chooseMedia` → `tempFilePath` → `request.uploadFile()`（返回 `wx.cloud.uploadFile().fileID`）→ `api.msgPublish({images})`；后端 `normalizeNoticeImages` → `JSON.stringify` → `INSERT`；`SELECT n.images` → `parseNoticeImages`（字符串/已解析数组/`NULL` 三种都兜住）→ 前端；前端 `wx:if="{{item.images.length}}"` + `<image src="{{fileID}}">`（基础库 2.2.3+ 原生支持云文件 ID，无需换临时链接）。

### 4. 新页转场（截图③ 精神）+ 按下反馈
- **改动**：二级页根 `<view class="page ...">` 加 `page-fade`（纯 opacity 淡入，不给 `fixed` 后代建包含块 → nav-bar/回收站/查看器/bottom-sheet 全部安全）；`.np-btn:active` 加 `scale(.975)` + transition；`.ap-btn:active` 加 `scale(.95)`；`.mb-row` 加 `hover-class=tap-hover` + `fade-item`（复用原语）；`.ab-row` 加 `tap-hover`；`goRoster` 补 `press-dim`。
- **影响面**：纯视觉反馈；无业务逻辑改动。
- **验证**：`check-wxss`/`check-wxml` 全绿。

### 5. find-animation-opportunities 审计（先报告再实施）
- 产出 `docs/animation-audit-v0.7.14.md`：四闸过滤后落地 4 条（发布按钮按压 / 名单全页 hover / 名单筛选淡入 / 我的页申请按钮与关于行反馈），另记录被否掉的候选。
- 全部通过四闸并已实施（见 §4）。

### 6. 门禁：`check-tab-enter` 整文件重写（并修掉它自己的 bug）

这一版入场动画比以往都危险，因为位移**又加回来了**（第 ⑤ 版刚把位移删掉）。所以门禁从「断言零位移」**反向**改成「断言位移存在但必须轻微、且只能是 Y 轴」。

- **新增 wxml 结构审计** `auditStructure(wxml, fixedSet)`：栈式扫描标签，`<block>` 视为虚拟节点不入栈（页面里大量 `<block wx:if>` 包内容块）。逐页断言：
  - `nested` —— 所有 `.st-item` 必须互为兄弟；
  - `onFixed` —— `.st-item` 不得落在 `fixed` 元素上；
  - ⚠️ `fixedInside` —— **`fixed` 元素不得待在 `.st-item` 内**（`translateY` 建包含块 → 动画期间会飞走，且只错 180ms，肉眼难查）。
  - `fixed` 类名**从 wxss 动态提取**（不写死清单），再扫 wxml 嵌套关系。
- **反向位移锁**：入场 keyframes 出现 `translateX / translate3d / scale / rotate / skew / matrix` 任一即失败；JS 与 CSS 的位移值（8px / 5px）、单块时长（180 / 140ms）**双向比对**。
- **档位序列校验** `tierSeq()` / `wantTier()`：逐页按文档顺序读出所有 `.st-item` 的档位号，断言序列 **必须等于 `1,2,3,4,4,4…`**（第 N 块 = `st-N`、从 `st-1` 起连续不跳号、封顶 `st-4`）。配套 `tierDelays()` 校验 CSS 侧延迟严格等于 `step×(n-1)`（20/40/60ms 与 14/28/42ms）且不得出现 `st-5` 及更高档（否则长页面尾巴越拉越长 = 又变回「错峰太碎」）。
- **⚠️ app.wxss 不得出现 `~` 选择器**：真机编译 fatal，见 §7。
- **reduced-motion 专项**：档位规则的权重（0-3-0）高于基档（0-2-0），不会被 `animation` 简写重置，因此必须**显式清零档位延迟**。
- **⚠️ 修掉门禁自身的 bug（首跑即误报 4 项）**：属性段正则 `(?:"[^"]*"|'[^']*'|[^>"'])*` 是贪婪的，`[^>"']` 连 `/` 一起吃，于是 `<app-icon ... />` 这种自闭合标签被判成**开标签**入栈 → 栈白涨一层 → 后面所有元素都被误判成「待在更深的容器里」→ `fixedInside` 集体假阳性（课表 `.fab-shift` / `.fab`、值日 `.off-canvas` 全被误报成「在 `.st-item` 内」）。
  - 修法：属性段排除裸 `/` → `((?:"[^"]*"|'[^']*'|[^>"'/])*)\s*(\/?)>`。属性值里的 `/`（`src="/a.png"`、`{{a / b}}`）都在引号内，由前两个分支整段吃掉，不受影响。
  - **防复发**：新增 `selfCloseMismatch` 字段（源码以 `/>` 收尾却不判自闭合即记录），主流程逐页硬断言为 0，并补两条自证（自闭合组件样本不误报、属性值内 `/` 不影响解析）。
- **其余自证**：`fixed` 带 `.st-item` 的坏样本必须被抓、普通内容块不得误报、**档位跳号（`st-1 → st-3`）必须被抓**、**完全未标档位必须被抓（记为 0 ≠ 期望的 st-1）**、封顶样本不得误报、嵌套样本必须被抓、`fixed`-inside 样本必须被抓、平级样本不误报。
- **范围约束**：二级页一律不得加 `.st-item`（navigateTo 自带系统转场）。
- 顺带修掉一个既有断言的精度问题：`pa-lite-b` 的「基档不得带 animation-delay」原先用单次 `exec`，会先命中 will-change 规则（该规则的选择器列表恰好以 `.pa-lite-b .st-item {` 结尾）→ **检查错对象**，只是恰好也通过。已改为「取含 `animation:` 的那条规则」。

### 7. ⚠️ 事故复盘：WXSS 编译失败 → 全站样式丢失

**本版最严重的一次问题，因此单独成节。**

- **现象**：微信开发者工具报
  `[ WXSS 文件编译错误] ./app.wxss(248:31): unexpected token ~`
  —— 是**整个 app.wxss 编译失败**，不是只有那一条规则失效，而是**全站样式全丢**。
- **根因**：§1 最初为了「不用手工维护档位号」，把入场错峰写成 CSS **通用兄弟选择器**
  `.pa-first .st-item ~ .st-item { animation-delay: 20ms; }`，并逐级堆到三层 `~~~`。
  **WXSS 不支持 `~`**。
  - 线索：报错的第 31 列正好是**第二个 `~`**（上一行的单个 `~` 没报错）。这里没有去赌「单 `~` 是否可用」——直接换方案。
- **为什么骗过了门禁（最值得记的一条）**：当时 **32 个离线门禁全绿**。它们只做**文本检查**（正则扫源码），**跑不了真正的 WCSS 编译器**。
  → **「门禁绿」≠「能编译」。** 凡是依赖「运行时 / 编译器行为」的写法，门禁必须**显式断言该写法本身合法**，而不能只断言它的文本形状。
- **修复**：改为 **wxml 档位类** `st-1`~`st-4`（见 §1）。选择依据：
  - WXSS 官方支持的选择器只有 类 / ID / 元素 / 群组 / `::after` / `::before`，`~` 不在其列；
  - 档位类**静态可校验**（门禁能断言「第 N 块 = `st-N`」），比赌选择器行为可靠；
  - 代价：增删块要手工重排档位号、`wx:if` 为假时序号会跳一格（已写进 wxml 注释 + 门禁守）。
  - 注：`+`（相邻兄弟）**项目里大量在用且线上长期正常**（doc / poster / roster / home / mine / classes / timetable 共 7 处），故**只拦 `~`**，避免大面积假阳性。
- **门禁加固（放回正确的归属）**：`check-wxss.js` 新增「WXSS 选择器合法性」段 —— 全量扫描 27 个 wxss，**禁止通用兄弟选择器 `~`**。
  - 四条双向自证：`~` 必须被抓 / `+` 不得误报 / 属性选择器 `~=` 不得误报 / **跨行注释里的 `~` 不算数**（注释先整块替换为等长空白，行号仍准确）。
  - 顺带把 `timetable/index.wxss` 注释里两处「周一 ~ 周五」改为「周一至周五」：注释里的 `~` 理论上安全，但代价是「全站样式丢失」，不值得赌。
- **教训（写给下一次）**：
  1. 动 CSS 选择器之前，先确认它在 **WXSS** 里合法 —— **「标准 CSS 合法」不等于「WXSS 合法」**；
  2. 无法在本地真跑 WCSS 时，任何「编译器行为相关」的写法都必须有一条门禁**显式守着**；
  3. 门禁报错时先质疑门禁（本轮 `check-tab-enter` 自身的自闭合 bug 就是这么抓到的），但**门禁全绿时也不能当作没问题** —— 要追问它**覆盖到哪一层**。

### 8. 辅导员入场路径：现状与缺口（本轮**只调研、未改代码**）

- **问题**（用户提出）：辅导员没有班级、没有学号，怎么进入这个小程序？
- **现状（线上库 + 代码双向核实）**：
  - 辅导员身份 = `member.group_tag = 'X'`（`guard.isCounselor`）。
  - **全库只有 1 条 X 记录**：`id=72 示例成员57 / student_no=000000000090 / class_id=1 / role=ADMIN / position=辅导员 / status=LEAVE / openid 为空（从未绑定）`。
  - **三条已知入口全部堵死**：
    1. **绑定名单里看不到他**：绑定页走 `member.list(public='roster')`，SQL 尾部固定拼 `NOT_TEST`（`student_no NOT LIKE '0000000000%'`）→ id=72 被过滤，名单里根本没有这个人可选。
    2. **没有任何创建入口**：`member.addMember` 必须填学号且按学号奇偶自动定 A/B 组；`member.updateGroup` 只接受 `['A','B']`。**前后端都没有能把人设成 X 组的路径** —— 现有那条是手工 SQL 插的。
    3. **绑定校验要求「学号后 4 位」**（`auth.bind` 比对 `student_no` 末 4 位）—— 这套验证对没有学号的教职工不成立。
  - 另有一处模型矛盾：`member.class_id` 是 NOT NULL，而辅导员要管**所有**班级，却被强制挂在某一个班里。
- **未改动任何代码**：本轮只做定位与取证，避免在方案未定前先动 `auth`/`member` 两个已上线的云函数。

### 9. 上一轮 4 个分叉的裁决与落地

| 分叉 | 用户裁决 | 落地 |
|---|---|---|
| ① 胶囊宽度 | **「整体都小一点，左右上下，内部图标文字都小一点」** | 500 → **464rpx**（左右内缩 125 → 143rpx），高 104 → 92rpx、圆角 52 → 46rpx、图标 48 → 42rpx、文字 22 → 20rpx、总占位 112 → **98rpx**（详见 §10） |
| ② 指示器手感 | **left 预冲 14rpx + 回弹**（维持上一轮实现） | 不变，`OVER_RPX = 14` 保留；只把指示器圆角随胶囊 52 → 46rpx |
| ③ 玻璃可见性 | **维持现状（不挡内容）** | 不改各页底部留白；「玻璃不像玻璃」的结构性原因（§2 末）留档，后续再议 |
| ④ 辅导员入场 | **教职工一次性绑定码** | 已全链路实施并部署（详见 §11） |

### 10. 底栏整体缩小一号（第六轮）

- **需求原话**：「整体都小一点，左右上下，内部图标文字都小一点」。
- **实测算表**（沿用第 5 轮量出的「屏宽 403px ↔ 750rpx」基准，同一比例整体缩一号）：

  | 量 | 第 5 轮 | 第 6 轮 |
  |---|---|---|
  | 胶囊横向内缩 `SIDE_RPX` | 125 | **143**（须奇数） |
  | 内容宽 `BAR_W_RPX` | 500 | **464** |
  | 单格宽 `CELL_RPX` | 125 | **116** |
  | 胶囊高 | 104rpx | **92rpx** |
  | 胶囊圆角 / 指示器圆角 | 52rpx | **46rpx** |
  | 图标框 / 图标 | 48rpx | **42rpx** |
  | 文字 `margin-top` / `font-size` / `line-height` | 8 / 22 / 30rpx | **7 / 20 / 26rpx** |
  | 红点 `width` / `right` / `radius` | 16 / −6 / 8rpx | **14 / −5 / 7rpx** |
  | **底栏总占位** | 112rpx | **98rpx** |

- ⚠️ **内缩量为什么必须取奇数**：指示器常态宽 = 整格宽 = `(750 − 2S) / 4`，要求它**是整数**（否则指示器与胶囊边缘对不齐、零留白断言必失败）。`750 ≡ 2 (mod 4)`，故须 `2S ≡ 2 (mod 4)`，即 **S 必须为奇数**。取 143 → (750−286)/4 = **116 ✓**；若取 142 → 466/4 = **116.5 ✗**。已写成门禁硬断言（并附「格宽必须为整数」的自证）。
- **胶囊高 92rpx 的来历**：`.tab-item` 实高 = `icon 42 + text margin 7 + line-height 26 = 75rpx`，`justify-content:center` 上下均分 → 92rpx 留足余量；`overflow:hidden` 不会裁掉文字。
- **6 处让位值联动（统一 −14rpx）**：

  | 位置 | 第 5 轮 | 第 6 轮 |
  |---|---|---|
  | `pages/home/index.wxss` `.remind-fab` bottom | 136rpx | **122rpx** |
  | `pages/timetable/index.wxss` `.fab` | 152rpx | **138rpx** |
  | 同页 `.fab-shift` | 158rpx | **144rpx** |
  | `components/duty-sheet/index.wxss` `.ds-foot` padding-bottom | 128rpx | **114rpx** |
  | `pages/timetable/index.js` `_fitHeight()` `reserve` | 220 | **206**（= 占位 98 + 108） |
  | `app.js` `sheetMetrics().tabbarPx` | 112 | **98** |
  | `components/bottom-sheet/index.js` 兜底 | 56px | **49px** |

- **门禁升级（`check-tabbar-liquid`）**：
  - 圆角断言 `52rpx → 46rpx`；重拍窗口 `130ms → 140ms`；README 注释 `0.13 → 0.14`；
  - **新增第 ④ 段「底栏占位联动」**：从 wxss 解析出胶囊占位（`height` + `margin-bottom`）= 98rpx，再逐条校验上表 4 处 wxss 偏移量（`+24 / +40 / +46 / +16`）与 2 处 js（`reserve = 占位 + 108`、`tabbarPx` 基准），并新增「格宽为整数」自证。
  - 这条门禁的价值：底栏占位是个**跨 6 个文件的隐式契约**，以前全靠人肉 grep，现在改一处漏改另一处会直接失败。
- **影响面**：纯视觉 + 底部让位；底栏切换逻辑、指示器几何算法、JS/CSS 双向绑定机制都不变（内缩值只改了常量）。

### 11. 教职工（辅导员 / 老师）一次性绑定码（全链路）

- **问题**（承 §8）：辅导员既没有班级也没有学号，原有「班级口令 → 从名单选人 → 填学号后 4 位」三步绑定对他完全不成立；且前后端**都没有创建教职工记录的入口**。
- **方案取舍**（三条候选见上一轮 §9，用户选定 ①）：
  - ① **教职工一次性绑定码** ✅ —— 超管/辅导员建号并生成码，教职工在绑定页专属入口输入；改动集中在 `auth` + `member`，**不把教职工暴露在名单里**。
  - ② 放行 X 组进绑定名单 —— 改动最小，但**教职工名单对任何拿到班级口令的人可见**，且仍需手工 SQL 建号，放弃。
  - ③ 只补创建入口 —— 绑定仍走手工 SQL，管理员不可自助，放弃。
- **数据库**：`scripts/migrate-staff-code.sql` —— `member` 加 `staff_code VARCHAR(16) NULL` + `staff_code_expire DATETIME NULL`。⚠️ **TDSQL 不支持 `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`**（报 1064），脚本里注明并改用普通 `ALTER`。
- **后端 `member`**：
  - 顶部新增常量与 helper：`STAFF_CODE_CHARS`（`ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，**剔除 I/O/0/1**）/ `STAFF_CODE_LEN = 8` / `STAFF_CODE_HOURS = 48` / `STAFF_NO_PREFIX = 'STAFF'` / `genRand` / `genUniqueStaffCode`（撞库重试）/ `genUniqueStaffNo`（占位学号）。
  - 新增 **`addStaff`**（`auth:{needAdmin:true}` + `requireSuperOrCounselor`）：`INSERT` `group_tag='X'`、`role='ADMIN'`、`staff_code`、`staff_code_expire = DATE_ADD(NOW(), INTERVAL 48 HOUR)`；**返回体是唯一一次**明文带 `staffCode`。
  - 新增 **`staffCode`**（重发）：限 `group_tag==='X'` 且未绑定；旧码直接覆盖。
  - 新增 **`staffList`**（超管/辅导员）：只回 `hasCode` / `codeExpire`，**绝不回码本身**（越权面收敛）。
  - **4 处 SQL 加 `AND group_tag <> 'X'`**：`loadSeqPrefix`（⭐关键）、roster 分支、非 manage 分支、`stats` 的 `COUNT(*)`。
    - ⭐ **`loadSeqPrefix` 是本次顺带修掉的潜在回归**：它按「全班学号同前缀」推断序号名册的补全前缀，教职工占位学号 `STAFF…` 会把 `pfx` / `lens` 顶成 2 种 → 整班判为「前缀不可推导」→ **补学号静默失效**（不报错、不提示）。原先全仓无门禁守这条，已由 `check-staff-bind` 补上。
- **后端 `auth`**：
  - 新增 **`bindStaff`**（`auth: null`，未登录可调 —— 绑定本来就是未登录态动作）。
  - 校验顺序：格式 `/^[A-Z0-9]{6,16}$/` → 查码 → 过期 → 已被他人占用 → `status === 'DISABLED'` → **当前微信已绑别的身份**（先查再给可读的 40006，避免撞 UNIQUE 报错）→ 绑定 + **同一条 UPDATE 里一次性作废**（`staff_code = NULL, staff_code_expire = NULL`）。
  - ⚠️ **两个「故意不做」**：**不调 `assertGlobalOk`**（全局熔断会顺手关掉所有班级的绑定入口，教职工这条也不该被连坐）；**不检查 `bind_open`**（那是班级绑定开关，教职工码另有 48h + 一次性 + 失败计数的门）。
  - 仍走 `assertNotLocked` + 失败计数（防爆破与班级绑定同源）。
- **前端**：
  - `pages/bind`：新增 `staffMode` 开关 —— step 0 用 `wx:if="{{!staffMode}}"` 包住学生路径（口令 → 选人 → 学号后 4 位），`wx:else` 走教职工码输入；底部新增 `.bind-switch`「我是老师 / 辅导员」。`onStaffInput` 做 `replace(/[^0-9A-Za-z]/g,'').toUpperCase().slice(0,8)` 清洗；提交同样要求勾选隐私协议；被锁定返回 40005 时置 `locked:true`。
  - `pages/classes`：卡片新增**单独一行**的「教职工（辅导员 / 老师）」按钮（不与已有 3 键同排 —— 「邀请码 / 入班码」1/4 宽会折行），新增 `bottom-sheet` 面板（列出教职工、发/重发码、复制）；`page-meta` 的锁滚动表达式同步加 `|| staffShow`。
  - WXML 不能调方法 → 过期时间文案由 `_expireText` 预先算成 `codeExpireText`。
  - `utils/api.js` 新增 `bindStaff` / `addStaff` / `staffCode` / `staffList`。
- **门禁 `scripts/check-staff-bind.js`（第 33 个）三段**：
  1. **真实源码审计**（约 28 条断言）：码字符集、长度、48h、一次性作废、`staffList` 不回码、`bindStaff` 不调 `assertGlobalOk`、4 处 `AND group_tag <> 'X'`、占位学号前缀、前端入口与 api 映射等；核心断言做成可重放的 `audit()`，变异测试直接复用。
  2. **10 组变异必须逐个被抓** + **不得连带误报**（引入 `extra: ['x-guard-count']` 白名单并把连带项逐条报出）。
  3. **运行时行为自证**：把 `auth/index.js` 原样 `new Function` eval（桩化 `require`），用假连接池真跑 7 条分支 —— 格式非法 / 码不存在 / 已过期 / 被别人占用 / 同一微信已绑别的身份 / 正常绑定并一次性作废 / 同码复用被拒。
- **部署与核验**：迁移脚本已在生产库执行；`member` / `auth` 已 `updateFunctionCode` 部署；`tcb fn code download` 回下载线上包与本地 **逐字节一致**；`invokeFunction(bindStaff)` 返回 40001、对照组未知 action 返回 41001。
- **仍未做**：真机走一遍「生成码 → 输入 → 绑定成功 → 码失效」；前端改动需微信开发者工具上传生效。

### 部署状态
- **本轮范围（v0.7.14 第 6 轮）**：① 底栏整体缩小一号（§9/§10，纯前端 + 门禁）；② 教职工一次性绑定码**全链路**（§11，含数据库迁移 + `member`/`auth` 两个云函数 + 绑定页/班级页前端 + 新门禁）。
- **后端已部署并三重核验**：`scripts/migrate-staff-code.sql` 已在生产库执行（`member` 加 `staff_code` / `staff_code_expire`）；`member` 与 `auth` 均 `updateFunctionCode` 部署，`tcb fn code download` 回下载的线上 `index.js` / `common/*` 与本地**逐字节一致**（`diff` 无输出），env 与 VPC `vpc-c4ga6fms/subnet-a5mkrg1l` 未被改动；`invokeFunction(bindStaff)` 返回 40001、对照组未知 action 返回 41001 → 新 action 已注册、路由正常。
- **前端**：待微信开发者工具上传生效（工作区无小程序上传私钥，无法走 miniprogram-ci）。⚠️ 必须**重新编译一次**，确认 ① `unexpected token ~` 消失（本地跑不了 WCSS 编译器）；② 底栏已变小；③ 绑定页「我是老师 / 辅导员」与班级页「教职工」入口可用。
- **后端 `media`**：已于第 4 轮部署 + 已核验（§3），本轮未再改动。
- ⚠️ 修复前发布的 17 条通知 `images` 均为 `null`（代码不回填历史数据），需重新发布一次带图通知做端到端确认。
- 门禁：**33 个全绿**（`check-tabbar-liquid` 覆盖收窄几何、零留白与新增的「底栏占位联动 6 处」；`check-tab-enter` 覆盖入场结构与档位序列；`check-wxss` 覆盖全量禁 `~`；`check-notice-v2` R7 覆盖 fileID 白名单；**新增 `check-staff-bind`** 覆盖教职工码三段自证）。`scripts/deploy.md` §2.1 已补全到 33 个并加「新增门禁必须登记」的约定。
- 备份：开工基线 `20260926-051621-v0.7.14-第6轮-底栏整体缩小一号（开工基线）`；收尾基线 `20260926-053930-v0.7.14第6轮-底栏缩小一号+教职工绑定码-收尾`。`--diff` 复核：**修改 23 / 新增 2 / 删除 0**，与预期改动集完全一致（无意外文件）。
- **取证工具落盘**：`.workbuddy/tmp/measure2.py`（纯标准库解 PNG，量屏幕/指示器/红框边界并换算 rpx）、`.workbuddy/tmp/ascii-map.py`（ASCII 亮度图）。用于把「目测比例」换成**实测像素**。

---

## v0.7.13 · 2026-09-26

主题：通知页三处动效（折叠展开 / 回收站 / 卡片堆叠）+ 全站多选标签「挤开」动画，并修掉 v0.7.12 的一个回归。

用户原话（5 条，第 5 条是 v0.7.12 的回归）：

> 1、通知中超过 3 行的文字进行折叠，使用这个过渡动画展开文本，**高度和文字同步展开，下方内容自然向下移动，同一个箭头旋转到新状态**。
> 2、通知页面右下角添加回收站（垃圾桶图标），左滑选择删除后，**从卡片位置开始移动，曲线路径连接到回收图标，缩小、旋转后进入回收站**。
> 3、通知过多时，使用卡片堆叠动画，**卡片到顶层后停留，后续卡片逐张压上来，层级和大小表示浏览进度**。
> 4、所有的多选标签（发布通知中的选择班级、选择职位等）都使用这个动画：**标签扩大占用宽度，邻项跟随新的位置移动**。
> 5、内容分块依次上浮有问题，目前首页仅有最上面一点动画，我的页面前两个有动画，其他的还是闪烁出来。

### 1. 需求确认（4 个分叉，都选了推荐项）

| 分叉 | 选择 | 为什么不选另一边 |
|---|---|---|
| 第 3 条堆叠怎么做 | **渐进增强**（保留现有列表结构，顶部卡片 sticky 逐层压上） | 改成真正的卡片堆栈控件要重写整个列表交互，风险与收益不成比例 |
| 第 2 条回收站要不要内容 | **可查看 + 可恢复** | 只做「飞进去就没了」，用户误删无从找回 |
| 第 4 条改多少 | **一次性全改**（发布通知 / 名册筛选 / 课表表单等所有 chip） | 分批改会长期处于「一半有一半没有」的割裂状态 |
| 交付节奏 | **一次全做** | 五条互相独立，分回合做只是拉长等待 |

### 2. 第 5 条（v0.7.12 回归）：回访只动前 2 块

| 项 | 内容 |
|---|---|
| 现象 | 首页只有最上面一块有动画，我的页前两块有动画，**其余块直接出现** |
| 根因 | v0.7.12 的「回访轻量版」只给 `st-1 / st-2` 写了 animation，后面的块**没有任何动画**，于是「无动画地出现」被感知成闪烁 |
| 改动 | `app.wxss` 的 lite 段补到全部四档（0/40/80/120ms）；`utils/page-anim.js` 的 `LITE_MAX` 2 → 4、新增 `LITE_STEP_MS = 40` 并导出 |
| 防回归 | `check-tab-enter` 新增断言：**回访档位数必须等于首次档位数**，且 lite 步长与 `LITE_STEP_MS` 一致 —— 以后再有人「只动前两块」会直接报错 |

### 3. 第 1 条：折叠展开改成「高度连续变化」

| 项 | 内容 |
|---|---|
| 原实现 | 只切一个 class（摘掉 `-webkit-line-clamp`）→ 高度瞬间跳到位，下面整块跟着弹一下 |
| 新做法 | ① 先摘 clamp（此时 `max-height` 仍是折叠值，**视觉零变化**）→ ② 量出正文真实高度（px→rpx）→ ③ 把 `max-height` 从折叠值**过渡**到实测值 |
| 关键约束 | 动画期间**必须摘掉 line-clamp**：挂着它内容高度被钉死在 3 行，`max-height` 再怎么过渡也看不出变化；收起要**等动画播完**再把 clamp 挂回去，提前挂 = 收起动画直接消失 |
| 阈值 | 5 行 → **3 行**；折叠高度 `FOLD_H_RPX = FOLD_LINES × LINE_H_RPX`（126rpx）是唯一来源，与 CSS 的 `line-height: 42rpx` 由门禁比对 |
| 箭头 | 只用一个 `chevron-down`，靠 `.nt-fold-arrow.on { transform: rotate(180deg) }` 表示两态（原来是 chevron-up / chevron-down 两个图标来回换） |

⚠️ 为什么必须分两拍 setData：`transition` 与「目标位移」放在同一次 `setData` 里，元素的 before-change 样式里根本不存在 transition，**不会起过渡**（瞬移）。折叠与飞行都踩了这个点，两处都是「先挂 class、下一帧再给目标值」。

### 4. 第 2 条：回收站 + 曲线飞入 + 可恢复

**曲线是怎么来的**：横向与纵向**挂在不同元素**上，并给**不同的时序曲线** —— 外层 `.nt-wrap` 走 X（`linear` 匀速），内层 `.nt-item` 走 Y（`cubic-bezier(0.55,0,1,0.45)` 越走越快），两条合成出来就是一条弧线。放在同一个元素上做不到：X 与 Y 只能共用一条 `transition-timing-function`，出来是直线。

| 项 | 内容 |
|---|---|
| 起终点 | 起点按**卡片当前实际位置**量（`selectAll('.nt-card')`），终点按回收站图标位置量（`select('.nt-trash')`）—— 不写死坐标，换机型也对 |
| 终点形态 | `scale(.14) rotate(26deg) opacity 0`，520ms |
| 时序 | 动画与删除请求**并行**，`Promise.all([req, 动画])` 两件事都完成才把卡片从数据源摘掉；**请求失败会把卡片飞回原位**（保留过渡，不是硬弹） |
| 垃圾桶反馈 | 卡片飞进来时 `.nt-trash.on` 给一个 `scale(1.18)` 脉冲，让落点看得见 |
| 层级 | 飞行卡 `z-index: 60` < 回收站 `70`（卡片是「钻进」垃圾桶） < tabBar `900` |
| 回收站内容 | 后端新增 `media.msgRecycleList` / `media.msgRestore`（删除是软删除，回收站 = 反查 `notice_msg_delete`，**不额外建表**；恢复 = 删掉那一行） |
| 角标 | 进页面取一次回收站条数，右下角显示角标，否则用户不知道里面有东西 |

### 5. 第 3 条：卡片堆叠（滚动驱动）

- **只在「通知过多」时启用**（列表 > 6 条），短列表保持原样。
- 划过顶部的卡片加 `position: sticky` 钉住：最新划过去的那张在最上层（全尺寸、不透明，钉在距顶 40rpx），更早的逐层往上错开 16rpx、缩小 4%、变暗 18%，最多留 3 层，更早的直接划走。
- `transform-origin: 50% 0` 不能省 —— 用默认的中心点缩，上面那层会被盖死，看不出是「一摞」。
- 没进堆的卡片 `z-index: 5` > 堆里的最大层级 3 → 后面的卡是**压上来**，而不是从堆底钻过去。
- **量位置的坑**：已经钉住的卡片，`rect.top` 是它被钉住的位置、不是自然位置。所以只在「一张都没钉住」时记录首卡自然位置，其余一律用「上一张 + 高度 + 间距」往下推（高度不受 sticky 影响）。
- **性能**：只有「堆的张数变了」才 `setData`；滚动过程中绝大多数帧是空操作。展开 / 收起正文后重新量一次（卡片高度变了）。

### 6. 第 4 条：全站多选标签「挤开」

- 唯一来源 `app.wxss` 的 `.chip-motion`：**过渡 `padding`**（布局属性）而不是 `transform: scaleX` —— scaleX 只改绘制、不改布局，邻项根本不会动，看着像「标签自己胖了一下、旁边纹丝不动」，比硬切还怪。
- 覆盖 7 族：`.np-cls`（发送班级）/ `.np-chip`（按职位）/ `.np-abtn`（A·B 组）/ `.np-cell`（成员网格）/ `.mb-chip`（名册筛选）/ `.f-chip`（课表表单）/ `.wk-chip`（周次）。
- **两个静默失败点**（都在门禁里钉死了）：
  - 加了 `.chip-motion` 却没在 `.on` 里给**变宽后的目标 padding** → 宽度压根没变，动画看不见；
  - chip 自己的类里又写了一条 `transition` → 页面 wxss 排在 app.wxss 之后、同特异性**后者胜出**，共享过渡被整条覆盖。
- 固定宽格子（成员网格 96rpx / 周次 148rpx）只吃 `scale` 顶起、不参与挤开 —— 强行让 50+ 个格子逐个改宽度会整片重排。
- `.f-chip` / `.wk-chip` 默认补一圈 `border: 2rpx solid transparent` + `box-sizing: border-box`：原来 `.on` 凭空长边框会把盒子撑大 4rpx，选中瞬间整行抖一下。
- segmented（单选 + 等分固定宽）**有意排除**：挤开对它无意义，它本来就有 background/color 过渡。

### 7. 改动文件

| 文件 | 改动 |
|---|---|
| `miniprogram/utils/notice.js` | 折叠阈值 5 → 3；新增 `LINE_H_RPX` / `FOLD_H_RPX` 并导出；`toItems` 补 `clamped` / `bodyH` |
| `miniprogram/pages/notice/index.js` | 折叠两拍展开（`_expandFold` / `_collapseFold` / `_measureBody`）；飞入回收站（`_flyToTrash` / `_measureFly` / `_flyBack`）；回收站（`onTrashOpen` / `onRestore` / `_loadRecycleCount`）；堆叠（`onPageScroll` / `_applyPile` / `_measureStack` / `_restack`）；`withSwipe` 补字段 |
| `miniprogram/pages/notice/index.wxml` | 正文包一层 `.nt-body` 裁剪层；单箭头 + 旋转容器；列表项加 `.nt-wrap` 外层；`<page-meta>` 滚动锁；右下角回收站 + 回收站弹层 |
| `miniprogram/pages/notice/index.wxss` | `.nt-body` / `.nt-fold-arrow` / `.nt-wrap` / `.nt-fly-x` / `.nt-fly-y` / `.nt-trash*` / `.rc-*`；reduced-motion |
| `miniprogram/pages/notice/index.json` | 引入 `bottom-sheet` |
| `miniprogram/app.wxss` | 新增 `.chip-motion`（全站多选标签共用）；lite 入场扩到全部四档（第 5 条） |
| `miniprogram/utils/page-anim.js` | `LITE_MAX` 2 → 4；新增并导出 `LITE_STEP_MS`（第 5 条） |
| `miniprogram/pages/home/index.{wxml,wxss}` | 4 族标签挂 `chip-motion` + `.on` 目标 padding |
| `miniprogram/pages/roster/index.{wxml,wxss}` | `.mb-chip` 同上 |
| `miniprogram/pages/timetable/index.{wxml,wxss}` | `.f-chip` / `.wk-chip` 同上；补透明边框 + border-box |
| `miniprogram/utils/api.js` | 注册 `msgRecycleList` / `msgRestore` |
| `cloudfunctions/media/index.js` | 新增 `msgRecycleList` / `msgRestore` 两个动作 |
| `scripts/check-chip-anim.js` | **新增**（第 30 个门禁） |
| `scripts/check-notice-motion.js` | **新增**（第 31 个门禁） |
| `scripts/check-notice.js` | 折叠章节重写（3 行阈值 + 高度过渡 + 箭头旋转 + 常量 ↔ CSS 比对） |
| `scripts/check-tab-enter.js` | 第 5 条防回归断言 |

### 8. 影响面 / 风险

- 回收站与恢复都是**软删除语义**，只影响「我自己」看不看得见，不动别人的数据；`msgRestore` 对不在回收站里的 id 会报错（防越权 / 防重复点击误判成功）。
- 卡片堆叠只在长列表启用，且量不到位置时 `_applyPile` 直接空转 —— 最坏情况是「没有堆叠效果」，不会错位或挡住内容。
- 飞行动画失败会飞回原位，不会留下空洞。
- 无障碍：折叠、飞行、标签三套动效都在 `prefers-reduced-motion` 下降为瞬时。

### 9. 部署状态

- 云函数 `media`：**已部署**，`tcb fn code download media _verify/media -e <YOUR_ENV_ID>` 与本地 `diff` 一致（仅 `node_modules` 差异），线上包已确认含 `msgRecycleList` / `msgRestore`。
- 回收站 SQL 已在生产库实跑验证（可查到已删除记录）。
- 前端改动需在**微信开发者工具**上传生效。
- **31 个离线门禁全部通过**（`PASS=31 FAIL=0`）。

---

## v0.7.12 · 2026-09-26

主题：四个 Tab 页（首页 / 课表 / 值日 / 我的）切进去时不再「直接展示」，改成**内容分块依次上浮**。

用户原话：

> 点击首页、课程表、值日、我的，都有动画，现在直接展示太生硬了。

### 1. 这是同一个问题的第三次返工，先把历史摆清楚

| 版本 | 做法 | 用户反馈 |
|---|---|---|
| 2026-09-25 初版 | 整页 `opacity: 0 → 1`，**每次 onShow 重播** | 「每次切换页面，页面都会闪一下」 |
| 2026-09-25 修正 | 改成**只播一次**，回访完全静止 | 「直接展示太生硬」 |
| v0.7.12（本次） | **内容分块**依次上浮 + 淡入；首次完整 / 回访轻量 | — |

根因判断：**「闪」的根源不是「有动画」，是「整页一起动」** —— 内容其实一点没变，却整屏重来一遍，大脑就会把它判成闪烁。所以这次不是「把动画加回来」，而是换成**分块 + 小位移 + 有先后**：观感是「内容依次就位」，而不是「屏幕闪了一下」。

### 2. 需求确认（4 个分叉，都选了推荐项）

| 分叉 | 选择 |
|---|---|
| 什么时候播 | **首次完整 + 回访轻量**（回访播完整版会重蹈「闪」） |
| 动画形态 | **区块依次上浮淡入**（不是整页淡入、不是方向性滑入） |
| 强度 | **中等**：12px / 260ms / 块间 50ms；回访 6px / 180ms / 只动前 2 块 |
| 范围 | **只四个 Tab 页**（二级页由 navigateTo 自带系统转场，再叠一层会显得慢） |

### 3. 实现

- **`utils/page-anim.js` 重写**：
  - 首次进入**只做标记、不 setData** —— 根节点初始 `animSeq: 0`（对应 `pa-first`），CSS animation 在元素**创建那一刻**就开播了（animation 与 transition 不同），此时再 setData 一次不会重播，写别的值反而会打断刚播几毫秒的动画。
  - 回访才 setData：`animSeq` 在 `1 / 2` 之间轮换，wxml 的三元把它映射到 `pa-lite-a` / `pa-lite-b` —— **同名 class 不会重播动画，换名字才会**。
  - 强度常量导出（`FULL_MS / LITE_MS / FULL_Y / LITE_Y / STEP_MS / MAX_STEP / LITE_MAX`），供门禁与 CSS 比对。
- **`app.wxss`**：新增 `.st-item`（入场标记）+ `st-1 ~ st-4`（延迟档，第 4 档封顶）+ 三组 keyframes（`stInFull` / `stInLiteA` / `stInLiteB`，后两组内容完全一致、只差名字）。只动 `transform` + `opacity`，带 `backwards`（延迟期间保持首帧，否则会先闪现再消失再淡入），并尊重 `prefers-reduced-motion`。
- **四个页面打标记**（首屏块，按序）：
  - 首页：值日 Hero(st-1) / 语音通知条(st-2) / 今日课次(st-3) / 明日课次(st-4)
  - 课表：周切换条(st-1) / 分组切换(st-2) / 课表主体(st-3)
  - 值日：周切换条(st-1) / 按日按人切换(st-2) / 管理员操作区(st-3) / 数据区(st-4，单独套一层，与切周动画的 `wk-swipe` 分层避免争同一个 `animation` 属性)
  - 我的：用户信息(st-1) / 统计(st-2) / 提醒(st-3) / 任务(st-4)
  - 注：`week-switcher` 组件声明了 `options: { addGlobalClass: true }`（已查证），外部 class 能落到组件根节点，所以顶部周切换条也能参与入场；反之若某个组件没开这个开关，加 `st-item` 是无效的 —— 这是选中这些块的前提。

### 4. 两条硬约束（都写代码注释 + 门禁）

1. **`.st-item` 绝不能落在 `position: fixed` 的元素上** —— transform 会创建包含块，首页值日提醒胶囊、课表页两个 FAB 会在动画这 260ms 里被摆到「内容盒底部」（内容比屏幕高时直接飞出屏幕，动画一结束又跳回来）。
   - 门禁**从 wxss 动态提取**所有 `position: fixed` 的类名（不是写死清单，将来新增 fixed 元素会自动纳入），再扫 wxml 看有没有跟 `.st-item` 撞在同一个标签上；还断言这些 fixed 元素必须是根节点直接子节点（= 不被任何动画容器包住）。
2. **强度常量（JS）与数值（CSS）必须一致** —— 改一处忘另一处不会报错，只是「说好的 12px 变成别的」。门禁逐项比对：时长、位移、块间延迟、延迟封顶档、回访动几块。

### 5. 改动文件

| 文件 | 改动 |
|---|---|
| `miniprogram/utils/page-anim.js` | 重写：首次/回访轮换 + 强度常量导出 |
| `miniprogram/app.wxss` | 删旧的 `page-anim-1/2` + `pageInA/pageInB`；新增 `.st-item` / `st-1~4` / 三组 keyframes / reduced-motion |
| `miniprogram/pages/{home,timetable,duty,mine}/index.{js,wxml}` | `animSeq: 1 → 0`；根节点三元换三个新类名；内容块打 `st-item st-N` |
| `scripts/check-tab-enter.js` | **新增**：60+ 条断言（见下） |
| `scripts/check-popup-anim.js` | ③ 段从旧机制（整页淡入）改判新机制（分块 stagger） |

### 6. 门禁：`check-tab-enter`（新增，29 个脚本仍全绿）

- **行为自证**：`require('utils/page-anim.js')` 用假 page 跑 —— 首次不 setData、回访按 `1 → 2 → 1` 轮换。
- **接线**：四个 Tab 页 `animSeq: 0` + 根节点三元写全三个类名 + `onShow` 调 `play` + 至少 2 个入场块。
- **安全性**：fixed 类名动态提取后扫 wxml 撞车；fixed 元素必须是根节点直接子节点；二级页不得出现 `st-item`。
- **防漂移**：CSS 时长 / 位移 / 块间延迟 ↔ JS 常量逐项比对；两套 lite keyframes 内容必须一致；不得出现 `st-5`（延迟没封顶）。
- **双向自证**：fixed 元素带 `st-item` 的坏样本必被抓；普通内容块的好样本不得误报。

### 7. 验证

- `node --check` × 7 全过；改动文件 UTF-8 全过；`check-wxss` / `check-wxml` 通过。
- **29 个门禁脚本全绿**；`check-api` 映射问题 `none`。
- 本版**纯前端**，无云函数改动 → **无需部署**。

---

## v0.7.11 · 2026-09-26

主题：给左右滑动切周加**方向性过渡动画**，并补上「滑到头」的回弹反馈。

用户原话：

> 左右滑动添加动画

### 1. 为什么是「先滑走 → 再换数据 → 再滑入」

最直觉的做法是「判出方向就立刻换数据 + 播入场动画」。但换周要重新拉云函数（`scheduleListWeek` / `scheduleManualBoard`），
缓存未命中时中间会出现骨架；如果先换数据，动画就会变成「先白一下，然后新内容滑进来」，比不加动画更割裂。
所以时序定为三段（全部由 `utils/swipe.js` 的 `shift()` 统一编排）：

| 阶段 | 时长 | 内容 |
|---|---|---|
| out | 160ms | 旧内容朝手指方向滑走 + 淡出（`cubic-bezier(0.7, 0, 0.84, 0)` 加速曲线，像被手指带走） |
| 换数据 | — | 回调页面的 `_applyWeek(wk)`：写 week + 重新 load |
| in | 220ms | 新内容从反方向滑入 + 淡入（`cubic-bezier(0.16, 1, 0.3, 1)` 减速曲线，快进慢停） |

- 方向映射：左滑（下一周）= `wk-out-left` → `wk-in-right`；右滑（上一周）= `wk-out-right` → `wk-in-left`。
- **点箭头 / 周次选择器也走同一条路**：`onWeekChange` 内部按 `delta` 判方向后交给 `swipe.shift`，两条入口观感一致（不再只有滑动才有动画）。
- 越界（第 1 周还往右滑 / 最后一周还往左滑）：**只播回弹、不换数据**（原实现是静默无反应，容易被当成「没滑到」）。回弹只探出 10px，比整段滑出轻得多。

### 2. 两条硬约束（都写进注释并由门禁守着）

1. **只动 `transform` / `opacity`**：动 width / left / margin 会触发重排，长列表（值日页最多 20+ 条）必掉帧。
2. **动画容器里不能放 `fixed` 元素**：`transform` 会创建包含块，`fixed` 后代会跟着一起位移。
   - 值日页的离屏 canvas（`.off-canvas`，导出长图用）刻意留在容器外；
   - 手动排班页的底部固定条（`.ms-bar`）刻意留在容器外。
   - 门禁按「容器闭合位置 < fixed 元素位置」断言，谁把 fixed 挪进来就报错。

### 3. 改动文件

| 文件 | 改动 |
|---|---|
| `miniprogram/utils/swipe.js` | 新增 `OUT_MS/IN_MS/EDGE_MS` 常量、`animOut/animIn/animEdge`（方向→class）、`shift(page, delta, go)`（编排时序 + 越界回弹）、`cancel(page)`（清定时器）；导出全部新增项 |
| `miniprogram/app.wxss` | 新增 `.wk-swipe` 容器 + 6 个动画 class + 6 组 `@keyframes` + `prefers-reduced-motion` 关闭分支 |
| `miniprogram/pages/duty/index.{js,wxml}` | data 加 `swipeCls`；`onWeekChange` 走 `swipe.shift`，抽出 `_applyWeek`；数据区（骨架/空态/列表）套 `wk-swipe` 容器；`onUnload` 调 `swipe.cancel` |
| `miniprogram/pages/manual/index.{js,wxml}` | 同上 |
| `scripts/check-week-swipe.js` | 新增第 ④ 组：动画 class 映射、时序真实自证、越界回弹、cancel 安全、CSS↔JS 时长一致、只动 GPU 属性、reduced-motion、容器挂载与 fixed 位置、**页面源码 eval 接线自证** |

### 4. 门禁：`check-week-swipe` 扩到 4 组

形态断言（「写了这几行」）证明不了「接对了」，所以 ④ 组里有两层真实自证：

- **时序自证**：用假 page 跑 `swipe.shift`，断言「同步阶段只播 out、且没换数据」→ 等 `OUT_MS` 后「换了数据 + 播 in」；越界分支断言「返回 false、播回弹、全程不换数据、结束后清空 class」。
- **页面接线自证**：从 `pages/duty/index.js`、`pages/manual/index.js` 源码里**正则抽出 `onWeekChange` / `_applyWeek` 函数体 eval 执行**（注入真实 `swipe` 模块），断言点箭头后 week 变化、load 只调一次、入场 class 正确、越界周次被拦下。**不写副本**，避免与生产漂移。

另外两条防漂移断言：

- **CSS 时长 ↔ JS 常量一致**：解析 `app.wxss` 里 `.wk-out-left { animation: wkOutLeft .16s … }` 与 `swipe.OUT_MS` 比对（改 JS 忘了改 CSS，动画会被截断或空等）。
- **keyframes 不得出现布局属性**：`/width|height|margin|left|right|top|bottom/` 命中即报错。

### 5. 验证

- `node --check` 4 个 JS 全过；改动文件 UTF-8 全过。
- **28 个门禁脚本全绿**（`check-week-swipe` 60+ 条断言全过）；`check-api` 映射问题 `none`。
- 本版**纯前端**，无云函数改动 → **无需部署**。

---

## v0.7.10 · 2026-09-26

主题：值日页 / 手动排班页支持左右滑动切换周次；去掉值日页的误导性提示。

用户原话（1 条，两项）：

> 值日页「长按周切换条可快速跳转」提示不要。值日页左右滑动可切换上一周、下一周；手动排班页左右滑动页可这么切换。

### 1. 去提示：文案本身就是错的

- 位置：`pages/duty/index.js` 的 `onWeekPick()` —— `wx.showToast({ title: '长按周切换条可快速跳转' })`，由 `<week-switcher bind:pick="onWeekPick">` 触发。
- 顺带发现的错：`week-switcher` 组件里 `.ws-mid` 绑的是 **`bindtap="onPick"`（点击）**，不是长按。所以这句提示不仅多余，描述还是错的。
- 改动：删掉 `onWeekPick()` 与 wxml 上的 `bind:pick`（该事件从此无人监听，`pick` 变 no-op）；没有换一句新文案 —— 用户要的是「提示不要」。

### 2. 左右滑动切周（值日页 + 手动排班页）

- 新增 `miniprogram/utils/swipe.js`（两页共用），只在 **touchend 判一次方向**，不做跟手位移。理由写进文件头：
  - 两页都是**页面级纵向滚动**，实时跟手要每帧抢方向判定，稍斜的滑动就会被误判成换周；
  - 换周要重新拉云函数数据，属重操作，跟手拖动会让用户中途反复触发。
  - 两道门槛：横向位移 ≥ 50px，且横向位移 ≥ 纵向位移 × 1.4（否则让给页面滚动）。
  - 判定：`dx < 0` → `next`（左滑下一周）；`dx > 0` → `prev`（右滑上一周）。
- 页面接入：手势挂在**页面根节点**（覆盖整页），`onSwipeEnd` 里**先挡弹层再判方向** —— 弹层的 DOM 就在页面根节点内，touch 会冒泡上来，不挡的话「在值日详情里横滑」会偷偷换周（数据被换掉，用户还以为自己点错了）。挡的清单：
  - `pages/duty`：`sheetShow || aiShow || exportShow`；
  - `pages/manual`：`pickerShow`。
- 切周复用既有 `onWeekChange`（内部已有 `1..totalWeeks` 边界校验），越界自动忽略。
- **课表页明确不接入**：课表主体是 `scroll-x`，横向手势另有归属，加了会抢横向滚动（门禁里专门断言「课表页没挂」）。

### 3. 新增门禁 `scripts/check-week-swipe.js`

手势是「看不见的入口」——被删掉不会报错，只会「滑不动了」；漏挡弹层更危险（静默换周）。所以上门禁：

- ① **真实行为自证**：直接 `require('utils/swipe.js')`，用合成 touch 事件跑判定 —— 左滑→`next`、右滑→`prev`、位移过小→``、斜滑（纵向为主）→``、无 touchstart→`` 不抛异常；
- ② 两页根节点都有 `bindtouchstart`/`bindtouchend`、都 require 了 `utils/swipe`、`onSwipeEnd` 里**先 return 挡弹层**再 `swipe.end`、`_shiftWeek` 复用 `onWeekChange`；并断言值日页挡满三个弹层、手动排班页挡掉选人弹层；
- ③ 旧提示与 `onWeekPick` 死代码不得复活、两页不得残留 `bind:pick`、**课表页不得挂 `onSwipeStart`**。

### 4. 改动文件与验证

- 小程序：新增 `utils/swipe.js`；`pages/duty/index.{js,wxml}`、`pages/manual/index.{js,wxml}`。
- 门禁：新增 `scripts/check-week-swipe.js`。
- 文档：`CHANGELOG.md` / `CHANGELOG-DETAIL.md` / `.workbuddy/memory/DETAILS.md` §55 / `.workbuddy/memory/2026-09-26.md`。
- 验证：`node --check` × 4 全过；6 个改动文件 UTF-8 全过；**28 个门禁脚本全绿**。
- **纯前端版本**：无云函数改动、**无需部署**；小程序端需经微信开发者工具上传生效。

---

## v0.7.9 · 2026-09-26

主题：班委可视化（筛选）与任命（选职位）+ 全站弹层滚动穿透治本（含结构性门禁）+ 手动排班可排测试账号。

用户原话（4 条）：

1. 查看班级-查看人员中可添加筛选班委，仅显示班委。
2. 超管、辅导员可在人员详情中选择设置为班委（设置班委选项点击后可详细选择设置为哪个班委）。
3. 添加值日页面滑动到最下面后会滑动后面的页面。（在其他类似页面修了很多次了。将所有类似的全部修复并记录，以后不能出错）。
4. 超管手动排班增加可添加测试人员账号，方便进入测试账号换班测试主账号是否能收到通知。

### 1. 需求③ 滚动穿透：为什么「修了好多次还是漏」

- 现象：「添加值日」的选人列表滑到下沿后，**后面页面的列表跟着一起滑**。
- 根因（机制层面）：`bottom-sheet` / `duty-sheet` 的面板里是 `<scroll-view>`；面板**不能**挂 `catchtouchmove`（会连同列表的正常滑动一起吞掉），所以列表滑到下沿后 `touchmove` 会继续冒泡给 `page`，触发页面级滚动。唯一可靠的锁是页面的 `<page-meta page-style="overflow:hidden">`。
- **为什么会反复漏**：这是「每个页面各自记得加一行」的约定式防护 —— 之前只在 `pages/duty` 加了锁（注释里也写了原因），但换成新页面（`pages/manual` 加选人弹层、`pages/roster` 加导入弹层…）就没人记得补，于是同一类问题在不同页面反复出现。
- 改动：把「约定」变成「结构 + 门禁」。
  - 7 个含滚动弹层的页面统一补 `<page-meta page-style="{{(标志们) ? 'overflow:hidden' : ''}}">`，并放在页面第一个节点：
    | 页面 | 弹层标志 |
    |---|---|
    | `pages/classes` | createShow / renameShow / qrShow / wbShow / importShow |
    | `pages/duty` | sheetShow / aiShow / exportShow（原有，补注释指向门禁） |
    | `pages/home` | sheetShow / noticeShow |
    | `pages/manual` | pickerShow |
    | `pages/mine` | appShow / aboutShow |
    | `pages/roster` | mDetailShow / addShow / importShow / posShow（新增 posShow） |
    | `pages/timetable` | detailShow / formShow / weekPickerShow / shiftShow / calShow |
  - `pages/bind` **有意豁免**：该页只有一个 `dialog`，`dialog` 根节点自带 `catchtouchmove`、内部也没有滚动区，不需要 `page-meta`（这一点写进门禁注释，避免以后被当成遗漏）。
- **新增结构性门禁 `scripts/check-scroll-lock.js`**（这是「以后不能出错」的落点）：
  - 规则 A：含 `bottom-sheet`/`duty-sheet` 的页面必须有且**仅有 1 个** `<page-meta>`，且出现在第一个 `<view>` 之前（`page-meta` 必须是页面第一个节点）；
  - 规则 B：`page-style` 必须含 `overflow:hidden`；
  - 规则 C（**覆盖性**）：每个弹层的 `show` 标志都必须出现在 `page-style` 表达式里 —— 新加弹层忘了写进去，自检直接报「漏锁弹层标志：xxx」；
  - 规则 D（组件兜底）：`bottom-sheet` / `duty-sheet` 的 body `scroll-view` 必须 `enhanced` + `bounces="{{false}}"`，遮罩必须有 `catchtouchmove`；
  - **双向自证**：合成样例断言「漏标志必被抓到」「完整表达式必须放行」「`abFlag` 不误命中 `bFlag`」，防止门禁本身写错还永远绿灯；
  - 扫描前先剥掉 `<!-- -->`（本项目组件注释里就「引用」了 `<scroll-view>`，不剥会假失败 —— 首次运行确实踩到，已修）。
- 影响：所有弹层（含未来新增的）在滑到下沿时不再带动页面滚动；漏配会在自检阶段暴露，而不是等用户报。

### 2. 需求① 「仅班委」筛选

- 改动：`pages/roster` 搜索栏下方新增 `全班 N / 仅班委 N` 两个 chip（`onFilterAll` / `onToggleCommittee`）。
- 判据（`_isCommittee`）：`role ∈ {ADMIN, MONITOR}` 且 **非辅导员**（`groupTag !== 'X'`）且 **非测试账号**（`!test`）。超管（示例成员01·生活委员）**算班委** —— 他确实担任着一个班委职位。
- 关键设计：筛选是**纯展示层**——列表渲染 `viewMembers`（筛选后），但 `members` 始终保留全量，成员详情仍按 `this.data.members.find(...)` 查找，避免「筛掉的人点不开详情 / 详情串行」。
- 实测：示例班级A 仅班委 = **7** 人。

### 3. 需求② 「设置班委」（超管 + 辅导员，可选具体职位）

- 背景：原入口是超管专属的「设为管理员 / 取消管理员」，只改 `role`，**不写 `position`** → 会产生「有管理权限但没有任何职位」的中间态；且辅导员无此权限。
- 改动：
  - 后端（`cloudfunctions/member/index.js`）新增 action `setPosition`（`auth.needBind` + `requireSuperOrCounselor`）：
    - `position` ∈ `POSITIONS`（7 项）→ `role='ADMIN'` 且写入 `position`；
    - `position === ''` → `role='MEMBER'`、清空 `position`（取消班委）；
    - 保护①：拒绝改 `is_super=1`（超管身份只能在 `setRole` / 库里改）；保护②：拒绝改 `group_tag='X'`（教职工不是学生班委）。
  - 前端（`pages/roster`）：详情里把按钮换成 `{{role === 'ADMIN' ? '改班委职位' : '设为班委'}}`，可见条件 `canManage && !mDetailIsSelf && groupTag !== 'X' && !isSuper`；点开 `posShow` 弹层逐项选职位，已是班委时额外给「取消班委」（走 `util.confirm` 二次确认）。
  - 职位清单**唯一来源**：`miniprogram/utils/util.js` 的 `POSITIONS`，通知「按职位」预设（`pages/home`）与「设置班委」（`pages/roster`）共用；云函数侧同名单。由 `scripts/check-positions-sync.js` 强制比对两份清单逐字一致，并断言前端**不允许再各写一份字面量**。
- 影响：班委身份与职位一次设置到位；辅导员也能任命班委（与「辅导员可新建班级 / 加成员」的既有口径一致）。

### 4. 需求④ 手动排班可排入测试账号

- 现象：超管想在手动排班里把测试账号排进某个课次，再切进该账号发起换班，验证主账号能否收到换班通知 —— 但选人列表里**没有测试账号**。
- 根因：测试账号（id 69–71，学号 `0000000000xx`）在库里是 `status='LEAVE'`（刻意不进自动轮转），而手动排班的名册 SQL 与「可安排」校验都写死 `status='ACTIVE'`：
  - `manualBoard` 名册：`WHERE status='ACTIVE' AND group_tag <> 'X'` → 不返回测试账号；
  - `addManual`：`target.status !== 'ACTIVE'` → 抛「该同学当前不可安排」；
  - `reassign`：同样拦「替补不可用」。
- 改动（`cloudfunctions/schedule/index.js`）：
  - 新增 `TEST_NO_PREFIX` / `isTestNo()`；
  - `manualBoard` 名册：`AND (status='ACTIVE' OR student_no LIKE '0000000000%')`，并回传 `test` 标记；
  - `addManual` / `reassign` 两处：`status !== 'ACTIVE' && !isTestNo(...)` 才拒绝；
  - **自动生成（`generate`）的名册 SQL 保持原样** —— 测试账号绝不进入自动轮转（门禁里专门有一条断言守着这个 SQL 不被顺手改掉）。
  - 前端（`pages/manual`）：选人列表在姓名下方标「测试账号 · A 组 · 本轮已排 N 次」，并在提示文案里说明「带测试标记的可手动排入，用来验证换班通知」。
- 实测：手动排班名册 **59** 人（56 在校 + 3 测试账号；辅导员 72 仍排除），自动轮转名册仍 **56** 人。

### 5. 门禁升级

新增 3 个脚本（共 27 个）：

| 脚本 | 作用 |
|---|---|
| `check-scroll-lock.js` | 滚动穿透结构性门禁（详见第 1 节，含双向自证） |
| `check-positions-sync.js` | 前后端职位清单逐字一致 + 前端不得硬编码职位 + `setPosition` 两道保护 |
| `check-committee.js` | ①仅班委筛选（含「筛选不动全量 members」）②设置班委入口→util.POSITIONS→api→落库 ③测试账号进手动不进自动 |

顺带修正既有门禁里的过期注释：`check-count-align.js` 第三节的「取消管理员」表述改为「设置班委」（断言本身未放宽，仍为真判据）。

### 6. 改动文件清单

- 云函数：`cloudfunctions/member/index.js`（POSITIONS + `setPosition`）、`cloudfunctions/schedule/index.js`（测试账号放行，`manualBoard` / `addManual` / `reassign`）。
- 小程序：`utils/util.js`（POSITIONS 唯一来源）、`utils/api.js`（setMemberPosition）、`pages/roster/index.{js,wxml,wxss}`、`pages/home/index.js`（复用 util.POSITIONS）、`pages/manual/index.wxml`；`page-meta` 滚动锁：`pages/{classes,home,manual,mine,roster,timetable,duty}/index.wxml`。
- 门禁：新增 `scripts/check-scroll-lock.js` / `check-positions-sync.js` / `check-committee.js`；`scripts/check-count-align.js` 注释同步。
- 文档：`CHANGELOG.md` / `CHANGELOG-DETAIL.md` / `.workbuddy/memory/DETAILS.md` §54 / `.workbuddy/memory/2026-09-26.md`。

### 7. 验证与部署

- `node --check` × 9 个改动 JS 全过；17 个改动文件 UTF-8 校验全过。
- **27 个门禁脚本全绿**；`check-api` 映射问题 `none`。
- `member` / `schedule` 已部署；`tcb fn code download -e <YOUR_ENV_ID>` + `diff -q` 与本地 `index.js` / `common/` / `xlsx-lite.js` **逐字节一致**，并在线上包里 grep 到 `setPosition` / `POSITIONS` / `TEST_NO_PREFIX`。
- 线上库口径实测：仅班委 7 / 手动名册 59 / 自动名册 56 / 辅导员 1。
- 开工基线 `20260926-004046`。
- **本版含云函数改动（`member` / `schedule` 已部署）；小程序端需经微信开发者工具上传生效。**

---

## v0.7.8 · 2026-09-26

主题：通知「全体」范围与红点口径收口（含测试账号隔离）+ 辅导员按身份收敛（学号 / 通知栏 / 课表）+ 通知正文折叠。

用户原话（8 条，附 2 张截图）：

1. 辅导员不需要学号。
2. 辅导员发的通知自己不需要收到通知，辅导员「我的」页面不需要「通知」栏。
3. 发送全体通知无需包含测试账号。
4. 我的账号发布通知，全体成员也只是当前班级的全体成员，而不是所有班级。
5. 自己发布的通知自己，在查看通知页不会有红点提醒。新通知在点进查看通知页面后，红点提醒消失。
6. 通知正文内容超过 5 行则折叠，可点击展开全文。
7. 不需要导出我的值日表。
8. 辅导员的课表暂时清空（标记：后续等学校教务系统开通，接入课表，辅导员可选择查看每个班 a/b/全体）。

### 1. 需求④「全体」发到所有班级（最高危的一条）

- 现象：发布者（示例成员01，`class_id=1`，`is_super=1`）在首页「发布通知」时，选班区显示「已选 2 个班级」，通知实际发到了**全部启用班级**。
- 根因（前端 + 后端各一半，彼此「配合」出来的）：
  - 前端 `onNoticeOpen` 默认 `noticeAllClasses: true` + `noticeClassIds: []`；`onNoticeSubmit` 于是传 `classIds = []`。
  - 后端 `msgPublish` 把「空数组」解释成**全部启用班级**：`else if (!classIds.length) { SELECT id FROM class WHERE is_active=1 }`。注释原话就是「classIds 缺省=全部启用班级」。
  - 另一条分支更隐蔽：`classIds = [myClassId]` 只在 `isCommittee`（`role ∈ {ADMIN,MONITOR}` 且非超管非辅导员）成立时命中 —— **超管落不到这条分支**，直接掉进「全部启用班级」。
  - 线上实测：启用班级 5 个，跨班全体 199 人，本班只有 55 人。
- 改动（`cloudfunctions/media/index.js` + `miniprogram/pages/home/index.js|index.wxml`）：
  - 后端：新增 `const canCrossClass = isCounselor || isSuper;`，`if (!canCrossClass || !classIds.length) classIds = [myClassId];` —— **「缺省」从「全部班级」改成「本班」**，要跨班必须由前端把 id 铺开传过来。普通班委无论传什么都被强制回本班（防伪造越权）。
  - 前端：默认 `noticeClassIds: [myClassId]`、`noticeAllClasses: false`；`onNoticeToggleAllClasses` 改为**显式全选**（把每个班 id 铺进 `noticeClassIds`，不再靠「空数组 = 全部」）；`onNoticeToggleClass` 全选态下不再把列表折叠回空数组；`onNoticeSubmit` 一律显式传 id。
- 影响：发布通知的默认范围由「全校各班」收窄为「本班」；辅导员要发多班，点「全部班级」或逐个点班（多一次点击，换掉一次误发）。超管暂不显示选班区（沿用 v0.7.6 的「超管不再显示」决定），故超管的「全体成员」= 本班。
- 验证：线上库实测 —— `class_id=1` 且排除自己/辅导员/测试账号 = **55**；全部班级同口径 = **199**。

### 2. 需求③ 测试账号混进收件人（「仅发班委」的隐藏缺口）

- 现象：要求「发送全体通知无需包含测试账号」。`ALL` 与 `POSITION` 两处早已带 `student_no NOT LIKE '0000000000%'`，**唯独 `COMMITTEE`（仅发班委）漏了** —— 「测试管理员」`role=ADMIN`、`is_super=0`、非 X 组，完全符合班委条件，会被当成真实班委写进 `notice_msg_target` 并计入接收人数。
- 另有两个派生问题：
  - `msgList` 的 `recipientCount` `CASE` 里，`COMMITTEE` 分支同样漏了测试账号。
  - `ALL` 分支写成 `(class_id = n.class_id OR n.class_id = 0)` —— `n.class_id = 0`（跨班）时**统计全部班级**，这正是需求④里「199 人」的来源；顺带也没排除测试账号的跨班计数。
- 改动：抽出模块级常量 `TEST_NO_PREFIX` / `NOT_TEST` / `IS_TEST` / `NOT_COUNSELOR` / `IS_COUNSELOR`，把散落的字符串字面量统一成常量（口径唯一来源）；`COMMITTEE` 目标 SQL 与 `recipientCount` `COMMITTEE` 分支补 `NOT_TEST`；`recipientCount` 的 `ALL` 分支改为按目标班级子查询收窄：
  `... AND (class_id = n.class_id OR (n.class_id = 0 AND class_id IN (SELECT nc2.class_id FROM notice_msg_class nc2 WHERE nc2.notice_id = n.id)))`
  并给 `ackCount` / `ackList` 也补上测试账号过滤（测试账号不计入接收人数，也不该出现在确认名单里）。
- 验证：`COMMITTEE` 收件人在本班由 1 → 1（测试管理员 `openid IS NULL` 本就被 `openid IS NOT NULL` 挡住，所以这是**潜在缺口**，本次属防御性修复）；`recipientCount` 新表达式实测：单班 = 55，跨 1+2 班 = 112（= 55 + 57），不再等于跨班总数 199。

### 3. 需求② 辅导员自己发的通知自己去接收 + 「我的」页通知栏

- 现象：辅导员（`group_tag='X'`，`class_id=1`）虽然不接收通知，但订阅消息推送与列表可见性都没把他排干净。
- 根因：`pushNoticeMsg` 的 `else` 分支已有 `group_tag <> 'X'`，但**调用处没传 `excludeId`**，发布者本人仍在收件人集合里；`msgList` 的可见性 `WHERE` 里 `scope='ALL' AND n.class_id = 1` 会让辅导员（class_id=1）看见本班全体通知 —— 可他本不该是收件人。
- 改动：
  - `pushNoticeMsg(..., excludeId)` 增加 `if (Number(excludeId)) sql += ' AND id <> ?'`，调用处传 `me.id` —— 「自己发的通知自己不接收」在**所有 scope** 下都成立（原来只有全班通知隐式靠 X 组过滤）。
  - `msgList` 增加 `const counselorOnly = isCounselor ? 1 : 0;` 与 `WHERE (? = 0 OR n.publisher_id = ?)` —— 辅导员**只看得见自己发的**。
  - `pages/mine/index.wxml`：「通知」行加 `wx:if="{{!isCounselor}}"`（他仍可从首页「查看通知」查回执）。
- 影响：辅导员的收发语义变干净 —— 「只发不收」。

### 4. 需求⑤ 红点口径（顺带修掉「永远消不掉」的老 bug）

- 现象：要求「自己发的通知不产生红点」「进通知页红点消失」。
- 根因：角标口径是 `unackedCount(list) = list.filter(x => x.needAck && !x.acked)`（「待我确认」）。
  - 发布者自己的「确认收到」按钮是**隐藏**的（`isPublisher`）→ 他永远点不了 → 自己发一条 `needAck` 通知 = 角标**永久 +1**。
  - 「确认收到」语义 ≠ 「看过」：进通知页不点确认，红点不会消失，与需求⑤第二条直接冲突。
- 改动（`miniprogram/utils/notice.js`）：
  - 新口径 `unackedCount(list, memberId)` = `list.filter(x => !x.isPublisher && Number(x.id) > seen).length`（**我还没看过的新通知**，排除自己发的）。
  - 新增未读游标：`seenId(memberId)` / `markSeen(list, memberId)`，存 `wx.setStorageSync('noticeSeen:<memberId>')`，**按成员隔离**（同一台机切换测试账号互不串味），只前进不后退。
  - `pages/notice/index.js`：`onLoad`（缓存那份）与 `load()`（网络那份）都调 `notice.markSeen(...)`；新增 `_memberId()`（profile 未就绪回落 0）。
  - 三个消费点同步传 memberId：`pages/home/index.js`（onShow 角标）、`pages/mine/index.js`（`_loadNoticeBadge` 缓存 + 网络两处）。
- 影响：红点从「待我确认数」变成「未读新通知数」。**注意这是语义变更**：需要确认但已看过的通知不再有红点，确认提醒只在通知页内（卡片右上角「待收到」标签 + 按钮）体现。
- 已知取舍：游标存本地，是**单设备**维度（在手机 A 看过，手机 B 仍显示红点）。要跨端一致需要落库（新增 `notice_msg_seen` 或 `member.notice_seen_id`），本次未做。

### 5. 需求⑥ 通知正文超 5 行折叠

- 改动：
  - `utils/notice.js`：新增 `estimateLines(text)`（正文 27rpx、卡片内容宽 630rpx → 一行约 23 个汉字；汉字权重 1、ASCII 0.55、换行强制断行），`toItems` 输出 `fold: estimateLines(content) > 5`。
  - `pages/notice/index.wxml`：正文加 `class="nt-content {{item.fold && !item.expanded ? 'is-fold' : ''}}"`，下面按 `wx:if="{{item.fold}}"` 出「展开全文 / 收起」（`app-icon` 用 `chevron-down / chevron-up`）。
  - `pages/notice/index.wxss`：`.nt-content.is-fold { display:-webkit-box; -webkit-box-orient:vertical; -webkit-line-clamp:5; overflow:hidden; max-height:210rpx; }`（5 × 42rpx line-height）。
  - `pages/notice/index.js`：`withSwipe` 补 `expanded:false`；新增 `onToggleFold(index)` —— **只改 `list[i].expanded` 这一个标量路径，绝不重建 list 数组**（数组重建会替换卡片内节点、按钮 tap 丢失，正是 v0.7.6 左滑卡片踩过的坑）。
- 设计取舍：只做「估多了就折叠」这一个方向 —— 估少了就不折叠（整段照常显示，不会出现「被截断却点不到展开」的死角），估多了最多多一个无副作用的「展开全文」。折叠**只用 CSS 裁显示，不截断字符串**，展开即原文。
- 验证：`check-notice` 新增「正文行数估算在 utils/notice.js」「超 5 行折叠 + 可展开」两条断言。

### 6. 需求① 辅导员不显示学号

- 现象：截图里辅导员（示例成员57）下方显示 `00000000**** · 辅导员`。
- 定位：那串文案来自 `pages/mine/index.wxml` 的个人卡（`profile.studentNoMasked + ' · ' + ...`）；名册（`pages/roster`）另有「N 号 · 值日」与详情「学号 N 号」两处也会暴露辅导员学号。
- 根因（为什么不只是改文案）：辅导员是教职工，`student_no` 只是入库占位（`000000000090`），**不该在任何地方作为「学号」出现**。
- 改动：
  - `cloudfunctions/member/index.js`：新增 `noOf(r)` / `maskedNoOf(r)`（`group_tag === 'X'` → 返回 `''`），`memberList` 的 `public=manage` / `public` / 默认三个分支全部走这两个 helper；同时**新增 `test: isTestNo(r.student_no)` 字段**（见下）。
  - `pages/mine/index.wxml`：个人卡改为 `profile.groupTag === 'X' ? '辅导员' : profile.studentNoMasked + ' · ' + profile.groupTag + ' 组'`。
  - `pages/roster/index.wxml`：列表行对 X 组改为「辅导员 · 不参与值日轮转」（不显示「N 号」）；详情原本已按 X 分支处理。
  - `pages/bind/index.wxml`：`studentNoMasked` 为空时不渲染那一行（避免空行）。
- **连带修复（重要）**：辅导员学号被清空后，「学号 99 段」这个正则判据就认不出「测试辅导员」了 —— 会导致 `pages/mine` 的「切换测试账号」列表**漏掉辅导员**（无法再切到辅导员视角验证）。故后端补 `test` 字段，并把三处判据改成「优先用 `test`、正则兜底」：`pages/mine/index.js`（切换账号列表）、`pages/roster/index.js`（`test` 徽标 + `seq` 对 X 组给 999 哨兵值，保持排在名单末尾不跳动）、`pages/home/index.js`（发布通知选人网格的测试账号过滤）。

### 7. 需求⑦ 移除「导出我的值日表」

- 改动：`pages/mine/index.wxml` 删掉整行；`pages/mine/index.js` 删掉随之变成死代码的 `onExportMine()`（此前对辅导员隐藏、对其它身份显示；现对所有身份移除）。
- 验证：`check-notice` 新增「入口连同死代码一起移除（所有身份）」断言。

### 8. 需求⑧ 辅导员课表暂时清空

- 改动：
  - `pages/timetable/index.js`：data 增 `isCounselor`；`onShow` 里 `applyAuth` 同时算 `isCounselor` 并抽出 `_afterAuth()` —— 辅导员**不调 `load()`**、不建网格（`loading` 置 false 走空态分支），并把 `grid/dates/periods/tip` 清空避免上一个身份的课表残影；`app.ready()` 后若身份从「非辅导员」变「辅导员」再走一次 `_afterAuth` 清干净。
  - `pages/timetable/index.wxml`：辅导员空态分支**必须排在 `loading` 骨架之前**（否则页面永远卡在骨架屏）；`week-switcher`、A/B 分组 `segmented`、调课 FAB、编辑 FAB 全部对辅导员隐藏；空态文案明确写出「学校教务系统开通后接入，并支持按班级（A 组 / B 组 / 全体）切换查看」，作为将来接入点的标记。
  - `pages/timetable/index.wxss`：新增 `.tt-empty / .tt-empty-title / .tt-empty-desc`。
- 将来接入方式：`_afterAuth()` 里把「不 load」换成「按 `viewGroup` 拉教务课表」即可，`viewGroup` 机制（A/B）已在。

### 9. 门禁升级（本版顺手清偿的过期断言）

本版开始时 `check-notice`(2) / `check-notice-v2`(4) / `check-count-align`(18) / `check-perf`(1) 四处长期红着。逐个核对后确认**都是过期判据**（对着已重构掉的旧代码形态断言），而不是真实缺陷，因此按当前真实设计逐条改写 —— 改法是「换成同语义的真判据」，不是放宽阈值：

| 脚本 | 过期原因 | 处理 |
| --- | --- | --- |
| `check-notice` | 角标口径断言写的是旧口径 `needAck && !x.acked`；另两条钉死了已改写的文案/三元表达式 | 换成新口径断言（排除自己 + 未读游标）；把两条文案/范围断言同步到真实代码形态；**新增 8 条**覆盖本版 8 项需求（辅导员学号 / 通知栏隐藏 / 导出移除 / 折叠 / 班委测试账号 / 全体=本班 / excludeId / markSeen） |
| `check-notice-v2` | `msgDelete` 可见性正则钉的是旧 SQL（`scope='ALL'` 后 200 字内有 `member_id = ?`）；`onLoad` 缓存窗口 260 字太小；`_loadNoticeMembers` 窗口 400 字太小；成员展示断言读的是 `pages/mine`（已迁走） | 改按真实实现形态断言；窗口放宽；读取目标 `pages/mine` → `pages/roster` |
| `check-count-align` | ②③ 两节整体指向 `pages/mine/*`，而「成员与分组」早已迁到 `pages/roster/*`；③ 的解绑断言还是「self 双确认 + `_doUnbind`」时代（现设计是**不给自己解绑入口**） | 读取目标下移到 `pages/roster/*`；③ 按当前自保设计重写（按钮 `isSuper && !mDetailIsSelf`、函数内 `if (mDetailIsSelf) return`、一次 `util.confirm`） |
| `check-perf` | 钉死 `setData({ active: index })` 整串，而实现后来多置了 `popIndex` | 改为前缀匹配 `setData({ active: index`（顺序断言不变） |

同时 `check-timetable-local` 新增 §⑥ 5 条断言锁死需求⑧（身份识别 / 不建网格 / 空态分支在骨架之前 / 切周与分组与 FAB 全隐藏 / 说明标记在位）。

### 10. 改动文件清单

云函数（**已部署**）：
- `cloudfunctions/media/index.js` —— 常量收口（`NOT_TEST/NOT_COUNSELOR/...`）、`pushNoticeMsg` 的 `excludeId`、`classIds` 缺省=本班、`COMMITTEE` 补 `NOT_TEST`、`recipientCount` 的 `ALL/COMMITTEE` 收窄、`ackCount/ackList` 排测试账号、`msgList` 辅导员只看自己发的、调用处传 `me.id`。
- `cloudfunctions/member/index.js` —— `noOf` / `maskedNoOf` / `isTestNo`，三个 `memberList` 分支应用，`public=manage` 新增 `test` 字段。

小程序（**需微信开发者工具上传**）：
- `miniprogram/utils/notice.js`（未读游标 + `estimateLines` + `fold`）
- `miniprogram/pages/notice/index.{js,wxml,wxss}`（markSeen / 折叠 UI / 折叠样式）
- `miniprogram/pages/home/index.{js,wxml}`（角标 memberId、默认本班、显式全选、提交显式传 id、选人网格测试账号判据）
- `miniprogram/pages/mine/index.{js,wxml}`（角标 memberId、通知栏对辅导员隐藏、删 `onExportMine`、个人卡辅导员不显示学号、切换账号判据用 `test`）
- `miniprogram/pages/roster/index.{js,wxml}`（辅导员 seq 哨兵 + `test` 判据、列表行 X 分支）
- `miniprogram/pages/bind/index.wxml`（空学号不渲染）
- `miniprogram/pages/timetable/index.{js,wxml,wxss}`（辅导员空态）

脚本：`scripts/check-notice.js`、`check-notice-v2.js`、`check-count-align.js`、`check-perf.js`、`check-timetable-local.js`。

### 11. 验证与部署

- `node --check` 全部改动 JS 通过；改动文件 UTF-8 校验通过（无 GBK 混入）。
- 21 个离线门禁脚本全绿；`check-api` 映射问题 `none`。
- `media` / `member` 用 `tcb fn code download -e <YOUR_ENV_ID>` 下载后与本地 `index.js` / `common/` / `xlsx-lite.js` **逐字节一致**（`diff -q` 无输出）。
- 线上库口径核对（只读 SQL）：启用班级 5；本班真实收件人 55；跨班全体 199；`recipientCount` 新表达式单班 55 / 跨 1+2 班 112。
- 基线：`.workbuddy/backups/20260926-000913-v0.7.8-通知8项+辅导员学号-课表-入口`（386 文件 / 2.31M）。
- 遗留：通知表当前为**空表**（`notice_msg` = 0 行），所以本版改动没有历史数据需要迁移；`recipientCount` 的 `ALL` 分支对历史行（`n.class_id = 0` 但缺 `notice_msg_class`）仍保留了 `class_id = n.class_id` 的兼容路径。

---

## v0.7.7 · 2026-09-25

主题：辅导员查看班级不再区分「本班」+ 通知「发送班级」高亮修复 + 「按职位」只留预设。

### 1. 通知「发送班级」勾了却没高亮（根因：模板表达式不支持方法调用）

- 现象：辅导员发布通知切到「班级发送」，点选 2 个班级，下方提示已是「已选 2 个班级」，但 2 个班级 chip **没有任何高亮**。
- 根因：高亮判断写在模板表达式里 —— `class="np-cls {{ noticeAllClasses || noticeClassIds.indexOf(item.id) >= 0 ? 'on' : '' }}"`。小程序 WXML 的 `{{ }}` 只支持「属性访问 / 运算符 / 三元 / 字面量」，**不支持方法调用**：`arr.indexOf(x)` 不抛错、不告警，直接恒为假 → 永不落 `on`。全项目 grep 确认仅此一处这么写（`pages/notice` 等页面的同类高亮都是查表对象）。
- 改动（`pages/home/index.js`）：
  - 新增 data `noticeClassPicked: {}`；新增 `_clsPickedMap(all, ids)` —— 把「全部选中」或「显式 id 列表」统一算成 `{classId: true}` 查表对象。
  - `onNoticeToggleAllClasses` / `onNoticeClearClasses` / `onNoticeToggleClass` / `_loadNoticeClasses` 四处同步维护该查表对象（`_loadNoticeClasses` 在班级列表回来后按当前 `noticeAllClasses` 重算，避免「先默认全选、列表后到」时高亮丢失）。
  - `pages/home/index.wxml`：class 绑定改为 `{{ noticeClassPicked[item.id] ? 'on' : '' }}`（纯属性访问）。
- 影响面：仅辅导员可见的「发送班级」区；选中态与提交逻辑（`noticeClassIds` / `noticeAllClasses`）不变，仅补齐视觉高亮。

### 2. 辅导员查看班级不再区分「本班」

- 问题：`pages/classes` 用 `item.isMine` 打「本班」标签并给卡片加 `mine` 高亮。辅导员管理所有班级，标记「本班」既无意义又误导。
- 改动（`pages/classes/index.js`）：data 新增 `isCounselor`；把 `onShow` 内的身份同步抽成 `_syncRole()`，`isCounselor = (profile.groupTag === 'X')`；`authChecked` 未就绪时经 `app.ready().then(...)` 补算一次（`_roleSynced` 防重入），避免登录晚于 `onShow` 时漏判。
- 改动（`pages/classes/index.wxml`）：卡片 class 与「本班」标签都改为 `item.isMine && !isCounselor`（`isMine` 保留为原始事实，仅显示层收敛）。
- 顺带修正权限不一致：「新建班级」按钮原为 `wx:if="{{isSuper}}"`，而 JS 里 `canCreate = isSuper || groupX`、后端 `class.create` 也已放开辅导员 → 按钮改为 `wx:if="{{canCreate}}"`，与 §41 三级权限模型一致。

### 3. 「按职位」只保留 7 个预设，去掉手动输入

- 依据：`member.position` 实际只有 7 种取值，手输会造成自由文本、与后端按值匹配的口径脱节。
- 改动（`pages/home/index.wxml`）：删除手输 `<input>` 与「点上方职位一键选择；多个职位用逗号分隔」说明；`pages/home/index.js` 删除已成死代码的 `onNoticePositions`；`onNoticePosPreset` 增设计数 `noticePosPickedCount`。
- 文案：下方提示改为实时状态 —— 「已选 N 个职位（再点一下取消）」/「点上方职位一键选择，未选将无法发布」；提交拦截文案由「请填写职位（如 班长,副班长）」改为「请至少选择一个职位」。

### 4. 门禁与部署

- `node --check` 通过 `pages/home/index.js` / `pages/classes/index.js`；`check-wxml` / `check-wxss` / `check-segmented` / `check-pages-runtime` / `check-roster-parse` / `check-popup-anim` / `check-today-course` / `check-clean-label` 全 PASS。
- **新增确定性门禁**（`scripts/check-wxml.js`）：扫描 `miniprogram` 下全部 `.wxml`，凡 `{{ }}` 内出现方法调用即报错并给出文件:行号；并内置双向自证（`a.indexOf(b)` 必须被抓到、`picked[item.id]` 不得误报）。此后再犯同类错误会在提交前被拦下，而不是等到用户发现「点了没反应」。
- 既有失败项保持不变：`check-notice`（2）/ `check-notice-v2`（4）/ `check-count-align`（18）/ `check-perf`（1），用改动前基线 `20260925-234433` 复跑计数**完全一致**。
- 本版**纯前端，无云函数改动、无需部署**；`pages/home` / `pages/classes` 需微信开发者工具编译 / 上传生效。

---

## v0.7.6 · 2026-09-25

主题：我的页按身份收敛 + 通知「发送班级」修复与按职位预设 + 班级卡片左滑观感 / 按钮修复。

### 1. 「我的」页按身份收敛

- 问题：辅导员账号的「我的」页出现「导出我的值日表」，但辅导员（`group_tag='X'`）不参与值日轮转，该入口对其无意义。
- 改动：`pages/mine/index.js` 新增 `isCounselor`（`profile.groupTag === 'X'`），在 `onShow` 与 `app.ready()` 回调**两处**写入（避免登录晚于 `onShow` 时漏判）；`pages/mine/index.wxml` 给该行加 `wx:if="{{!isCounselor}}"`。「我的」任务卡对辅导员只剩「通知」一行。

### 2. 通知「发送班级」仅辅导员可见 + 「选不了」修复

- 问题：① 多班级选班区对超管也显示，但超管发布恒发全体，该区无意义；② 「全部班级」是 toggle（再点变全不选），且单班高亮依赖 `noticeClassIds`，全选态下点单班看起来没反应。
- 可见性：`pages/home/index.js` 的 `onNoticeOpen` 把 `noticeShowClasses` 由 `isSuper || isCounselor` 收窄为 **`isCounselor`**，并仅在辅导员时 `_loadNoticeClasses()`；wxml 班级区条件改为 `noticeShowClasses && noticeScope !== 'PICK'`。
- 交互重做：「全部班级」= 一键全选（清空显式 `noticeClassIds`，由后端按全部启用班兜底）；新增「清空」chip；单班 chip 在全选态点击 = 取消该班（`noticeClassIds` 落地为「除它之外的全部」），非全选态 = 增删；回到全量自动折叠回「全部班级」。下方新增 `np-cls-tip` 实时提示「已选 N 个班级」；`onNoticeSubmit` 增加拦截：选了「发送班级」但一个班都没选 → `toast('请至少选择一个发送班级')`。
- 新增样式 `.np-cls.ghost` / `.np-cls-tip`（`pages/home/index.wxss`）。

### 3. 辅导员「按职位」预设 chip

- 口径核对：查库 `member.position` 实际只有 7 种值（班长兼团支书 / 副班长 / 学习委员 / 生活委员 / 组织宣传委员 / 文体委员 / 心理委员），据此设常量 `NOTICE_POSITION_PRESETS`（`pages/home/index.js`）。
- 改动：wxml 按职位区改为 `np-chips` + `np-chip` 预设 chip（`bindtap="onNoticePosPreset"` + `data-pos`），点一下加入 / 再点移除，与手输框（逗号分隔）双向同步（`_posPickedOf` 反推高亮）；可先按班级一键缩小范围再按职位发送。

### 4. 班级卡片左滑观感对齐 + 四按钮点击修复

- 观感：`pages/classes/index.wxss` 删除区 `.cl-del` 改为「居中 trash 图标 + 删除文案」的圆角矩形（`top/right/bottom: 12rpx`、`width: 128rpx`、`border-radius: 20rpx`、底色 `#FFECE8`、字色 `--danger`），与「通知」页 `nt-del-zone` 同款；卡片过渡统一到 `.2s`。
- 根因（四按钮点不动，第二次反馈才定位）：卡片手势用了 **`catchtouchstart/move/end`** —— 祖先 `catchtouchstart` 会让卡片内子元素的 `tap` 无法生成。对照组：「通知」页卡片用 `bindtouchstart/move/end`，其内部按钮一切正常。
- 改动：`pages/classes/index.wxml` 卡片手势 catch→bind 并补 `bindtouchcancel="onSwipeEnd"`，移除操作区上多余的 `catchtouchstart/touchend="noop"`；`pages/classes/index.js` 保留第二重保险（未横向移动不 `setData`、6px 抖动阈值、纵向手势让位）。
- 顺带收窄：导入预览默认勾选由 `(g.willCreate || stat.fresh>0 || stat.diff>0)` 改为 **`(!g.conflict && (stat.fresh>0 || stat.diff>0))`** —— 「将新建」但 `fresh=0 && diff=0` 的组（学号已全属别班）默认**不勾**，避免一键建出空班。

### 5. 门禁与部署

- `node --check` 通过 `pages/home/index.js` / `pages/classes/index.js` / `pages/mine/index.js`；`check-wxss`（home 97 / classes 58 / mine 47 个 class 全定义）+ `check-wxml` + `check-segmented` + `check-pages-runtime` + `check-roster-parse` 全 PASS。
- `check-notice` / `check-notice-v2` 各有 2 / 4 项失败，用改动前基线 `20260925-231719` 复跑失败项**完全一致** → 属既有失败（涉 roster 展示完整学号、msgDelete 可见性等），与本次无关。
- 本版**纯前端，无云函数改动，无需部署**；`pages/mine` / `pages/home` / `pages/classes` 需微信开发者工具编译 / 上传生效。
- 基线 `20260925-231719`，改动 8 文件（mine×2 / home×3 / classes×3）。

### 6. 随版数据修正（非代码）

- 示例班级C（id 2）混入 3 个专业共 87 人（示例专业B3班 10 + 英语2601 20 + 示例专业B1班 57），系更早「按班号静默错配」残留。经授权删除 30 人（id 135–164；删前核查全部未绑定 / 无值日 / 无外键引用 / 关联表计数全 0），class 2 → **57 人**（单一前缀 `0000000001`），残留 0；还原快照 `.workbuddy/backups/20260925-2336-class2-removed-30.restore.sql`。全库终态 **173 行**（60+57+56，含 4 个测试账号）、`student_no` 全库唯一无重复。

---

## v0.7.5 · 2026-09-25

主题：班级管理「左滑删除」+「改名」放开到辅导员 + 导入空班预警。

### 1. 班级左滑删除（超管 / 辅导员）

- 后端新增 `class.delete`（`cloudfunctions/class/index.js`）：仅超管 / 辅导员可调用，**且仅能删「无人班级」**（成员数 > 0 直接拒绝），防成员 `class_id` 悬空。
- 前端 `pages/classes` 班级卡片改为可左滑容器（外层 `relative` + `overflow:hidden`，删除区绝对定位、卡片 `translateX`），仅 `canDelete`（超管 / 辅导员）渲染删除区。

### 2. 改名放开到辅导员

- `class.update` 拆分权限：班级名可由**超管 / 辅导员**修改（改名即应用到全部成员，因成员引用 `class_id`）；学期 / 周数 / 绑定开关 / 大节时间等敏感字段**仍仅超管**。
- 前端卡片新增「改名」按钮（`canCreate` = 超管 / 辅导员可见），配套 rename 弹层。

### 3. 导入「只建班不导人」预警

- 问题：整表导入预览对「将新建」分组，若其成员学号已全部属别班（`stat.fresh === 0 && stat.diff === 0`），勾选后只会建出一个空班级。
- 改动：该组卡片显示橙色警示「勾选后只会新建空班级、不导入任何人」并默认不勾选；确认导入后若新建了班级却 0 人导入，结果弹窗额外提示「如需合并请先删空班级再导入到已有班级」。
- 根因：防串号保护 —— 22:50 那次把同一份文件重复导入，新班级（全名标签）与已有班（短名）不匹配被标 `willCreate`，但每个学号都已归属别班 → 全部跳过 → 只留空班。

### 4. 门禁与部署

- `node --check` 通过 `pages/classes/index.js` / `cloudfunctions/class/index.js` / `utils/api.js`；`check-wxss` + `check-wxml` 对 `pages/classes` 全 PASS。
- 线上 `class` 函数 `updateFunctionCode` 部署成功；invoke 冒烟（未知操作 errCode 41001）确认模块图与路由正常。
- DB 探针：id 4–8 为 22:50 误建的空班级（各 0 成员），可经左滑删除；id 3（示例班级B）56 成员，受保护不可删。

---

## v0.7.4 · 2026-09-25

主题：权限模型重构（超管 / 辅导员 / 普通班委三级）+ 自动建班根因修正。

### 1. 三级权限模型（§41 重构）

- 超管（`is_super=1`）：独占敏感权限 —— 解绑他人 / 设为管理员 / 清空通知 / 停用班级 / 改班级信息。
- 辅导员（`group_tag='X'`）：新建班级 + 发跨班大通知（ALL / COMMITTEE / POSITION）+ 添加成员 + 自动建班。
- 普通班委（ADMIN / MONITOR，非超管非辅导员）：仅管本班成员；发布通知可发「本班成员(ALL)」或「指定成员(PICK，限本班)」，不可跨班、不可 COMMITTEE / POSITION。

### 2. 具体放权

- `class.create` 由 `needSuper` 改为 `needBind` + 显式 `requireSuperOrCounselor`；`update` / `setActive` 仍仅超管。前端 `pages/classes` 新建入口由 `isSuper` 改为 `canCreate`（超管 / 辅导员）。
- `media.msgPublish` 放开普通班委 PICK：`scope` 接受 ALL / PICK；PICK 后端校验 `class_id` 只允许本班成员（防越权选他班）；辅导员不开放任意 PICK。前端 `pages/home` 班委 scope 选项由「仅本班成员」增为「本班成员 / 指定成员」，选人列表经 `targetClassId` 已限本班。

### 3. 自动建班根因修正（更正 v0.7.3 的结论）

- 真实 bug 在 `buildGroups` 用 `resolveLabel` 按「班号」静默把新班级错配到已有同班号班（`willCreate=false`），已用「精确班级名匹配优先」修复。
- 曾误加的 `requireManager`（超管 + 管理员 + 辅导员）属错误方向，已删除（全仓 grep 确认从未被调用）。`createMissing` 始终保持 `requireSuperOrCounselor`（仅超管 / 辅导员）。

### 4. 门禁与部署

- `node --check` 三函数通过；`check-roster-parse` ⑥「自动建班 + 分组」全过。
- 线上 `updateFunctionCode` 成功部署 `member` / `media` / `class`；三函数 invoke 冒烟（未知操作 errCode 41001）确认模块图与路由正常、无语法 / 依赖错误。

---

## v0.7.3 · 2026-09-25

主题：导入「其他班级选择后未自动新建」修复 + 班级名可编辑 + 权限口径。

### 1. 根因（与权限无关）

- `buildGroups` 在整表导入预览阶段走 `resolveLabel` 按「班号」把新班级标签（如「商务示例专业B2班」）**静默匹配**到已有同班号班级（如「示例班级C」id=2）→ `willCreate=false`、预览显示成「→ 示例班级C」而非「将新建」，确认时走 mapping 而非建班。**超管账号同样失败**，证明与权限无关。
- 修复：预览分组改为「**精确班级名匹配**」优先（名字完全一致才算同班，避免「示例专业B3班」错配「示例专业B1班」）；名字不在已有班级且 `autoCreate` 时直接标 `willCreate=true` → 确认时真建。

### 2. 权限口径澄清

- 自动建班属「班级管理」，写入校验保持 `requireSuperOrCounselor`（仅**超管 + 辅导员**），**不放开给普通班委**；曾一度误判为权限拒绝而加的 `requireManager` 已删除（从未调用）。

### 3. 班级名可编辑

- 预览里「将新建」的班级带一个输入框，默认填系统推导名（如 `商务示例专业B2班`），确认前可改；后端用 `payload.createNames[label]` 覆盖默认名。`ensureClass` 仍按名查重，改成已存在的班名会直接复用、不重复建。
- 确认导入入参新增 `createNames`（map：原始班级标签 → 自定义班名）；`applyImport` 用 `createNames[label] || suggestName || label` 作为建班名。

### 4. 门禁

- `check-roster-parse` ⑥「自动建班 + 分组」全 PASS（含「勾选自动新建标 willCreate」「同班号不同专业仍标 weak、不静默导入」等）；线上真实文件探针确认新班级标签现在标 `willCreate=true`；`node --check` 通过。

---

## v0.7.2 · 2026-09-25

主题：导入「一直解析中 / 很慢」根治 —— 跳过云存储往返。

### 1. 根因

- `member` 函数**绑定了 VPC**（`vpc-c4ga6fms`），原流程是「客户端上传文件到云存储 → 云函数在 VPC 内 `downloadFile` 回下载」。**VPC 出网到云存储极慢**：冷启动实测 ~1s、解析仅 3ms，慢点全在回下载。表现为「一直解析中 / 网络错误」。

### 2. 改动

- 客户端选完文件直接 `getFileSystemManager().readFile({encoding:'base64'})`，把 base64 传给云函数（`payload.content`），云函数 `Buffer.from(content,'base64')` 直接解析，**不再走云存储往返**；大文件（>900KB）才回落 `wx.cloud.uploadFile` + `fileId` 兜底。
- 后端 `importExcel` 兼容 `content` / `fileId` 两条入参；csv / xlsx 判定改用 `payload.name`（content 模式下没有 fileId 后缀）。
- ⚠️ 铁律：**绝不**让绑定 VPC 的云函数 `downloadFile` 回下载云存储文件。

### 3. 验证

- 真实 199 行 xlsx：解析 3ms、sheetToText 0.2ms（本地）；`member` 冷启动 1013ms（`Coldstart` 日志确认，非 VPC ENI 慢）。
- 旁证：同一份名单用「粘贴」方式正常（粘贴路径无 `downloadFile`，DB 查询完全相同）→ 慢点确为 `downloadFile`。
- 线上 CodeInfo 已含 `payload.content` / `Buffer.from(content` 分支（ModTime 22:14:21），新代码确已生效。

---

## v0.7.1 · 2026-09-25

主题：解析表格「网络异常」加固（真因在下一版定位）。

### 1. 改动

- `member` 云函数超时 20s → **60s**（冷启动 + 下载文件 + 解析 + 查库，20s 余量偏紧）。
- 解析失败若是**传输层**问题（网络抖动 / 超时），自动**退避重试一次**。
- 解析失败时把**原始原因**直接显示在弹层里（红底块），不再笼统一句「网络异常」。
- 选完文件后显式传递文件标识，不再依赖页面数据时序。
- 新增服务端分段计时日志（下载 / 解析 / 总耗时），便于在云函数日志里定位。

### 2. 排查记录（当时尚未定位真因）

- 已排除：解析器（真实 199 行表格门禁全过）、SQL（两条语句线上实跑正常）、函数部署（线上包已含新代码）。真因在 v0.7.2 定位为 **VPC 内 `downloadFile` 回下载**。

---

## v0.7.0 · 2026-09-25

主题：查看班级「批量导入名单」——一张表含多个班级，自动识别 / 自动建班 / 已有的先比对后跳过。

### 1. 后端：先校验、后写入

- 新增 `annotateExisting(groups, existing)`：把每组的行按「与库里的关系」分类
  - `fresh` 库里没有 → 新增
  - `same` 已存在且**姓名 + 分组完全一致** → **无需写库**（「无问题就跳过」）
  - `diff` 已存在但姓名或分组不同 → 更新（附前 5 条差异：原姓名/原分组/新分组）
  - `other` 学号已属于**别的班级** → 不导入（防串号）
- 新增 `annotateForPreview(pool, rows, groups)`：**预览阶段**就查一遍存量成员再标注 —— 用户在确认之前就能看到「会新增多少 / 有多少差异 / 多少已一致被跳过」。
- `applyImport` 写入阶段：命中 `same` 的行**不再 UPDATE**，单独计入 `unchanged`（原来会被算成 `updated`，口径不准）。
- `buildGroups` 新增 `opts.autoCreate`：整表导入时，解析不出班级的组直接标 `willCreate` + `suggestName`，预览显示「将新建班级 xxx」（真正建班仍需前端显式传 `createLabels` / `createMissing`）。
- 返回体新增 `unchanged`；`perClass` 各计数同步增加 `unchanged`。

### 2. 前端：查看班级新增入口

- 「查看班级」列表底部新增白底描边按钮「批量导入名单（一张表含多个班级）」（`canCross` 即可见）。
- 两步弹层：选文件 → 预览分组 → 确认导入；分组卡显示「新增/有差异/已一致/归它班」，**全一致的组默认不勾选**并提示「无需导入」；`conflict`（班号与学号前缀冲突）默认不勾且提示改用逐班导入。
- 确认后按组构造 `mapping`（已有班级）+ `createLabels`（要新建的）；`createMissing` 仅在有新建时 true —— 后端也只在有新建时才校验「超管 / 辅导员」，纯导入仍是 `needAdmin`。
- 完成后 toast，若有新建班级再弹一次明细，并刷新班级列表。

### 3. 顺带修掉一个真实边界 bug

- `looksLikeClass` 原用「包含『班』」，会把**姓氏带「班」的真实姓名**（如「班超」）误判成班级列 → 该行读不出姓名而整行失败（写 §9 单测时被测试数据「别班的人」暴露出来）。
- 改为：`专升本 / 专业` 任意位置算班级；**「班」只认结尾**（`/班$/`）。既有样本（`示例班级C`、`示例专业B1班`）不受影响。

### 4. 门禁与部署

- `check-roster-parse.js` 新增 §9：`annotateExisting` 断言（一致1/差异1/新增1/归它班1 + 差异清单 + 整组一致时 fresh/diff 均为 0）。
- 全过：`check-wxml` / `check-wxss`（classes 51 个 class 全定义）/ `check-icons` / `check-api`（映射 none）/ `check-pages-runtime` / `check-segmented` / `check-popup-anim` / `check-roster-parse` / `check-xlsx-lite`。
- 部署 `member` 单函数；探针 `invokeFunction(action='importExcel', autoCreate:true)` 返 40001 确认路由在线。
- 备份基线 `20260925-215128`。

---

## v0.6.4 · 2026-09-25（补记）

主题：从聊天选文件时「无文件可选」修复 —— `wx.chooseMessageFile` 的 `extension` 每项**必须带点**（`.xlsx`），写成 `xlsx` 会匹配不到任何文件（表现为「进了聊天一个文件都没有」）。改为**不传过滤**、选完再校验后缀；用户取消不再弹失败；文案补「列表为空 = 该聊天没有文件，先发给文件传输助手」。

---

## v0.6.3 · 2026-09-25

主题：班级口令可随机重置 + 扫码自动填口令。

### 1. 扫码自动填口令

- §43 设定的「口令 / 邀请码等价入场」只在 `checkToken` / `bind` 生效，**`auth.resolveScene` 当时只匹配 `invite_code`**，而入班码的 scene 正是 `invite_code` —— 能解析、能回填。
- 本轮把入班码的 scene 改为**班级口令（`join_token`）**：扫码 → `resolveScene` 命中 token → 绑定页 `_resolveScene` 自动把口令填进输入框（该逻辑本来就有，见 `pages/bind/index.js`）。
- `resolveScene` 的 SQL 改为 `WHERE invite_code = ? OR join_token = ?` —— **已经发出去的旧二维码（带 invite_code）依然可用**，不会因为这次改动失效。

### 2. 口令可随机重置

- 新增 `class.randomToken`（**超管 / 辅导员**，本地校验，不走 `needSuper`）：复用 `nextJoinToken` 生成不与任何班级口令/邀请码冲突的随机 6 位数字，写回 `class.join_token`。
- 前端：入班码弹层「班级口令」行右侧加「随机」胶囊按钮 → `util.confirm` 二次确认（明确告知旧口令与旧二维码会失效）→ 调 `classRandomToken` → 同步更新弹层里的口令、列表里的口令，并**立即重新生成入班码**（scene 变了 → cloudPath 也变 → 不会命中旧图）。
- 抽取 `_regenQr(classId)` 供「打开弹层」与「重置口令」共用，避免两处重复。

### 3. 门禁与部署

- 全过：`check-wxml` / `check-wxss`（classes 38 个 class 全定义）/ `check-icons` / `check-api`（映射 none）/ `check-pages-runtime` / `check-segmented` / `check-roster-parse` / `check-xlsx-lite`。
- 部署 `class` / `poster` / `auth` 三个函数；探针 `randomToken` 与 `resolveScene` 均返 40001 确认路由在线。
- 探针在 `guard.getContext()` 就返回，**未触达 handler**，已复核 `class` 表三行口令仍是原值（<JOIN_TOKEN> / 202601 / <JOIN_TOKEN>），没有被测试改掉。
- 备份基线 `20260925-213953`。

---

## v0.6.2 · 2026-09-25

主题：入班码（班级小程序码）生成修复。

**背景**：`pages/poster` 当初注册了但**全项目没有入口**（邀请/入班码保留未启用），所以 `poster.getQrcode` 与 `getInviteCode` **从未被真正跑过** —— 直到本轮「查看班级 → 邀请码 / 入班码」上线才第一次暴露，三个 bug 一起发作。

### Bug 1 · 云存储路径当成文件 ID（导致必失败）

- `cloud.getTempFileURL({ fileIdList: [...] })` 只接受 `cloud://...` 的 **fileID**，旧代码传的是 `wxacode/<INVITE_CODE>.png` 这种 **cloudPath** → 命中缓存判定永远失败、生成后换链接也失败 → 返回 `url: ''` → 前端整块空白。
- **修**：`cloud.uploadFile()` 的返回值 `fileID` 拿去做 `getTempFileURL`；并且前端在 `url` 为空时**退回用 fileID** —— `<image src="cloud://...">` 本来就是合法用法，保证「码生成了就一定显示」。

### Bug 2 · 只有 release 一次机会

- `envVersion:'release'` 要求**已有发布版本**；开发期必然 41030（invalid page）。
- **修**：先试首选版本，若错误属于「页面不存在 / 未发布」（`isPageMissing`）则换另一个版本（release⇄trial）重试一次；两者都失败才报错，且文案明确指向「先用口令 / 邀请码」。非页面类错误不重试（省一次调用）。

### Bug 3 · openapi 报错不一定抛异常

- `cloud.openapi.*` 失败时可能**正常 resolve** `{ errCode, errMsg }`。旧代码直接取 `res.buffer` → undefined → 抛 `empty buffer`，用户看到的是毫无信息量的错。
- **修**：显式判 `res.errCode` 并转成带 `errCode/errMsg` 的错误再走统一处理，报错文案回显真实原因（截断 60 字）。

### 前端

- `onShowQr` 用 `r.url || r.fileId`；新增 `qrEnv`，当拿到体验版码时在二维码下方提示「只有体验成员扫码能进；正式版发布后会自动换成正式码」；文案改为「可扫码，或直接输入上面的口令 / 邀请码」。

### 门禁与部署

- 全过：`check-wxml` / `check-wxss`（classes 37 个 class 全定义）/ `check-icons` / `check-api`（映射 none）/ `check-pages-runtime` / `check-segmented` / `check-roster-parse` / `check-xlsx-lite`。
- 部署 `poster` 单函数；探针 `invokeFunction(action='getQrcode')` 返 40001 确认路由在线。
- ⚠️ **`getUnlimited` 的真实调用无法在 MCP 侧验证**（需小程序 WX 上下文 + 已发布版本），必须由用户在真机/开发者工具里点一次确认。
- 备份基线 `20260925-212112`。

---

## v0.6.1 · 2026-09-25

主题：成员详情按钮间距 + 点名册（只有序号）也能导入。

### 1. 成员详情按钮贴在一起

- **根因**：`.mb-abtn` 用了 `flex: 1 1 46%` + 容器 `justify-content: space-between`。`flex-grow:1` 会把整行剩余空间全部吃掉，`space-between` 就没有余量可分配 → 两个按钮各占 50%，**中间零间距**。
- **改动**：容器去掉 `space-between`；按钮 `flex: 0 1 46%` + `margin: 0 8% 16rpx 0`，`.mb-abtn:nth-child(2n)` 去掉右外边距 → 一行正好 46% + 8% + 46%。不再依赖 grow 与 space-between 的配合。

### 2. 「序号 + 姓名」点名册（无学号列）

- **背景**：用户桌面有 `示例班级A点名册.xlsx`，只有 `序号 | 姓名` 两列，导入时读不出学号 → 整份名单 0 行有效。
- **可行性验证**：库里每个班的学号都是**统一 12 位、前 10 位相同**（`COUNT(DISTINCT LEFT(student_no,10))=1` 且长度唯一）：示例班级A→`0000000003`、2601→`0000000001`、示例班级B→`0000000002`，后两位即班内序号。
- **改动**：
  - `parseLine` 增加 `seq` 识别（1~999 的小整数，兼容 Excel 的 `1.0`）；`parseRoster` 现在接受「有姓名 + 有学号或序号」的行。
  - 新增 `loadSeqPrefix(pool)`：按班级汇总存量学号，**长度一致 + 前 N-2 位一致 + 全数字**才认为可推导，得到 `{prefix, width:2}`。
  - `applyImport` 新增补全分支：**仅当整份名单都没有学号**（`allMissingNo`）时，按目标班级前缀 + 序号补出学号；补不出的行如实计入 skipped/failed。
  - 预览返回 `missingNo` / `seqSample`，前端分组卡片显示「将按班级学号补齐（如 000000000301）」或「无法按序号补全 —— 请先给这组选一个班」。
- **正确性证明（写进门禁）**：把 `示例班级A点名册.xlsx` 按前缀补出的学号，与 `示例班级A点名册.xlsx` 里的真实学号**逐行比对** —— 56/56 完全一致（`check-roster-parse.js` §8）。
- **安全边界**：只有「整份都没有学号」才走补全（避免正常学号表被误当序号）；无前缀参照的班直接拒绝；绝不猜。

### 3. 门禁与部署

- `check-roster-parse.js` 新增 §7（序号名册单测：序号+姓名、三列、`1.0`、两者皆无→失败）与 §8（真实点名册 + 交叉验证）。
- 全过：`check-wxml` / `check-wxss` / `check-icons` / `check-api`（映射 none）/ `check-pages-runtime` / `check-segmented` / `check-popup-anim` / `check-roster-parse` / `check-xlsx-lite`。
- 部署 `member` 单函数；探针 `invokeFunction(action='importExcel')` 返 40001 确认路由在线。
- 备份基线 `20260925-210711`。

---

## v0.6.0 · 2026-09-25

主题：Excel 直接导入（自动建班）+ 解绑按钮修复 + 提醒入口收口。

### 1. 「解除微信绑定」按钮消失（根因）

- **现象**：已绑定成员点开后，详情里没有「解除微信绑定」「设为管理员」。
- **根因**：`pages/roster` 从「我的」页拆出来时**没有把 `isSuper` / `isAdmin` 带过来**，而 WXML 里用 `wx:if="{{isSuper}}"` 控制这两个按钮 → 恒为 undefined，永远不渲染。属历史遗留 bug（本轮首次被用户发现）。
- **改动**：`roster/index.js` 补 `isSuper` / `isAdmin` / `canManage`，并在 `!app.globalData.authChecked` 时 `app.ready()` 后补一次身份。
- **按钮自适应**：`.mb-abtn` 由固定 `width:328rpx` 改为 `flex:1 1 44%` + `padding` + 省略号，一行两个、放不下自动换行。

### 2. Excel 直接导入 + 自动建班

- **前端**：导入弹层「阶段一」新增「从聊天选择 Excel / CSV」——微信只能从聊天选文件，故用 `wx.chooseMessageFile({type:'file', extension:['xlsx','csv']})` → `wx.cloud.uploadFile` 到 `import/` → 交给云函数解析。预览/确认两阶段与粘贴导入完全一致。
- **新增 `cloudfunctions/member/xlsx-lite.js`**：**零第三方依赖**的最小 xlsx 读取（xlsx = zip + XML）。手动解 ZIP 中央目录 + `zlib.inflateRawSync` 解压，再用正则读 `sharedStrings.xml` / `workbook.xml` / `workbook.xml.rels` / `worksheets/*.xml`；支持 `t="s"` / `inlineStr` / `str` / 布尔 / 公式缓存值。不支持 `.xls`（旧二进制）与 ZIP64。
  - 为什么不用 SheetJS：云函数依赖会带来额外的安装/打包失败面，而 xlsx 结构用 Node 自带能力已足够。
- **新增 `member.importExcel({fileId, sheetIndex?, preview?, mapping?, createLabels?, createMissing?})`**：下载云存储文件 → 解析 → 复用 `parseRoster` 与「分组 / 写库」链路（本轮把 importCsv 内的分组与写库逻辑抽成 `buildGroups` / `applyImport` / `previewOf`，文本与 Excel 两条链路共用）。
- **自动建班**：`createLabels` 里的标签走 `ensureClass` —— 名字已存在则复用，否则新建（`deriveClassName` 把标签补成「xxx班」，`allocClassKeys` 生成唯一 6 位口令 + `CLS26A` 序号邀请码，学期/周数/大节时间继承 class id=1）。**建班属班级管理，仅超管 / 辅导员可勾选**（后端 `requireSuperOrCounselor`）。
- **注意**：预览阶段**不删**上传的文件（确认导入还要用），导入完成/失败后才 `deleteFile`。

### 3. 右下角提醒胶囊只在未开启时显示

- 需求：只在「还没打开微信通知」时出现；开启后隐藏（避免长期占屏）。
- 改动：`wx:if="{{!unbound && !loading && !failed && !remindOn}}"`，文案固定「打开微信通知」，去掉 `.remind-fab.on` 态样式；测试提醒入口保留在「我的 → 微信通知」。

### 4. 门禁与部署

- **新增 `scripts/check-xlsx-lite.js`** + 仓库内置样本 `scripts/fixtures/roster-mini.xlsx`（由 `scripts/fixtures/make-roster-mini.py` 用标准库手写最小 OOXML 生成，覆盖 sharedStrings 与 inlineStr）。若本机存在桌面「学生信息表.xlsx」还会额外校验 **200 行 / 5 组 / 57·56·56**。
- `scripts/check-roster-parse.js` 扩展：新增 `deriveClassName` / `buildGroups` 断言（willCreate、已存在班级不受影响、同班号不同专业标 weak、匹配不到保持未定）。
- 全过：`check-wxml` / `check-wxss` / `check-icons` / `check-api`（映射 none）/ `check-pages-runtime` / `check-segmented` / `check-popup-anim` / `check-roster-parse` / `check-xlsx-lite` / `check-today-course`。
- 历史遗留（非本轮引入）：`check-notice` 2 项（断言旧的 msgPublish「两种范围」措辞与旧换班 toast）、`check-perf` 1 项、`check-notice-v2` 4 项、`check-count-align` 18 项。
- 部署：`member` 单函数（含新增 `xlsx-lite.js`）；探针 `invokeFunction(action='importExcel')` 返 40001 确认新路由上线。
- 备份基线 `20260925-200538`。

---

## v0.5.0 · 2026-09-25

主题：名单导入增强（列序自适应 / 多班级批量自动分类 / 可撤回）+ 班级成员增删。

### 1. 数据修正（先处理已发生的事故）

- **背景**：用户把 示例班级B（小学教育）的名单导进了 示例班级C，5 条落到 `class_id=2`（学号 `0000000002xx`）。
- **处理**：核对全库后把这 5 条（id 130–134）改归属到 `class_id=3`（示例班级B），而不是删除 —— 它们本就属于 示例班级B，移动后既修正了班级，也不必日后重复导入。
- **修正后核对**：class 1（示例班级A）= 56 人 + 4 测试账号；class 2（示例班级C）= 57；class 3（示例班级B）= 5（其余待导）。

### 2. 新增表（可撤回）

```sql
import_batch      (id, class_id, operator_id, label, total, inserted, updated, created_at, reverted_at, reverted_by)
import_batch_item (id, batch_id, member_id, action('INSERT'|'UPDATE'), prev_name, prev_group)
```

- 每次 `importCsv` 落一条 batch；INSERT 项记 member_id，UPDATE 项记改前的 name/group。
- 撤回 = 删 INSERT（**已绑定微信 / 已有值日记录则跳过并计数**）、还原 UPDATE，然后标记 `reverted_at`。

### 3. 后端 `member` 云函数

- **解析器**（列序自适应）：按「这一格像什么」认列 —— 学号=4 位以上纯数字；姓名=中文/字母且排除性别、班级字样；班级=含「班/专业/专升本」。支持逗号 / 中文逗号 / 制表符 / 竖线 / 连续空格分隔，自动跳过表头行。
- **自动分类**：`resolveLabel` 优先级 = 学号前缀命中 > 班号命中；两者不一致标 `conflict`；只按班号命中且与该班已有前缀不符标 `weak`（同班号不同专业的辨识信号）。前缀来自存量成员的 `student_no` 前 10 位，能区分 `0000000001xx`（示例专业B1班）与 `2608030201xx`（示例专业B3班）。
- **写入策略**：同班已存在 → 更新姓名/分组；**已存在于其它班 → 跳过并报告**（防跨班串号）；新学号 → 插入。
- **新 action**：`importCsv`（含 `preview` 预览模式与 `mapping` 显式映射）、`importBatches`、`revertImport`、`addMember`、`removeMember`。
- **权限**：`addMember` / `removeMember` / `revertImport` 需**超管或辅导员**（本地 `requireSuperOrCounselor`，未改 `common/guard.js` 以免全量重部署）；`importCsv` 仍是 `needAdmin`。

### 4. 前端

- `pages/roster`：顶部加「添加」按钮；导入弹层改为两步（粘贴 → 预览分组 → 确认）；预览里每组可勾选、可「选班」，weak/conflict/未匹配组默认不勾选并给出橙色提示；导入完成后弹窗直接提供「撤回」；同时提供常驻「撤回最近一次导入」入口。
- 成员详情新增「移出班级」（超管/辅导员、非本人、未绑定时可见）。
- `utils/api.js` 新增 `importBatches` / `revertImport` / `addMember` / `removeMember`。

### 5. 门禁

- **新增 `scripts/check-roster-parse.js`**：从 `member/index.js` 抽解析函数 eval（与生产同源），校验列序自适应、表头跳过、整表分组、自动分类（含 weak/conflict）、奇偶分组。若本机存在 `.workbuddy/_tmp_roster.csv` 还会额外校验真实 199 行名单。
- 全过：`check-wxml` / `check-wxss` / `check-icons` / `check-api`（映射 none）/ `check-pages-runtime` / `check-segmented` / `check-popup-anim` / `check-roster-parse`。
- 部署：`member` 单函数 `updateFunctionCode`（ModTime 2026-09-25 19:47:47）；用 `invokeFunction(action='revertImport')` 探针确认新路由已生效（返回 40001 = 路由存在但无 WX 上下文）。
- 备份基线 `20260925-194732`。

---

## v0.4.0 · 2026-09-25

主题：多班级系统（§43）+ 首页 / 课表体验调整（本轮 5 条需求）。

### 1. 多班级系统（§43 主线）

- **背景**：从单班（示例班级A）扩展为多班级；超管 / 辅导员需跨班管理；通知需支持多目标。
- **数据模型**：新建 `class` 表（id / name / join_token / invite_code / term_start / total_weeks / bind_open / period_time / is_active）；12 张业务表（member / course / session / duty / duty_log / swap_request / leave_request / notice / notice_msg / notice_msg_target / notice_msg_read / notice_msg_delete）+ `schedule_rules` / `session_shift` 加 `class_id`（默认 1）；`schedule_publish` 主键改 `(class_id, week)`；新建 `notice_msg_class`（跨班通知目标班）。
- **存量兼容**：所有存量数据 `class_id=1`；`class` 表 id=1 缺失时 `week.getConfig` 回退 `class_config`。
- **后端**：`common/week.js`（`getConfig(pool,classId)` / `loadSessionShifts(pool,classId)`）、`common/guard.js`（`classIdOf` / `isCounselor`）；`auth` / `member` / `course` / `duty` / `export` / `schedule` / `cron-weekly` / `adjust` / `media` / `poster` 全部按 `class_id` 隔离。
- **新增云函数**：`cloudfunctions/class`（action `list` / `detail` / `create` / `update` / `setActive`；口令 6 位随机、邀请码 `CLS26A` 序号自增，服务端保证唯一）。
- **MySQL 8 注意**：`8.0.30-cynos` 不支持 `ADD COLUMN IF NOT EXISTS` / `ADD INDEX IF NOT EXISTS`，迁移走 MCP `runStatement` 逐条执行。
- **代码位置**：`cloudfunctions/{common,class,auth,member,course,duty,export,schedule,cron-weekly,adjust,media,poster}`。

### 2. 进入小程序首屏不显示「查看班级」

- **现象**：首次进入首页看不到「查看班级」，切到别的 Tab 再回来才出现。
- **根因**：`pages/home` 的 `onShow` 早于登录完成，`app.globalData.profile` 还是 `null` → `canViewClass=false`，之后没有任何时机重算。
- **改动**：抽出 `_applyIdentity()`（按 profile 重算 `adminTag/adminTier/canViewClass`）；`onShow` 里若 `!app.globalData.authChecked` 则 `app.ready().then(重算 + 必要时 load(true))`；身份指纹纳入 `classId`。
- **文件**：`miniprogram/pages/home/index.js`。
- **验证**：`check-today-course`、`check-perf`、`check-pages-runtime` 通过。

### 3. 首页区块重排 + 提醒改悬浮

- **需求**：管理员入口（成员与分组 / 发布通知）放到「明日课次」下面，接着「查看通知」；「开启提醒」不占整卡，改悬浮。
- **改动**：WXML 顺序调整为 明日课次 → 管理员卡 → 查看通知 → 查看班级 → 待办条；原「提醒卡」删除，新增右下角固定胶囊 `.remind-fab`（未开启点开启、已开启点发测试提醒），定位 `right:32rpx; bottom: calc(124rpx + env(safe-area-inset-bottom))`。入口文案统一为「打开微信通知 / 已打开通知」（原「开启值日提醒 / 已开启提醒」），`onRemind` / `_enableRemind` 的 toast 同步改为「已打开微信通知」。
- **文件**：`miniprogram/pages/home/index.{wxml,wxss}`。
- **验证**：`check-wxss`（`pages/home` class 全覆盖）、`check-popup-anim`。

### 4. 班级管理「查看人员」

- **需求**：点击班级可查看该班人员，类似「成员与分组」。
- **改动**：班级卡片新增「查看人员」主按钮 → `pages/roster/index?classId=&name=`；`roster` 支持 `classId` 入参，统一经 `_payload()` 把 `classId` 透传给 `memberStats/memberList/importCsv/updateGroup/setStatus/setRole/unbind`（后端 `targetClassId` 已支持，超管 / 辅导员才允许跨班），导航标题显示「{班级名} · 成员」。
- **文件**：`miniprogram/pages/classes/index.{js,wxml,wxss}`、`miniprogram/pages/roster/index.{js,wxml}`。
- **验证**：`check-pages-runtime`（`pages/classes`、`pages/roster` 生命周期正常）。

### 5. 课表页布局调整

- **需求**：临时调课移到左边、加号留右边；整体缩小；表格自适应屏幕宽高；没课不显示周六日，调课后有课则显示。
- **改动**：
  - `pages/timetable/index.js`：列宽不再写死 —— 显示天数 ≤5 时按右侧可视宽等分（铺满不滚动），含周末时用 110rpx + 横向滚动；新增 `showDows` 逻辑（周末有课含「调课调入」才补周六日）；新增 `_fitHeight()` 按屏幕高度算行高（夹在 104~168rpx）。
  - `index.wxml`：行高 / 表头高 / 总宽改内联下发；「左右滑动」提示仅出现周末列时显示；FAB 交换位置（临时调课 `left:32rpx`、加号 `right:32rpx`），去掉互相抬高的 `.fab.up`。
  - `index.wxss`：`.tt-head-cell` / `.tt-cell-slot` 改 `flex:1; height:100%`；表格整体缩小（`.tt-foot` 240→48rpx，FAB 112→96rpx）。
  - `scripts/check-pages-runtime.js`：课表断言由「固定 7 列」改为「动态列（∈{5,7}）」，校验行数恒为 5、表头与格子 dow 对齐、`dateWidth = 列数 × colW`。
- **文件**：`miniprogram/pages/timetable/index.{js,wxml,wxss}`、`scripts/check-pages-runtime.js`。
- **验证**：`check-pages-runtime`（16 周 × 5 行，列数 ∈ {5} 全部对齐）、`check-session-shift`、`check-ai-plan`、`check-timetable-local`、`check-week`、`check-fixed-layers` 全部通过。

### 6. 本轮统一门禁结论

- 通过：`node --check`（timetable/home/roster/classes）、`check-wxml`、`check-wxss`、`check-icons`、`check-segmented`、`check-popup-anim`、`check-pages-runtime`、`check-today-course`、`check-session-shift`、`check-ai-plan`、`check-timetable-local`、`check-week`、`check-fixed-layers`、`check-api`（映射 none）。
- 历史遗留（非本轮引入）：`check-perf` 1 项（`custom-tab-bar` 乐观选中顺序）、`check-notice-v2` 4 项、`check-count-align` 18 项。
- 本轮为**纯前端 + 门禁脚本**改动，未改云函数，**无需部署**。

---

<!-- 新版本请追加在本行上方（最新在上） -->

## v0.3.0 · 2026-09-23

主题：通知与成员体验整合 + 性能优化 + 测试 / 正式隔离。

- **通知闭环**：`media` 云函数补齐发布 / 接收 / 回执（发布人、超管可见确认人数与序号）；订阅消息提醒模板接入（值日 / 通知）。
- **成员与分组页**：查看全班、按分组筛选、设置班委与职位（`roster` 页 + `member.setPosition`）。
- **校历与临时调课**：`session_shift` 临时换课，调课后周末自动显示（`pages/timetable` + `check-session-shift`）。
- **自定义 tabBar**：原生自定义底部栏，替代系统 tabBar（`custom-tab-bar/` 组件）。
- **首屏性能**：云函数预热、`utils/notice` 缓存先渲染再刷新、`page-anim` 无变化不重载（`check-perf` 系列门禁）。
- **测试 / 正式版隔离**：测试账号 + 辅导员（X 组）账号体系；学号显示末两位；超管可切换测试账号验证视角（§27 ~ §34）。
- **修复**：tabBar 闪烁（§35 / §37 / §58）、弹层滚动穿透（§54）、通知页打开慢（§20.5）等（详见 DETAILS.md §20 ~ §42）。

---

## v0.2.0 · 2026-09-18

主题：值日轮转与排班自动化。

- **值日自动排班**：学号末位奇偶分 A / B 组，按 `duty_count`、学号顺序轮转，跨周连续不重复，整班轮完重置（`duty` + `schedule_solver` 相关逻辑）。
- **每日清扫 410 教室**：4 节课后、周一至周五，与课程值日共享轮转池，仅值日页展示、不进课表（§16 / §16.1 / §16.2）。
- **AI 排班**：DeepSeek 自然语言生成值日计划，本地按「日期 + 节次」落库，保洁由 `fillCleaningByRotation` 补齐（§7 / §16.1）。
- **换班申请 + 生活委员确认**；手动排班页（超管）（§4 / §18 / §26）。
- **绑定防爆破**：绑定入口开关 + 学号可推算防护三层防线（§32 / §33）。

---

## v0.1.0 · 2026-09-14

主题：MVP 首发 —— 班级任务安排助理上线。

- 技术栈：原生小程序（WXML / WXSS / JS）+ CloudBase（MySQL 14 表、11 个云函数、78 个 SVG 图标）+ openid 登录。
- **示例班级A数据初始化**：示例学生、学期 16 周、加入口令 `<JOIN_TOKEN>`、邀请码 `<INVITE_CODE>`、`student_no` = 学号末 2 位。
- **两级管理员**：6 名 ADMIN 管课程 / 通知；示例成员01（学号 1）为唯一 SUPER，拥有解绑、值日、全课表管理权限。
- **可复现数据库脚本**：`init.sql`（含 `is_super` 列）+ `import_members.sql`（按 `student_no` 追加管理员 UPDATE）。
- 基础课表、值日提醒、通知雏形（详见 DETAILS.md §1 ~ §19）。

---

<!-- 早期逐轮修复（通知、值日轮转、换班、订阅消息、校历与临时调课、绑定防爆破、成员与分组等）的详细记录见 `.workbuddy/memory/DETAILS.md` §1 ~ §42。 -->
