# class_id 重排迁移 · 执行记录

**环境**：CloudBase `<YOUR_ENV_ID>`（TDSQL）
**日期**：2026-10-06
**目标**：把小教三个班的 `class_id` 与学号班号段对齐（用户确认「学号段为准→改 class_id」，专升本 9/10 保持不动）

## 映射规则（3-循环置换）
| 原 class_id | 班号段 | 班级名 | → 新 class_id |
|---|---|---|---|
| 1 | 03 | 示例班级A | **3** |
| 2 | 01 | 示例班级C | **1** |
| 3 | 02 | 示例班级B | **2** |

专升本 `9`（商务示例专业B2班）、`10`（示例专业B2班）**保持不变**。

## 执行方式
- 脚本 `scripts/rearrange-classid.js`：幂等护栏（哨兵表 `bak_class_rearrange_pre_class`，已存在则中止）+ 全量备份 + 两段临时偏移（1→101,2→102,3→103 再 101→3,102→1,103→2，避免 3-循环碰撞）+ 行数校验。
- 备份表前缀 `bak_class_rearrange_pre_*`（20 张表全量快照，用于回滚）。
- 无外键约束，纯数值置换。

## 受影响表（20 张）
`class`（主键 id）+ 19 张 `class_id` 子表：
course, duty, duty_log, import_batch, leave_request, member, notice, notice_msg,
notice_msg_class, notice_msg_delete, notice_msg_read, notice_msg_target,
schedule_publish, schedule_rules, session, session_shift, staff_class,
swap_request, timetable_apply。

## 迁移影响行数（affected，phase1=phase2 应相等）
- member 173、duty 144、course 13、session 30、leave_request 9、notice_msg_class 22、schedule_publish 7、schedule_rules 1、staff_class 3、class 3
- duty_log / import_batch / notice / notice_msg / notice_msg_delete / notice_msg_read / notice_msg_target / session_shift / swap_request / timetable_apply：**0 行**（这些表在 {1,2,3} 内无数据，正确不动）

## 校验结果
- **行数校验**：20 张表迁移前后行数全部一致 ✅
- **member 按 class_id 计数（迁移后）**：1=57、2=56、3=60、9=10、10=20 —— 与 3-循环预期完全吻合（新1=原2的57，新2=原3的56，新3=原1的60）✅
- **class 主表（迁移后）**：id1=示例班级C(202601)、id2=示例班级B(<JOIN_TOKEN>)、id3=示例班级A(<JOIN_TOKEN>)、9/10 不变 ✅
- **示例成员01(id=13)**：`class_id=3, duty_off=1` —— 本人班（示例班级A）且仍排除值日 ✅
- **用户班级配置保留**：class id=3 行含 term_start=2026-09-14、total_weeks=16、bind_open=1、is_active=1、invite_code=<INVITE_CODE>（随原 id=1 行整体迁移，配置未丢）✅

## 明确未改动
- **`class_config`**：代码确认它是固定 `WHERE id=1` 的兜底表（`getConfig` 优先读 `class` 表，仅 class 缺行且 cid=1 才回退；`auth/index.js:432` 切换 `bind_open` 也写 `class_config WHERE id=1`）。`class` 表已覆盖全部 5 班 ⇒ 它休眠；改动其 id 反而破坏兜底/开关。故保留 `id=1` 原样。
- 专升本 9/10 全部引用不动。

## 代码侧
- 无需重部署：所有云函数按 `class_id` 参数查询，本次只改数据值，未改代码逻辑（`seqOf` 取学号末两位=班内序号，不受影响）。

## 回滚
确认无误后，可删除 `bak_class_rearrange_pre_*` 备份表；如需回滚，对每张表 `DELETE FROM <t>; INSERT INTO <t> SELECT * FROM bak_class_rearrange_pre_<t>;`（备份为全量快照）。

## 已知坑（供复现参考）
- 本沙箱中 `spawnSync(绝对 managed-node 路径, [tcb...])` 返回 `status=null`（子进程起不来）；改用 `execSync('node "<tcb>" ...')` 走 shell/PATH 才正常。
- 首个 tcb 调用偶发冷启动失败 → 脚本内已加 3 次重试 + 预热 `SELECT 1`。
