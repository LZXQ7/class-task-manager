
node scripts/check-leave-realtime-courseinfo.js # **请假卡实时口径 + 课堂情况弹窗（第 69，2026-10-09 用户两条实拍新增；改首页 `_setLeaveHomeClass` / `_scheduleLeaveWindowTimer` / `_buildCourseInfo` / `canCourseInfo`、`duty.sessionsOnDate` 的 teacher 必跑）**。
   ⚠️ ①「上午请假过了时间仍显示请假」**不是 bug，是口径分层被首页忽略了**：后端 `leaveBoard` 早返回两套口径（2026-10-08 定，别再合并）——`stat`=日期口径（今天有生效请假的全列，**含已过时段**）、`now`=实时口径（此刻真在请假时段内）。首页**只读 `stat`、把 `now` 整个丢了**。
   - 修法（用户定：数字走实时、名单走日期）：卡片大数字用 `now`，名单保持 `stat` 全列，已过时段标 `over: true` 显示「已过时段」角标；另存 `leaveHomeTotal`（日期口径行数）。
   - 🔴 **`now` 缺失时不许回落 `stat`** —— 回落**正是这个 bug**；老后端没返时宁可不显示数字（`leaveHomeHasNow=false`）。
   - `markOver` 的**整天假必须显式 `over:false`**（两列都空时直接进 `now2 >= '' && now2 <= ''` 会把整天假误标成已过时段）。
   - 数字要**自己会变**：`_scheduleLeaveWindowTimer` 排出下一个时段边界（12:00/18:00/00:00）到点重拉，翻面后再排下一次。🔴 必须 **setTimeout 链不能 setInterval**（App 退后台仍按墙钟触发，回前台补发一串过期请求）；`waitMs` 要有下限；**必须 onHide/onUnload 清**（最长跨小时，不清会对已销毁实例 setData）。
   ⚠️ ② 课堂情况弹窗（班长/副班长点首页今日课次 → 一键复制）。`canCourseInfo = canLeave && !isCounselor`（复用请假权限口径，不另造；辅导员不给）。
   - **教师名**：`course.teacher` 一直存在（课表页已在读），只是 `sessionsOnDate` 没 SELECT ⇒ **duty 云函数需重新部署**。
   - 入口按权限**渲染两份**而非 bindtap 插值（插值真机其实可用，但条件为假时绑成**空handler 名** ⇒ 点了没反应且不报错）。
   - 应到 = 课次涉及组的人数（`groupScope` 空=全体）；实到 = 应到 − 请假数（下限 0）；**请假者也过同一组过滤**。请假名单用 `leaveHomeNowList`（与卡片数字同源）。
   - `courseInfoText` 是**唯一真源**，弹层预览与复制读同一字段。⚠️ 复制文本里**学号与姓名之间没有空格**（照用户模板抄）。
   ⚠️ **本门禁自证抓到两个假自证**：①`judge(o)` 的 `o` **必须有默认值**（基线那轮 `judge()` 无参调用，必填参数会 TypeError 崩在 forEach 里、判据根本没跑）；②**变异锚点不唯一 = 没变异** —— M3 锚点 `leaveHomeRaw: rows;` 先匹配到 data 里的初始值 `leaveHomeRaw: []` ⇒ replace 静默不生效 ⇒ 测的是原文件。修法=锚点带上下文 + 判据钉到收尾是 `,`/`}`/`;`（`rows\b` 会把 `rows.filter(...)` 也放过）。
��是治标 ⇒ 必须同时补 `max-width` + `overflow:hidden` + `white-space:nowrap` + `text-overflow:ellipsis`（**只写 max-width 不会省略，会被裁出半个字**，四个属性成套）。
   **8 组变异自证**：M1 去掉 `!sheetOpen` / **M2 只漏 roster 一页**（真实事故形态：线上表现「这个页有箭头、那个页没有」，极难联想到漏接一行）/ M3 去掉白名单 / M4 改读 dataset / M5 第二个真源 / M6 缺 `slotText` / M7 去掉 max-width / M8 文案改回。
   ⚠️ **写这类门禁自身的五个坑**：①**变异改名 ≠ 变异** —— `sheet-open=` 改成 `sheet-opened=` 后判据 `/sheet-open/` **仍然为真**（子串）⇒ 变异体没被真正改坏 ⇒ **假自证**，必须**删属性**；②`vPages` 既可能是文件列表也可能是内容覆盖表 ⇒ 要 `Array.isArray` 分开走，否则 `scan.forEach is not a function`；③**`page-meta` 表达式可能没有外层括号**（单标志时作者常写 `{{pickerShow ? … }}`）⇒ 正则两种形态都要认，否则 manual 页被误判；④每组变异前**先确认基线为 0**（非 0 = 判据与实现漂移，此时「抓到变异」毫无意义）；⑤逐页判据要配**反向自证**（doc/bind 被正确排除）才能证明不是「一律要求接」蒙对的。
生成下周草稿（幂等） | ✅ |
     | daily | `0 0 6 * * * *` | 每日 06:00 | 昨日未确认 → EXPIRED | ✅ |
     | hourly | `0 0 * * * * *` | 每小时 | 申请超时撤销 / AUDITING 超 24h → BLOCKED | ✅ |
     | remind | `0 0 21 * * * *` | 每日 21:00 | **次日**值日订阅提醒（需 `TEMPLATE_REMIND`） | ✅ |
     | remindAM | `0 0 7 * * * *` | 每日 07:00 | **当日**值日订阅提醒（v0.7.15 新增） | ✅ 2026-09-26 |

     ⚠️ `manageFunctions(action="createFunctionTrigger")` 是**整体覆盖**语义：必须一次性传齐
     要保留的全部触发器，漏掉的会被删除（2026-09-24 只传 remind 时误删了 weekly）。
     正确写法（5 个一起传）：
     `triggers=[{name:weekly,config:"0 0 20 * * 0 *"},{name:daily,config:"0 0 6 * * * *"},{name:hourly,config:"0 0 * * * * *"},{name:remind,config:"0 0 21 * * * *"},{name:remindAM,config:"0 0 7 * * * *"}]`

## 2.1 增量更新（改动云函数后）

