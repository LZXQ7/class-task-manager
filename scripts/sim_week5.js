//  faithful simulation of schedule.generate 的轮转逻辑（仅用于验证修复方案）
//  用真实的 class-3 名册 + 真实的 week-5 课表 + 目标 duty_count，复刻 generate 的取人顺序。
//  不写库，只打印预测结果，供核对「是否从 A-21/B-18 接续」。
const fs = require('fs');

// ── 名册：id -> {seq, group}（来自生产库查询） ──
const ROSTER = {
  14:[2,'B'],15:[3,'A'],16:[4,'B'],17:[5,'A'],18:[6,'B'],19:[7,'A'],20:[8,'B'],
  21:[9,'A'],22:[10,'B'],23:[11,'A'],24:[12,'B'],25:[13,'A'],26:[14,'B'],27:[15,'A'],28:[16,'B'],
  29:[17,'A'],30:[18,'B'],31:[19,'A'],32:[20,'B'],33:[21,'A'],34:[22,'B'],35:[23,'A'],36:[24,'B'],
  37:[25,'A'],38:[26,'B'],39:[27,'A'],40:[28,'B'],41:[29,'A'],42:[30,'B'],43:[31,'A'],44:[32,'B'],
  45:[33,'A'],46:[34,'B'],47:[35,'A'],48:[36,'B'],49:[37,'A'],50:[38,'B'],51:[39,'A'],52:[40,'B'],
  53:[41,'A'],54:[42,'B'],55:[43,'A'],56:[44,'B'],57:[45,'A'],58:[46,'B'],59:[47,'A'],60:[48,'B'],
  61:[49,'A'],62:[50,'B'],63:[51,'A'],64:[52,'B'],65:[53,'A'],66:[54,'B'],67:[55,'A'],68:[56,'B']
};
// 示例成员01 id13 seq01 A 经 duty_off=1 排除，不在池中（已确认）。

// ── 目标 duty_count（修复方案）：A 03-19=2, A 21-55=1; B 02-16=2, B 18-56=1 ──
function target(mid){
  const [seq, g] = ROSTER[mid];
  if (g === 'A') return (seq >= 3 && seq <= 19) ? 2 : 1;
  return (seq >= 2 && seq <= 16) ? 2 : 1;
}

// ── 轮转内核（与 schedule-core.js 完全一致） ──
function rotationPick(roster, scope, n, blocks, avoidSameDay, inBatch, exclude, inWeek) {
  const ex = exclude || new Set();
  const week = inWeek || new Set();
  const ok = m => !ex.has(m.id) && (!scope || m.group === scope) && !blocks.onLeave.has(m.id)
    && (!avoidSameDay || (!blocks.busy.has(m.id) && !inBatch.has(m.id)));
  const byRound = (a, b) => (a.mark - b.mark) || (a.seq - b.seq);
  const pool = roster.filter(ok).sort(byRound);
  const fresh = pool.filter(m => m.mark === 0);
  const used = pool.filter(m => m.mark > 0);
  const tiers = [fresh.filter(m=>!week.has(m.id)), used.filter(m=>!week.has(m.id)),
                 fresh.filter(m=>week.has(m.id)), used.filter(m=>week.has(m.id))];
  const chosen = []; const taken = new Set();
  for (let i=0;i<tiers.length && chosen.length<n;i++)
    for (const m of tiers[i]){ if(chosen.length>=n)break; if(taken.has(m.id))continue; taken.add(m.id); chosen.push(m); }
  chosen.forEach(m => { m.mark += 1; });
  return { chosen };
}
function repairRoundMarks(roster){
  const getMark = r => r.mark||0;
  const rows = roster.slice().sort((a,b)=>(a.seq-b.seq)||(a.id-b.id));
  let len=0,bestLen=0,bestEnd=0;
  for(const r of rows){ if(getMark(r)>0){ len+=1; if(len>=bestLen){bestLen=len;bestEnd=r.seq;} } else len=0; }
  return { cursor: bestLen<2?0:bestEnd };
}

// ── week-5 课表（按 generate 的排序：日期, 节次, session_id） ──
// 日期：dow1=10-12,2=10-13,3=10-14,4=10-15,5=10-16
const SESSIONS = [
  ['2026-10-12',2,35,'A'], ['2026-10-12',3,39,null], ['2026-10-12',4,26,null], ['2026-10-12',4,62,'B'],
  ['2026-10-13',1,32,'A'], ['2026-10-13',2,38,'A'], ['2026-10-13',4,30,null], ['2026-10-13',5,45,'A'],
  ['2026-10-14',1,48,'B'], ['2026-10-14',2,51,'B'], ['2026-10-14',3,40,null], ['2026-10-14',4,29,null], ['2026-10-14',5,46,'A'],
  ['2026-10-15',1,33,'A'], ['2026-10-15',2,54,'B'], ['2026-10-15',3,41,null], ['2026-10-15',4,27,null], ['2026-10-15',5,63,'B'],
  ['2026-10-16',1,34,'A'], ['2026-10-16',1,49,'B'], ['2026-10-16',2,53,'B'], ['2026-10-16',3,42,null], ['2026-10-16',4,28,null]
];
const N = 2; // 每个课次需 2 人（session.duty_count 全为 2）
const AVOID_SAME_DAY = true;

// ── 构建名册（含目标 mark） ──
const roster = Object.keys(ROSTER).map(mid=>({id:+mid, seq:ROSTER[mid][0], group:ROSTER[mid][1], mark:target(+mid)}));
roster.sort((a,b)=>(a.seq-b.seq)||(a.id-b.id));
const rf = repairRoundMarks(roster);
const assignedWeek = new Set();
const assignedByDate = {};
const picks = [];
for (const [date, period, sid, scope] of SESSIONS){
  const inBatch = assignedByDate[date] || new Set();
  const blocks = { onLeave: new Set(), busy: new Set() };
  const r = rotationPick(roster, scope, N, blocks, AVOID_SAME_DAY, inBatch, new Set(), assignedWeek);
  for (const m of r.chosen){
    assignedWeek.add(m.id);
    (assignedByDate[date]=assignedByDate[date]||new Set()).add(m.id);
    picks.push({ date, sid, mid:m.id, seq:m.seq, group:m.group });
  }
}
// 输出
let out = 'repairRoundMarks.cursor=' + rf.cursor + '\n';
out += 'predicted week-5 plan (' + picks.length + ' rows):\n';
out += 'date       session  member  seq  group\n';
for(const p of picks) out += p.date+'  s'+p.sid+'  m'+p.mid+'  '+String(p.seq).padStart(2,'0')+'   '+p.group+'\n';
// 统计每个被选 member 的周累计 pick 数 → 最终 duty_count
const cnt = {};
for(const p of picks) cnt[p.mid]=(cnt[p.mid]||0)+1;
out += '\nfinal duty_count (target + week5 picks):\n';
const finalDc = {};
for(const mid of Object.keys(ROSTER)){ finalDc[mid]=(target(+mid))+(cnt[mid]||0); }
// 打印 A/B 分组的最终 duty_count 区间，便于核对
out += JSON.stringify(finalDc)+'\n';
fs.writeFileSync(__dirname+'/_sim_week5.txt', out, 'utf8');
console.log(out);
