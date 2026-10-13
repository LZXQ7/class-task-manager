-- ============================================================
-- 值日轮转游标（2026-10-07，v0.7.31）
-- ============================================================
-- 背景：轮转位置原先寄存在 `member.duty_count`（「本轮已排次数」靠相对大小间接
-- 表达位置）。该列后来又被「累计值日次数」的统计口径占用，两种语义挤在一列，
-- 一旦被压平（全员同值）相对大小就丢失 ⇒ 退化成「序号最小优先」⇒ 从 1 号重排。
-- 用户 2026-10-07 第五次反馈「按序号轮转还是不对」即由此而来。
--
-- 修法：轮转位置改成**显式的数字游标**，与 duty_count 彻底解耦。
--   · class.round_cursor_a / round_cursor_b = 当前游标（下一批从哪开始）
--   · duty_week_cursor = 每一周「生成前 / 生成后」的游标快照
--
-- ────────────────────────────────────────────────────────────
-- 为什么还需要按周的快照（duty_week_cursor）
-- ────────────────────────────────────────────────────────────
-- 只有一个全局游标是不够的。真实时序：
--   周日 20:00 cron 自动生成「下周」→ 游标前进；
--   之后超管对「本周」再点一次一键生成 → 全局游标已经走过了，本周会被排成
--   完全不同的一批人（旧版靠 duty_count 回扣本周 AUTO 行来规避，v2 没有这个
--   回扣的余地）。
-- 记录每W「生成前的游标」后，重复生成同一周永远从同一个起点开始 ⇒ 幂等；
-- 全局游标则恒等于「已生成的最大周次的结束游标」，保证周与周之间严格接续。
--
-- ⚠️ TDSQL 不支持 `ADD COLUMN IF NOT EXISTS`，加列前先查 information_schema。
-- ============================================================

-- 1. 班级表加游标列（两条独立执行，TDSQL 一次只允许一条 DDL）
ALTER TABLE `class` ADD COLUMN round_cursor_a INT NOT NULL DEFAULT 0 COMMENT 'A 组值日轮转游标（本轮已排到的序号）';
ALTER TABLE `class` ADD COLUMN round_cursor_b INT NOT NULL DEFAULT 0 COMMENT 'B 组值日轮转游标（本轮已排到的序号）';

-- 2. 按周的游标快照（重复生成同一周要幂等，见文件头说明）
CREATE TABLE IF NOT EXISTS duty_week_cursor (
  class_id INT NOT NULL DEFAULT 1,
  week     INT NOT NULL,
  start_a  INT NOT NULL DEFAULT 0 COMMENT '生成该周之前的 A 组游标',
  start_b  INT NOT NULL DEFAULT 0 COMMENT '生成该周之前的 B 组游标',
  end_a    INT NOT NULL DEFAULT 0 COMMENT '生成该周之后的 A 组游标',
  end_b    INT NOT NULL DEFAULT 0 COMMENT '生成该周之后的 B 组游标',
  PRIMARY KEY (class_id, week)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='值日轮转游标按周快照';

-- 3. 示例班级A初值（用户 2026-10-07 明确口径：「目前轮到 a组47，b组48」；
--    与库里第 3 周的落库一致 —— A 组最大序号 47、B 组最大序号 48）
UPDATE `class` SET round_cursor_a = 47, round_cursor_b = 48 WHERE id = 3;

-- 4. 第 5 周（10-12~10-18）已由 cron 生成过 46 行，但那批是「从 2 号重排」的
--    坏数据，随后会用「一键生成第 5 周」重排；这里先不建快照，让它接着 47/48 走。
--    （如需保留，不要插 duty_week_cursor。）

-- 5. 校验
-- SELECT id, name, round_cursor_a, round_cursor_b FROM `class` ORDER BY id;
-- SELECT * FROM duty_week_cursor ORDER BY class_id, week;
