# -*- coding: utf-8 -*-
import re, html

src = r"D:/PC/Downloads/教学安排表.files/sheet001.htm"
with open(src, "rb") as f:
    raw = f.read()
# try decode
for enc in ("gb2312", "gbk", "utf-8"):
    try:
        txt = raw.decode(enc)
        print("DECODED WITH:", enc, "len", len(txt))
        break
    except Exception as e:
        print("fail", enc, e)

# extract table rows -> cells text + spans
rows = re.findall(r"<tr.*?>(.*?)</tr>", txt, re.S | re.I)
print("NUM <tr>:", len(rows))
out = []
for ri, r in enumerate(rows):
    cells = re.findall(r"<td\b(.*?)</td>", r, re.S | re.I)
    cellinfo = []
    for c in cells:
        m = re.match(r"\s*[^>]*>", c)
        attrs = c[:c.find(">")] if ">" in c else ""
        cs = re.search(r"colspan\s*=\s*(\d+)", attrs, re.I)
        rs = re.search(r"rowspan\s*=\s*(\d+)", attrs, re.I)
        body = c[c.find(">")+1:] if ">" in c else c
        body = re.sub(r"<[^>]+>", "", body)
        body = html.unescape(body).strip()
        cellinfo.append((cs.group(1) if cs else "1", rs.group(1) if rs else "1", body))
    out.append(cellinfo)

for ri, cellinfo in enumerate(out):
    line = " | ".join("[cs%s rs%s] %s" % (cs, rs, b) for cs, rs, b in cellinfo)
    print("R%-2d:" % ri, line[:300])
