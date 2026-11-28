# 口径决策记录（DECISIONS.md）

> 目的：把「动手前钉死的需求口径」落成可追溯记录，防止 M4（用户口径未钉死就动手，返工量最大）复发。
> 与 `RULES-RECURRENCE.md` 的关系：那六节是**规则**，本文件是**规则的实例流水**——每条都对应一次真实确认，供 `check-decisions.js` 核对「有可追溯记录」，供人回看「当时为什么这么做」。
>
> ⚠️ 能力边界：`check-decisions.js` **只查记录存在性与结构**，不查记录内容对不对。正确性靠用户在动手前点头（AskUserQuestion），不靠正则。这是刻意的设计——把一个无法自动化的判断伪装成自动检查，只会制造 M2 假绿。

## 记录格式

每条决策一个 `## <YYYY-MM-DD> · <短标题>` 段，必含四行：

- **需求原话**：用户提出诉求的原话（不改写、不美化）。
- **我理解的口径**：动手前复述的、经用户确认的目标与边界。
- **触发文件**：本次口径覆盖的呈现类文件路径（wxml/wxss/admin-web public 等），供门禁关联。
- **确认结果**：用户明确的答复原文（如「确认，开始执行」「按推荐来」）。

> 纯逻辑修复、门禁脚本、发版脚本、文档改动**不需要**记录——它们不改用户可感知的呈现/行为，不属于 M4 返工源。

---

## 2026-11-27 · 用 grilling 追问「别默认我的问题定义正确」这条要求本身

- **需求原话**：「不要默认我提出的问题定义就是正确的。你先分析我真正想解决的底层需求，判断我有没有把症状误认为原因、把手段误认为目标。如果存在更值得解决的问题，直接指出来。」
- **我理解的口径**：用户不是要「我以后每次都质疑」，而是要「别因方向错而返工」。表层要求（让我先质疑）是手段，真实目标是减少返工。更值得解决的问题是上一轮复盘里 M4 我自己写下的「自动化承载：无」——返工量最大的一类却留着纯文本规则。经三轮追问确认：
  - Q1：作为长期原则，但**只在关键分叉触发**，不是每轮都质疑（避免弹窗疲劳与拖慢）。
  - Q2：目标是补 **M4 自动化承载为空** 的缺口，不是改「我回答前先分析」这个行为。
  - Q3：采用**分层承载**——正向预防靠关键分叉前置确认 + 决策落盘；自动化只做两件真事（查记录可追溯性、反向门禁钉死已回退特性），不造假绿门禁。
- **触发文件**：`DECISIONS.md`（新建）、`scripts/check-decisions.js`（新建）、`scripts/run_all_gates.sh`（接入）、`RULES-RECURRENCE.md`（M4 自动化承载更新）、双仓 `README.md`。
- **确认结果**：「按推荐来」→「我不知道三个都有什么区别，按最优的来」→「确认，开始执行 (Recommended)」。

---

## 2026-11-27 · 从第一性原理修「门禁检测信号源错配」

- **需求原话**：「从第一性原理出发，找到最本质原因，修复一下」。
- **我理解的口径**：不是再叠一个门禁，而是找检测层本身的错配。用 diagnosing-bugs 建隔离回路实测：门禁用 `git diff --name-only HEAD` 作信号源，而 `git diff` **看不见未跟踪文件**；「口径未钉死就动手」最高发场景恰是**新建页面/新交互**（返回 untracked）⇒ 最该触发时反而假绿。A/B 对照锁因：A 未跟踪新 wxml 假绿（exit 0），B `git add -N` 后同一文件立刻抓到（exit 1）。本质 = **表征（git 看见的变化）≠ 实体（用户可感知的呈现改动）**，防护装在最不会触发的地方。
- **触发文件**：`scripts/check-decisions.js`（信号源扩为 `git diff ∪ git ls-files --others --exclude-standard`，加信号源守卫 + 2 条变异自证）。
- **确认结果**：用户「修复一下」授权；diagnosing-bugs Phase 1 红色回路已实测、Phase 5 回归测试已固化、Phase 6 探针已清除。
- **修复后回路复测**：A/B 均 exit 1 并命中 `covered::`；门禁 11/11 自证全抓，零误报。

---

## 2026-11-27 · 二阶推演后发现「信号源修了、判定通道没修」，抽共享原语收口

