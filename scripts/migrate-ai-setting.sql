-- ============================================================
-- 需求 D（下半）：AI 排班「自带密钥」
-- ------------------------------------------------------------
-- 背景：AI 生成值日表原先只能用平台统一配置的密钥（存在 ai-proxy 的
--   DEEPSEEK_API_KEY 环境变量里），大家共用一份额度。本批允许每个人
--   **自带**自己的接口地址与密钥，谁用谁付。
--
-- ⚠️ 口径：按**成员**（member_id），不是按班
--   定案原话是「模拟态下会消耗**被模拟者本人**的 key 额度（操作还记在他名下）」，
--   且生命周期规则是「**撤销职位保留**、仅**删除成员**时清行」——
--   这两条只有「配置跟着人」才说得通（跟班的话，撤职与删人都与它无关）。
--   排班仍按班进行，只是**用谁的钥匙**按生效身份取。
--
-- 字段设计要点：
--   · member_id UNIQUE —— 一人一条。
--   · api_key 明文只存一次 —— 没有可用的可逆加密托管，接口**只回掩码**；
--     这意味着清掉就不可逆，故生命周期必须保守（见下）。
--   · base_url 留空 = 用官方默认地址；填了必须过 ai-proxy 的三道公网闸。
--   · enabled=0 表示「本人没有自带配置」—— 此时超管可回落到平台密钥，
--     生活委员不可（否则平台额度被无限外借，且无法归因到人）。
--
-- 生命周期（与职位解耦，重要）：
--   **撤销「生活委员」职位不得清除本行** —— 明文只存一次、接口只回掩码，
--   清掉即不可逆；而该职位会被频繁调整，手滑一次就要人家重新申请密钥。
--   能否使用完全由当前身份判定（撤职立即用不了 AI 排班，但钥匙还在；
--   重新任命立刻恢复）。仅当**成员被删除（移出班级）**时才清除本行。
--
-- TDSQL 注意：一次只执行一条 DDL。
--   CREATE TABLE IF NOT EXISTS 幂等；改口径时先 DROP（本表无历史数据）再建。
-- ============================================================

CREATE TABLE IF NOT EXISTS ai_setting (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT COMMENT '自增主键',
  member_id   INT          NOT NULL                COMMENT '成员 id（member.id），一人一条；跟随本人而非班级',
  provider    VARCHAR(32)  NOT NULL DEFAULT 'deepseek'
                                                   COMMENT '服务商标识（当前 deepseek / 其它 OpenAI 兼容端）',
  base_url    VARCHAR(255) NOT NULL DEFAULT ''     COMMENT '自定义接口地址；须经 ai-proxy 公网校验（禁内网 / 禁带 query 与 hash）；留空=官方默认',
  api_key     VARCHAR(255) NOT NULL DEFAULT ''     COMMENT '自带密钥；明文只存一次、接口只回掩码；**撤销职位不清，仅删除成员时清**',
  model       VARCHAR(64)  NOT NULL DEFAULT ''     COMMENT '模型名；留空=用 ai-proxy 的 DEEPSEEK_MODEL',
  enabled     TINYINT      NOT NULL DEFAULT 0      COMMENT '1=本人已启用自带配置；0=未配置（超管可回落平台密钥）',
  created_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP COMMENT '创建时间',
  updated_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP COMMENT '更新时间',
  PRIMARY KEY (id),
  UNIQUE KEY uk_member (member_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  COMMENT='AI 排班自带密钥配置（需求 D，按成员）；撤职不清、仅删成员时清';
