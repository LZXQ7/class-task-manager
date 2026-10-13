# 动效机会审计 · v0.7.14（find-animation-opportunities）

> 方法：对全站逐页扫描「应该有动效却没有」的交互点，用四道闸逐一过滤。
> **四道闸**：① Frequency（用户多常触发）② Purpose（反馈是否必要）③ Speed（动画是否该快）④ Function（是否真解决问题）。
> 结论：筛出 4 条机会，全部通过四闸，本版落地。

---

## 通过四闸、本版落地的 4 条

### ① 发布按钮按压反馈（首页 · 发布通知）
- **Frequency** 高：每次发布通知都点。
- **Purpose** 必要：点下去到云函数返回有数百毫秒延迟，按钮毫无反馈会被误判「没点上」。
- **Speed** 必须即时：按下当帧就要有反应（<100ms），不能等网络。
- **Function** 解决「点不点得动」的感知问题。
- **落地**：`.np-btn:active` 在原有 `opacity` 基础上加 `transform: scale(.975)`，并给 `.np-btn` 加 `transition` 回弹。

### ② 名单页全页 hover（roster）
- **Frequency** 高：名册是最常翻的页之一。
- **Purpose** 必要：成员行此前没有任何按下反馈，长列表里点哪一行没焦点感。
- **Speed** 即时。
- **Function** 让「我点在哪一行」可见，降低误触。
- **落地**：`.mb-row` 加 `hover-class="tap-hover"`（与全站行反馈口径一致）。顶栏「添加 / 导入名单」、详情内「调组 / 解绑」等按钮此前已有 `:active` 反馈，本版确认保留。

### ③ 名单筛选列表淡入（roster · 复用 fade-item）
- **Frequency** 中：切「全班 / 仅班委」、搜索时列表刷新。
- **Purpose** 必要：新列表「啪」地出现略生硬，淡入更顺。
- **Speed** 与全站列表同档（.28s，封顶 8 项错峰）。
- **Function** 复用既有 `.fade-item` 原语，零新增代码、零新门禁。
- **落地**：`.mb-row` 加 `fade-item` 类（wx:key 稳定 → 仅首屏/新插入行淡入，搜索复用不重播）。

### ④ 我的页 申请按钮 / 关于行反馈（mine）
- **Frequency** 中：处理换班申请、看关于时触发。
- **Purpose** 必要：`.ap-btn`（同意 / 拒绝）此前仅有 `:active` 淡入，缺少「实」的触感；`.ab-row`（关于内行）此前完全无反馈。
- **Speed** 即时。
- **Function** 补齐最后两块无反馈的交互。
- **落地**：`.ap-btn:active` 加 `scale(.95)` + `transition`；`.ab-row` 加 `hover-class="tap-hover"`。

---

## 被四闸否掉的候选（不实施）

| 候选 | 被否闸 | 理由 |
|---|---|---|
| Tab 页再加分块错峰 | Function | v0.7.12 已改为「单一整体节拍」，再加错峰会复活「整页重来」闪烁回归，与 #1 方向冲突 |
| 课表单元格逐个淡入 | Speed + Function | 课表 30+ 格，逐个淡入既慢又乱；已有切周方向动画，无需叠加 |
| 值日卡片长按缩放 | Frequency | 长按是「换人」入口，加缩放手势会与长按判定打架 |
| 全局页面切换阴影 | Function | 系统 navigateTo 已带右滑切入，再加重阴影显脏 |

---

## 配套原则（本版动效统一口径）
- **单一整体节拍（Apple 式）**：整块一次 opacity + 轻微位移，不写分块错峰。
- **按下反馈靠 `hover-class`**（不是 `:active` 兜底）：`tap-hover`（底色调）/ `press-dim`（变淡）/ `scale`（缩放）三选一，按元素底色选。
- **二级页进场只用 opacity 淡入**（`page-fade`）：opacity 不给 `fixed` 后代建包含块，nav-bar / 回收站 / 查看器 / bottom-sheet 全部安全，零回归。
- **`prefers-reduced-motion` 一律降级为纯 cross-fade 或不动**，不关掉功能。