- **需求原话**：「不要只考虑这个改动产生的直接效果。继续推演它的二阶、三阶影响，尤其关注对其他模块、用户行为、系统复杂度和长期维护成本的潜在影响。」→「我点错了，没看到选项，按推荐来」→ 选「抽共享原语并修残留 (Recommended)」。
- **我理解的口径**：不是继续叠门禁，而是把反复出现的同一根因（表征≠实体的信号源错配）收敛到一个实现。推演实证：① `git diff HEAD -- <未跟踪文件>` 输出 0 字节，而 `ls-files --others` 能看到它 ⇒ 上一轮虽然把未跟踪文件纳入 `changedFiles()`，但 `addedLinesOf()` 仍走 `git diff` ⇒ **新建 js 含 `wx.navigateTo` 依旧假绿**；② `check-no-api-key.js` 只用 `git ls-files -z`（受跟踪），未跟踪文件里硬编码 key 在私有仓门禁假绿；③ `normalize-eol.js` 早在 11-16 自行补过 `--others`，同根因第三次各写各的。经用户确认按推荐执行。
- **触发文件**：`scripts/lib/changed-files.js`（新建共享原语）、`scripts/check-decisions.js`、`scripts/check-no-api-key.js`、`scripts/normalize-eol.js`、`scripts/check-recurrence-rules.js`（守卫三处接入）。
- **确认结果**：「我点错了，没看到选项，按推荐来」→ 选择「抽共享原语并修残留 (Recommended)」。
- **落地与回路**：A/B 真实文件系统验证 —— 新建未跟踪导航 js ⇒ 口径门禁翻红且命中 `covered::`，删除后转绿；新建未跟踪硬编码 key 文件 ⇒ 密钥门禁红且命中文件，删除后转绿。三门禁自证 13/13、13/13、5/5 全抓。

---

## 2026-11-28 · 课表长按菜单按钮失效 + 遮罩矩形边缘

- **需求原话**：「课程表页，长按课程后的按钮没作用，并且点击边上后，按钮消失过程中，灰色遮罩边缘太明显了一个矩形。」（附 4 张真机截图：按钮已展开但点击无响应；遮罩淡出时露矩形边）
- **我理解的口径**：这是明确的 bug 修复，无口径分歧——① 格子长按菜单的三个圆形按钮点击必须生效（进入对应调课设置）；② 菜单出现/消失时遮罩边缘要柔和、不露矩形；③ 保持深浅色安全与既有「左下角悬浮按钮菜单」的拖动松手选中行为不变。诊断确认两个独立根因：按钮不可点是 `.rm-root` 的 `pointer-events:none` 继承到 `.rm-item` 致其 `bindtap` 收不到；矩形边缘是遮罩的 `press-shrink` 按压缩放 + 纯色背景（1.0.8.72 已在弹层遮罩修过、本组件漏同步）。
- **触发文件**：`miniprogram/components/radial-menu/index.wxml`、`miniprogram/components/radial-menu/index.wxss`（按钮 `pointer-events:auto` + 遮罩去按压缩放、改径向渐变）。
- **确认结果**：用户以 bug 报告形式授权修复，并在模式切换后明确「请继续完成未完成的任务」。诊断回路（真实 week.js 症状回放 + 门禁判据）先行判红，修复后转绿，未引入新的交互口径。

---

## 2026-11-28 · 演讲名单顺序改为轮转出场序 + 课程长按改为拖拽松手选中

- **需求原话**：①「先是 56，完了才是 2 号，56 在前面」（附截图：演讲卡上午 B 组显示「示例成员02 2 / 示例成员56 56」）；②「课程长按也是和左下角的按钮一样，而不是现在长按后再点按钮」（附截图：格子长按后弹出三个圆形按钮，仍需再点一下）。
- **我理解的口径**：① 组内顺序是**轮转出场序**，不是学号升序——游标走到 56 后回绕到 2，所以 56 必须排在 2 前面；AUTO 行按 `plan.rows` 顺序 `INSERT`，`speech.id` 递增即出场序，按 `student_no` 排会把回绕场景翻成 2→56。② 课程格子长按的交互口径**与左下角 FAB 完全一致**：按住展开、手指拖到选项上高亮、松手即选中、拖到空白处松手收回——不是当前「长按展开后再点一下按钮」。两处都要保持深浅色安全与既有弹层行为不变。
- **触发文件**：`cloudfunctions/schedule/index.js`（speechList 与 loadSpeechSessions 两处 SQL 的 `ORDER BY` 由 `m.student_no` 改 `sp.id`）、`miniprogram/pages/timetable/index.wxml`（page-meta 加 `rmShow` 锁滚动；有课格 + 空格子绑 `touchstart/catchtouchmove/touchend/touchcancel`；课程菜单加 `id="rm-cell"`）、`miniprogram/pages/timetable/index.js`（新增 `onCellTouchStart/Move/End` 转发给 `#rm-cell` 的 `moveTo/release`）。两处 SQL 与两处格子属同源，必须一起改（M1 同源漏改）。
- **确认结果**：用户以 bug 报告 + 体验口径形式直接授权，无需选择。两个反馈回路均先判红再修：`check-speech-rotate-order.js`（症状回放按学号复现 2→56、按 id 得 56→2 + 两处 SQL 接线 + 4 变异，红→绿）、`check-radial-menu.js` 扩展 `cellTouchForward`（判据红 + 3 变异，红→绿）。诊断阶段向用户展示了根因定位（SQL 排序字段 / 格子缺 touch 转发），用户未要求改口径。

