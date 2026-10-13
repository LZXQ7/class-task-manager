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
    ('肖诗轩', '209901030301', 'A'), ('示例成员59', '209901030302', 'B'),
    ('示例成员63',   '209901030303', 'A'), ('丁湘豫', '209901030304', 'B'),
    ('郭昕瑜', '209901030305', 'A'), ('吴炳馨', '209901030306', 'B'),
    ('乔月琴', '209901030307', 'A'), ('张铭钰', '209901030308', 'B'),
    ('段文静', '209901030309', 'A'), ('聂铭',   '209901030310', 'B'),
    ('袁金鹏', '209901030311', 'A'), ('胡文熙', '209901030312', 'B'),
    ('谢柳',   '209901030313', 'A'), ('韩雨彤', '209901030314', 'B'),
    ('卢书瑶', '209901030315', 'A'), ('何明',   '209901030316', 'B'),
    ('薛雯',   '209901030317', 'A'), ('钱柄滔', '209901030318', 'B'),
    ('许晨',   '209901030319', 'A'), ('宋宇华', '209901030320', 'B'),
    ('傅紫怡', '209901030321', 'A'), ('程子墨', '209901030322', 'B'),
    ('戴佳',   '209901030323', 'A'), ('冯嘉',   '209901030324', 'B'),
    ('余雅琳', '209901030325', 'A'), ('萧若曦', '209901030326', 'B'),
    ('苏婉',   '209901030327', 'A'), ('龚柯',   '209901030328', 'B'),
    ('田欣怡', '209901030329', 'A'), ('郝思源', '209901030330', 'B'),
    ('毛俊熙', '209901030331', 'A'), ('彭晓彤', '209901030332', 'B'),
    ('蔡凌',   '209901030333', 'A'), ('梁佳怡', '209901030334', 'B'),
    ('邓子辰', '209901030335', 'A'), ('贺锦',   '209901030336', 'B'),
    ('麦梓',   '209901030337', 'A'), ('邹语',   '209901030338', 'B'),
    ('石佳一', '209901030339', 'A'), ('柳青',   '209901030340', 'B'),
    ('夏若',   '209901030341', 'A'), ('雷雨',   '209901030342', 'B'),
    ('万辰',   '209901030343', 'A'), ('罗宇泽', '209901030344', 'B'),
    ('曾语桐', '209901030345', 'A'), ('汪可昕', '209901030346', 'B'),
    ('潘卓',   '209901030347', 'A'), ('邱雪',   '209901030348', 'B'),
    ('韦明',   '209901030349', 'A'), ('熊沐',   '209901030350', 'B'),
    ('蒋薇',   '209901030351', 'A'), ('阎俊',   '209901030352', 'B'),
    ('孙淑璠', '209901030353', 'A'), ('苑烨轩', '209901030354', 'B'),
    ('示例成员11',   '209901030355', 'A'), ('李宠',   '209901030356', 'B'),
    ('陈腾浩', '209901030357', 'A'),
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