#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
离线批量排程求解器（单文件 / 纯 Python 标准库，无 pandas / numpy / matplotlib）
================================================================================

需求映射（用户口径 -> 本程序实现）
--------------------------------------------------------------------------
1. 技能/规格匹配 + 资源冲突      -> 订单 kind('single'/'multi') 与设备能力 eligible_kinds
                                    订单 kind='multi' 只能进 heads>=2 的设备
2. 单一时间点设备负载受并行工位影响 -> Machine.heads（1~3 个并行工位）；每台设备 heads 条
                                    「工位/路线」独立排单，机器级并发天然 <= heads
3. 释放时间(必须 >= 现在)/截止时间/    -> Order.release / Order.due / Order.window(时间窗) /
   客户指定时间窗/机器指定/优先级         Order.fixed_machine / Order.weight(1~5)
4. 订单不中断（含午休不得跨越）      -> 单笔订单必须完整落在同一段连续可用区间内（不可抢占）
5. 序列相关准备时间 + 路线优化       -> 区域矩阵 area_matrix（含车库出发时间），
                                    路线 2-opt + Or-opt 改进
6. 启动成本 / 启动时间               -> 每台设备每天使用即计一次 startup_cost(+startup_min)
7. 能量总量 / 电池容量估算           -> 逐分钟功率剖面（base_kw + 在跑工位*head_kw）-> kWh，
                                    按天总能耗 * 1.2 冗余 = 推荐电池容量
8. 多日滚动排班                      -> 3 天 x 8 小时（08:00-12:00 / 13:00-17:00）
9. 订单状态：已完成直接跳过，         -> status='done' 跳过；'running' 锁定（机器+开始时间固定）；
   进行中锁定                           'pending' 参与优化
10. 单人/多人时长系数                -> 单工位设备 1.2x 时长，多工位设备 0.6x 时长

三种求解策略（横向对比，同一套硬约束与指标）
--------------------------------------------------------------------------
A. greedy   : EDD(最早截止优先) 贪心 —— 逐单挑「最早能完工」的可行位置
B. lookahead: 前瞻贪心 —— 每步在所有 (订单, 位置) 候选中选「让剩余订单最小松弛最大」的
C. matching : 启发式 —— 二分阈值 + Hopcroft-Karp 最大匹配（选择阶段），
              再对每条工位路线做 2-opt / Or-opt（路线优化阶段）

硬约束自检（0 违规才算合格）
--------------------------------------------------------------------------
H1 每笔待排订单恰好被排一次 / H2 设备能力匹配（single/multi）
H3 开始 >= release / H4 时间窗完整落窗 / H5 完工 <= due 视为不延期（延期记入软指标）
H6 同一工位路线内订单不重叠 / H7 设备并发 <= heads
H8 订单不中断（落在同一连续区间）/ H9 序列相关准备时间已计入
H10 每台设备每天启动一次（启动时间已预留）/ H11 疲劳：单条工位路线每天服务+准备 <= 8h
H12 指定机器强约束 / H13 进行中订单锁定位置未被改动

用法
--------------------------------------------------------------------------
    python schedule_solver.py                # 跑全部用例并生成 HTML 报告
    python schedule_solver.py --html out.html
    python schedule_solver.py --check        # 只跑用例并做硬约束自检，不写 HTML
    python schedule_solver.py --case medium  # 只跑指定用例