```bash
node scripts/backup.js 改了什么              # ★ 第 0 步：改之前先备份（见 §0）
node scripts/sync-common.js          # 公共模块必须先同步，否则部署的是旧 common
node scripts/check-api.js            # 前端 api.xxx ↔ 云函数 routes 映射自检
node scripts/check-wxml.js           # WXML 事件 / 结构自检
node scripts/check-wxss.js           # WXSS 体检：大括号配平 / 非 ASCII 空白 / 漏分号 + wxml 用了但 wxss 没定义的 class + **全量禁 `~` 选择器**（**改样式必跑**；`~` 在 WXSS 非法，真机 fatal 且整个 wxss 编译失败 → 全站样式丢失）
node scripts/check-segmented.js      # segmented 事件契约：组件 emit {key} ↔ 页面读 e.detail.key（**改 segmented 用法必跑**；读 e.detail.value 会拿到 "undefined"，表现是「点了没反应」）。v0.7.20 起高亮改为独立胶囊 `.seg-ind` 两拍位移，**事件契约一字未动**；③ 节另有「`.seg-item` 必须保留带 background 的 transition」的断言
node scripts/check-icons.js          # 图标名称引用（云端一一对应用 check-icons-cloud.js）
node scripts/check-fixed-layers.js   # 浮动层 z-index 关系
node scripts/check-perf.js           # 导航延迟不变量（**改 tabBar / nav-bar / bottom-sheet / 任何页 load() 必跑**）：tabBar 乐观选中、导航路径禁同步 IPC、数据页有内容不退回骨架、写操作后作废缓存、Tab 数据预热与缓存键同源。🔴 组件里**全文**（含 methods）不得出现 `wx.getWindowInfo(` / `wx.getSystemInfoSync(` / `wx.getMenuButtonBoundingClientRect(` —— 需要窗口尺寸就让 `app.navMetrics()` 多带字段

# ---- 动效 / 几何（**改底栏、动画、弹层必跑**）----
node scripts/check-tabbar-liquid.js  # 底栏：胶囊与指示器几何（JS↔CSS 双向绑定、零留白、预冲幅度、两拍换速）+ 第 ④ 段**底栏占位联动 6 处让位值**（改 98rpx 必同步）。⚠️ 让位值的 `RPX_SPOTS` 按**类名**匹配 —— 课表页左下角入口改名（`.fab-shift` → `.fab-menu`，v0.7.21 需求③）**必须同步这里**，否则门禁是「找不到这个点」而不是报错
node scripts/check-tab-enter.js      # Tab 入场：wxml 结构审计（.st-item 必须互为兄弟 / 无 fixed 后代）+ 位移只许 Y 轴 + 档位序列 + JS↔CSS 双向比对（自证含自闭合解析）
node scripts/check-popup-anim.js     # 弹层开合动画（mounted/active 两帧）+ Tab 入场动画（**改弹层/加动画必跑**；wx:if="{{show}}" + 动画类绑 show = 瞬间打开，不报错）
node scripts/check-scroll-lock.js    # 滚动穿透：每个滚动弹层的 show 标志都必须进页面 page-meta 表达式（**新增/改名弹层标志必跑**）
node scripts/check-chip-anim.js      # 多选标签挤开动画：.chip-motion 过渡 padding、每族 .on 目标 padding、chip 自身禁 transition
#
# ⚠️ v0.7.21 起：「同一数据源、切换视图或筛选」的列表过渡统一走 `miniprogram/utils/list-transition.js`
#    （`flip` 布局整体换 / `filterSwap` 只增只减 / `guard` 可打断）。已接线三页：值日按日⇄按人、课表 A组⇄B组、成员全班⇄仅班委。
#    新页要加同类过渡**请复用它**，不要各写一份。规格：保留项 220+70ms（**两段真实位移**，禁伪弹性曲线）/ 离场 240ms（渐隐与行高塌缩**同步**、两阶段 setData）/ 新增 200ms 从下 16px。
#    ⚠️ 禁止：整列表 opacity 0→1 / 离场不塌缩留白再跳位 / 逐项 stagger / 切换期间锁点击。切视图前**必须自增打断令牌**并在 onUnload 作废。
node scripts/check-notice-motion.js  # 通知页三处动效：折叠高度过渡 / 回收站曲线飞入两拍 setData / 卡片堆叠仅 >6 张
node scripts/check-week-swipe.js     # 页面横滑切周（只在 touchend 判方向；**scroll-x 页不得挂手势**）。v0.7.20 起课表页也复用 `utils/swipe` 的**动画**（`swipe.shift` + `_applyWeek` + `onUnload` 清定时器），但**不挂手势** —— 102 行显式断言课表页不得出现 `onSwipeStart`；4.6 节断言 `wk-swipe` 容器 + `fixed` 在其外（动画容器的 `transform` 会建包含块）；4.7 节从源码 eval 抽 `onWeekChange`/`_applyWeek` 执行

# ---- 排班算法（**改排班必跑**）----
node scripts/check-round-robin.js    # 连续 6 周轮转 + 内核唯一性 / 无 Math.random。**第 6 部分（v0.7.23 新增）：跨轮态必须从 09 号接续** —— 构造「01–08 = 2 次、09–56 = 1 次」的跨轮态名册 → 第 5 周首节必为 09/10、整周 01–08 一个都不出现、且无重复；+ 变异自证（把旧「全班清零」块原样搬回 → 必被打回 01 号）+ **剥注释**文本判据（`/roster\.every\([^)]*mark\s*>\s*0/` 不得命中 schedule / cron-weekly）+ **线上真实第 5 周 23 节课次形状复刻**（清零态逐节复现线上那 46 行作**校准**，修复态 = 清零态 **+8**）。起因：`every(mark>0)` 被当成「一轮刚排满」，在跨轮态误判 → 全班清零 → 第 5 周从 1 号重排、与第 4 周重复排人（详见 DETAILS §71 / CHANGELOG-DETAIL v0.7.23）。⚠️ 复刻时漏 `dutyCount` 字段会让 `rotationPick` 一节都不选，表现为「复刻 =（空）」**而非报错** —— 门禁测出全空时先查输入形状
node scripts/check-seq-order.js      # 配对顺序：AI 不决定「谁配哪节课」，程序按课次取最小号
node scripts/check-ai-plan.js        # AI 计划硬规则 + 幂等性（预览 == 落库）
node scripts/check-ai-token-budget.js # **AI token 预算 + 空返回可诊断性**（2026-10-07 新增，64/64）。起因：线上「[40010] DeepSeek 返回内容为空」——`callAi` 对所有模型一律 `max_tokens: 2000`，而库里配的 `deepseek-flash` 是**推理模型**、thinking 计入 max_tokens，2000 被思考吃满（`finish_reason='length'`、reasoning 占 2000/2000、content 空）⇒ 上游仍HTTP 200 + 合法 JSON，本地只能报无信息量的「返回内容为空」。实测三组：flash+2000 空 / flash+8000 正常（reasoning 3126+正文 327，16s）/ chat+2000 正常（340 token，1.4s）。门禁钉三条：① 预算 ≥ 8000（schedule `AI_MAX_TOKENS` + ai-proxy 兜底值）且`callAi` 用常量；② 空返回按 `finish_reason` 归因（length / content_filter / 只回思考），**禁止**退回裸的「返回内容为空」，且诊断字段须真落到 `fail` 第 3 参（`fail(errCode,errMsg,data)` 不接受 data 会静默丢弃）；③ `aiCheck` 显示**实际会用的模型**（读 `ai_setting.model`）而非常量 `AI_MODEL` + 标 `modelSource`。判据**全程剥注释** + 抽解析块**运行时**喂三种空返回验文案互不相同；3 组变异自证（预算改回 2000 / 解析退回黑洞 / aiCheck 恢复常量）全被抓。⚠️ 抽源码 eval 时**必须注入 `fail`**，否则门禁自身 ReferenceError 而不是给 PASS/FAIL
node scripts/check-clean-label.js    # 保洁「18点前」口径 + 订阅模板字段
node scripts/check-duty-rotation.js  # 值日轮转：第 2 周真实安排**逐条比对** + `rotationPick` 从生产源码抽出（不抄副本）；v0.7.21 起末尾追加**roundReset 文案口径**文本断言（剥注释后不得出现「从 1 号重新开始」、`roundReset` 那句必须含「接着序号」，双向自证）。⚠️ **判据必须剥注释** —— duty/index.js 的注释里为解释旧措辞**引用了旧措辞**（「判据命中注释」第 4 次）

# ---- 页面运行时 / 业务语义 / 数据 ----
node scripts/check-week.js           # 日期 / 星期 / resolveSlot 双端一致性
node scripts/check-timetable-local.js# 本地课表与真实课表一致；v0.7.21 起辅导员入口改为**逐入口点名**（切周条 / `.fab-menu` / `.fab` 三个开标签**各须**带 `!isCounselor`）+ 双向自证 —— 取代原「`!isCounselor` ≥4 次」的**计数判据**（顶部 A/B 分段并入 `.fab-menu` 后合法降为 3 次即翻红；**计数式判据会被任何合法重构推翻，点名式才描述意图**）
node scripts/check-pages-runtime.js  # 逐页跑 onLoad/onShow + 课表列数自适应（∈{5,7}）断言（**改课表必跑**）
node scripts/check-session-shift.js  # 临时调课：选课次展开 + AI 方案校验（抽源码 eval）
node scripts/check-today-course.js   # 首页今日/明日课次：按「实际上课日期」判定放假 → 今日无课 / 明天无课（**改首页必跑**）
node scripts/check-count-align.js    # 弹层 scroll-view 不被 catchtouchmove 吞掉 + page-meta 锁滚动链 + 「值日 N 次」三段对齐（**改弹层/列表 UI 必跑**）
node scripts/check-notice.js         # 换人语义（超管**原地替换**+可还原/成员申请走超管确认）+ 班级通知（**改换人/通知必跑**）
node scripts/check-notice-v2.js      # 第三批四条 + **R7 配图 fileID 白名单**（真实 fileID 原文断言 + 「旧正则必须被判丢图」反向自证）
node scripts/check-committee.js      # 班委判据（role ∈ {ADMIN,MONITOR} 且 group_tag<>'X' 且非测试）/「仅班委」筛选
node scripts/check-positions-sync.js # 职位清单：utils/util.js POSITIONS ↔ 云函数 member 逐字一致 + **setPosition 授予权**（判据限定在函数体内：基础权限 / 新职位 / **目标当前职位** / 仅超管 / **写库之前**，4 组变异必抓）
node scripts/check-permission-delegate.js # **需求 D 权限下放（2026-09-27）**：① 三域能力位（canSchedule=超管|生活委员 / canRosterEdit=超管|辅导员|班长 / canGrantPosition=仅超管）单一来源是 auth.login，前端经 app.js 三个同名方法读、**不得散落 position 字面量判定**；② 排班域 `scheduleAuth` 路由覆盖（schedule 16 / adjust 2）+ 派发器接线 + **12 份 common/guard.js 副本与源逐字一致**；③ 名册录入域 `requireRosterEditCheck` 4 个写入调用点 + `applyImport` **跨班兜底**（mapping 前端可伪造，不校验 = 跨班批量改姓名/分组）且越界必须计入 skippedRows（不静默）；④ 前端入口按能力位而非 isSuper 显隐（值日页 5 处 / mine 手动排班与待确认换班 / roster 添加·导入·调组）。6 组变异自证。⚠️ **改权限模型必跑**：判据里 16 / 2 / 4 是路由与守卫的**完整性计数**，新增排班域路由却漏声明 scheduleAuth = 裸奔，必须是红灯
node scripts/check-roster-parse.js   # 名单列序自适应 + 多班分类 + 防串号
node scripts/check-xlsx-lite.js      # 零依赖 xlsx 解析器（不支持 .xls / ZIP64）
node scripts/check-staff-bind.js     # 教职工一次性绑定码（**改 auth/member 绑定或发码必跑**）：源码审计 + 10 组变异必被抓 + 运行时 7 条分支（抽 auth/index.js eval）

# ---- 材质 / 身份链路（v0.7.17 新增）----
node scripts/check-glass.js          # 液态玻璃材质（**改任何 backdrop-filter / app.wxss / 底栏 / 弹层必跑**）：用了模糊就必须给 `@supports not` 加厚兜底 + `prefers-reduced-transparency` 分支（不支持模糊的安卓机上不兜底 = 正文透上来压字，iOS 上永远复现不了）；另断言玻璃令牌齐全、`page` 垫了环境色晕、`.page` 透明、底栏 alpha ≤0.4 且仍带模糊。自证含 3 组变异（删兜底 / 删降低透明度分支 / 掏空兜底块）
node scripts/check-unbind-route.js   # 身份失效必须回绑定页（**改 request.js / app.js / 绑定页必跑**）：四环链路（request emit needBind → app 监听 → 清身份与 mem/notice 缓存 + reLaunch → onShow 补校身份）缺一即报；并断言绑定页「口令校验 + 名单拉取」并行、有同名缓存、进页面预热 member 云函数。自证含 4 组变异（摘监听 = 历史真实故障）
node scripts/check-staff-pin.js      # 辅导员「关注的学生 · 固定到主页」（**改 member 的 pin* 路由 / 备注权限 / 首页关注卡片必跑**）：静态审计（staffClassIds 收窄、class_id IN 真拼进 SQL、PIN_MAX 上限、增删两分支、复用 noteScopeOk）+ **运行时 17 条**（原样 eval member/index.js + 假连接池，判据落在真拼出来的 SQL 与 args；含越权：跨班关注 40003、学生身份 40003、无绑定班不发无约束查询）+ 4 组变异必抓。⚠️ 它返回的是学生姓名 + 备注正文，过滤失效 = 越权读隐私，必须离线拦住

# ---- 结构完整性（v0.7.19 新增，**改页面 json / 移动固定层必跑**）----
node scripts/check-component-paths.js # `usingComponents` 相对路径**真实解析**（按 `index.json` 所在目录解析 `../..` 后检查 `.json/.js/.wxml` 存在）。⚠️ 此前 37 门禁都没覆盖这条 → 组件路径少写一层导致「模拟器启动失败」；带双向自证（坏路径必抓 / 好路径不误报）
node scripts/check-fixed-in-scroll.js # `<spring-scroll>` 内**禁**固定定位覆盖层组件（`nav-bar`/`bottom-sheet`/`duty-sheet`/`dialog`）。`.ss-content` 的 `transform: translate3d()` 会给子元素**建包含块** → `position:fixed` 不再以视口为基准（已连踩三次：导航栏随滚动位移 / 值日弹层跑到页面上方 / 课表 FAB）→ **统一解法：fixed 元素放在带动画/位移的容器外面**，不要用 `transform:none` 去救。带双向自证（内嵌坏样本必抓 / 外置好样本不误报）

# ---- 数据层韧性（v0.7.22 新增，**改 common/db.js 或任何连接层代码必跑**）----
node scripts/check-db-resilience.js  # mysql2 池三层防御（SCF 冻结容器 → 池内空闲连接被 VPC 静默断开 → 「偶发 50000，重试就好」）：A 文本层（12 份 common/db.js 副本与源逐字节一致 + keepalive/ping/重试白名单齐全，判据**先剥注释再断言**）+ B 行为层（生产源码 eval + 桩 mysql2：ECONNRESET 丢池重建后重试成功 / SQL 语义错误绝不重试 / 死连接被 ping 拦下重借 / 3 次全死最终抛出不吞错）+ C 变异自证（删掉重试逻辑 → 门禁必须翻红）。⚠️ 改 db.js 后必须 `sync-common.js` + **全量重部署 12 个函数** + 下载线上包 diff；事务体内语句不自动重试（半段事务重放是错的）

# ---- 排班生成可跑通（v0.7.22 续新增，**改 schedule / cron-weekly 的 generate 链路必跑**）----
node scripts/check-schedule-generate-runtime.js  # schedule.generate 全空快照**真跑一遍**（生产源码 eval + 桩 wx-server-sdk/db/guard + 假连接池）：resolve 且返回 `{created:0, roundFixed:0,…}`。起因：`roundFix` 在 try 块内 const、try/finally 之后引用 → ReferenceError（事务已 commit 仍兜成 50000，「每次生成都失败」）；文本正则查不出作用域边界错误，40 个门禁全绿照样上线了它。变异自证（声明搬回 try 内 → 必须 reproduce errCode 50000 且 errMsg 带 roundFix）+ 锁 cron-weekly 的声明在 try 之前。**D 段（v1.0.6 新增）=「一键生成只补手动排班的空缺」**：起因 `const n = s.duty_count || 1` 无视该课次已有手动排班 ⇒ 手动排 2 人的课次再自动追加 2 人变 4 人。口径五条：① 手动排满的课次**一个都不追加**（`keptManualSessions` 计数回传，让前端能告诉用户保留了几节）；② 只补 `duty_count − 手动占用` 的差额；③ 手动排的人必须 `state.used[组].add(seq)` —— 只加 `assignedWeek`/`softSeqs` 是**软避让不是硬排除**，`pickBySeq` 的补漏分支（`seq<=cursor && 本轮未排`）仍会把他再排到别的课次；④ 统计手动占用须 `status <> 'SWAPPED_OUT'`（换出的人不占坑）；⑤ **三条生成链路必须同口径**（`schedule.generate` / `cron-weekly` / `buildCleaningPlan`，后者原本就对）。13 条断言 + 5 组变异自证（M1 无视占用 / M2 排满还加 1 人 / M3 摘掉 state.used / M4 按课次去重成布尔 / M5 漏 SWAPPED_OUT）。⚠️ 变异自证**只在 `.workbuddy/` 下沙盒副本做**（禁改真源码再还原）；⚠️ 判据必须锚 `SELECT DISTINCT session_id, class_date, member_id FROM duty …` **整串**，短判据会被同文件 `buildCleaningPlan` 的相同字面量顶掉 → 假自证；⚠️ **等价变异抓不到不算门禁失效**（M2 最初只删 `continue`，此时 `n` 已为 0 行为完全等价，须改成 `(duty_count − already) || 1` 才有真实差异）

# ---- 真编译（v0.7.18 新增，**改任何 wxss 必跑**）----
node scripts/check-wxss-compile.js   # 用**微信官方 wcsc.exe 真编译**每个 wxss（**改样式必跑**）。项目已两次栽在「门禁全绿但编译不过」：v0.7.17 的 `~` 选择器（真机 fatal、全站样式丢失）、v0.7.18 的残留 hex 尾巴（IDE 报「编译 .wxss 文件错误」）。⚠️ 编译器按已知路径查找（`D:\Tencent\微信web开发者工具\...\wcc-exec\wcsc.exe` 等），找不到会 **SKIP 并提示**（不误报红）；可用环境变量 `WX_WCSC` 指定。自带 3 组自证（残留尾巴必抓 / 孤立 `}` 必抓 / 好样本不误报）+ ① 段实测记录「本版 wcsc **接受** `~`」→ 所以 `check-wxss` 段③ 的文本级禁 `~` **不可删**（两门禁互补：一个管能不能编译过，一个管真机跑不跑得动）

# ---- 圆角裁切容器 / 左滑删除区 / 块级图标居中（v0.7.24 新增，**改任何左滑卡片或裁切容器必跑**）----
node scripts/check-corner-clip.js    # 三族同源缺陷：① 裁切层（`.nt-item`/`.cl-swipe`）必须 `overflow:hidden` **且自带与卡片同值的圆角**（跨文件取有效圆角：卡片挂全局 `.card` 时圆角在 `app.wxss`）+ **外投影上提到裁切层**（`overflow:hidden` 会连子元素自己的 `box-shadow` 一起裁 → 「方形裁切层套圆角卡片」时投影只在四个圆角缺口残留 = 四角暗肩；v0.7.24 用户报「卡片四个角有灰色」）；② 左滑删除区（`.nt-del-zone`/`.cl-del`）显隐必须由 `item.offset` 驱动 + **静止态 `opacity:0`**（半透明卡片后方有色块会透上来 → 卡片右半边泛粉）；③ 空态容器（`.rc-empty`）必须 `flex + align-items:center`（`<app-icon>` 是 `display:block` 的 `<image>`，`text-align:center` 管不了块级子元素 → 图标贴左）。自带 5 组变异（旧 `.nt-item` 无圆角 / 卡片自带投影 / 删除区不带 offset / 旧 `.rc-empty` 无 flex 必翻红 + 剥注释后注释里的圆角不被误判）

# ---- 模拟态护栏（v1.0.5 新增，**改 4 个 tab 页身份套用 / impersonate.js / auth.switchAccount / guard 必跑**）----
node scripts/check-impersonate-guard.js # 「切换测试账号」模拟态必须有全局醒目护栏（v1.0.5，**改 pages/home|timetable|duty|mine 的 onShow/身份套用、utils/impersonate.js、auth.switchAccount、common/guard.getContext 必跑**）：① 4 个 tab 页都渲染 `danger` 横幅 + 「恢复本人」；② 4 页 json 都注册 `notice-bar`（漏注册 = 组件静默不渲染）；③ 横幅在**身份套用处**同步（登录晚于 onShow 完成也补上）；④ 横幅必须在 `spring-scroll` **之外**（进去被 `.ss-content` 的 transform 建包含块、还跟着滚）；⑤ `recover()` = 清 impersonation → refreshAuth → reLaunch（模拟态切走后权限整体变了，原地补丁必漏页）；⑥ 「不与真人冲突」两前提：`switchAccount` 用 `ctx.realMember` 鉴权（否则切过去切不回来）+ impersonation 按**调用者 openid** 键。起因：可切换目标里有一位**真人持有**的账号（示例辅导员，学号 000000000090 特意放 99 段），无提示 = 以她的名义静默落库。7 组变异必抓。⚠️ ⑥ 段的判据必须锚定 `FROM impersonation WHERE openid = ?` 整串 —— 只写 `/WHERE openid = ?/` 会被同文件的 `SELECT * FROM member WHERE openid = ?` 顶掉 → 变异 7 查不出来（实测踩到）

# ---- 轮转游标「删行必回滚」（v0.7.26 新增，**改任何 `DELETE FROM duty` 站点 / schedule.remove / schedule.addManual / course 临时调课必跑**）----
node scripts/check-duty-marker-symmetry.js # `member.duty_count` 是轮转位置的**唯一来源**（`rotationPick` 按 `(duty_count ASC, 序号 ASC)` 取人），任何「删 duty 行但不把游标减回去」的路径都让它**单向漂移**（只增不减）→ 被删的人「没值日却算已排过」→ 在队列里被往后推。线上实锤：1 号 `duty_count=3` 而同批同学是 2 → 第 6 周（48 名额 / 56 人）队列 `[55,56,02,…,54,01]` 取到第 48 位就满了 → **1 号整周消失**。本门禁守 5 件事：① 全仓 7 个「删值日」站点的**所在函数体内**必须有回滚证据（`rollbackDutyMarkers(` / `duty_count - ?` / `duty_count = duty_count - 1` / `- (ownAuto.get(`），第 8 处 `member.removeMember`（删即将被移出班级者**本人**的未来值日，紧接着 member 行也被删）在 `EXEMPT` 里显式登记；② `schedule.remove` 不得再用 `source === 'AUTO'` 当回滚门（写入侧 `addManual` **无条件** +1、`reassign` 又把 source 改成 `'MANUAL'` → 「手动加人 → 取消」每次永久 +1），必须 `status !== 'SWAPPED_OUT'` 无条件回滚；③ `addManual` 仍无条件 +1（写读两侧必须成对）；④ `course.rollbackDutyMarkers` 存在且 OFF / MOVE-dup 两分支各 `await` 一次；⑤ 该 helper 自己排除 `SWAPPED_OUT` 历史行。8 组变异必抓（含变异 4/7 的坑：`- (ownAuto.get(…))` 与 `UPDATE … duty_count + 1` 在 schedule 里各出现**两次且逐字相同**，变异必须全量替换，否则只改到无关那一处 → 假通过）

node scripts/check-shift-move.js # **临时调课全链路：批量调课 / 新建课次的值日搬迁（2026-10-07 新增，改 `moveSessionSlots` / `appendSessionSlots` / `shiftSet` / 课表页调课向导必跑）**。分两组：**(甲) 2026-10-07 批量调课的两个 helper** —— 两处**读代码看不出来、只有跑起来才暴露**的坑（都是先用假 pool 仿真抓出来、再回补的）：① `appendSessionSlots` 命中 `madeKey` 去重时若 `continue`，同一门课一周上两次（两个不同节次）时第二个课次那条值日会永远留在旧日期+旧课次上 ⇒ **孤儿值日**（课已挪走、值日还挂原格）；② `moveSessionSlots` 撞「同一天同一人两条值日」时，删的必须是**目标周上原有那条**、保留**跟着课走这条**（与 `syncDutyForShift` 的 MOVE 分支同一范式），反过来删会让值日留在已不在的星期上。**(乙) 2026-10-08「日期间调课」必然报 41001 的事故**（A6-A11 判据 + C5-C7 变异）：用户走完 4 步向导点「确认调课」必报「第 1 条写入失败：请选择改到星期几」。根因是**三处口径叠加**，缺任一都不成立：① 前端 `_currentPlanItem` 的 date 分支只产 `dates`+`toDate`、**没有 `toDay`**（界面本就不渲染星期/节次选择器，只有两个日期选择器）；② `onShiftConfirm` 无条件 `payload.toDay = it.toDay` 把 undefined 发上云；③ 云端 `shiftSet` 对 `kind='MOVE'` 无条件要求 `toDay∈[1,7]` ⇒ `Number(undefined)`=NaN 撞校验。修法**不是回滚**而是把三处对齐到**全链路早已在用的「缺省 = 保留原值」**语义（`common/week.js resolveSlot` 的 `ov.toDay || dayOfWeek`、前端 `data/timetable.js resolveSlot` 同款、`upsertSessShifts` 的 `Number(it.toDay) || null`）—— 只有 `shiftSet` 的硬校验与之冲突。判据钉死：`byDates`（按日期定位）时放行缺省、**按课次定位（sessionIds/weeks/dayOfWeek）仍必须给全**（那三种方式界面都渲染了选择器，缺了就是用户漏填，静默当「保留原值」会把人调了个寂寞）；`effDay` 必须按 `t.dayOfWeek` 回退（否则 `getDateOfWeekDay` 拿到空日期，**值日停在旧日期变孤儿**）；前端只带**合法**的 toDay/toPeriod（云端要能区分「没传」与「传了非法值」）。另加跨周拦截（`session_shift` 主键 `(session_id, week)`，**跨周搬课它根本表达不了**，UI 的 date picker 又不限范围 ⇒ 早先会静默落到「目标周的星期几」而不是用户选的那天）。⚠️ 三条纪律：变异**锚点必须用真实代码行**（`let nid = madeKey[key];`，用修复前的旧写法 `if (madeKey[key]) {…continue; }` 会静默匹配失败 ⇒ **假自证**）且**前置检查锚点存在**；假 pool 必须**按 SQL 里实际有没有 `class_id` 决定隔离**，否则去掉守卫的变异体在模拟器这边被挡住 ⇒ 同样假自证；跨班隔离的变异必须**同时**去掉 SELECT 和 UPDATE 两处 `class_id` —— 单点去掉不构成缺陷（另一处仍挡着），写成「必须判死」才是假自证。🔴 **抽 `routes` 里的对象方法要用 `extractRoute`（按 `{` 配平），不能复用只认 `function name(` 的 `extractFn`** —— 抽不到会返回空串让判据「静默全红」，看不出是代码坏了还是判据坏了（2026-10-08 踩，故补 A0 前置断言）。🔴 **另一条同源纪律**：本门禁的「假 week 模块」是 `cloudfunctions/common/week.js` 的**手工副本**，`common/week.js` 加/改任何 helper（如 2026-10-07 新增 `isWeeksBlank`）后**必须同步补这里**，否则本门禁会以 `week.isWeeksBlank is not a function` 报错 —— 那个报错长得像**生产代码 bug**，会直接把排查方向带偏（实际只是仿真器没跟上）。**(丙) 2026-10-08 补修：同一个死路的第二个入口 —— 「新建课次后课表」（APPEND）**。上面 (乙) 只修了 `OVERWRITE` 走的 `shiftSet`，交付前扫「是否还有别的入口进同一判据」才发现 `sessionAppend` 的 `normalizePlan` 里**还有一套一模一样的无条件必填**（`缺目标星期` / `缺目标节次`）⇒ 只修一半 = 用户切一下写入方式照样报 `第 N 条：缺目标星期`。判据 A12-A14钉死三处：`normalizePlan` 里 `byDates` 分支必须 `item.toPeriod = null`（**`session_shift.to_period` 可为 NULL 表示保留原节次，但 `session.period` 是必填语义列不能写 NULL** —— 这是两套表的语义差，不是同一个字段）；`appendSessionSlots` 写 `session` 时 `effPeriod` 必须按 `Number(s.period)` **逐课次**回退（同一周两门课节次不同，回退成同一个值等于把第二门课的节次改了）；「按课次定位必须给全」那条护栏**不能顺手一起删**（`if (!byDates) { 缺星期/缺节次 }`）—— 那三种方式界面都渲染了选择器，删了就变成静默「保留原值」。行为层 B6用假 pool 跑 date+APPEND 真实调用：created2 / noNullPeriod / keepsOwn2 / keepsOwn4 / dayMovedTo6 / weeksOneWeek 六项断言（`keepsOwn2`+`keepsOwn4` 是专门为「逐课次回退」加的，只断言 `noNullPeriod` 抓不出「全落第 1 节」这种错）。⚠️ **C9b 行为层变异的判据极性必须写成 `!(断言)`** —— 变异体注入后正确性断言应当**崩**，写成要求为 true 等于把「成功抓住变异」报成 FAIL（2026-10-08 踩，40/41 卡在这一项上）；且另配一条 `s6m9.noNullPeriod === false` 的**定位断言**，避免「崩在别处也算抓住」而看不出变异到底生效没有（另：**行为层变异必须把变异体 `new Function` 注入执行**，拿未变异的原体跑一遍必然假通过）

node scripts/check-wxml-expr-depth.js # **WXML 嵌套三元层数上限 ≤3（2026-10-07 新增，写任何 `{{}}` 表达式前必读）**。WXML 表达式解析器（wcc）对**嵌套三元**有层数上限，超了**编译期**就报 `Bad attr "xxx" with message: error at token !`；🔴 **那个 `!` 是误导性定位**（解析器失败位置回读到的一个运算符 token），按「表达式里有 `!`」去查会完全跑偏。上限取 **3 层**依据的是实测对照：3 层在 4 个页面 + 1 个组件长期存在且线上正常，唯一的 4 层（`pages/timetable` 4 步向导的 `title`，152 字符查 5 种方式标题）必然失败；**长度不是判据**（108 / 102 字符的表达式一直跑得好好的）。**正确修法是把派生值挪到 JS**（`data.shiftTitle`），不是把三元拆短 —— 这与「WXML 不做逻辑」是同一条铁律。⚠️ 本门禁第一版的层数算法**是错的**（用「遇 `:` 就降」压平计数，而三元**右结合**、`:` 是外层先出现 ⇒ 4 层被算成 1 层 ⇒ **变异自证假通过**）；现算法 = 遇到 `?` 时「已开启括号数 + 1」的峰值，已用项目真实表达式校准 7/7。写这类判据的通用教训：**自证用的变异必须是「线上真实报错的那条表达式」原文照抄**，不是人造简化版；并给「判据算出的层数本身」配一条前置断言（B1b），否则判据坏了自证照样绿。🔴 **2026-10-08 课表页 4 步向导已整体回退**（用户要求，见下条），本门禁的「4 层必然失败」实证样本随之消失，但**判据本身保留**（别的页面随时会写嵌套三元），且 `data.shiftTitle` 那条「派生值挪到 JS」的修法纪律照旧有效

# ---- 临时调课 UI 回退（2026-10-08，**改课表页调课弹层前必读**）----
⚠️ **本轮把 `pages/timetable/index.{js,wxml,wxss}` 整体回退到 C3 动手前（`20261007-093918`）的「分段标签」形态**（顶部 5 个 tab：本周 / 多周次 / 按日期 / AI 调课 / 结果），一并消失的功能有两个：`batch` 批量课程调课、写入方式选择（覆盖课表 / 新建课次后课表）。三条必须记住的纪律：
① 🔴 **绝不能整体 `backup.js --restore`** —— C3 之后还做了值日轮转游标重构（`common/round-robin.js` 新增 + `class.round_cursor_a/b`）、深色模式 C-4、AI token 预算，整体 restore 会把刚上线的轮转一起打回。**只精准回退课表页三文件**；云端**零改动**（旧版只调 `shiftSet`，不调 C3 新增的 `sessionAppend`）。
② 🔴 **回退时必须手工补回两处 C3 之后独立做的改动**：`theme.mount/unmount`（旧版没有）**和 WXML 根节点的 `{{tClass}}`** —— `theme.mount` 只是 setData，根节点没有 `tClass` 可挂 ⇒ **只补 JS 不补 WXML = 深色模式静默失效**（mount 成功、无报错、页面不变色）。
③ 🔴 **`check-shift-move` 的 A9~A11 / C7 已随之改写**：那三条守的是**向导专属**的 `_currentPlanItem`（向导里「调到哪天」是**日期** `shiftToDate`，要 `util.weekdayOfNum()` 折成星期几，漏了就是上一轮 41001 事故根因）；旧版**没有这个函数**，`toDay` 直取 `this.data.shiftToDay`（本来就是 1-7 星期几）⇒ 该 bug 结构上不可能复现。已合并为一条判据 `!_currentPlanItem && /const toDay = move \? this\.data\.shiftToDay : null;/`，C7 变异同步改为掏空 `move` 分支。**将来若再做回 C3 向导形态，A9-A14 与 C5-C7 必须一并恢复。**
⚠️ 改 C7 变异时踩的新坑：`const toDay = move ? this.data.shiftToDay : null;` 在旧版**出现两次**（week 单周次 + multi 多周次），`String.replace` 无 `/g` **只改第一处** ⇒ 变异体里第二处仍在，判据照样通过 = **假自证**。**凡判据锚点在同一文件出现多次，变异必须全量替换。**


node scripts/check-weeks-semantics.js # **`weeks` 字段的「未指定 / 非法值」语义（2026-10-07 线上事故新增，改 `common/week.js` / 任何 `parseWeeks` / `matchesWeeks` / 课次查询前必读）**。事故：用户报「第 4 周周四第 2 节明明是 3 号楼 303，首页和值日页都多出一节一区 212」。根因在 `common/week.js`：`parseWeeks('99')` 把超出 `1..53` 的值 filter 掉 → 返回 `[]` → `matchesWeeks` 的 `if (!arr.length)` 分支把它当「未指定」→ 落进 `matchesWeekRule('ALL', 4)` = **true**。🔴 即 **`weeks='99'` 的语义是「每一周都上」，与「隐藏」意图正好相反**；而 `weeks=''`（空串）在本项目语义**也是**「每周都上」（存量课大量依赖）⇒ **不能用「清空 weeks」来隐藏**。修法 = 新增 `isWeeksBlank` 拆开两个概念（blank ⇒ 每周都上；非空但全非法 ⇒ `return false` 永不上），并把 `parseWeeks` 的空值判断收敛到它（避免两处各写一套、空串语义漂移）。⚠️ `course/index.js` 的 `moveSessionSlots` 里 `if (arr.length) … else 铺满学期` 有**同样的坑**，已一并改；`sessionAppendRemove` 那处本就正确（不上的课次不该往回搬值日），**不要**「顺手统一」。🔴 **前端 `miniprogram/data/timetable.js` 的 `matchesWeeks` 语义本来是对的**（`'99'` → `set[4]` undefined → 不上）—— 这正是「课表页正常、首页/值日页中招」的原因；**云端与端上两份实现语义不一致**才是这类漂移的根源，故 B5 组做 98 组逐项对拍。结构：A 源码结构判据（`isWeeksBlank` 必须在、`matchesWeekRule` 只许出现 1 次、`if (!arr.length) return false`、必须 `trim()`、必须导出、course 侧分流）+ B 行为（`'99'` 全 18 周皆不上、`''`/`null`/`'   '` 仍每周都上、ODD/EVEN 仍生效、边界 1/53 保留 0/54 丢弃）+ C **5 组变异自证**（事故版 / 半修版 / 去掉 trim / **修过头把「未指定」也判不上** / 判据自身 `return false→true`），全部 `loadModule(内存副本)` 不落盘。⚠️ 两条纪律：对拍集合要配**前置断言**（防「用例集合写错却伪装成一致」）；变异自证要含**反向错误**（修过头把存量课全灭），只测「漏判」测不出「过判」

node scripts/check-ai-proxy-guard.js # **AI 自带密钥（2026-09-27 需求 D 下半，改 ai-proxy / schedule 的 AI 设置 / migrate-ai-setting.sql 必跑）**：A 文本层（三道闸 + 禁跳转的实现存在）+ B 行为层（抽生产源码 eval 真跑 `resolveEndpoint`：内网 / 回环 / 169.254 元数据 / 非 http / 非常规端口 / 带 `?` 或 `#` 必须全拒，官方与带路径的合法地址必须放行）+ C **5 组变异自证** + D 口径（`ai_setting` **按 member_id** 跟随本人、**只回掩码**、`setPosition` 撤职不清、仅删人时才清）。⚠️ ai-proxy 是全环境**唯一有公网出口且不绑 VPC** 的函数，「自定义地址 + 回显响应体」= 一条**可被借道的内网探测通道**，闸③ 不可删；端口闸的行为测试**必须用可解析的域名**（用不存在的域名会先在 DNS 失败，测不到端口闸）

node scripts/check-duty-columns.js   # **duty 表列名白名单（第 47，2026-09-28 线上事故新增，改任何 `FROM/JOIN duty` 的 SQL 必跑）**：`duty` 表**没有 `kind` 列**（只有 10 列 id/class_id/session_id/week/class_date/member_id/status/source/done_at/created_at；`kind` 在 `session` 表）。事故：`duty.myList` 写 `SELECT ... d.kind ...` → MySQL `1054 Unknown column 'd.kind'` → 「我的 · 待值日」弹层「加载失败」。本门禁用微型 tokenizer **剥注释**后取字符串字面量，对全仓云函数里每个 `FROM|JOIN duty <别名>` 校验 `<别名>.<列>` ∈ 白名单（`*` 放行）。⚠️ 同时守「d/s 列混读」陷阱：`... JOIN session s ...` 后 `s.kind` 产出的结果属性名恰好是 `kind`，代码读 `d.kind` **碰巧正确** —— 一旦给 duty 加 `kind` 列即静默出错，故一律显式 `s.kind AS sessionKind`。自证 4 组（剥注释自证 / 内存变异 `s.kind AS sessionKind`→`d.kind AS sessionKind` 必抓 / 合法列不误报 / `d.doneAt` 坏样本必抓）+ 防空转 `checked` 计数

node scripts/check-inline-style-join.js  # **WXML 内联 style 拼接（第 48，2026-09-29 事故新增，改任何弹层/带插值的 style 必跑）**：全仓 `style="…"` 里「三元以 `''` 收尾后紧接另一个插值」（`'}}{{`）一律判死 —— 那必然把上一条声明的值粘进下一条声明的属性名。事故：`bottom-sheet` 的 `{{height …}}` 与 1.0.4.4 新加的 `{{capStyle}}` 之间漏了 `;` → 拼成 `height:1040rpxmax-height:calc(100vh - 68px);` → **整条声明被丢弃** → 四个传 height 的弹层（添加值日 1040 / AI 生成 1280 / 导入 1180 / 加值日生 1240）固定高度失效、长列表滚不动。② 另点名断言 sheet-panel 的 `{{capStyle}}` 前必须紧邻 `;`。自证 3 组（删 `;` 必判死 / 好样本不误报 / 注释里的坏样本不被误判）

node scripts/check-duty-stats-source.js  # **值日统计同源（第 49，2026-09-29 新增，改 duty 的 myStats/myList 必跑）**：状态是**读时派生**的（`week.effectiveStatus`），库里 `duty.status` 恒为 `PENDING` ⇒ 谁自己写 SQL 数那个列，谁的数就与明细对不上（事故：「待值日 4 / 已结束 0」，弹层却是 3 / 1）。判据：myStats 体内**不得**出现 `SUM(status` / `COUNT(*) AS term`，且 myStats 与 myList **都**必须走 `deriveMyDuties()`，分桶必须走 `dutyBucket()`（唯一来源）。行为层抽 `dutyBucket` 真跑（六种状态分桶 + 复刻截图场景 4→3/1）+ 变异自证（把 myStats 改回 SQL 计数必判死）

node scripts/check-leave-register.js   # **请假登记的权限与多班隔离（第 50，2026-09-29 需求④新增，改 adjust 的 leave* / common/guard.js / auth.login 的 canLeave / roster 页请假入口必跑）**：守三处**静默**越权/串班 —— ① 三个路由体内必须有 `guard.requireLeaveRegister`；② `addLeave` 必须显式写 `class_id`（线上 `leave_request.class_id` 是 NOT NULL DEFAULT 1，靠默认值只有 1 班正确；而 schedule 按 class_id 过滤请假 ⇒ 串班后「已请假的人照样被排到值日」）+ 只给学生（`group_tag <> 'X'` + 排除测试账号）+ 幂等；③ `applyLeave` 的同类隐患一并守；④ `cancelLeave` 必须复查「同一天是否仍被另一条生效请假覆盖」再决定是否恢复值日。另守 `isCommittee` 排除教职工、`auth.login` 下发 `canLeave`、`app.js` 读 profile、roster 接线三个 api + `leaveShow` 进 page-meta。⚠️ **guard 的真源是 `cloudfunctions/common/guard.js`**（sync-common 复制进 12 个函数目录）—— 改副本 = 改错文件，下次 sync 会被覆盖（本轮实踩，被本门禁抓出）。变异自证（删 addLeave 的守卫必判死）

node scripts/check-class-isolation.js  # **课表跨班隔离（第 51，2026-09-29 用户反馈新增，改任何查 session / session_shift / course 的 SQL 必跑）**：`course` / `session` 有 `class_id`（`migrate-multiclass.sql` 加的），**「列出一批课次」的查询必须按班过滤**；`duty.today` 取「今日/明日课次」时漏了 `s.class_id = ?` ⇒ 把所有班的 session 混在一起返回（当时只有 示例班级A 有课 → 人人看到 示例班级A 的课表，且**不报错**）。判据：扫 `cloudfunctions/<fn>/index.js` 全部**字符串字面量**（先剥注释），凡 `FROM|JOIN session|session_shift` 必须带 `class_id` **或**已被**行级条件**限定（`xxx_id = ?` / `id IN (`；⚠️ 不能写成宽松的 `id =`，否则会被 JOIN 的 `ON c.id = s.course_id` 骗过 —— 本门禁第一次就栽在这）；例外逐条点名登记（cron 群发提醒本就跨班）。另断言 duty.today 必须 `s.class_id = ?` + `loadSessionShifts(pool, classId)`。双向自证（class_id 放行 / 行级限定放行 / 漏过滤判死 / 注释不算数）+ 变异自证（删掉 `s.class_id = ? AND ` 必判死）

node scripts/check-overscroll.js   # **列表 overscroll 弹性拉伸（第 52，2026-09-29 新增，改 spring-scroll / 任何 scroll-view 类列表页 / 任何带下拉刷新的列表必跑）**：守五条静默退化 —— ① 位移+拉伸只走 `transform: translate3d(0,{{_offset}}px,0) scaleY({{_scale}})`，**绝不碰 `height`/`margin`/`top`**（否则每帧重排、列表卡顿）；② 只在边界接管：`raw>0`（顶，scrollTop===0）/`raw<-maxScroll`（底，已滚到底）才做橡胶带形变，区间内是 1:1 正常滚动；③ 回弹用松手前 `_velocity` 做 spring 阻尼积分（半隐式欧拉、收敛到目标），**非固定 300ms 匀速弹回**；④ 内容位移乘 `CONTENT_DAMP=0.6`（<1，有重量、绝不 1:1 跟手）、边界最大拉出 `RUBBER_MAX=120px`（指数衰减 `RUBBER_MAX*(1-exp(-|o|/RUBBER_SCALE))` 封顶）、下拉刷新阈值 `REFRESH_PX=60px`；⑤ `bottom-sheet` 内列表已改用 spring-scroll（弹层同样获得顶部/底部弹性 + 刷新）。3 组变异自证（删 scaleY 拉伸 / 删顶部边界接管 / 阻尼改 1:1 必翻红）。

node scripts/check-roster-hidden-staff.js   # **成员与分组·教职工隔离 + 已绑定口径（第 53，2026-10-04 用户反馈新增，改 roster 名单/统计 或 member.list 的 manage 分支必跑）**：守四条 —— ① roster `_loadMembers` 的名单必须过滤 `groupTag !== 'X'`（成员与分组**不显示辅导员**，教职工账号/绑定只在「班级管理→教职工管理」里维护）；② `boundCount` 必须同时排除 `test` 与 `X`（否则「已绑定」会把测试账号/辅导员算进去，与「总人数」口径不一致）；③ **反向**：`member.list` 的 `public:'manage'` 分支**不得**加 `group_tag <> 'X'` —— 「切换测试账号」要靠它取到**测试辅导员**视角（`mine._pickTestAccounts` 明确支持切到辅导员），后端一刀切会让该验证能力永久失效；④ 相对面：值日页选人 / 首页通知选人各自保留 X 过滤。3 组变异自证（删成员列表 X 过滤 / 已绑定口径改回只数 bound / 给 manage 分支塞 group_tag <> X 必翻红）。⚠️ 取 `_loadMembers` 方法体时锚点必须写 `_loadMembers() {`（带花括号）—— 该名字的**调用点**在定义前出现十余次，只写 `_loadMembers()` 会截错块导致判据假通过。

node scripts/check-class-order.js   # **班级统一排序（第 54，2026-10-04 线上实踩新增，改 util.sortClasses / 任何班级列表渲染必跑）**：唯一来源是 `utils/util.js` 的 `sortClasses()`（专业优先级 小教/小学教育→英语→商务英语→其它 + 组内按名称首个 4 位数字）。守的是**「排序悄悄变空操作」**这种不报错的 bug —— 班级名的字段名**两种都有**：`class.list` 返回 `name`、`leaveSummary` 辅导员分支返回 **`className`**；比较器只认 `name` 时，拿到 className 形状的数据全部读成空串 → 同序 → 原样返回（线上实证：辅导员「各班请假人数」示例班级A 一直第一位，上传修复后仍不变）。4 条判据（className 形状 / name 形状 / 纯函数不改入参 / 「商务英语」不被「英语」误捕）+ 2 组**行为级**变异自证（把 `c.name || c.className` 改回只认 name、删掉 '商务英语' 优先项 → 必须翻红）。变异用内存 `new Function` 加载，不落盘。

node scripts/check-duty-ended.js   # **本周值日「已结束」折叠（第 55，2026-10-04 需求新增，改 pages/duty 的「按日」列表 / `data.days` / 弹层必跑）**：把本周里**早于今天**的日子收进顶部「已结束」弹层，主列表只画今天及以后；今天是 9/29 → 9/28 及以前进弹层。守 7 类共 20 条断言：A 主列表渲染源必须是 `activeDays`（不得再有 `wx:for="{{days}}"`）；B 入口必须同时挂 `bindtap="onEndedOpen"` + `mode === 'day'` + `pastDays.length`；C 弹层内有 `pastDays` 且**不含**「加值日生」（过去的日子不再补排，也避免和主列表抢 check-permission-delegate 的 canSchedule 计数）；D `onEndedOpen/onEndedClose` 翻转 `endedSheetShow`、空列表有 guard；E～G **行为级**：把真实 `_paint` 方法体抽出在内存里 `new Function` 真跑（假 this 注入 `_decorate/_toPersons/setData`，`util.fmtDate` 固定今天）→ 验证本周 past=[昨天] / active=[今天起]，而历史周**不折**（pastDays 为空、activeDays 整周）、`_toPersons` 与底层 `days` 在两种情况下都拿**整周**。7 组变异自证（`<` 改 `<=` → 今天被两边重复；`>=` 改 `>` → 今天两边都丢；三元揉平 → 历史周被折；`_toPersons(days)`→`(activeDays)`；主列表改回 `days`；入口删 `mode === 'day'`；弹层塞回 `onAddOpen`）。⚠️ 判据坑：只盯 `activeDays` 抓不到「`<` 写成 `<=`」（今天会同时出现在两个列表，activeDays 那侧没变）→ 变异判据必须取 **past+active 的完整划分**。结构变异用「同一把 `between` 先量再贴」注入，避免缩进不匹配的空替换（本门禁首次跑时发现：`.replace()` 直接替换带换行的字面量会静默不生效 = 假自证）。滚动锁由 check-scroll-lock.js 按 `endedSheetShow` 自动覆盖，本门禁不重复断言。

node scripts/check-rotation-date-order.js   # **轮转取人按「实际上课日期」排序（第 56，2026-10-05 国庆调休实锤新增，改任何调 rotationPick 的循环必跑）**：`session.day_of_week` 记的是**课表上的星期几**，调休（MOVE）只把课挪到新日期、day_of_week 不变 ⇒ 按 `ORDER BY s.day_of_week` 迭代会让调来的那天排在后面几天的**前面**被分配轮转序号（线上：10/7→10/10，轮转顺序变成 10 号、8 号、9 号，应为 8→9→10）。三条链路同口径修好：`schedule.generate`、`schedule.buildCleaningPlan`、`cron-weekly` 都改成「先算 `rotatePlan`（解析后 classDate）→ `sort(classDate, period, id)` → 再遍历取人」。判据：A 三条链路都遍历 `rotatePlan`（classDate 排序后取得）+ **反向**「没有直接 `for (const s of sessions)` 就调 `rotationPick` 的循环」（预解析循环里有 resolveSlot 是正常的，故按「块体内是否含 rotationPick」判）；B **行为级**抽 comparator 在内存里跑国庆场景 [(周三课→10-10),(周四→10-08),(周五→10-09)] 必须输出 10-08→10-09→10-10，另测同日按节次→课次 id；C 三条链路输出必须一致（自动/手动不许分叉）；D 相对面：`aiPlan` 的 `ordered` 仍按 date 排（正确样板）。4 组变异自证。⚠️ 写这条门禁时踩的两个坑（都靠自证当场抓出来）：① 抽 `sort(...)` 实参拿到的是**整个箭头函数**，`new Function` 里必须**立即调用**它，直接 return 会让 sort 拿到函数当比较结果 → **全绿假象**；② 判「旧循环已消失」不能只搜 `resolveSlot` —— 新写的预解析循环里就有它，会把好代码判死，要按「循环块体内是否出现 rotationPick」判。

node scripts/check-timetable-import.js   # **青果课表导入映射与隔离（第 57/58/59，2026-10-05 需求 D-2 新增，改 course 的 importTimetable/applyTimetable/import-parse 必跑）**：三道闸 —— ① #57 解析映射（`import-parse.js`）：列位置→day_of_week(1-based)、节次标签→period、周次文本→显式 CSV weeks 且 week_rule='ALL'、同(课程名+教师)去重为一门 course、kind='COURSE'/dutyCount=2；② #58 班级隔离：`importTimetable` 必须用 `guard.resolveClassId` 收口（认传入 classId），严禁 `classIdOf`（超管适配他班时 classIdOf 忽略传入 ⇒ 数据写进自己班）；③ #59 命名格式：`applyTimetable` 的 fileName = '【班级名】-教学安排表'，括号只包班级名、名称取自 class 查询（cls[0].name），绝不包文件名。三处各带双向自证（weekRule 改坏 / resolveClassId→classIdOf / 去掉【】必翻红）。

node scripts/check-dark-mode.js      # **深色模式 C-4（2026-10-07 新增，改 `app.json` / `app.js` 的 theme 初始化 / `app.wxss` 令牌 / 任何页面的 `{{tClass}}` / nav-bar 主题按钮必跑）**：用户报「深色模式切换没有实装」—— 上一轮 `utils/theme.js` + `theme.json` 都建好了，**但整条链没通电**（`app.json` 没开 `darkmode`、`app.js` 没调 `init()`、页面根节点没主题 class、令牌写死在 `page{}` 里永远浅色）。六类事故逐条钉死：①**接线层**（`darkmode`+`themeLocation`+`theme.init()` 且必须在身份加载**之前**，否则首帧先浅后深闪一下）；②**作用域层**（🔴 WXSS 的 `page` **只能选元素本身、不能选 class** ⇒ 主题 class 必须由每个页面挂在自己根 view 上，漏一个页面那个页面就仍是浅色；11 个页面逐一验 `{{tClass}}` + `mount`/`unmount`）；③**令牌层**（`.t-light`/`.t-dark` 集合**严格一致** + 逐个比值不同 + 亮度方向校验 bg 变暗/text 变亮 + 深色玻璃 tint 不是白色）；④**写死白色的降级兜底**（`@supports not(backdrop-filter)` 与 `prefers-reduced-transparency` **各须一份 `.t-dark` 覆盖**，否则「深色 + 系统降低透明度 = 一整片纯白卡片」，正好把深色模式废掉）；⑤**组件层**（nav-bar `bg`/`color` 默认值走 `var(--token)`；揭示动效用 `clip-path: circle()` **禁 scale**、半径取**最远角**、`pointer-events:none`、z-index 必须高于**全仓最高浮层**——动态扫全仓 wxss 不写死清单）；⑥**行为仿真**（真 `Module._compile` 编译 `theme.js` + 假 `wx`，验三态/落库/mount 幂等/unmount 不 setData）。🔴 **开关感知**：`utils/config.js` 的 `DARK_MODE_ENABLED` 关闭时验「入口已隐藏 + 渲染锁浅色」，开启时验「入口在场 + 三态可用」—— 行为仿真用 `loadTheme(src, true/false)` **两种形态都编译跑**，不依赖 config 当前值（⚠️ 假模块必须设 `m.filename`，否则 `require('./config')` 解析不到、cache 注入不命中 ⇒ MODULE_NOT_FOUND；变异样本也必须显式注入 true，否则开关关着时好坏样本都是 light ⇒ 假绿）。9 组变异自证全部**在内存副本上做**。⚠️ **本门禁踩过的三个坑（都是老坑复发）**：①**假 `wx` 必须挂 `global.wx`** —— 小程序模块里是裸 `wx.xxx`（自由变量），只在 `g.wx` 放一份则模块拿到 undefined，而 `theme.js` 每个 wx 调用都包在 try/catch ⇒ **全静默吞掉**，表现为「system 不跟系统 / setMode 不落库」这类**假失败**（16 项红里一半是它），加载完要 `restore()`；②**变异锚点漏尾逗号**（`value: '…' },` 那个 `,`）⇒ 变异自证**假绿**，所有变异都要先 `chk(mutated !== original, '锚点命中')`；③**变异要打在真实调用链上**（误以为「系统跟随」走 `resolve()`，其实走 `wx.onThemeChange` 回调里直接赋值、不经过它 ⇒ 改了零影响、自证看着绿其实没验）。另：供变异复用的判据常量必须放**模块作用域**，块内 `const` 外部看不见

node scripts/check-history-filter.js   # **历史请假按日期分组 + 筛选 + 搜索（第 66，2026-10-08 需求新增，改 roster 的历史请假段 / `adjust.leaveHistory` / `util.todayStr`/`dateAddDays` 必跑）**：纯行为级门禁 —— 把 `_applyHistoryFilter` / `_historyFiltered` / `_histMatch` / `_histDateLabel` / `_histWeekday` 五个方法**抽出来在内存里真跑**，34 条断言覆盖「分组键 = `startDate`（不是按天展开，跨天假只在开始那天出现一次，行内已写 `startDate ~ endDate`）/ 区间按 `startDate` 判（与分类键同口径，否则筛出的一组却在组外）/ 快捷时段与区间互斥且快捷优先 / 近 N 天含今天（`from = today - (N-1)`）/ 人员多选任一命中 / 三路有序搜索 / 组合筛选 / 空态区分 / 候选列表与筛选共用 `_histMatch`」。11 组变异自证全部必须被抓（区间下界 `>` vs `>=` / 上界改用 `endDate` / 近 N 天少一天 / 快捷不覆盖区间 / 「任一命中」改「全部命中」/ 短学号退回子串 / 全学号模糊不限长 / 分组键改 `endDate` / 分组丢 `count` / 「今天」标签失效 / 星期偏移一天）。⚠️ **三个必须照抄的坑**：①**短学号必须「整段相等」且全学号模糊限长 ≥4 位** —— 学号本身含序号（`2026010101` 里有 `01`），用子串或不限长则「搜 01」把全班捞出来；两条路互为兜底时结果完全相同、**互相掩盖 ⇒ 变异抓不到**，须另配两条**可观测**断言（搜单字符 `'0'` = 0 条 / 搜完整短号 `'01'` = 1 条）；②**夹具必须按后端真实排序**（`start_date DESC, RIGHT(student_no,2) DESC, id DESC`）书写 —— 分组「组序天然倒序」依赖它、代码内不再排一次，随手按日期聚类会让组序断言失败（那次是夹具不对不是代码错）；③**抽页面方法做行为测试的四坑** —— 必须先 `stripComments` 再定位**且用 stripped 切片**（JSDoc 里的 `{…}` 会被当方法体起点，而剥了注释却拿原文同下标切片会错位）、切片**必须连方法名一起抽**否则 `return _foo() {}` 语法错误、签名不能自己造（`ds`/`today` 会未定义）、`new Function(dep,…)` 返回的是**工厂**必须先调用拿函数再 `.call`（直接 `工厂.call(page, dep)` 是把 page 当依赖传 ⇒ 返回的函数从不执行 ⇒ setData 没跑、断言全 undefined）；对象方法简写**不能当独立表达式**（`_histWeekday(ds){}` 是语法错误，须改写 `function`）、箭头函数没有自己的 `this`（抽页面方法必须普通 function 包装）；五个方法互相调用**必须全挂上**，只挂入口会 `ds is not defined`。

node scripts/check-sheet-resize-anim.js  # **弹层高度过渡（第 67，2026-10-08 用户两次实拍「切换后高度突然降低」+「闪烁两下、几乎没有平滑的降低动画」新增，改 bottom-sheet 的 resizeAnim / `_animateResize` / `_measureHeights` / `_setResizeClamp` / `_playResize` 必跑）**：自适应高度弹层面板是 `height: auto` + `max-height`，而 **CSS 过渡不了 `height: auto`**。⚠️**第一版（已废弃）= 两段式「锁定 → 放开」**，用户实测两个缺陷都出自它：**闪烁两下**（`resizeScroll()` 在 setData 回调里调，那一刻内容已重排完、面板已是新高度，此时才写回旧高度 ⇒ 「跳到新 → 又跳回旧 → 再过渡到新」= 两次可见跳变）；**几乎不平滑**（第二段是「显式 px → `height:auto`」，auto 不可插值；且挂 class 与改值落在同一批 setData 被合并成一次样式提交 ⇒ 过渡根本没起播）。**现行修法 = min-height / max-height 成对夹紧**：常态下发 `min-height: H px; max-height: H px`（H = 上一次落定高度），上下同值 ⇒ 面板可见高度恒等于 H、内容怎么变都动不了它（**不会提前跳变**）；两端都是确定 px ⇒ 浏览器直接插值；**变高变矮完全对称**（⚠️ 只写 `min-height` 做不到 —— 变高时 `height:auto` 会立刻把面板顶上去，仍是硬跳变，这正是本轮修的核心）。目标高度**从内容算**（`chrome + sc.contentHeight()`）而非量面板（夹紧值一旦下发，量面板恒等于夹紧值 ⇒ 永远发现不了变矮）。本门禁钉六条**看不出来的失效**：①**from 不能靠本次量出来**（取 `this._lastPanelH`；若量当前高度则 from 恒等 to ⇒ 差值恒 0 ⇒ **永不动画且不报错**，最容易写废的形态）；②**目标必须从内容算**；③**成对下发**（漏一个方向面板就被钉死）；④**必须两拍**（先只挂 `.animating`、等 `TRANSITION_ARM_MS=16ms` 再改高度；同批 setData 会被合并 ⇒ 无动画）；⑤**开场静默期 OPEN_SETTLE_MS=260**；⑥**body 选择器必须是 `.sheet-spring`**（v1.0.5 起 body 已换成 spring-scroll，`.sheet-body` 只留在 wxss 当历史说明、**wxml 里根本不存在** ⇒ 恒为 null ⇒ 整段 return ⇒ 动画静默失效；第一版实打实踩过）。另钉 `.animating` **必须带 transform**（`transition` 是简写属性、会整条覆盖，不带 ⇒ 位移过渡被抹掉）与 min/max 时长曲线一致。行为层用假 `createSelectorQuery`（支持 `fields({size:true})`）+ 假 `setTimeout`/`clearTimeout`/`getApp` 真跑两拍时序 + 变高/变矮对称 + 上限 cap + 11 条守卫。6 组变异自证（M1 目标误取 from / M2 两拍不等 16ms / M3 删静默期 / M4 删最小区差 / M5 只写 min-height / M6 选择器退回 `.sheet-body`）。⚠️ **写这类门禁自身的六个坑**：①`new Function` 建的函数在**全局作用域**跑，组件模块作用域的 `const`、宿主全局 `getApp` 取不到 ⇒ 必须注入；②假 `setTimeout` 也必须注入（否则打到 Node 真定时器、断言永远等不到）；③**变异体必须语法合法且能真跑**（SyntaxError / ReferenceError 被当成「抓到了」= 假自证，故 judge 包 try/catch 并把「变异体语法非法」单独判死）；④**变异锚点必须逐字真实且唯一**，且**替换后要断言源码真的变了**（`indexOf < 0` 与 `mutated === js` 要单独判死，否则 replace 静默失效会被误报成「锚点漂移」）；⑤假实例的**方法 stub 必须放在真方法注入之后**（否则被覆盖、固定上限 capPx 静默失效，测出来的 to 全是真实 `_capPx` 算的值）；⑥假 `getApp` 的 `windowHeight` 要写 `=== undefined ? 默认 : 值` 而不是 `|| 默认`，否则显式传 0（测「拿不到窗口高」分支）会被吃掉。另：`.animating` 的 transition 列表**必须写单行**——`check-wxss.js` 不接受跨行以 `,` 结尾（会判「疑似漏了分号」），尽管真编译器接受。
   - **同日追加第七条判据 ⑦「顺序：先重测、再算高度」**（2026-10-08 用户实拍「下面选择同学偶尔不显示成员，只有在搜索框输入序号才会显示出来」；高度过渡 v2 带出的回归）：`spring-scroll.contentHeight()` 返回 `_contentH`，而它**只在 `_measure()` 的异步 selector query 回调里更新** ⇒ 原来的 `resizeScroll()` 写成「先 `_animateResize()` 后 `sc.resize()`」拿到的**必然是上一轮的旧高度** ⇒ 面板夹紧值被锁在偏矮数字上、再也长不高 ⇒ **成员名单其实渲染了却被裁掉**（截图里第 13 行只露半颗）；输序号能出来，是因为输序号触发新一轮 setData，那时上一轮的 `sc.resize()` 已经把 `_contentH` 更新对了。**修法四处缺一不可**：①`spring-scroll.resize(cb)` 加回调，**在 `_maxScroll` 夹紧之后**才触发；②`resizeScroll()` 改 `sc.resize(() => this._animateResize())`；③**重入保护不丢弃请求** —— `_resizeEndTimer` 在位时置 `_resizePending = true`，`_setResizeClamp` 收尾定时器里补算（否则过渡那 276ms 内来的高度变化永久丢失）；④`active` observer 在 300ms 铺完夹紧初值后**再补一拍 `resizeScroll`**（80ms 那次落在 260ms 开场静默期内、只补可滚动范围不算高度 ⇒ 名单在 300ms 后回来就永远不补）。页面侧同源一处：`roster._applyMemberRows` 在弹层开着时重算 `leaveCands`（`leaveBoard` 可能先于 `member.list` 返回，候选会是空数组）。**变异加到 9 组**：M7 顺序反回「先算后重测」/ M8 收尾不补算 pending / M9 删 300ms 兜底补调，**9/9 全被抓**。**门禁自身另加两个夹具坑**：⑦要模拟异步测量就必须让假 `contentHeight()` **可变**（给 `resize(cb)` 一个 `contentHAfter`，重测时才换值），否则测不出时序 bug；⑧断言 `sets.find(s => s.resizeStyle !== undefined)` **必须在触发两拍的定时器之后**取，在之前取只拿到拍 1 的 `{resizeCls}` ⇒ 报「没下发 style」的假失败。

node scripts/check-test-account-hidden.js # **测试账号全站隐藏（第 65，2026-10-08 用户指令「所有人员列表都不显示测试账号，包括后面新增功能」新增）**：测试账号（前缀 `0000000000`，id 69+）从**所有**人员列表消失，**含超管**；唯一例外是「我的 → 切换测试账号」，走**独立 action** `member.testAccountList`。新增 `conditionalFilter`（按条件过滤，避免判据误伤）/ `balanced`（括号配平）两个工具函数。变异自证必抓「漏一处 SQL / 漏一个入口」。

# 合计 67 个门禁（第 45 = check-permission-delegate.js、第 46 = check-ai-proxy-guard.js，均为 2026-09-27 需求 D 新增；第 47 = check-duty-columns.js，2026-09-28 线上 myList 1054 事故新增；第 48/49/50 = check-inline-style-join / check-duty-stats-source / check-leave-register，2026-09-29 1.0.5 新增；第 51 = check-class-isolation.js，2026-09-29 首页课次串班新增；第 52 = check-overscroll.js，2026-09-29 overscroll 弹性拉伸新增；第 53 = check-roster-hidden-staff.js，2026-10-04 成员与分组隐藏教职工 + 已绑定口径新增；第 54 = check-class-order.js，2026-10-04 班级统一排序（className 字段漏认）新增；第 55 = check-duty-ended.js，2026-10-04 本周值日「已结束」折叠新增；第 56 = check-rotation-date-order.js，2026-10-05 调休周轮转顺序（day_of_week ≠ 实际上课日）新增；第 57/58/59 = check-timetable-import.js，2026-10-05 青果课表导入（解析映射 / resolveClassId 收口 / 【班】-教学安排表 命名）新增；第 60 = check-page-registry.js，2026-10-07 页面注册表（`pages/` 与 `app.json` `pages[]` 一一对应）；第 61 = check-weeks-semantics.js，2026-10-07 `weeks='99'` 语义反转事故；第 62 = check-glass.js 迁出；第 63 = check-dark-mode.js，2026-10-07 深色模式 C-4），退出码 0 = 过；新增门禁**必须**登记到本清单并带双向自证
# 全量跑法（一条命令看总数）：
#   for f in scripts/check-*.js; do node "$f" >/dev/null 2>&1 && echo "ok $f" || echo "FAIL $f"; done

# 探针（非门禁，跑一次看结论）：用线上库快照真跑 duty.today，验收「放假日 = 今日无课 / 明天无课」
node scripts/probe-today-sessions.js

# 一次性数据修复生成器（非门禁，跑一次出 SQL）：v0.7.23 用生产 `rotationPick` 在**修复态名册**
#   （01–08 = 2 次、09–56 = 1 次）上复跑第 5 周 → 生成订正 INSERT 到 `.workbuddy/week5-fix.sql`
#   （46 行 / 序号 09~54 / 无重复）。**用完即归档，勿反复跑**（跑两次 = 两套 SQL，见 MEMORY 铁律 9「命令可能被执行两次」）
node scripts/gen-week5-fix.js
# 再通过 manageFunctions(action="updateFunctionCode", functionName=xxx,
#                        functionRootPath=<项目>/cloudfunctions) 逐个更新
```

> 注意：`functionRootPath` 必须指向**直接包含函数目录**的 `cloudfunctions`，不要写到函数子目录。

> 改动 `common/*` 时，**所有**依赖它的函数（course/schedule/duty/export/adjust/member/auth/media/poster/cron-weekly）
> 都要重新部署，否则各函数的 common 副本版本不一致。`scripts/sync-common.js` 负责复制，
> 但**不会**帮你部署。

## 2.1b 本次部署通道（tcb CLI 3.8.4，2026-09-27 实跑通过）

```bash
TCBJS="C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb"
ENV=<YOUR_ENV_ID>

# ⚠️ 三个必须同时满足，否则部署失败：
#   ① 必须 cd 进**函数目录**（在仓库根跑会把整仓打包 → 「ZipFile 不能大于 1.5MB」，
#      退回自动方式又会「COS 上传超时 60 秒」）
#   ② --dir . --deployMode zip    → 走「ZIP base64 上传」
#   ③ printf '\n\n\n' |          → CLI 会弹交互式确认，管道送 Enter；不送会 SIGTERM
# ⚠️ 这份清单必须与「含 common 副本的函数」**完全一致**：
#    `ls -1d cloudfunctions/*/common | wc -l` = 12（ai-proxy 不连库、不带 common，是唯一豁免）。
#    2026-09-29 实踩：清单里漏了 `poster`（只列了 11 个）→ 改 common/guard.js 后少部署一个函数，
#    它的 guard 副本会长期停在旧版。**改 common/* 时先跑上面那条 ls 对齐清单**。
for f in auth schedule adjust member class course duty export media cron-weekly audit-receiver poster; do
  ( cd cloudfunctions/$f && printf '\n\n\n' | \
    timeout 240 node "$TCBJS" fn code update $f --dir . --deployMode zip -e $ENV )
done
```

**部署前先排除「线上有热修、仓库没有」**（否则部署本地版 = 静默回滚线上改动）：
先把线上版下载回来与**改动前备份基线**比对，全一致才说明「仓库即真源」。

```bash
for f in <同上 12 个>; do node "$TCBJS" fn code download $f _online/$f -e $ENV; done
BASE=".workbuddy/backups/<改动前的备份ID>/cloudfunctions"
for f in <同上 12 个>; do diff -rq --exclude=node_modules "$BASE/$f" "_online/$f"; done
```

**CLI 两个坑**：日志**别**重定向到 `/tmp`（本机不可写，会 SIGTERM）→ 写工作区；
`fn detail --json` 的 VPC 在 **`VpcConfig.vpc.VpcId`**（嵌套两层，不是 `VpcConfig.VpcId`），
直接取会显示 `undefined`，别误判成「VPC 丢了」。

## 2.1c 用开发者工具上传云函数（**本项目当前环境走这条**）

> 背景（2026-09-29 查明）：仓库里有**两份** `project.config.json` ——
> **根目录**那份有 `miniprogramRoot` + `cloudfunctionRoot`（能上传云函数），但 appid 曾是 `touristappid`（游客模式）；
> `miniprogram/` 那份 appid 是真实的 `<YOUR_APPID>`，但**没有 `cloudfunctionRoot`**。
> 开发者工具若**打开的是 `miniprogram/` 目录**，就**看不到「云开发」入口、也传不了云函数**
> —— 这正是「线上云函数长期没更新」的真正原因（不是忘了传，是没有入口）。
> 已把**根目录**那份的 appid 改成真实值，两条能力随之齐备。

**步骤**：
1. 开发者工具 → 「项目」→「打开最近」/「导入项目」→ 选**仓库根目录** `C:\Users\PC\WorkBuddy\LZXQ-WorkBuddy`
   （不是 `miniprogram\`）。确认「小程序根目录」自动是 `miniprogram/`。
2. 左侧文件树会出现 **`cloudfunctions`** 目录（带云图标）。
3. **改哪个传哪个**：右键 `cloudfunctions/<函数名>` → **「上传并部署：云端安装依赖（不上传 node_modules）」**。
   - 一次要传多个就逐个右键（12 个函数约 1~2 分钟）。
   - ⚠️ 右键必须落在**函数目录本身**上，不是仓库根。
4. 传完在「云开发」面板 → 云函数 → 选函数 → **「函数代码」** 可直接肉眼核对最新代码
   （如 `adjust` 是否含 `resolveClassId`、`duty` 是否含 `s.class_id = ?`）。
5. 前端改动：点顶部 **「上传」**（或「预览」扫码真机验证）。

**与 CLI 通道（§2.1b）的关系**：两条传的是同一个 `cloudfunctions/<fn>` 目录，效果等价；
CLI 适合脚本化 / 批量，开发者工具适合「改一个传一个」+ 肉眼核对线上代码。
⚠️ 只改前端（`miniprogram/`）时**不需要**这一步，直接「上传」即可。

## 2.2 部署后核对（发布门禁，必做）

**不要**用 `queryFunctions(getFunctionDownloadUrl)` 拿链接再手动 curl —— 返回的签名 URL 里
`q-ak` 是脱敏前的长 AK，人眼复制极易出错，会得到
`<Code>InvalidAccessKeyId</Code>`（看着像权限问题，其实只是复制错了）。
用 CLI 直接下载，无签名、无手抄：

```bash
# ⚠️ 必须用带 .js 的真实入口，不能直接用 .../cli-connector-packages/tcb
#    （那个是 bash 包装脚本，交给 node 跑会报 "missing ) after argument list"）
TCBJS="C:/Users/PC/.workbuddy/binaries/node/cli-connector-packages/node_modules/@cloudbase/cli/bin/tcb"

for f in course schedule duty export adjust; do
  node "$TCBJS" fn code download $f _verify/$f -e <YOUR_ENV_ID>
done

# 逐文件比对（node_modules 是云端装的，排除掉）
for f in course schedule duty export adjust; do
  diff -r --exclude=node_modules cloudfunctions/$f _verify/$f && echo "一致 $f"
done
rm -rf _verify
```

**`diff` 无输出才算部署成功。** 首次运行 CLI 若提示未登录，会打印一个
`https://tcb.cloud.tencent.com/dev#/cli-auth?user_code=XXXX-XXXX&flow=device` 授权链接，
浏览器打开一次即可（与 MCP 用同一套凭据）。注意 CLI 登录会**轮换凭据**，
之后 MCP 会报 `AUTH_REQUIRED`，需要 `auth(action="status")` 看到 `REQUIRED` 时
再走一次设备码登录恢复。

补充两条快速佐证（不替代上面的 diff）：
- `queryFunctions(getFunctionDetail)` 的 `Status` 应为 `Active`、`ModTime` 应是刚才的时间，
  且 `CodeInfo` 里能找到本次改动的那几行（entry `index.js` 的原文）；
- `manageFunctions(invokeFunction)` 冷启动一次，带鉴权的 action 返回 `40001`（本环境 MCP
  没有 WX 上下文）即说明模块图加载、路由正常 —— 语法/require 出错会报别的错。

## 3. 数据库初始化

`scripts/init.sql` 已通过 MCP `manageMysqlDatabase.initializeSchema` 执行。
重复执行安全（CREATE IF NOT EXISTS + INSERT IGNORE；member 种子表为演示数据，勿重复插入）。

### 3.1 增量迁移

单条 DDL 走 `manageMysqlDatabase(action="runStatement")`（**一次只允许一条语句**，多条会报 1064）。

| 脚本 | 做了什么 | 状态 |
|---|---|---|
| `scripts/migrate-weeks.sql` | session 增加 `weeks` 列（周次编码） | 已执行 |
| `scripts/migrate-session-shift.sql` | 新建 `session_shift`（按周生效的课次例外） | 已执行（2026-09-24） |
| `scripts/migrate-notice-popup.sql` | `notice_msg` 加 `popup` 列 + 新建 `notice_popup_seen`（发布通知的「一次性弹窗」，每人每条一次） | 已执行（2026-09-27） |

`session_shift` 的结构（同时已并入 `init.sql` §15）：

| 列 | 说明 |
|---|---|
| `session_id` + `week` | 联合唯一键 `uq_shift`，决定「哪节课 · 哪一周」 |
| `kind` | `ENUM('OFF','MOVE')`：OFF=本周不上；MOVE=换到 `to_day`/`to_period` |
| `to_day` / `to_period` | 1–7 / 1–5，仅 MOVE 使用 |
| `note` | 备注 / 来源（手动调课、多周次调课、按日期取消、AI 调课） |

> 表不存在时所有读取都会降级成「没有临时调课」（`loadSessionShifts` 吞异常），
> 所以漏建表不会让课表打不开，但临时调课功能会静默失效 —— 排查时先看这张表在不在。

## 3.2 云存储

- `icons/`：**78 个 SVG**（45 个图标族 × 品牌/灰/白/橙/红等变体），由 `scripts/gen-icons.js` 生成。
- 小程序侧统一经 `miniprogram/utils/icons.js` 的 `cloud://` 文件 ID 引用；`<app-icon>` 组件在 `binderror` 时自动降级为内联 base64。
- 自查：`node scripts/check-icons.js`（名称引用）/ `node scripts/check-icons-cloud.js`（云端文件一一对应）。
- 运行时上传目录：`duty/{bizId}/`（照片）、`notice/`（15s 语音）、`wxacode/{scene}.png`（小程序码缓存）。

## 4. 上线前必须调整（状态更新于 2026-09-25）

1. **`MEDIA_AUDIT` 改 `strict`**（**待办**，两个前置条件缺一不可）：
   - 前提 A：mp 后台「开发管理 → 消息推送」绑定到 `audit-receiver`（云函数接收）——**先确认绑定生效再改值**，
     否则语音通知会卡在 AUDITING 不显示（hourly 兜底触发器线上不存在）；
   - 前提 B：`updateFunctionConfig` 把 media 的 `MEDIA_AUDIT` 改为 `strict`；
   - 当前线上为 `auto_pass`（语音直接显示），不影响发布，两者齐了再切。
2. ~~`poster.getQrcode` 中 `checkPath: false`~~ **已完成（2026-09-25）**：已删除 `checkPath:false`（恢复默认页面校验，
   41030 走 50030 友好兜底）；**同时把 envVersion 默认从 `trial` 改为 `release`** —— 原默认会生成体验版小程序码，
   正式版同学扫码打不开，这是真正的上线阻塞项，已随本条一起修复并部署。
3. 订阅消息模板状态：
   - `TEMPLATE_REMIND` ✅ 已配齐：cron-weekly（21:00 提醒）+ media（testRemind 测试提醒）+ 前端 `SUBSCRIBE_TEMPLATE_ID`；
     `TEMPLATE_REMIND_STATE` 未设 → 默认 `formal`，**只有正式版能收到提醒**（体验版收不到属预期，不设 developer）。
   - `TEMPLATE_PUBLISH`（schedule 发布值日表推送）/ 班级通知 `TEMPLATE_NOTICE`：未申请，代码安全降级（不推送、不报错），上线后可选增强。
   - `TEMPLATE_SWAP`：代码无引用，历史文档超前，无需处理。
4. ~~替换 `init.sql` 演示数据~~ **不适用**：真实班级（示例班级A）与成员已在线上库，init.sql 仅作重建库还原脚本（import_members.sql 按学号还原管理员）。
