"""生成 scripts/fixtures/roster-mini.xlsx —— check-xlsx-lite.js 用的最小样本。
只用标准库 zipfile 手写最小 OOXML，不依赖 openpyxl。
样本覆盖：共享字符串（t="s"）、内联字符串（t="inlineStr"）、表头行、5 列结构。
"""
import os
import zipfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "roster-mini.xlsx")

ROWS = [
    ["专业班级", "学号", "姓名", "性别", "指导员"],
    ["示例专业B1班", "000000000101", "示例成员60", "女性", "示例成员57"],
    ["示例专业A2班", "000000000201", "示例成员58", "女性", "示例成员57"],
    ["示例专业B2班", "209903030101", None, "女性", "示例成员57"],   # 姓名走 inlineStr
    ["商务示例专业B2班", "209903020101", "示例成员61", "女性", "示例成员57"],
]
INLINE_CELL = (3, 2, "内联姓名")   # (row_index, col_index, text)

# ---- 收集共享字符串 ----
shared = []
index = {}


def sid(text):
    if text not in index:
        index[text] = len(shared)
        shared.append(text)
    return index[text]


def esc(s):
    return (str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;"))


def col_letter(i):
    """0 → A"""
    s = ""
    i += 1
    while i:
        i, r = divmod(i - 1, 26)
        s = chr(65 + r) + s
    return s


sheet_rows = []
for ri, row in enumerate(ROWS):
    cells = []
    for ci, val in enumerate(row):
        ref = "%s%d" % (col_letter(ci), ri + 1)
        if INLINE_CELL[0] == ri and INLINE_CELL[1] == ci:
            cells.append('<c r="%s" t="inlineStr"><is><t>%s</t></is></c>' % (ref, esc(INLINE_CELL[2])))
        elif val is None:
            continue
        else:
            cells.append('<c r="%s" t="s"><v>%d</v></c>' % (ref, sid(val)))
    sheet_rows.append('<row r="%d">%s</row>' % (ri + 1, "".join(cells)))

CONTENT_TYPES = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>"""

RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""

WORKBOOK = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"""

WB_RELS = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>"""


def build_shared():
    items = "".join("<si><t>%s</t></si>" % esc(s) for s in shared)
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="%d" uniqueCount="%d">%s</sst>'
            % (len(shared), len(shared), items))


def build_sheet():
    return ('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<sheetData>%s</sheetData></worksheet>' % "".join(sheet_rows))


with zipfile.ZipFile(OUT, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", CONTENT_TYPES)
    z.writestr("_rels/.rels", RELS)
    z.writestr("xl/workbook.xml", WORKBOOK)
    z.writestr("xl/_rels/workbook.xml.rels", WB_RELS)
    z.writestr("xl/sharedStrings.xml", build_shared())
    z.writestr("xl/worksheets/sheet1.xml", build_sheet())

print("written", OUT, os.path.getsize(OUT), "bytes")