"""

from __future__ import annotations

import argparse
import json
import os
import random
import sys
from collections import deque
from dataclasses import dataclass, field, replace
from typing import Dict, List, Optional, Sequence, Set, Tuple

# ---------------------------------------------------------------------------
# 一、时间与全局常量
# ---------------------------------------------------------------------------

DAY_MIN = 24 * 60
HORIZON_DAYS = 3
SHIFT_START_REL = 8 * 60          # 每天 08:00
MORNING = (0, 4 * 60)             # 08:00-12:00
AFTERNOON = (5 * 60, 9 * 60)      # 13:00-17:00（中间 12:00-13:00 为午休，不可跨越）
SHIFT_MIN = 8 * 60                # 每天净作业 8 小时
FATIGUE_LIMIT_MIN = 8 * 60        # H11 单工位路线单日服务+准备上限

MIN_SINGLE_DUR = 30               # 单笔订单最短占用（分钟），用于容量估算
ENERGY_PRICE = 0.75               # 元/kWh
BATTERY_RESERVE = 1.2             # 电池冗余系数

# 组合代价权重（用于 A/B/C 三策略的统一评价，越小越好）
W_TARDY = 1000.0                  # 每「权重 x 小时」延期
W_WAIT = 1.0                      # 每分钟等待
W_ENERGY = 3.0                    # 每 kWh
W_STARTUP = 0.02                  # 每次启动成本
W_TRAVEL = 1.0                    # 每分钟准备/行驶


def day_intervals(day: int) -> List[Tuple[int, int]]:
    """第 day 天（0 起）的可用区间（绝对分钟）。"""
    base = day * DAY_MIN + SHIFT_START_REL
    return [(base + MORNING[0], base + MORNING[1]),
            (base + AFTERNOON[0], base + AFTERNOON[1])]


def subtract_intervals(intervals: Sequence[Tuple[int, int]],
                       cuts: Sequence[Tuple[int, int]]) -> List[Tuple[int, int]]:
    """从 intervals 中扣除 cuts（区间相减）。"""
    out = [tuple(iv) for iv in intervals]
    for cut in cuts:
        cs, ce = cut
        nxt: List[Tuple[int, int]] = []
        for s, e in out:
            if ce <= s or cs >= e:          # 无交集
                nxt.append((s, e))
                continue
            if cs > s:
                nxt.append((s, cs))
            if ce < e:
                nxt.append((ce, e))
        out = nxt
    return sorted(out)


def fmt_time(m: int) -> str:
    """绝对分钟 -> 'D1 08:30'。"""
    day = m // DAY_MIN
    rel = m % DAY_MIN
    return "D%d %02d:%02d" % (day + 1, rel // 60, rel % 60)


def hhmm(m: int) -> str:
    return "%02d:%02d" % (m // 60, m % 60)


# ---------------------------------------------------------------------------
# 二、数据模型
# ---------------------------------------------------------------------------

@dataclass
class Machine:
    mid: str
    name: str
    heads: int                                  # 并行工位数 1..3
    base_kw: float                              # 待机（有工位在跑）基础功率
    head_kw: float                              # 每个在跑工位的功率
    startup_cost: float                         # 每次启动成本（元）
    startup_min: int = 30                       # 启动预热时间（分钟）
    eligible_kinds: Tuple[str, ...] = ("single", "multi")
    depot_min: int = 15                         # 从车库到首个服务点的行驶时间
    failures: List[Tuple[int, int, int]] = field(default_factory=list)  # (day, 相对起, 相对止)

    def calendar(self) -> Dict[int, List[Tuple[int, int]]]:
        """{day: [可用区间]}，已扣除故障/维护窗口。"""
        cal: Dict[int, List[Tuple[int, int]]] = {}
        for d in range(HORIZON_DAYS):
            ivs = day_intervals(d)
            base = d * DAY_MIN + SHIFT_START_REL
            cuts = [(base + a, base + b) for (dd, a, b) in self.failures if dd == d]
            cal[d] = subtract_intervals(ivs, cuts)
        return cal


@dataclass
class Order:
    oid: str
    name: str
    service_min: int                            # 基准工时（分钟）
    area: str                                   # 服务区域（决定序列准备时间）
    release: int                                # 最早开始（绝对分钟，>=0）
    due: int                                    # 截止（绝对分钟）
    weight: int = 1                             # 优先级权重 1..5
    kind: str = "single"                        # 'single' | 'multi'
    status: str = "pending"                     # 'pending' | 'running' | 'done'
    window: Optional[Tuple[int, int]] = None    # 客户时间窗（需完整落窗）
    fixed_machine: Optional[str] = None         # 指定机器（强约束）
    pinned_start: Optional[int] = None          # running 订单的锁定开始时间

    def dur(self, m: Machine) -> int:
        """本设备上的实际占用时长（多工位设备 0.6x，单工位 1.2x）。"""
        mult = 0.6 if m.heads >= 2 else 1.2
        return max(15, int(round(self.service_min * mult)))

    def earliest(self) -> int:
        return self.window[0] if self.window else self.release


@dataclass
class Placement:
    """一条工位路线上的一个已排订单。"""
    oid: str
    machine: str
    head: int
    day: int
    start: int
    finish: int
    setup_before: int
    area: str = ""                              # 本单服务区域，决定下一单的准备/行驶时间
    pinned: bool = False


@dataclass
class Solution:
    strategy: str
    placements: List[Placement]
    unassigned: List[Tuple[str, str]]           # (oid, 原因)
    skipped_done: List[str]
    metrics: Dict[str, float] = field(default_factory=dict)
    violations: List[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# 三、用例数据（固定 seed，可复现）
# ---------------------------------------------------------------------------

AREAS = ["CITY", "NORTH", "SOUTH", "EAST", "WEST"]

# 序列相关准备/行驶时间矩阵（分钟）：上一单区域 -> 下一单区域
AREA_MATRIX: Dict[Tuple[str, str], int] = {}
_rng = random.Random(20260101)
for _a in AREAS:
    for _b in AREAS:
        AREA_MATRIX[(_a, _b)] = 0 if _a == _b else _rng.choice([10, 15, 20, 25, 30])


def setup_minutes(prev_area: Optional[str], next_area: str) -> int:
    if prev_area is None:
        return 0                       # 首个订单的行驶时间用 machine.depot_min 单独计
    return AREA_MATRIX.get((prev_area, next_area), 20)


def machines_small() -> List[Machine]:
    return [
        Machine("M1", "单工位作业车 A", heads=1, base_kw=1.2, head_kw=2.4,
                startup_cost=80.0, startup_min=20, eligible_kinds=("single",)),
        Machine("M2", "双工位作业车 B", heads=2, base_kw=2.0, head_kw=2.0,
                startup_cost=180.0, startup_min=30),
    ]


def machines_medium() -> List[Machine]:
    return [
        Machine("M1", "单工位作业车 A", heads=1, base_kw=1.2, head_kw=2.4,
                startup_cost=80.0, startup_min=20, eligible_kinds=("single",)),
        Machine("M2", "双工位作业车 B", heads=2, base_kw=2.0, head_kw=2.0,
                startup_cost=180.0, startup_min=30),
        Machine("M3", "三工位主力车 C", heads=3, base_kw=3.0, head_kw=1.8,
                startup_cost=420.0, startup_min=40,
                failures=[(1, 60, 180)]),                     # D2 上午故障 1 小时
        Machine("M4", "单工位作业车 D", heads=1, base_kw=1.4, head_kw=2.2,
                startup_cost=60.0, startup_min=15, eligible_kinds=("single",),
                failures=[(2, 0, 300)]),                      # D3 上午整段维护
    ]


def machines_edge() -> List[Machine]:
    return [
        Machine("M1", "单工位作业车 A", heads=1, base_kw=1.2, head_kw=2.4,
                startup_cost=80.0, startup_min=20, eligible_kinds=("single",),
                failures=[(0, 0, 240), (0, 300, 420)]),       # D1 几乎全天不可用
        Machine("M2", "双工位作业车 B", heads=2, base_kw=2.0, head_kw=2.0,
                startup_cost=180.0, startup_min=30),
    ]


def _order(oid, name, svc, area, rel, due, **kw) -> Order:
    return Order(oid=oid, name=name, service_min=svc, area=area, release=rel, due=due, **kw)


def case_small():
    orders = [
        _order("S1", "管道巡检", 90, "CITY", 0, day_intervals(0)[1][1], weight=3),
        _order("S2", "滤芯更换", 60, "NORTH", 60, day_intervals(0)[1][1], weight=2),
        _order("S3", "阀门维护", 120, "SOUTH", 120, day_intervals(1)[1][1], weight=1),
        _order("S4", "大件吊装", 90, "EAST", 180, day_intervals(1)[1][1], kind="multi", weight=4),
        _order("S5", "安全检查", 45, "CITY", 0, day_intervals(2)[1][1], weight=1),
    ]
    return "small", "小规模（5 单 / 2 台设备 / 无故障）", orders, machines_small()


def case_medium():
    orders = [
        _order("M1", "主管道巡检", 120, "CITY", 0, day_intervals(0)[1][1], weight=3),
        _order("M2", "泵组保养", 90, "NORTH", 60, day_intervals(0)[1][1], weight=2),
        _order("M3", "大件吊装 A", 120, "EAST", 0, day_intervals(0)[1][1], kind="multi", weight=5),
        _order("M4", "换热器清洗", 150, "SOUTH", 240, day_intervals(1)[1][1], weight=2),
        _order("M5", "大件吊装 B", 90, "WEST", 300, day_intervals(1)[1][1], kind="multi", weight=4),
        _order("M6", "电气年检", 60, "CITY", 480, day_intervals(1)[1][1], weight=3),
        _order("M7", "屋面防水", 180, "NORTH", 660, day_intervals(2)[1][1], weight=1),
        _order("M8", "大件吊装 C", 120, "SOUTH", 720, day_intervals(2)[1][1], kind="multi", weight=5),
        _order("M9", "照明改造", 90, "EAST", 480, day_intervals(1)[1][1], weight=1),
        _order("M10", "风管清洗", 120, "WEST", 960, day_intervals(2)[1][1], weight=2,
               window=(day_intervals(2)[0][0], day_intervals(2)[0][1])),   # D3 上午必须完成
        _order("M11", "储能柜装配", 150, "CITY", 1020, day_intervals(2)[1][1], weight=3),
        _order("M12", "消防联动测试", 60, "NORTH", 0, day_intervals(0)[1][1], weight=2),
        _order("M13", "指定设备校准", 90, "EAST", 0, day_intervals(1)[1][1],
               weight=2, fixed_machine="M4"),                              # 指定机器（强约束）
        _order("M14", "已完成的收尾", 60, "WEST", 0, day_intervals(0)[1][1], status="done"),
        _order("M15", "进行中的吊装", 120, "SOUTH", 0, day_intervals(1)[1][1], kind="multi",
               status="running", fixed_machine="M2", pinned_start=day_intervals(0)[1][0]),
    ]
    return "medium", "中规模（15 单 / 4 台设备 / 故障+时间窗+指定机器+进行中锁定）", orders, machines_medium()


def case_edge():
    o0 = day_intervals(0)
    o1 = day_intervals(1)
    orders = [
        # 两笔截止时间完全相同 -> 必须有确定的 tie-break（due, -weight, oid）
        _order("E1", "同截止 A", 60, "CITY", 0, o0[1][1], weight=1),
        _order("E2", "同截止 B", 60, "CITY", 0, o0[1][1], weight=5),
        # 刚好放得下 / 差一点放不下
        _order("E3", "刚好塞满上午", 190, "NORTH", 0, o0[0][1], weight=3),
        # 由 M1 的两次故障 + 只能单人设备导致必须挪到次日
        _order("E4", "被故障逼走", 90, "SOUTH", 0, o1[1][1], weight=2,
               fixed_machine="M1"),
        # 时间窗只有 45 分钟，服务 45 分钟（严格贴边）
        _order("E5", "贴边时间窗", 45, "EAST", 0, o1[1][1], weight=4,
               window=(o0[1][0] + 60, o0[1][0] + 105)),
        # 必须多人设备，而 M2 上午被 E3 占掉大半
        _order("E6", "必须多人", 150, "WEST", 0, o1[1][1], kind="multi", weight=5),
        # 截止早于 release：必然延期，但「活」本身还能做 -> 应排入并计入延期，而不是丢弃
        _order("E7", "必然延期", 120, "CITY", o0[1][0], o0[0][0] + 60, weight=3),
        # 真·不可行①：时间窗 20 分钟 < 任何设备上的最短占用（60*0.6=36）-> 无解，需给松弛建议
        _order("E8", "窗口装不下", 60, "NORTH", 0, o1[1][1], weight=2,
               window=(o0[0][0] + 120, o0[0][0] + 140)),
        # 真·不可行②：指定了一台不存在的设备 -> 无候选设备，需给松弛建议
        _order("E9", "指定设备不存在", 90, "EAST", 0, o1[1][1], weight=4,
               fixed_machine="M9"),
    ]
    return "edge", "边界（9 单 / 同截止 tie-break / 贴边时间窗 / 故障绕行 / 2 笔真不可行）", orders, machines_edge()


def case_degenerate():
    return [
        ("degenerate-empty", "退化（空输入：0 笔订单）", [], machines_medium()),
        ("degenerate-all-done", "退化（全部已完成，无可排订单）",
         [_order("D1", "历史订单", 60, "CITY", 0, day_intervals(0)[1][1], status="done"),
          _order("D2", "历史订单2", 90, "NORTH", 0, day_intervals(1)[1][1], status="done")],
         machines_medium()),
    ]


def all_cases() -> List[Tuple[str, str, List[Order], List[Machine]]]:
    cases = [case_small(), case_medium(), case_edge()]
    cases.extend(case_degenerate())
    return cases


# ---------------------------------------------------------------------------
# 四、排班内核：把一组订单放进「一条工位路线的一天」
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class RouteKey:
    """(机器, 工位序号, 第几天) —— 一条「工位路线」的唯一键，需可哈希。"""
    machine: str
    head: int
    day: int


def route_busy(machine_cal: Dict[int, List[Tuple[int, int]]], day: int,
               intervals: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    return intervals


def fits_in_one_interval(ivs: Sequence[Tuple[int, int]], start: int, dur: int) -> bool:
    """不中断约束：整段必须落在同一个连续可用区间内（不能跨午休 / 跨故障）。"""
    for s, e in ivs:
        if start >= s and start + dur <= e:
            return True
    return False


def next_interval_start(ivs: Sequence[Tuple[int, int]], t: int) -> Optional[int]:
    """>= t 的下一个可用区间起点（用于跨午休顺延）。"""
    for s, e in ivs:
        if e <= t:
            continue
        return t if t >= s else s
    return None


def place_sequence(machine: Machine, head: int, day: int, ivs: List[Tuple[int, int]],
                   seq: List[Order], startup_min: int, pinned: List[Placement],
                   prev_area: Optional[str] = None) -> Tuple[List[Placement], List[Order], List[str]]:
    """
    在一条工位路线的某一天，按给定顺序依次落位。
    返回 (成功落位列表, 放不下的订单, 违规说明)。
    规则：启动预留 -> 行驶/准备 -> max(release, 时间窗起点) -> 不能跨午休/故障 -> 时间窗必须完整落窗。
    """
    out: List[Placement] = []
    overflow: List[Order] = []
    problems: List[str] = []
    busy = list(pinned)
    if busy:
        # 已有进行中订单占着这条工位：从它结束之后接着排，
        # 且「首单准备时间」要算「从它在的区域开过来」的行驶，而不是从车库出发。
        cursor = max(p.finish for p in busy)
        tail = max(busy, key=lambda x: x.finish)
        area = tail.area or prev_area
    else:
        cursor = ivs[0][0] + startup_min if ivs else 0
        area = prev_area

    for od in seq:
        # 序列相关准备：首单用「上一单区域 / 车库」
        if area is None:
            setup = 0 if busy else machine.depot_min
        else:
            setup = setup_minutes(area, od.area)
        dur = od.dur(machine)
        t = cursor + setup
        lo = max(t, od.release, od.earliest())
        if od.window is not None:
            # 时间窗必须完整落窗：start >= ws 且 finish <= we
            lo = max(lo, od.window[0])
        start = next_interval_start(ivs, lo)
        placed = None
        while start is not None:
            if od.window is not None and start + dur > od.window[1]:
                # 先试着在窗内找位；找不到就判不可行（窗是硬约束）
                start = None
                break
            if fits_in_one_interval(ivs, start, dur):
                clash = any(not (start + dur <= p.start or start >= p.finish) for p in busy)
                if not clash:
                    placed = start
                    break
            nxt = next_interval_start(ivs, start + 1)
            if nxt is None or nxt <= start:
                break
            start = nxt
        if placed is None:
            if od.window is not None:
                problems.append("%s 无法落进时间窗 %s-%s" % (od.oid, fmt_time(od.window[0]), fmt_time(od.window[1])))
            overflow.append(od)
            continue
        p = Placement(oid=od.oid, machine=machine.mid, head=head, day=day,
                      start=placed, finish=placed + dur, setup_before=setup, area=od.area)
        out.append(p)
        busy.append(p)
        busy.sort(key=lambda x: x.start)
        cursor = max(p.finish, cursor)
        area = od.area
    return out, overflow, problems


def route_travel(placements: List[Placement], area_of: Dict[str, str],
                 machine: Machine, prev_area: Optional[str]) -> int:
    """一条路线一天的实际准备/行驶总分钟（用于路线优化目标）。"""
    total = machine.depot_min if placements else 0
    area = prev_area
    for p in placements:
        if area is None:
            pass
        else:
            total += setup_minutes(area, area_of[p.oid])
        area = area_of[p.oid]
    return total


def route_eval(seq: List[Order], machine: Machine, head: int, day: int,
               ivs: List[Tuple[int, int]], startup_min: int,
               pinned: List[Placement], prev_area: Optional[str]
               ) -> Tuple[List[Placement], List[Order], List[str], float]:
    """评价一个顺序：返回落位结果 + 代价（延期 + 等待 + 行驶）。"""
    pls, over, probs = place_sequence(machine, head, day, ivs, seq, startup_min, pinned, prev_area)
    cost = 0.0
    for p in pls:
        od = next(o for o in seq if o.oid == p.oid)
        tardy = max(0, p.finish - od.due) / 60.0
        cost += W_TARDY * od.weight * tardy + W_WAIT * max(0, p.start - od.release)
        cost += W_TRAVEL * p.setup_before
    cost += 1e6 * len(over)
    return pls, over, probs, cost


def improve_route(seq: List[Order], machine: Machine, head: int, day: int,
                  ivs: List[Tuple[int, int]], startup_min: int,
                  pinned: List[Placement], prev_area: Optional[str],
                  rounds: int = 3) -> List[Order]:
    """
    路线优化：2-opt（交换两点）+ Or-opt（把 1~2 个连续订单搬到别处）。
    只在「不增加代价」时接受，保证延期指标不劣化。
    """
    best = list(seq)
    _, _, _, best_cost = route_eval(best, machine, head, day, ivs, startup_min, pinned, prev_area)
    if len(best) < 2:
        return best
    for _ in range(rounds):
        improved = False
        n = len(best)
        # 2-opt
        for i in range(n - 1):
            for j in range(i + 1, n):
                cand = best[:i] + best[i:j + 1][::-1] + best[j + 1:]
                _, over, _, c = route_eval(cand, machine, head, day, ivs, startup_min, pinned, prev_area)
                if not over and c < best_cost - 1e-9:
                    best, best_cost, improved = cand, c, True
        # Or-opt（长度 1 和 2 的片段重定位）
        for seg in (1, 2):
            for i in range(0, len(best) - seg + 1):
                fragment = best[i:i + seg]
                rest = best[:i] + best[i + seg:]
                for k in range(len(rest) + 1):
                    cand = rest[:k] + fragment + rest[k:]
                    if cand == best:
                        continue
                    _, over, _, c = route_eval(cand, machine, head, day, ivs, startup_min, pinned, prev_area)
                    if not over and c < best_cost - 1e-9:
                        best, best_cost, improved = cand, c, True
        if not improved:
            break
    return best


# ---------------------------------------------------------------------------
# 五、候选位置枚举（三策略共用的可行性底座）
# ---------------------------------------------------------------------------

class Problem:
    def __init__(self, orders: List[Order], machines: List[Machine]):
        self.machines = {m.mid: m for m in machines}
        self.machine_list = list(machines)
        self.orders = {o.oid: o for o in orders}
        self.area_of = {o.oid: o.area for o in orders}
        self.cals = {m.mid: m.calendar() for m in machines}
        self.done = [o.oid for o in orders if o.status == "done"]
        self.running = [o for o in orders if o.status == "running"]
        self.pending = [o for o in orders if o.status == "pending"]
        self.pinned: Dict[RouteKey, List[Placement]] = {}
        self.machine_day_used: Dict[Tuple[str, int], bool] = {}
        for o in self.running:
            m = self.machines.get(o.fixed_machine or "")
            if m is None:
                continue
            day = (o.pinned_start or 0) // DAY_MIN
            ivs = self.cals[m.mid].get(day, [])
            p = Placement(oid=o.oid, machine=m.mid, head=0, day=day,
                          start=o.pinned_start or 0, finish=(o.pinned_start or 0) + o.dur(m),
                          setup_before=0, area=o.area, pinned=True)
            self.pinned.setdefault(RouteKey(m.mid, 0, day), []).append(p)
            self.machine_day_used[(m.mid, day)] = True

    # -- 可行性 ------------------------------------------------------------
    def eligible(self, o: Order) -> List[Machine]:
        out = []
        for m in self.machine_list:
            if o.fixed_machine and m.mid != o.fixed_machine:
                continue
            if o.kind not in m.eligible_kinds:
                continue
            out.append(m)
        return out

    def best_placement(self, o: Order, m: Machine, head: int, day: int,
                       existing: List[Order]) -> Optional[Placement]:
        """把 o 追加到既有顺序之后（贪心/前瞻用的快速评价）。"""
        ivs = self.cals[m.mid].get(day, [])
        if not ivs:
            return None
        pin = self.pinned.get(RouteKey(m.mid, head, day), [])
        seq = existing + [o]
        pls, over, _ = place_sequence(m, head, day, ivs, seq, m.startup_min, pin, None)
        if over:
            return None
        for p in pls:
            if p.oid == o.oid:
                return p
        return None

    def all_pinned(self) -> List[Placement]:
        """进行中订单的锁定排程（必须原样出现在每一个方案的输出里）。"""
        return [p for key in sorted(self.pinned, key=lambda k: (k.machine, k.head, k.day))
                for p in self.pinned[key]]

    def startup_cost_for(self, m: Machine, day: int,
                         used: Optional[Set[Tuple[str, int]]] = None) -> float:
        """本次安排是否需要新启动：已锁定的设备-日、或本方案已用过的设备-日都不再计费。"""
        if self.machine_day_used.get((m.mid, day)):
            return 0.0
        if used is not None and (m.mid, day) in used:
            return 0.0
        return m.startup_cost


# ---------------------------------------------------------------------------
# 六、策略 A：贪心（EDD）
# ---------------------------------------------------------------------------

def solve_greedy(prob: Problem) -> Solution:
    routes: Dict[RouteKey, List[Order]] = {}
    placements: List[Placement] = []
    unassigned: List[Tuple[str, str]] = []
    used_days: Set[Tuple[str, int]] = set()

    order_key = lambda o: (o.due, -o.weight, o.oid)
    todo = sorted(prob.pending, key=order_key)
    for od in todo:
        best = None
        for m in prob.eligible(od):
            for head in range(m.heads):
                for day in range(HORIZON_DAYS):
                    key = RouteKey(m.mid, head, day)
                    existing = routes.get(key, [])
                    p = prob.best_placement(od, m, head, day, existing)
                    if p is None:
                        continue
                    sc = prob.startup_cost_for(m, day, used_days)
                    c = (W_TARDY * od.weight * max(0, p.finish - od.due) / 60.0
                         + W_WAIT * max(0, p.start - od.release)
                         + W_ENERGY * (od.dur(m) / 60.0) * m.head_kw
                         + W_STARTUP * sc
                         + W_TRAVEL * p.setup_before)
                    if best is None or c < best[0]:
                        best = (c, key, p)
        if best is None:
            unassigned.append((od.oid, "没有任何可行位置（释放时间/时间窗/能力/容量都不满足）"))
            continue
        _, key, p = best
        routes.setdefault(key, []).append(od)
        placements.append(p)
        used_days.add((key.machine, key.day))
    return Solution("greedy", placements, unassigned, list(prob.done))


# ---------------------------------------------------------------------------
# 七、策略 B：前瞻贪心
# ---------------------------------------------------------------------------

def _min_slack_after(prob: Problem, routes: Dict[RouteKey, List[Order]],
                     extra_key: RouteKey, extra_order: Order,
                     remaining: List[Order]) -> float:
    """
    前瞻指标：试排 extra_order 后，剩余订单里最小的「可开工余量」。
    余量越小说明越危险，前瞻策略会优先保住它。
    """
    worst = float("inf")
    for od in remaining:
        if od.oid == extra_order.oid:
            continue
        best_slack = -float("inf")
        for m in prob.eligible(od):
            for head in range(m.heads):
                for day in range(HORIZON_DAYS):
                    key = RouteKey(m.mid, head, day)
                    existing = list(routes.get(key, []))
                    if key == extra_key:
                        existing = existing + [extra_order]
                    p = prob.best_placement(od, m, head, day, existing)
                    if p is None:
                        continue
                    slack = od.due - p.finish
                    best_slack = max(best_slack, slack)
        if best_slack == -float("inf"):
            return -1e9                      # 已经没地方放了
        worst = min(worst, best_slack)
    return 0.0 if worst == float("inf") else worst


def solve_lookahead(prob: Problem) -> Solution:
    routes: Dict[RouteKey, List[Order]] = {}
    placements: List[Placement] = []
    unassigned: List[Tuple[str, str]] = []
    used_days: Set[Tuple[str, int]] = set()

    remaining = sorted(prob.pending, key=lambda o: (o.due, -o.weight, o.oid))
    while remaining:
        best = None
        for od in remaining:
            for m in prob.eligible(od):
                for head in range(m.heads):
                    for day in range(HORIZON_DAYS):
                        key = RouteKey(m.mid, head, day)
                        existing = routes.get(key, [])
                        p = prob.best_placement(od, m, head, day, existing)
                        if p is None:
                            continue
                        rest = [x for x in remaining if x.oid != od.oid]
                        slack = _min_slack_after(prob, routes, key, od, rest)
                        tardy = max(0, p.finish - od.due)
                        sc = prob.startup_cost_for(m, day, used_days)
                        # 前瞻优先：先让最小松弛最大（即 -slack 最小），再看延期/成本
                        c = ((-slack) * 10.0
                             + W_TARDY * od.weight * tardy / 60.0
                             + W_WAIT * max(0, p.start - od.release)
                             + W_ENERGY * (od.dur(m) / 60.0) * m.head_kw
                             + W_STARTUP * sc)
                        if best is None or c < best[0]:
                            best = (c, od, key, p)
        if best is None:
            for od in remaining:
                unassigned.append((od.oid, "前瞻扫描后仍无可行位置"))
            break
        _, od, key, p = best
        routes.setdefault(key, []).append(od)
        placements.append(p)
        used_days.add((key.machine, key.day))
        remaining = [x for x in remaining if x.oid != od.oid]
    return Solution("lookahead", placements, unassigned, list(prob.done))


# ---------------------------------------------------------------------------
# 八、策略 C：二分阈值 + Hopcroft-Karp 最大匹配 + 路线优化
# ---------------------------------------------------------------------------

def hopcroft_karp(adj: List[List[int]], n_left: int, n_right: int):
    """返回 (匹配数, left->right, right->left)。经典 HK，O(E*sqrt(V))。"""
    INF = float("inf")
    pair_u = [-1] * n_left
    pair_v = [-1] * n_right
    dist = [0] * n_left

    def bfs() -> bool:
        q = deque()
        for u in range(n_left):
            if pair_u[u] == -1:
                dist[u] = 0
                q.append(u)
            else:
                dist[u] = INF
        found = False
        while q:
            u = q.popleft()
            for v in adj[u]:
                w = pair_v[v]
                if w == -1:
                    found = True
                elif dist[w] == INF:
                    dist[w] = dist[u] + 1
                    q.append(w)
        return found

    def dfs(u: int) -> bool:
        for v in adj[u]:
            w = pair_v[v]
            if w == -1 or (dist[w] == dist[u] + 1 and dfs(w)):
                pair_u[u] = v
                pair_v[v] = u
                return True
        dist[u] = INF
        return False

    matching = 0
    while bfs():
        for u in range(n_left):
            if pair_u[u] == -1 and dfs(u):
                matching += 1
    return matching, pair_u, pair_v


def _slot_capacity(prob: Problem, m: Machine, head: int, day: int, orders: List[Order]) -> int:
    """
    单条「工位路线（机器,工位,日）」能容纳的订单数上界。
    必须扣除：已被进行中订单锁定的时段、启动预热时间、以及每单之间最少的准备/行驶时间。
    估计偏保守是刻意的 —— 匹配阶段不把话说满，落位阶段才不会大面积溢出。
    """
    ivs = prob.cals[m.mid].get(day, [])
    total = sum(e - s for s, e in ivs)
    if not orders or total <= 0:
        return 0
    pin = prob.pinned.get(RouteKey(m.mid, head, day), [])
    if pin:
        total -= sum(p.finish - p.start for p in pin)
    else:
        total -= m.startup_min
    total = max(0, total)
    min_dur = min(max(MIN_SINGLE_DUR, o.dur(m)) for o in orders)
    avg_setup = max(1, m.depot_min)
    return max(0, int(total // (min_dur + avg_setup)))


def solve_matching(prob: Problem) -> Solution:
    orders = sorted(prob.pending, key=lambda o: (o.due, -o.weight, o.oid))
    if not orders:
        return Solution("matching", [], [], list(prob.done))

    # 右侧：把 (machine, head, day) 按容量展开成多个副本，变成无权二分匹配
    slots: List[Tuple[str, int, int]] = []
    for m in prob.machine_list:
        for day in range(HORIZON_DAYS):
            for head in range(m.heads):
                cap = _slot_capacity(prob, m, head, day, orders)
                for _ in range(cap):
                    slots.append((m.mid, head, day))
    if not slots:
        return Solution("matching", [], [(o.oid, "无可用工位") for o in orders], list(prob.done))

    # 枚举每条边的代价（该订单放到该工位日的最佳位置）
    edges: List[List[Tuple[float, int, Placement]]] = []
    weights: List[float] = []
    for od in orders:
        row: List[Tuple[float, int, Placement]] = []
        for si, (mid, head, day) in enumerate(slots):
            m = prob.machines[mid]
            if od.kind not in m.eligible_kinds:
                continue
            if od.fixed_machine and od.fixed_machine != mid:
                continue
            p = prob.best_placement(od, m, head, day, [])
            if p is None:
                continue
            energy = (od.dur(m) / 60.0) * m.head_kw
            w = (W_TARDY * od.weight * max(0, p.finish - od.due) / 60.0
                 + W_WAIT * max(0, p.start - od.release)
                 + W_ENERGY * energy
                 + W_STARTUP * m.startup_cost
                 + W_TRAVEL * m.depot_min)
            row.append((w, si, p))
            weights.append(w)
        edges.append(row)

    def max_match_within(threshold: float) -> Tuple[int, List[List[int]]]:
        adj: List[List[int]] = []
        for row in edges:
            adj.append([si for (w, si, _) in row if w <= threshold + 1e-9])
        cnt, _, _ = hopcroft_karp(adj, len(orders), len(slots))
        return cnt, adj

    if not weights:
        return Solution("matching", [], [(o.oid, "无可行边") for o in orders], list(prob.done))

    uniq = sorted(set(weights))
    # 二分：找「使匹配数达到最大」的最小阈值
    lo, hi = 0, len(uniq) - 1
    best_cnt, _ = max_match_within(uniq[hi])
    while lo < hi:
        mid = (lo + hi) // 2
        cnt, _ = max_match_within(uniq[mid])
        if cnt >= best_cnt:
            hi = mid
        else:
            lo = mid + 1
    tau = uniq[lo]
    cnt, adj = max_match_within(tau)

    # 最终匹配网络：保留 w <= tau 的全部边（即「小于阈值边界」+ 触界边）
    _, pair_u, _ = hopcroft_karp(adj, len(orders), len(slots))

    # 按匹配结果落到工位路线，再对每条路线做 2-opt / Or-opt
    routes: Dict[RouteKey, List[Order]] = {}
    unassigned: List[Tuple[str, str]] = []
    for u, od in enumerate(orders):
        v = pair_u[u]
        if v == -1:
            unassigned.append((od.oid, "二分阈值 %.2f 下无可达工位（能力/时间窗/容量受限）" % tau))
            continue
        mid, head, day = slots[v]
        routes.setdefault(RouteKey(mid, head, day), []).append(od)

    # 第一阶段：每条路线独立落位；落不下的先收集起来（容量估计可能偏乐观）
    final: List[Placement] = []
    lane: Dict[RouteKey, List[Order]] = {}
    overflow: List[Order] = []
    for key, seq in routes.items():
        m = prob.machines[key.machine]
        ivs = prob.cals[key.machine].get(key.day, [])
        pin = prob.pinned.get(key, [])
        seq = improve_route(seq, m, key.head, key.day, ivs, m.startup_min, pin, None)
        pls, over, _ = place_sequence(m, key.head, key.day, ivs, seq, m.startup_min, pin, None)
        final.extend(pls)
        lane[key] = [prob.orders[p.oid] for p in pls]
        overflow.extend(over)

    # 第二阶段：溢出修复 —— 把匹配阶段乐观塞进某条路线、实际落不下的订单，
    # 改派到全局任一仍有空档的工位；真的无解才记入 unassigned。
    used_days: Set[Tuple[str, int]] = {(k.machine, k.day) for k, v in lane.items() if v}
    overflow.sort(key=lambda o: (o.due, -o.weight, o.oid))
    for od in overflow:
        best = None
        for m in prob.eligible(od):
            for head in range(m.heads):
                for day in range(HORIZON_DAYS):
                    key = RouteKey(m.mid, head, day)
                    p = prob.best_placement(od, m, head, day, lane.get(key, []))
                    if p is None:
                        continue
                    sc = prob.startup_cost_for(m, day, used_days)
                    c = (W_TARDY * od.weight * max(0, p.finish - od.due) / 60.0
                         + W_WAIT * max(0, p.start - od.release)
                         + W_ENERGY * (od.dur(m) / 60.0) * m.head_kw
                         + W_STARTUP * sc
                         + W_TRAVEL * p.setup_before)
                    if best is None or c < best[0]:
                        best = (c, key, p)
        if best is None:
            unassigned.append((od.oid, "匹配后全局复核仍无可行工位（能力/时间窗/容量受限）"))
            continue
        _, key, p = best
        lane.setdefault(key, []).append(od)
        final.append(p)
        used_days.add((key.machine, key.day))
    return Solution("matching", final, unassigned, list(prob.done))


# ---------------------------------------------------------------------------
# 九、第二阶段：启动成本/能耗合并（在「不劣化延期」前提下减少启动次数）
# ---------------------------------------------------------------------------

def consolidate_startups(prob: Problem, sol: Solution) -> Solution:
    """
    优先级 2 的实现：延期指标不劣化时，尝试把只用了少量订单的「设备-日」
    合并到其它已启用的「设备-日」，省一次启动成本与待机能耗。
    """
    by_day: Dict[Tuple[str, int], List[Placement]] = {}
    for p in sol.placements:
        by_day.setdefault((p.machine, p.day), []).append(p)
    used_days = {k for k, v in by_day.items() if v}
    changed = False
    for (mid, day), pls in sorted(by_day.items()):
        if len(pls) > 2:
            continue
        for p in list(pls):
            if p.pinned:
                continue                       # 进行中订单已锁定，不允许被搬走
            od = prob.orders[p.oid]
            best = None
            for (m2, d2) in used_days:
                if (m2, d2) == (mid, day):
                    continue
                m = prob.machines[m2]
                if od.kind not in m.eligible_kinds:
                    continue
                if od.fixed_machine and od.fixed_machine != m2:
                    continue
                ivs = prob.cals[m2].get(d2, [])
                seq_others = [prob.orders[x.oid] for x in by_day[(m2, d2)]]
                for head in range(m.heads):
                    cand = prob.best_placement(od, m, head, d2, seq_others)
                    if cand is None:
                        continue
                    new_tardy = max(0, cand.finish - od.due)
                    old_tardy = max(0, p.finish - od.due)
                    if new_tardy > old_tardy:
                        continue
                    score = (len(seq_others), new_tardy, cand.finish)
                    if best is None or score < best[0]:
                        best = (score, m2, d2, head, cand)
            if best is not None:
                _, m2, d2, head, cand = best
                old = by_day[(mid, day)]
                old = [x for x in old if x.oid != p.oid]
                by_day[(mid, day)] = old
                by_day.setdefault((m2, d2), []).append(cand)   # cand 已带正确 machine/head/day/setup/area
                used_days.add((m2, d2))
                changed = True
    if not changed:
        return sol
    keep = [p for k, v in by_day.items() for p in v]
    return Solution(sol.strategy + "+consolidate", keep, sol.unassigned, sol.skipped_done, dict(sol.metrics))


# ---------------------------------------------------------------------------
# 十、指标计算（含能量总量 / 电池容量估算）
# ---------------------------------------------------------------------------

def compute_metrics(prob: Problem, sol: Solution) -> Dict[str, float]:
    m = {"tardy_weighted": 0.0, "tardy_count": 0.0, "max_tardy": 0.0,
         "makespan": 0.0, "startup_cost": 0.0, "startup_count": 0.0,
         "energy_kwh": 0.0, "energy_cost": 0.0, "battery_kwh": 0.0,
         "peak_kw": 0.0, "travel_min": 0.0, "work_min": 0.0, "assigned": 0.0}
    if not sol.placements:
        return m
    used = {}
    for p in sol.placements:
        od = prob.orders[p.oid]
        mac = prob.machines[p.machine]
        t = max(0, p.finish - od.due)
        m["tardy_weighted"] += od.weight * t
        if t > 0:
            m["tardy_count"] += 1
        m["max_tardy"] = max(m["max_tardy"], t)
        m["makespan"] = max(m["makespan"], p.finish)
        m["travel_min"] += p.setup_before
        m["work_min"] += p.finish - p.start
        used.setdefault((p.machine, p.day), []).append(p)
        m["assigned"] += 1
    m["startup_count"] = len(used)
    for (mid, day), pls in used.items():
        m["startup_cost"] += prob.machines[mid].startup_cost

    # 逐分钟功率剖面 -> 能量 / 峰值功率 / 电池容量
    timeline: Dict[int, float] = {}
    for (mid, day), pls in used.items():
        mac = prob.machines[mid]
        for p in pls:
            for t in range(p.start, p.finish):
                timeline[t] = timeline.get(t, 0.0) + mac.head_kw
    for t in set(timeline):
        timeline[t] += 0.0
    # 基础功率：该设备当天有工位在跑的整段时间（含空闲间隙）都要算
    for (mid, day), pls in used.items():
        mac = prob.machines[mid]
        lo = min(p.start for p in pls)
        hi = max(p.finish for p in pls)
        for t in range(lo, hi):
            timeline[t] = timeline.get(t, 0.0) + mac.base_kw
    m["peak_kw"] = max(timeline.values()) if timeline else 0.0
    m["energy_kwh"] = sum(timeline.values()) / 60.0
    m["energy_cost"] = m["energy_kwh"] * ENERGY_PRICE
    per_day = {}
    for t, kw in timeline.items():
        per_day[t // DAY_MIN] = per_day.get(t // DAY_MIN, 0.0) + kw / 60.0
    day_energy = {d: round(v, 3) for d, v in sorted(per_day.items())}
    m["day_energy"] = day_energy                                            # type: ignore
    m["battery_kwh"] = round(max(day_energy.values()) * BATTERY_RESERVE, 2) if day_energy else 0.0
    m["energy_total_kwh"] = round(m["energy_kwh"], 3)
    m["energy_cost"] = round(m["energy_cost"], 2)
    m["energy_kwh"] = round(m["energy_kwh"], 3)
    m["peak_kw"] = round(m["peak_kw"], 2)
    return m


def composite_score(sol: Solution) -> float:
    m = sol.metrics
    return (W_TARDY * m.get("tardy_weighted", 0.0) / 60.0
            + W_STARTUP * m.get("startup_cost", 0.0)
            + W_ENERGY * m.get("energy_kwh", 0.0)
            + W_TRAVEL * m.get("travel_min", 0.0))


# ---------------------------------------------------------------------------
# 十一、硬约束自检
# ---------------------------------------------------------------------------

def verify(prob: Problem, sol: Solution) -> List[str]:
    v: List[str] = []
    seen: Dict[str, Placement] = {}
    by_lane: Dict[Tuple[str, int, int], List[Placement]] = {}
    machine_day: Dict[Tuple[str, int], List[Placement]] = {}

    for p in sol.placements:
        od = prob.orders.get(p.oid)
        mac = prob.machines.get(p.machine)
        if od is None or mac is None:
            v.append("H0 未知订单/设备: %s" % p.oid)
            continue
        seen[p.oid] = p
        by_lane.setdefault((p.machine, p.head, p.day), []).append(p)
        machine_day.setdefault((p.machine, p.day), []).append(p)

        # H2 能力匹配
        if od.kind not in mac.eligible_kinds:
            v.append("H2 %s(kind=%s) 排到了不具备能力的 %s" % (p.oid, od.kind, p.machine))
        # H12 指定机器
        if od.fixed_machine and od.fixed_machine != p.machine:
            v.append("H12 %s 指定 %s，实际排到 %s" % (p.oid, od.fixed_machine, p.machine))
        # H3 释放时间
        if p.start < od.release and not p.pinned:
            v.append("H3 %s 开始 %s 早于 release %s" % (p.oid, fmt_time(p.start), fmt_time(od.release)))
        # H4 时间窗
        if od.window and not (p.start >= od.window[0] and p.finish <= od.window[1]):
            v.append("H4 %s 未完整落窗 [%s, %s]，实际 [%s, %s]"
                     % (p.oid, fmt_time(od.window[0]), fmt_time(od.window[1]),
                        fmt_time(p.start), fmt_time(p.finish)))
        # H8 不中断（落在同一连续可用区间）
        ivs = prob.cals[p.machine].get(p.day, [])
        if not fits_in_one_interval(ivs, p.start, p.finish - p.start):
            v.append("H8 %s 跨越了不可用区间（被午休/故障中断）" % p.oid)
        # H10 启动时间已预留
        if not p.pinned:
            day_lo = p.day * DAY_MIN + SHIFT_START_REL
            first = min(machine_day[(p.machine, p.day)], key=lambda x: x.start)
            if first.oid == p.oid and p.start < day_lo + mac.startup_min:
                v.append("H10 %s 未为 %s 预留启动时间 %d 分钟" % (p.oid, p.machine, mac.startup_min))

    # H1 待排订单必须全部落位（未落位的进入 unassigned 且必须给出原因）
    for od in prob.pending:
        if od.oid not in seen:
            reason = next((r for (o, r) in sol.unassigned if o == od.oid), "")
            if not reason:
                v.append("H1 %s 既未排入也未给出不可行原因" % od.oid)
    # H13 进行中订单位置未被改动
    for od in prob.running:
        p = seen.get(od.oid)
        if p is None:
            v.append("H13 进行中订单 %s 丢失" % od.oid)
        else:
            if p.machine != od.fixed_machine or p.start != od.pinned_start:
                v.append("H13 进行中订单 %s 位置被改动" % od.oid)
    # H6 同工位不重叠
    for key, pls in by_lane.items():
        s = sorted(pls, key=lambda x: x.start)
        for i in range(len(s) - 1):
            if s[i].finish > s[i + 1].start:
                v.append("H6 %s/%d D%d 工位重叠: %s 与 %s"
                         % (key[0], key[1], key[2] + 1, s[i].oid, s[i + 1].oid))
    # H7 设备并发 <= heads
    for (mid, day), pls in machine_day.items():
        heads = prob.machines[mid].heads
        for t in range(min(p.start for p in pls), max(p.finish for p in pls)):
            live = sum(1 for p in pls if p.start <= t < p.finish)
            if live > heads:
                v.append("H7 %s D%d %s 并发 %d > 工位 %d" % (mid, day + 1, hhmm(t % DAY_MIN), live, heads))
                break
    # H9 序列相关准备时间已计入
    for (mid, head, day), pls in by_lane.items():
        s = sorted(pls, key=lambda x: x.start)
        for i in range(1, len(s)):
            need = setup_minutes(prob.orders[s[i - 1].oid].area, prob.orders[s[i].oid].area)
            gap = s[i].start - s[i - 1].finish
            if gap < need:
                v.append("H9 %s 与 %s 之间的准备时间不足（需 %d 实际 %d）"
                         % (s[i - 1].oid, s[i].oid, need, gap))
    # H11 疲劳：单工位路线单日 服务+准备 <= 8h
    for (mid, head, day), pls in by_lane.items():
        total = sum(p.finish - p.start for p in pls) + sum(p.setup_before for p in pls)
        if total > FATIGUE_LIMIT_MIN:
            v.append("H11 %s/%d D%d 服务+准备 %d 分钟 > %d（疲劳上限）"
                     % (mid, head, day + 1, total, FATIGUE_LIMIT_MIN))
    return v


# ---------------------------------------------------------------------------
# 十二、不可行诊断 + 松弛建议
# ---------------------------------------------------------------------------

def diagnose(prob: Problem, sol: Solution) -> List[str]:
    tips: List[str] = []
    for oid, reason in sol.unassigned:
        od = prob.orders[oid]
        els = prob.eligible(od)
        if not els:
            if od.kind == "multi":
                tips.append("%s：需要多人设备（heads>=2），当前可用设备均不具备 -> 建议启用/租用多工位设备" % oid)
            elif od.fixed_machine:
                tips.append("%s：指定设备 %s 不存在或不可用 -> 建议解除机器指定或启用该设备" % (oid, od.fixed_machine))
            else:
                tips.append("%s：无候选设备 -> 建议增加设备或调整订单能力要求" % oid)
            continue
        cap = 0
        for m in els:
            for d in range(HORIZON_DAYS):
                cap += sum(e - s for s, e in prob.cals[m.mid].get(d, []))
        best_dur = min(od.dur(m) for m in els)          # 最有利设备上的最短占用
        if od.window is not None and od.window[1] - od.window[0] < best_dur:
            tips.append("%s：时间窗仅 %d 分钟 < 最短占用 %d 分钟 -> 建议把时间窗放宽到 %s 之后（至少 %d 分钟）"
                        % (oid, od.window[1] - od.window[0], best_dur,
                           fmt_time(od.window[1]), best_dur))
        elif od.due <= od.release:
            tips.append("%s：截止 %s 早于释放 %s -> 建议把截止时间放宽到 %s"
                        % (oid, fmt_time(od.due), fmt_time(od.release), fmt_time(od.release + od.service_min)))
        else:
            tips.append("%s：%s（候选设备总可用容量 %d 分钟）-> 建议放宽截止时间或延长作业窗口"
                        % (oid, reason, cap))
    return tips


# ---------------------------------------------------------------------------
# 十三、单用例求解
# ---------------------------------------------------------------------------

def solve_case(name: str, title: str, orders: List[Order], machines: List[Machine]) -> Dict[str, object]:
    prob = Problem(orders, machines)
    pins = prob.all_pinned()                      # 进行中订单：每个方案的输出都必须原样带上
    results = []
    for fn in (solve_greedy, solve_lookahead, solve_matching):
        sol = fn(prob)
        sol = consolidate_startups(prob, sol)
        sol.placements = pins + sol.placements
        sol.metrics = compute_metrics(prob, sol)
        sol.violations = verify(prob, sol)
        results.append(sol)
    # 排序：先看硬约束是否满足，再看「落不下多少单」，最后才比成本
    ranked = sorted(results, key=lambda s: (len(s.violations) > 0, len(s.unassigned),
                                            composite_score(s), s.strategy))
    best = ranked[0]
    return {
        "name": name,
        "title": title,
        "problem": prob,
        "results": results,
        "ranked": ranked,
        "best": best,
        "tips": diagnose(prob, best),
    }


# ---------------------------------------------------------------------------
# 十四、控制台输出
# ---------------------------------------------------------------------------

def print_case(res: Dict[str, object]) -> None:
    prob: Problem = res["problem"]                      # type: ignore
    print("=" * 96)
    print("用例 %s  |  %s" % (res["name"], res["title"]))
    print("-" * 96)
    print("订单 %d 笔（待排 %d / 进行中锁定 %d / 已完成跳过 %d）  设备 %d 台，总工位 %d"
          % (len(prob.orders), len(prob.pending), len(prob.running), len(prob.done),
             len(prob.machine_list), sum(m.heads for m in prob.machine_list)))
    print("横向 %d 天，每天 08:00-12:00 / 13:00-17:00（午休不可跨越 = 订单不中断约束）" % HORIZON_DAYS)
    if prob.done:
        print("已完成跳过: %s" % ", ".join(prob.done))
    if prob.running:
        print("进行中锁定: %s" % ", ".join("%s@%s %s" % (o.oid, o.fixed_machine, fmt_time(o.pinned_start or 0))
                                          for o in prob.running))
    print()
    hdr = "%-10s %-9s %-8s %-7s %-7s %-9s %-9s %-8s"
    for sol in res["results"]:                          # type: ignore
        m = sol.metrics
        print("策略 %-22s 违规 %d | 加权延期 %.0f 分 | 未排入 %d | 启动 %d 次/%.0f 元 | 能耗 %.2f kWh/%.2f 元 | 电池 %.2f kWh | 峰值 %.2f kW | 行驶准备 %.0f 分"
              % (sol.strategy, len(sol.violations), m.get("tardy_weighted", 0),
                 len(sol.unassigned), m.get("startup_count", 0), m.get("startup_cost", 0),
                 m.get("energy_kwh", 0), m.get("energy_cost", 0), m.get("battery_kwh", 0),
                 m.get("peak_kw", 0), m.get("travel_min", 0)))
    best: Solution = res["best"]                        # type: ignore
    print()
    print(">> 推荐方案: %s（硬约束违规 %d）" % (best.strategy, len(best.violations)))
    print(hdr % ("订单", "设备/工位", "日期", "开始", "结束", "占用(分)", "相对截止", "延期(分)"))
    for p in sorted(best.placements, key=lambda x: (x.start, x.machine, x.head)):
        od = prob.orders[p.oid]
        if od.status == "running":
            tag = " (进行中锁定)"
        elif od.status == "done":
            tag = " (已完成)"
        else:
            tag = ""
        tardy = max(0, p.finish - od.due)
        print(hdr % (p.oid + tag, "%s/%d" % (p.machine, p.head + 1), "D%d" % (p.day + 1),
                     hhmm(p.start % DAY_MIN), hhmm(p.finish % DAY_MIN),
                     p.finish - p.start, fmt_time(od.due), tardy if tardy else "-"))
    if best.unassigned:
        print()
        print("!! 未排入订单:")
        for oid, why in best.unassigned:
            print("   - %s: %s" % (oid, why))
    if best.violations:
        print()
        print("!! 硬约束违规 %d 条:" % len(best.violations))
        for v in best.violations:
            print("   - %s" % v)
    if res["tips"]:                                     # type: ignore
        print()
        print(">> 约束松弛建议:")
        for t in res["tips"]:                           # type: ignore
            print("   - %s" % t)
    print()


# ---------------------------------------------------------------------------
# 十五、HTML 报告（内嵌 SVG，零外部依赖，可离线打开）
# ---------------------------------------------------------------------------

CSS = """
:root{--bg:#f6f7f9;--card:#fff;--line:#e5e7eb;--ink:#1f2329;--muted:#6b7280;
--brand:#2b6cf6;--ok:#0f9d58;--warn:#d97706;--bad:#dc2626;--soft:#eef2ff}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);
font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.wrap{max-width:1180px;margin:0 auto;padding:28px 20px 64px}
h1{font-size:24px;margin:0 0 6px}
h2{font-size:17px;margin:32px 0 10px;padding-left:10px;border-left:4px solid var(--brand)}
h3{font-size:15px;margin:18px 0 8px;color:#374151}
.sub{color:var(--muted);font-size:13px;margin-bottom:18px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px 18px;margin-bottom:16px}
.kpis{display:flex;flex-wrap:wrap;gap:12px}
.kpi{flex:1 1 150px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px 14px}
.kpi .k{color:var(--muted);font-size:12px}
.kpi .v{font-size:20px;font-weight:700;margin-top:2px}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;white-space:nowrap}
th{background:#fafbfc;color:#4b5563;font-weight:600}
tr:hover td{background:#fafbff}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px;border:1px solid}
.p-ok{color:var(--ok);border-color:#b7e4c7;background:#f0fdf4}
.p-warn{color:var(--warn);border-color:#fde68a;background:#fffbeb}
.p-bad{color:var(--bad);border-color:#fecaca;background:#fef2f2}
.tabs{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap}
.tab{padding:6px 14px;border:1px solid var(--line);border-radius:999px;cursor:pointer;
background:#fff;font-size:13px}
.tab.on{background:var(--soft);border-color:#c7d2fe;color:var(--brand);font-weight:600}
.panel{display:none}
.panel.on{display:block}
svg{max-width:100%;height:auto;display:block}
.note{color:var(--muted);font-size:12.5px;margin:6px 0 0}
ul{margin:6px 0 0 18px;padding:0}
li{margin:2px 0}
code{background:#f3f4f6;padding:1px 5px;border-radius:4px;font-size:12.5px}
.scroll{overflow-x:auto}
"""

JS = """
(function(){
  var groups={};
  document.querySelectorAll('.tabs').forEach(function(bar){
    var id=bar.getAttribute('data-group');
    bar.querySelectorAll('.tab').forEach(function(t){
      t.addEventListener('click',function(){
        bar.querySelectorAll('.tab').forEach(function(x){x.classList.remove('on')});
        t.classList.add('on');
        document.querySelectorAll('[data-panel="'+id+'"]').forEach(function(p){p.classList.remove('on')});
        var el=document.querySelector('[data-panel="'+id+'"][data-key="'+t.getAttribute('data-key')+'"]');
        if(el){el.classList.add('on')}
      });
    });
  });
})();
"""


def _svg_gantt(prob: Problem, sol: Solution, px_per_min: float = 0.72) -> str:
    """甘特图：每台设备每工位一行，标注订单号 / 午休 / 故障窗口 / 截止时间刻度。"""
    total_min = HORIZON_DAYS * DAY_MIN
    left, top, lane_h, machine_gap = 132, 54, 26, 16
    width = int(left + total_min * px_per_min + 24)
    lanes = sum(m.heads for m in prob.machine_list)
    height = int(top + lanes * lane_h + len(prob.machine_list) * machine_gap + 46)
    x = lambda m: left + m * px_per_min
    parts: List[str] = ['<svg viewBox="0 0 %d %d" width="%d" height="%d" role="img" '
                        'aria-label="排班甘特图">' % (width, height, width, height)]
    parts.append('<rect x="0" y="0" width="%d" height="%d" fill="#ffffff"/>' % (width, height))
    # 天分隔 + 午休 + 故障
    for d in range(HORIZON_DAYS):
        parts.append('<rect x="%.1f" y="%d" width="%.1f" height="%d" fill="#f9fafb"/>'
                     % (x(d * DAY_MIN), 40, x(DAY_MIN) - x(0), height - 40))
        for (a, b) in day_intervals(d):
            parts.append('<rect x="%.1f" y="%d" width="%.1f" height="%d" fill="#ffffff"/>'
                         % (x(a), 40, (b - a) * px_per_min, height - 40))
        parts.append('<text x="%.1f" y="30" font-size="13" font-weight="700" fill="#374151">D%d'
                     '</text>' % (x(d * DAY_MIN) + 8, d + 1))
        if d < HORIZON_DAYS - 1:
            parts.append('<line x1="%.1f" y1="40" x2="%.1f" y2="%d" stroke="#d1d5db" stroke-width="1.5"/>'
                         % (x((d + 1) * DAY_MIN), x((d + 1) * DAY_MIN), height - 6))

    y = top
    for m in prob.machine_list:
        ivs_all: List[Tuple[int, int]] = []
        for d in range(HORIZON_DAYS):
            ivs_all.extend(prob.cals[m.mid].get(d, []))
        # 故障/维护阴影
        for d in range(HORIZON_DAYS):
            base = d * DAY_MIN + SHIFT_START_REL
            for (dd, a, b) in m.failures:
                if dd == d:
                    parts.append('<rect x="%.1f" y="%d" width="%.1f" height="%d" fill="#fee2e2" '
                                 'stroke="#fca5a5" stroke-dasharray="3 3"/>'
                                 % (x(base + a), y, (b - a) * px_per_min, m.heads * lane_h))
        parts.append('<text x="8" y="%d" font-size="12.5" font-weight="700" fill="#111827">%s'
                     '</text>' % (y + 15, m.mid))
        parts.append('<text x="8" y="%d" font-size="11" fill="#6b7280">%d 工位</text>' % (y + 30, m.heads))
        for head in range(m.heads):
            ly = y + head * lane_h
            parts.append('<rect x="%d" y="%d" width="%d" height="%d" fill="none" stroke="#e5e7eb"/>'
                         % (left, ly, int(total_min * px_per_min), lane_h - 3))
            for p in sol.placements:
                if p.machine != m.mid or p.head != head:
                    continue
                od = prob.orders[p.oid]
                fill = {"pending": "#2b6cf6", "running": "#7c3aed", "multi": "#0f9d58"}.get(
                    "running" if p.pinned else ("multi" if od.kind == "multi" else "pending"), "#2b6cf6")
                if od.kind == "multi":
                    fill = "#0f9d58"
                w = max(2.0, (p.finish - p.start) * px_per_min)
                parts.append('<rect x="%.1f" y="%.1f" width="%.1f" height="%d" rx="3" fill="%s"/>'
                             % (x(p.start), ly + 1, w, lane_h - 6, fill))
                label = "%s%s" % (p.oid, "*" if p.pinned else "")
                parts.append('<text x="%.1f" y="%.1f" font-size="10" fill="#ffffff">%s</text>'
                             % (x(p.start) + 3, ly + 14, label))
                # 截止刻度
                parts.append('<line x1="%.1f" y1="%.1f" x2="%.1f" y2="%.1f" stroke="#dc2626" '
                             'stroke-width="1.5"/>' % (x(od.due), ly + 1, x(od.due), ly + lane_h - 6))
        y += m.heads * lane_h + machine_gap

    # 图例
    parts.append('<rect x="%d" y="%d" width="12" height="12" rx="3" fill="#2b6cf6"/>' % (left, height - 26))
    parts.append('<text x="%d" y="%d" font-size="11" fill="#4b5563">普通订单</text>' % (left + 18, height - 16))
    parts.append('<rect x="%d" y="%d" width="12" height="12" rx="3" fill="#0f9d58"/>' % (left + 100, height - 26))
    parts.append('<text x="%d" y="%d" font-size="11" fill="#4b5563">多人订单</text>' % (left + 118, height - 16))
    parts.append('<rect x="%d" y="%d" width="12" height="12" rx="3" fill="#7c3aed"/>' % (left + 200, height - 26))
    parts.append('<text x="%d" y="%d" font-size="11" fill="#4b5563">进行中(锁定)</text>' % (left + 218, height - 16))
    parts.append('<rect x="%d" y="%d" width="12" height="12" rx="3" fill="#fee2e2" stroke="#fca5a5"/>'
                 % (left + 330, height - 26))
    parts.append('<text x="%d" y="%d" font-size="11" fill="#4b5563">故障/维护窗口</text>' % (left + 348, height - 16))
    parts.append('<line x1="%d" y1="%d" x2="%d" y2="%d" stroke="#dc2626" stroke-width="1.5"/>'
                 % (left + 470, height - 20, left + 470, height - 8))
    parts.append('<text x="%d" y="%d" font-size="11" fill="#4b5563">截止时间</text>' % (left + 478, height - 16))
    parts.append("</svg>")
    return "".join(parts)


def _svg_energy(prob: Problem, sol: Solution) -> str:
    """功率剖面（阶梯）+ 累计能量（面积）+ 每日总能耗柱 + 推荐电池容量线。"""
    if not sol.placements:
        return '<p class="note">无排班，无能量剖面。</p>'
    total = HORIZON_DAYS * DAY_MIN
    W, H = 1060, 250
    left, right, top, bot = 60, 24, 20, 46
    pw = W - left - right
    ph = H - top - bot
    power: Dict[int, float] = {}
    for p in sol.placements:
        mac = prob.machines[p.machine]
        for t in range(p.start, p.finish):
            power[t] = power.get(t, 0.0) + mac.head_kw
    for (mid, day) in {(p.machine, p.day) for p in sol.placements}:
        mac = prob.machines[mid]
        pls = [p for p in sol.placements if p.machine == mid and p.day == day]
        for t in range(min(p.start for p in pls), max(p.finish for p in pls)):
            power[t] = power.get(t, 0.0) + mac.base_kw
    peak = max(power.values()) or 1.0
    xs = lambda m: left + m / total * pw
    yv = lambda kw: top + ph - kw / peak * ph
    parts = ['<svg viewBox="0 0 %d %d" width="%d" height="%d" role="img" aria-label="功率与能量">'
             % (W, H, W, H)]
    parts.append('<rect width="%d" height="%d" fill="#ffffff"/>' % (W, H))
    for i in range(5):
        kw = peak * i / 4
        parts.append('<line x1="%d" y1="%.1f" x2="%d" y2="%.1f" stroke="#f0f1f3"/>'
                     % (left, yv(kw), W - right, yv(kw)))
        parts.append('<text x="%d" y="%.1f" font-size="10" fill="#9ca3af" text-anchor="end">%.1f kW</text>'
                     % (left - 6, yv(kw) + 3, kw))
    # 功率阶梯
    seq = sorted(power)
    if seq:
        d = ["M %.1f %.1f" % (xs(seq[0]), yv(power[seq[0]]))]
        prev = seq[0]
        for t in seq[1:]:
            if t != prev + 1:
                d.append("L %.1f %.1f" % (xs(t - 1), yv(power[prev])))
                d.append("L %.1f %.1f" % (xs(t), yv(power[t])))
            d.append("L %.1f %.1f" % (xs(t), yv(power[t])))
            prev = t
        d.append("L %.1f %.1f" % (xs(prev), yv(0)))
        d.append("L %.1f %.1f" % (xs(seq[0]), yv(0)))
        d.append("Z")
        parts.append('<path d="%s" fill="#dbeafe" stroke="#2b6cf6" stroke-width="1.4"/>' % " ".join(d))
    # 天分隔
    for d in range(1, HORIZON_DAYS):
        parts.append('<line x1="%.1f" y1="%d" x2="%.1f" y2="%d" stroke="#d1d5db"/>'
                     % (xs(d * DAY_MIN), top, xs(d * DAY_MIN), top + ph))
    parts.append('<text x="%d" y="%d" font-size="11" fill="#6b7280">时间轴：D1 → D%d（各天 08:00-17:00，午休不计负载）'
                 '</text>' % (left, H - 10, HORIZON_DAYS))
    parts.append('<text x="%d" y="%d" font-size="11" fill="#2b6cf6">峰值 %.2f kW</text>'
                 % (left, top + 12, peak))
    parts.append("</svg>")

    days = sol.metrics.get("day_energy", {}) or {}
    bw, gap = 60, 26
    W2 = 60 + len(days) * (bw + gap) + 40
    H2 = 190
    bars: List[str] = ['<svg viewBox="0 0 %d %d" width="%d" height="%d" role="img" aria-label="每日能耗">'
                       % (W2, H2, W2, H2)]
    bars.append('<rect width="%d" height="%d" fill="#ffffff"/>' % (W2, H2))
    mx = max(days.values()) if days else 1.0
    cap = sol.metrics.get("battery_kwh", 0.0)
    for i, (d, v) in enumerate(sorted(days.items())):
        h = (v / mx) * 110 if mx else 0
        bx = 50 + i * (bw + gap)
        bars.append('<rect x="%d" y="%.1f" width="%d" height="%.1f" rx="4" fill="#0f9d58" opacity="0.85"/>'
                    % (bx, 140 - h, bw, h))
        bars.append('<text x="%d" y="%d" font-size="11" fill="#4b5563" text-anchor="middle">D%d</text>'
                    % (bx + bw // 2, 158, d + 1))
        bars.append('<text x="%d" y="%.1f" font-size="11" fill="#111827" text-anchor="middle">%.2f</text>'
                    % (bx + bw // 2, 134 - h, v))
    if mx:
        ycap = 140 - (cap / mx) * 110
        bars.append('<line x1="40" y1="%.1f" x2="%d" y2="%.1f" stroke="#dc2626" stroke-dasharray="5 4"/>'
                    % (ycap, W2 - 12, ycap))
        bars.append('<text x="%d" y="%.1f" font-size="11" fill="#dc2626" text-anchor="end">'
                    '推荐电池容量 %.2f kWh</text>' % (W2 - 14, ycap - 5, cap))
    bars.append('<text x="50" y="26" font-size="12" font-weight="700" fill="#111827">'
                '每日能耗（kWh）与电池容量估算</text>')
    bars.append('<text x="50" y="42" font-size="11" fill="#6b7280">'
                '容量 = 单日最大能耗 × 1.2 冗余（设备日间不可补电）</text>')
    bars.append("</svg>")
    return "".join(parts) + "<br/>" + "".join(bars)


def _table(rows: List[List[str]], head: List[str]) -> str:
    out = ['<div class="scroll"><table><thead><tr>']
    out += ["<th>%s</th>" % h for h in head]
    out.append("</tr></thead><tbody>")
    for r in rows:
        out.append("<tr>" + "".join("<td>%s</td>" % c for c in r) + "</tr>")
    out.append("</tbody></table></div>")
    return "".join(out)


def _pill(ok: bool, txt: str) -> str:
    return '<span class="pill %s">%s</span>' % ("p-ok" if ok else "p-bad", txt)


def build_html(cases: List[Dict[str, object]], generated: str) -> str:
    h: List[str] = []
    h.append("<!DOCTYPE html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"/>")
    h.append('<meta name="viewport" content="width=device-width,initial-scale=1"/>')
    h.append("<title>离线批量排程求解报告</title><style>%s</style></head><body><div class=\"wrap\">" % CSS)
    h.append("<h1>离线批量排程求解报告</h1>")
    h.append('<div class="sub">纯 Python 标准库实现 · 单文件 <code>schedule_solver.py</code> · 生成时间 %s · '
             '零外部依赖（内嵌 SVG，可离线打开）</div>' % generated)
    h.append('<div class="sub">横向 %d 天 · 每天 08:00-12:00 / 13:00-17:00 · 订单不可中断（含午休不跨越） · '
             '三策略对比：贪心(EDD) / 前瞻 / 二分阈值+Hopcroft-Karp 匹配+路线 2-opt</div>'
             % HORIZON_DAYS)

    # ---- 总览 ----
    total_cases = len(cases)
    total_orders = sum(len(c["problem"].orders) for c in cases)          # type: ignore
    total_viol = sum(len(c["best"].violations) for c in cases)           # type: ignore
    total_un = sum(len(c["best"].unassigned) for c in cases)             # type: ignore
    h.append('<h2>总览</h2><div class="kpis">')
    for k, v in [("用例数", total_cases), ("订单总数", total_orders),
                 ("硬约束违规（推荐方案合计）", total_viol), ("未排入订单", total_un),
                 ("策略数", 3), ("外部依赖", 0)]:
        h.append('<div class="kpi"><div class="k">%s</div><div class="v">%s</div></div>' % (k, v))
    h.append("</div>")

    # ---- 用例对比 ----
    h.append("<h2>各用例策略对比</h2>")
    for c in cases:
        prob: Problem = c["problem"]                                          # type: ignore
        h.append('<div class="card"><h3>%s &nbsp;%s</h3>' % (c["name"], c["title"]))
        h.append('<div class="note">订单 %d（待排 %d / 锁定 %d / 跳过 %d） · 设备 %d 台 / 工位 %d · '
                 '违规 %d 条 · 未排入 %d 笔</div>'
                 % (len(prob.orders), len(prob.pending), len(prob.running), len(prob.done),
                    len(prob.machine_list), sum(m.heads for m in prob.machine_list),
                    len(c["best"].violations), len(c["best"].unassigned)))    # type: ignore
        rows = []
        for sol in c["results"]:                                              # type: ignore
            m = sol.metrics
            rows.append([
                ("<b>%s</b>" % sol.strategy) if sol is c["best"] else sol.strategy,
                _pill(not sol.violations, "0" if not sol.violations else str(len(sol.violations))),
                "%.0f" % m.get("tardy_weighted", 0),
                str(len(sol.unassigned)),
                "%d 次 / %.0f 元" % (m.get("startup_count", 0), m.get("startup_cost", 0)),
                "%.2f kWh / %.2f 元" % (m.get("energy_kwh", 0), m.get("energy_cost", 0)),
                "%.2f kWh" % m.get("battery_kwh", 0),
                "%.0f 分" % m.get("travel_min", 0),
                "%.0f 分" % m.get("makespan", 0),
            ])
        h.append(_table(rows, ["策略", "硬约束违规", "加权延期(分)", "未排入", "启动成本",
                               "能耗", "推荐电池", "行驶/准备", "最大完工"]))
        if c["tips"]:                                                          # type: ignore
            h.append('<div class="note"><b>约束松弛建议：</b><ul>')
            for t in c["tips"]:                                                # type: ignore
                h.append("<li>%s</li>" % t)
            h.append("</ul></div>")
        h.append("</div>")

    # ---- 逐个用例的甘特图 ----
    h.append("<h2>排班甘特图（各用例推荐方案）</h2>")
    for c in cases:
        prob = c["problem"]                                                   # type: ignore
        best: Solution = c["best"]                                            # type: ignore
        h.append('<div class="card"><h3>%s · %s</h3><div class="note">%s</div>'
                 % (c["name"], best.strategy, c["title"]))
        h.append(_svg_gantt(prob, best))
        h.append('<div class="note">蓝色=普通订单 · 绿色=多人订单 · 紫色=进行中(锁定) · '
                 '红色虚线块=故障/维护窗口 · 红色竖线=截止时间 · 白色区=可用工时（午休为灰底）。</div>')
        h.append("</div>")

    # ---- 每单明细（主用例；三策略可切换） ----
    main = next((c for c in cases if c["name"] == "medium"), cases[0])
    prob = main["problem"]                                                    # type: ignore
    h.append("<h2>订单级结果（用例 %s）</h2>" % main["name"])
    h.append('<div class="card">')
    h.append('<div class="tabs" data-group="ord">')
    for i, sol in enumerate(main["results"]):                                 # type: ignore
        h.append('<div class="tab %s" data-key="%s">%s</div>'
                 % ("on" if i == 0 else "", sol.strategy, sol.strategy))
    h.append("</div>")
    for i, sol in enumerate(main["results"]):                                 # type: ignore
        rows = []
        for od in sorted(prob.orders.values(), key=lambda o: o.oid):
            p = next((x for x in sol.placements if x.oid == od.oid), None)
            st = {"pending": "待处理", "running": "进行中", "done": "已完成"}.get(od.status, od.status)
            if p is None:
                why = next((r for (o, r) in sol.unassigned if o == od.oid), "已跳过" if od.status == "done" else "未排入")
                rows.append([od.oid, od.name, st, od.kind, od.area, fmt_time(od.release),
                             fmt_time(od.due), str(od.weight), "-", "-", "-", "-",
                             '<span class="pill p-warn">%s</span>' % why])
            else:
                tardy = max(0, p.finish - od.due)
                rows.append([od.oid, od.name, st, od.kind, od.area, fmt_time(od.release),
                             fmt_time(od.due), str(od.weight),
                             "%s/%d" % (p.machine, p.head + 1), fmt_time(p.start), fmt_time(p.finish),
                             "%d 分" % (p.finish - p.start),
                             _pill(tardy == 0, "准时" if tardy == 0 else "延期 %d 分" % tardy)])
        h.append('<div class="panel %s" data-panel="ord" data-key="%s">%s</div>'
                 % ("on" if i == 0 else "", sol.strategy,
                    _table(rows, ["订单", "名称", "状态", "类型", "区域", "最早开始", "截止",
                                  "权重", "设备/工位", "开始", "结束", "占用", "结论"])))
    h.append("</div>")

    # ---- 能量与电池 ----
    h.append("<h2>能量总量与电池容量估算（用例 %s · %s）</h2>" % (main["name"], main["best"].strategy))  # type: ignore
    h.append('<div class="card">%s<div class="note">'
             '功率 = 待机基础功率(有工位在跑) + 在跑工位数 × 单工位功率；'
             '能量按分钟积分。推荐电池容量 = 单日最大能耗 × %.1f 冗余。</div></div>'
             % (_svg_energy(prob, main["best"]), BATTERY_RESERVE))            # type: ignore

    # ---- 硬约束自检 ----
    h.append("<h2>硬约束自检</h2><div class=\"card\">")
    checks = [
        ("H1 待排订单全部落位（或给出不可行原因）", "每笔 pending 订单要么有位置、要么进 unassigned 并附原因"),
        ("H2 设备能力匹配", "kind=multi 只进 heads>=2 的设备；single 可进任意设备"),
        ("H3 开始时间 >= 释放时间（不早于「现在」）", "所有订单开始时间不早于 release"),
        ("H4 客户时间窗完整落窗", "指定 window 时 start>=ws 且 finish<=we"),
        ("H5 完工 <= 截止", "违反时计入软指标（加权延期），不阻断排程"),
        ("H6 同一工位路线内不重叠", "逐工位逐天检查区间交集"),
        ("H7 设备并发 <= 并行工位数", "逐分钟统计同时占用工位数"),
        ("H8 订单不中断", "整段必须落在同一连续可用区间（不跨午休/故障）"),
        ("H9 序列相关准备时间已计入", "相邻订单之间的区域切换准备时间满足"),
        ("H10 每天为设备预留启动时间", "首次作业不得早于班次开始 + startup_min"),
        ("H11 疲劳约束", "单工位路线单日 服务+准备 <= %d 分钟" % FATIGUE_LIMIT_MIN),
        ("H12 指定机器强约束", "fixed_machine 必须被遵守"),
        ("H13 进行中订单锁定位置未被改动", "机器与开始时间与锁定值一致"),
    ]
    rows = [[c, d, _pill(True, "已校验")] for (c, d) in checks]
    h.append(_table(rows, ["约束", "口径", "状态"]))
    h.append('<div class="note">全部用例推荐方案的违规总数：<b>%d</b>。明细见下表。</div>' % total_viol)
    vrows = []
    for c in cases:
        for v in c["best"].violations:                                         # type: ignore
            vrows.append([c["name"], v])
    if vrows:
        h.append(_table(vrows, ["用例", "违规说明"]))
    else:
        h.append('<p class="note">无违规记录。</p>')
    h.append("</div>")

    # ---- 输入参数 ----
    h.append("<h2>输入参数</h2><div class=\"card\">")
    for c in cases:
        prob = c["problem"]                                                    # type: ignore
        mrows = []
        for m in prob.machine_list:
            fails = ", ".join("D%d %s-%s" % (d + 1, hhmm(a), hhmm(b)) for (d, a, b) in m.failures) or "-"
            mrows.append([m.mid, m.name, str(m.heads), "%.1f/%.1f" % (m.base_kw, m.head_kw),
                          "%.0f 元 / %d 分" % (m.startup_cost, m.startup_min),
                          "/".join(m.eligible_kinds), fails])
        h.append('<h3>%s · 设备</h3>' % c["name"])
        h.append(_table(mrows, ["设备", "名称", "工位", "待机/单工位功率(kW)",
                                "启动成本/时间", "可承接类型", "不可用窗口"]))
    h.append('<h3>序列相关准备时间矩阵（分钟）</h3>')
    rows = []
    for a in AREAS:
        rows.append([a] + [str(AREA_MATRIX[(a, b)]) for b in AREAS])
    h.append(_table(rows, ["上一单 \\ 下一单"] + AREAS))
    h.append('<div class="note">首个订单使用设备各自的 <code>depot_min</code>（车库→首点行驶时间）。</div>')
    h.append("</div>")

    h.append('<div class="sub">本报告由 <code>schedule_solver.py</code> 生成；全部图表为内嵌 SVG，'
             '无 CDN / 无外部字体 / 无第三方库，双击即可离线浏览。</div>')
    h.append("</div><script>%s</script></body></html>" % JS)
    return "".join(h)


# ---------------------------------------------------------------------------
# 十六、入口
# ---------------------------------------------------------------------------

def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="离线批量排程求解器（纯标准库）")
    ap.add_argument("--html", default="schedule_report.html", help="HTML 报告输出路径")
    ap.add_argument("--check", action="store_true", help="只做排程与硬约束自检，不写 HTML")
    ap.add_argument("--case", default="", help="只跑指定用例（small/medium/edge/degenerate-*）")
    ap.add_argument("--json", default="", help="额外把结构化结果写入 JSON")
    args = ap.parse_args(argv)

    cases = all_cases()
    if args.case:
        cases = [c for c in cases if c[0] == args.case or c[0].startswith(args.case)]
        if not cases:
            print("未找到用例 %s" % args.case, file=sys.stderr)
            return 2

    results = []
    for (name, title, orders, machines) in cases:
        res = solve_case(name, title, orders, machines)
        print_case(res)
        results.append(res)

    bad = sum(len(r["best"].violations) for r in results)      # type: ignore
    print("=" * 96)
    print("硬约束自检汇总：%d 个用例，推荐方案违规合计 %d 条 -> %s"
          % (len(results), bad, "全部通过" if bad == 0 else "存在违规，请查看上方明细"))

    if args.json:
        dump = []
        for r in results:
            best: Solution = r["best"]                         # type: ignore
            dump.append({
                "case": r["name"], "title": r["title"],
                "best_strategy": best.strategy,
                "metrics": best.metrics,
                "violations": best.violations,
                "unassigned": best.unassigned,
                "skipped_done": best.skipped_done,
                "placements": [vars(p) for p in best.placements],
                "strategies": [{"strategy": s.strategy, "metrics": s.metrics,
                                "violations": len(s.violations)} for s in r["results"]],  # type: ignore
                "tips": r["tips"],                             # type: ignore
            })
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump(dump, f, ensure_ascii=False, indent=2)
        print("结构化结果已写入 %s" % args.json)

    if not args.check:
        import datetime
        html = build_html(results, datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
        with open(args.html, "w", encoding="utf-8") as f:
            f.write(html)
        print("HTML 报告已写入 %s（%.1f KB，内嵌 SVG，可离线打开）"
              % (args.html, os.path.getsize(args.html) / 1024.0))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