---

## 2026-11-28 · 信息页班费显示「剩余班费」 + 后台单独授予「临时调课」

- **需求原话**：①「小程序信息页，班费下面……当前班费显示剩余班费」（附截图圈出「当前班费 ¥2800」）；②「后台管理页面，成员页，编辑成员可增加权限，设置课程表、调课」；追问后收窄为「仅调课权限吧」；③「后台页面要和小程序相照应，就是我在后台给谁权限，谁的小程序页面就会有相应权限的按钮，而不是每次都要更新小程序再上传审核」。
- **我理解的口径**：① 信息页那行读数必须是**余额**（后端 `feeSummary.class.balance = total − 已消费`）而不是总额，文案同步改「剩余班费」；字段名 `feeTotal` → `feeBalance`，避免状态语义漂移（M5）。② 只做**临时调课**一项，不做「设置课程表」；沿用 `speech_perm` 的「后台单独授予 + 登录实时下发」模式：写 `member.shift_perm`，`auth.login` 每次下发 `profile.canShift`，小程序课表页入口只读下发值——**后台改权限后无需发版/审核**。③ 不放宽 `requireCommittee`（还守着请假登记等），只给 `course.shiftSet/shiftRemove` 新增 `needShiftAuth`；原有班委的后端调课权不变，小程序入口仍维持「超管 + 被授权者」的窄口径，避免一次改动让所有班委突然多按钮。
- **触发文件**：`miniprogram/pages/classinfo/index.wxml`（文案 + `feeBalance` 绑定）、`miniprogram/pages/classinfo/index.js`、`cloudfunctions/admin-web/public/app.js`（成员编辑「单独授予权限（临时调课）」勾选框、列表 `+临时调课` 标签）、`cloudfunctions/admin-web/lib/mod-member.js`、`cloudfunctions/common/guard.js`、`cloudfunctions/course/index.js`、`cloudfunctions/auth/index.js`、`miniprogram/pages/timetable/index.{js,wxml}`、`scripts/migrate-shift-perm.sql`。
- **确认结果**：两处 AskUserQuestion 明确收窄：授权层级选「小程序端能力」；课表动作从「发布个人课表到全班」改「仅调课权限」。门禁先判红后修绿：`check-classinfo-fee.js`（20/20）、`check-classinfo-switch.js`（71/0）、`check-shift-perm.js`（12/12，5 变异全抓）。呈现类改动已按当日记录覆盖。

---

## 2026-11-28 · 调课交互四项玻璃弹层 + A/B 分组筛选 + 通知动作

- **需求原话**：「长按某个课程格子……长按后是这个样式，图片中白色底改成类似于底部导航栏的玻璃样式，仅本周调是这个样式，无需开始节次和结束节次，直接就是节次，一共五大节，1、2、3、4、5，无需调课原因。」「选择课次现在不清晰，ab组都混在一起比较杂乱，要筛选区分 A 组和 B 组，大课默认 AB 组都显示，调大课不论选的 A 组还是 B 组，都会一起调。」「调课应用后下面弹出存在 5 秒的提醒条，可选提醒条点击可同步更新值日和课前演讲。」「信息页增加通知……普通成员的信息页-通知，提醒调课，班费登记新的消费后也会写入通知。再检查还有无其他可以通知的。」
- **我理解的口径**：① 课程长按不再展开三项弧形菜单，改为一步进入四项玻璃弹层：仅本周调 / 多个周次 / 本周不上 / 编辑课程；左下角 FAB 的弧形菜单保持不变。② 单周次调课只保留五大节 1~5 的落位选择，不出现开始节次 / 结束节次 / 调课原因。③ 临时调课课次选择器默认「全部」，另可筛 A / B；全班课（`group_scope` 为空）在三种筛选下都显示；独立 A/B session 仍按各自节次独立调，不按课程名联动。④ 调课成功后的 5 秒提醒条是可选动作，点击才强制按当前游标重排值日与课前演讲；重排范围为源周 + 目标周，目标周仅在其前一周已有排班时继续轮转。⑤ 通知复用 `notice_msg` + `notice_msg_target` 双记录；调课按能力位分别定向，班费新增消费双记录分层，请假审批仅通知申请人；信息页恢复通知入口。⑥ 动作通知需后端二次鉴权、一次性消费，防止双击与并发重复消耗游标。
- **触发文件**：`miniprogram/pages/timetable/index.js`、`miniprogram/pages/timetable/index.wxml`、`miniprogram/pages/timetable/index.wxss`、`miniprogram/pages/classinfo/index.js`、`miniprogram/pages/classinfo/index.wxml`、`miniprogram/pages/notice/index.js`、`miniprogram/pages/notice/index.wxml`、`miniprogram/pages/notice/index.wxss`、`miniprogram/utils/notice.js`、`miniprogram/utils/api.js`、`cloudfunctions/common/system-notice.js`、`cloudfunctions/course/index.js`、`cloudfunctions/schedule/index.js`、`cloudfunctions/fee/index.js`、`cloudfunctions/common/review-demo.js`、`scripts/check-shift-ui-v2.js`、`scripts/check-shift-resync.js`、`scripts/check-system-notice.js`、`scripts/check-radial-menu.js`。
- **确认结果**：用户通过多轮 AskUserQuestion 明确选择「长按直接进入图二弹层」「全班课=空 group_scope」「强制按当前游标重排」「复用 notice_msg 双记录」「请假审批仅通知当事人」「重排源周+目标周且目标周看前一周是否已排」「按能力位分别定向」「班费双记录分层」「A/B 筛选默认全部」，并两次要求继续完成未完成任务。口径录于此，门禁只查可追溯性，不替代正确性判断。

