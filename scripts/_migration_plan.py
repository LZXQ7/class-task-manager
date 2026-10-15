#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
§43 多班级迁移执行器（兼容 MySQL 8 / CloudBase）
- 跳过已存在的列/索引（避免 Duplicate column / Duplicate key）
- 通过 manageMysqlDatabase MCP 调用 runStatement / runQuery
"""
import subprocess, json, os, sys

# 准备执行的 SQL 列表（按依赖顺序）
STMTS = []

# 1. 迁移 示例班级A → class 表 id=1（幂等）
STMTS.append(("迁移 示例班级A → class.id=1",
"INSERT INTO `class` (id, name, join_token, invite_code, term_start, total_weeks, bind_open, period_time) "
"SELECT 1, name, join_token, invite_code, term_start, total_weeks, bind_open, period_time "
"FROM class_config WHERE id = 1 "
"ON DUPLICATE KEY UPDATE name=VALUES(name)"))

# 2. 业务表加 class_id 列（默认 1）—— 12 张表
TABLES_WITH_CLASS_ID = [
    'member', 'course', 'session', 'duty', 'duty_log',
    'swap_request', 'leave_request', 'notice',
    'notice_msg', 'notice_msg_target', 'notice_msg_read', 'notice_msg_delete',
]
for t in TABLES_WITH_CLASS_ID:
    STMTS.append((f"ALTER {t} ADD class_id",
        f"ALTER TABLE {t} ADD COLUMN class_id INT NOT NULL DEFAULT 1 AFTER id"))

# 3. 加索引
INDEXES = [
    ('member',           'idx_class_status', '(class_id, status)'),
    ('member',           'idx_class_role',   '(class_id, role)'),
    ('course',           'idx_class',        '(class_id)'),
    ('session',          'idx_class',        '(class_id)'),
    ('duty',             'idx_class_date',   '(class_id, class_date)'),
    ('notice_msg',       'idx_class_created','(class_id, created_at)'),
]
for tbl, idx, cols in INDEXES:
    STMTS.append((f"ALTER {tbl} ADD INDEX {idx}",
        f"ALTER TABLE {tbl} ADD INDEX {idx} {cols}"))

# 4. 插入 示例班级C
STMTS.append(("INSERT 示例班级C",
"INSERT IGNORE INTO `class` (id, name, join_token, invite_code, term_start, total_weeks, bind_open, period_time) "
"VALUES (2, '示例班级C', '202601', '<INVITE_CODE>', '2026-09-14', 16, 1, "
"'[{\"period\":1,\"start\":\"08:00\",\"end\":\"09:40\"},{\"period\":2,\"start\":\"10:05\",\"end\":\"11:45\"},{\"period\":3,\"start\":\"14:00\",\"end\":\"15:40\"},{\"period\":4,\"start\":\"16:00\",\"end\":\"17:40\"},{\"period\":5,\"start\":\"19:00\",\"end\":\"20:40\"}]')"))

# 5. 插入 示例班级B（空班级，用户手动导入名单）
STMTS.append(("INSERT 示例班级B",
"INSERT IGNORE INTO `class` (id, name, join_token, invite_code, term_start, total_weeks, bind_open, period_time) "
"VALUES (3, '示例班级B', '<JOIN_TOKEN>', '<INVITE_CODE>', '2026-09-14', 16, 1, "
"'[{\"period\":1,\"start\":\"08:00\",\"end\":\"09:40\"},{\"period\":2,\"start\":\"10:05\",\"end\":\"11:45\"},{\"period\":3,\"start\":\"14:00\",\"end\":\"15:40\"},{\"period\":4,\"start\":\"16:00\",\"end\":\"17:40\"},{\"period\":5,\"start\":\"19:00\",\"end\":\"20:40\"}]')"))

# 6. 导入 示例班级C 57 人（class_id=2，奇=A / 偶=B）
_2601 = [
    ('肖诗轩', '000000000101', 'A'), ('示例成员59', '000000000102', 'B'),
    ('示例成员63',   '000000000103', 'A'), ('丁湘豫', '000000000104', 'B'),
    ('郭昕瑜', '000000000105', 'A'), ('吴炳馨', '000000000106', 'B'),
    ('乔月琴', '000000000107', 'A'), ('张铭钰', '000000000108', 'B'),
    ('段文静', '000000000109', 'A'), ('聂铭',   '000000000110', 'B'),
    ('袁金鹏', '000000000111', 'A'), ('胡文熙', '000000000112', 'B'),
    ('谢柳',   '000000000113', 'A'), ('韩雨彤', '000000000114', 'B'),
    ('卢书瑶', '000000000115', 'A'), ('何明',   '000000000116', 'B'),
    ('薛雯',   '000000000117', 'A'), ('钱柄滔', '000000000118', 'B'),
    ('许晨',   '000000000119', 'A'), ('宋宇华', '000000000120', 'B'),
    ('傅紫怡', '000000000121', 'A'), ('程子墨', '000000000122', 'B'),
    ('戴佳',   '000000000123', 'A'), ('冯嘉',   '000000000124', 'B'),
    ('余雅琳', '000000000125', 'A'), ('萧若曦', '000000000126', 'B'),
    ('苏婉',   '000000000127', 'A'), ('龚柯',   '000000000128', 'B'),
    ('田欣怡', '000000000129', 'A'), ('郝思源', '000000000130', 'B'),
    ('毛俊熙', '000000000131', 'A'), ('彭晓彤', '000000000132', 'B'),
    ('蔡凌',   '000000000133', 'A'), ('梁佳怡', '000000000134', 'B'),
    ('邓子辰', '000000000135', 'A'), ('贺锦',   '000000000136', 'B'),
    ('麦梓',   '000000000137', 'A'), ('邹语',   '000000000138', 'B'),
    ('石佳一', '000000000139', 'A'), ('柳青',   '000000000140', 'B'),
    ('夏若',   '000000000141', 'A'), ('雷雨',   '000000000142', 'B'),
    ('万辰',   '000000000143', 'A'), ('罗宇泽', '000000000144', 'B'),
    ('曾语桐', '000000000145', 'A'), ('汪可昕', '000000000146', 'B'),
    ('潘卓',   '000000000147', 'A'), ('邱雪',   '000000000148', 'B'),
    ('韦明',   '000000000149', 'A'), ('熊沐',   '000000000150', 'B'),
    ('蒋薇',   '000000000151', 'A'), ('阎俊',   '000000000152', 'B'),
    ('孙淑璠', '000000000153', 'A'), ('苑烨轩', '000000000154', 'B'),
    ('示例成员11',   '000000000155', 'A'), ('李宠',   '000000000156', 'B'),
    ('陈腾浩', '000000000157', 'A'),
]
vals = ','.join(f"('{n}','{sno}','{g}','MEMBER',2)" for n, sno, g in _2601)
STMTS.append(("INSERT 示例班级C 57 名成员",
    f"INSERT IGNORE INTO member (name, student_no, group_tag, role, class_id) VALUES {vals}"))

# === 检查列是否已存在 ===
def has_column(tbl, col):
    sql = f"SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{tbl}' AND COLUMN_NAME = '{col}'"
    return sql

def has_index(tbl, idx):
    sql = f"SELECT COUNT(*) AS c FROM INFORMATION_SCHEMA.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = '{tbl}' AND INDEX_NAME = '{idx}'"
    return sql

print(f"共 {len(STMTS)} 条语句待执行")
print("---")
for i, (label, sql) in enumerate(STMTS, 1):
    short = sql[:80].replace('\n', ' ')
    print(f"{i:2d}. [{label}] {short}...")

print("---")
print(f"=== 通过 MCP 执行 ===")
print(f"总语句: {len(STMTS)}")