# DevTools 渲染层报错诊断与修复（wx:key 表达式）

> 日期：2026-10-16 · 对应版本：1.0.6.9（内部 v0.7.42，**尚未上传**）
> 触发：用户发来开发者工具控制台截图

---

## 一、报错原文（截图内容）

```
[渲染层错误] Uncaught SyntaxError: Failed to execute 'appendChild' on 'Node': missing ) after argument list
              (env: Windows,mp,2.02.2610142; lib: 3.17.4)
[渲染层错误] SyntaxError: SystemError (webviewScriptError)
              Failed to execute 'appendChild' on 'Node': missing ) after argument list
[Perf] App.onLaunch took 106ms
[基础库] 正在使用灰度中的基础库 3.17.4 进行调试。如有问题，请前往工具栏-详情-本地设置更改基础库版本。
[渲染层错误] Framework inner error (expect FLOW_INITIAL_CREATION end but got FLOW_CREATE_NODE)
[渲染层错误] Error: SystemError (webviewScriptError)
              Framework inner error (expect FLOW_INITIAL_CREATION end but got FLOW_CREATE_NODE)
```

**这是两组不同性质的报错**，下面分开讲。

---

## 二、属于我们代码的问题：`wx:key` 写了表达式（已修）

### 定位过程

上一笔提交（`6c75f5a` 首页并入选修课）为区分「选修课」与「全班课次」，把列表 key 写成：

```xml
wx:key="{{item.isPersonal ? 'pid' : 'sessionId'}}"
```

用一条命令把全仓 `wx:key` 写法摊开统计：

```bash
grep -rho 'wx:key="[^"]*"' --include=*.wxml . | sort | uniq -c | sort -rn
```

结果：**33 种写法全是裸属性名**（`id` / `*this` / `key` / `leaveId` / `dow` …），
只有这 3 处带 `{{ }}` —— 全项目唯一例外。课表页本身就一直写 `wx:key="key"`（第 167/329/424 行）。

### 根因

**`wx:key` 的值是「属性名」，不是表达式**：框架内部做的是 `item[key]` 取值，
所以只能给裸属性名（`id`、`key`、`dow` …）或保留字（`*this`、`index`）。
写成 `{{ }}` 表达式后，渲染层在创建节点时解析失败 ⇒ 抛 `missing ) after argument list`
（同时把框架的节点创建流程搞乱 ⇒ 连带 `FLOW_CREATE_NODE` 那条内部错误）。

### 两个走过/差点走偏的弯路（记录下来）

1. **误以为「括号不配平」**。写了 `_dbg_room/wxml-expr-balance.js` 扫全仓所有 `{{ }}` 里的
   `()`/`[]`/`{}`/引号/mustache 配对 —— **全部配平**。
   这条否证很有价值：说明问题**不在表达式的内容**，而在「表达式出现在了一个不该出现的位置」。
2. **`FLOW_INITIAL_CREATION` 有很强的环境嫌疑**。社区多帖（uni-app / 独立分包 / 分包异步化）都指
   它由**基础库或开发工具版本**引起，标准解法是「详情 → 本地设置 → 调试基础库」换一个稳定版本；
   还有帖子记录基础库 3.15.0 存在该缺陷。
   而本次环境恰好是 **灰度基础库 3.17.4** + **开发工具 2.02.2610142**（2026-10-14 的构建，极新）。
   ⇒ 结论：**这一类报错必须同时怀疑「环境」，不能只往自己代码上归因**。

### 修法（按项目铁律：WXML 不做逻辑，派生值一律 JS 预计算）

`miniprogram/pages/home/index.js` 新增 `_withRowKey(arr)`：

```js
_withRowKey(arr) {
  return (arr || []).map((s, i) => {
    const cur = s || {};
    if (cur.key) return cur;
    const k = cur.isPersonal
      ? 'p' + (Number(cur.pid) || 0)          // 个人选修课
      : 's' + (Number(cur.sessionId) || Number(cur.id) || i);   // 全班课次
    return Object.assign({}, cur, { key: k });
  });
}
```

- 在 `_mergePersonalCourses` 的**两条 return**（含 `!dow` 早退分支）上统一补齐；
  今日 / 明日两条链路都经过这里 ⇒ 单一汇合点。
- 前缀 `s…` / `p…` 区分两个 id 空间：**选修课的 `sessionId` 恒为 0**，
  直接用 `sessionId` 会与其它选修课撞 key，列表增删时 diff 错位。
- `home/index.wxml` 三处改为裸 `wx:key="key"`。

### 门禁（防回归）

| 门禁 | 改动 |
|---|---|
| `scripts/check-wxml.js` | **新增通用铁律**「`wx:key` 不得写表达式」+ 4 项变异自证（坏样本 `{{item.a?'x':'y'}}` 与 `{{item.id}}` 必抓；裸属性名、注释里的写法不得误报） |
| `scripts/check-home-personal-course.js` | ⑥ 改钉「JS 预计算 key + wxml 裸属性名」，并校验两条 return 都补了 key |
| `scripts/check-today-course.js` | 明日课次的字面判据同步更新（**意图不变**） |

---

## 三、仍需你在本机确认的一件事（环境嫌疑）

上面修完后，**请按下面步骤复验**（`FLOW_CREATE_NODE` 那条若仍在，基本可判定是环境）：

1. 开发者工具右上角 **详情 → 本地设置 → 调试基础库**，把 `3.17.4`（灰度版）
   换成列表里的**稳定版本**（官方推荐 / 用户占比高的版本）。
2. **清缓存 → 全部清除**，然后重新编译。
3. 看控制台这两条是否消失：
   - `Failed to execute 'appendChild' on 'Node': missing ) after argument list`
   - `Framework inner error (expect FLOW_INITIAL_CREATION end but got FLOW_CREATE_NODE)`

- **两条都消失** ⇒ 我们的 `wx:key` 就是唯一原因，可以放心上传。
- **`missing )` 消失、`FLOW_CREATE_NODE` 仍在** ⇒ 后者是灰度基础库/工具的自身问题，
  真机（正式基础库）不受影响，上传不受阻。
- **两条都还在** ⇒ 请把新的控制台截图发我，我继续深挖。

---

## 四、发版状态

| 项 | 状态 |
|---|---|
| `APP_VERSION` | `1.0.6.9`（内部 v0.7.42） |
| 全量门禁 | **86/86 全绿** |
| 发版收尾体检 `check_closeout.sh` | **16/16 全绿** |
| 工作区 | 干净（全部已提交） |
| 本次新增提交 | `ca8e5ac`（wx:key 修复）、`c26aa4b`（CHANGELOG）、`4487b47`（HANDOFF） |
| 剩余用户侧动作 | **小程序前端上传 + 送审** |