---

## 2026-11-28 · 调整课程弹层三档吸附 + 弧形菜单避底栏 + 加号几何居中

- **需求原话**：「调整课程页显示不全，可以上下拖动，到30%、50%、顶部的位置有弹性吸附。」「临时调课会被底部导航栏遮挡，不要重合了。」「右边加号不在圆形中心。」「改动的所有功能都可以正常使用吗，例如调课，通知等，检测一下确保全部可用再出结果。」（附三张真机截图）
- **我理解的口径**：① 长按课程的「调整课程」弹层要一次容纳四项，并支持 Drag + Spring 的 snap points：可见 30% / 50% / 顶部三档；detents 用面板下移比例表达，分别是 0.7 / 0.5 / 0，非顶部档保留轻微 overshoot，边界超额继续 Rubber-banding。② 左下角弧形菜单的「临时调课」不得压到悬浮 tabBar：radial-menu 接收真实 `tabbarPx` 作为底部让位，仍整条弧平移，保持等间距与拖拽命中一致。③ 右下角「＋」不再依赖全角字形重心，改为横竖两条绝对居中的几何线。④ 「确保全部可用」按项目纪律只能做到确定性门禁、真函数回放、云函数线上包核验与路由冒烟；真机视觉与手势仍需用户设体验版验收，不得声称已完成真机验证。
- **触发文件**：`miniprogram/pages/timetable/index.js`、`miniprogram/pages/timetable/index.wxml`、`miniprogram/pages/timetable/index.wxss`、`miniprogram/components/radial-menu/index.js`、`miniprogram/components/bottom-sheet/index.js`、`scripts/check-timetable-polish-1093.js`。
- **确认结果**：用户以真机截图 + 明确诉求直接授权，无口径分歧；先建 `check-timetable-polish-1093.js` 判红（16 红），再修绿，并保留三组变异自证。

---

## 2026-11-28 · 启动预热五 Tab 首屏数据，切页秒显

- **需求原话**：「小程序打开后，五个页面都开始加载，而不是点到课程表、信息等页面后才开始加载。」澄清后用户明确：「是我需要让五个页面都开始加载，现在是我点开哪个页面，哪个页面才加载，这样首页加载完了，我想看值日或者课程表，还要再等加载。」
- **我理解的口径**：这是性能诉求，不是 bug 报告。微信小程序原生机制下 tabBar 页只有被点开时才创建实例，「启动就渲染五个页面」做不到（除非启动时静默轮转 switchTab，会闪屏 + 埋点污染 + 落地页抖动，已排除）。可行解 = 登录后后台预热五个 tab 页首屏数据到 req-cache / mem / notice，使切页时命中缓存直接渲染、不再等云函数。用户通过 AskUserQuestion 明确选择「五页首屏数据全预热」，而非「只预热慢的页」或「预热+页面预创建」。预热必须是纯优化：全部 `toast:false`、失败一律 catch 吞掉、不 await、不阻塞登录与首屏。按身份/权限门控预热（辅导员/超管/班委各自的数据范围），不得越权预热。
- **触发文件**：`miniprogram/app.js`（`_prefetchTabs()` 从 3 项扩到五页首屏）、`scripts/check-startup-prefetch-tabs.js`（新建，vm 真跑 + 变异自证）。
- **确认结果**：用户明确选「五页首屏数据全预热」。先建 `check-startup-prefetch-tabs.js` 判红（现状只见 3 项预热、10 红），再修绿，保留四组变异自证（去掉任一页关键预热必须翻红）。

---
