import openpyxl, io

path = r"C:\Users\PC\Desktop\示例班级A点名册.xlsx"
wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
ws = wb.worksheets[0]
rows = list(ws.iter_rows(values_only=True))
header = [("" if c is None else str(c).strip()) for c in rows[0]]

def find(cands):
    for c in cands:
        for j, h in enumerate(header):
            if h and c in h:
                return j
    return None
name_col = find(["姓名", "名称", "名字", "学生"])
no_col = find(["学号", "学籍", "编号", "考号"])

data = []
for r in rows[1:]:
    if all(c is None for c in r):
        continue
    name = str(r[name_col]).strip() if r[name_col] is not None else ""
    no = str(r[no_col]).strip() if r[no_col] is not None else ""
    if no.endswith(".0"):
        no = no[:-2]
    if not name or not no:
        continue
    last = int(no[-1])
    group = "B" if last % 2 == 0 else "A"
    data.append((name, no, group))

assert len(data) == 56, f"expected 56 got {len(data)}"
# duplicates / blanks check
nos = [d[1] for d in data]
assert len(set(nos)) == 56, "duplicate student_no"

def esc(s):
    return s.replace("'", "''")

lines = []
for name, no, group in data:
    lines.append(f"('{esc(name)}','{no}','{group}','MEMBER','ACTIVE',0)")
values = ",\n".join(lines)

sql = (
    "-- 清空演示数据（无 FK，先删子表再删主表）\n"
    "DELETE FROM duty_log;\n"
    "DELETE FROM duty;\n"
    "DELETE FROM schedule_publish;\n"
    "DELETE FROM member;\n\n"
    "-- 插入 56 名真实成员（学号尾号奇偶自动分 A/B 组）\n"
    "INSERT INTO member (name, student_no, group_tag, role, status, duty_count) VALUES\n"
    f"{values};\n"
)

with io.open("scripts/import_members.sql", "w", encoding="utf-8") as f:
    f.write(sql)

print("rows:", len(data))
print("A:", sum(1 for d in data if d[2] == "A"), "B:", sum(1 for d in data if d[2] == "B"))
print("wrote scripts/import_members.sql")
