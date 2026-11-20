#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Markdown 转 Word (.docx) 转换器（Knetsec_Ai 报告交付用）。

支持：标题 H1-H4、段落、无序/有序列表、表格、代码块、引用块、分隔线，
以及行内加粗、行内代码、链接语法。

设计目标不是通用 Markdown 渲染，而是把项目内报告（中文、含表格与代码块）
转成排版清晰、可直接打印或转 PDF 的 Word 文档：
- A4 页面、微软雅黑正文、Consolas 代码；
- 标题层级自带大纲级别，便于生成目录；
- 表格首行加粗加浅灰底，代码块浅灰底并缩进。
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

from docx import Document
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

BODY_FONT = "Microsoft YaHei"
CODE_FONT = "Consolas"
ACCENT = RGBColor(0x1F, 0x4E, 0x79)
GRAY = RGBColor(0x59, 0x59, 0x59)
BT = chr(96)
FENCE = BT * 3


def set_cell_shading(cell, fill):
    """给表格单元格设置底色（OOXML shd）。"""
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    tc_pr.append(shd)


def set_paragraph_shading(paragraph, fill):
    """给段落设置底色（代码块效果）。"""
    p_pr = paragraph._p.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), fill)
    p_pr.append(shd)


def set_east_asian_font(run, font_name):
    """中文必须显式设置 w:eastAsia，否则 Word 可能回退到其他字体。"""
    run.font.name = font_name
    r_pr = run._element.get_or_add_rPr()
    r_fonts = r_pr.find(qn("w:rFonts"))
    if r_fonts is None:
        r_fonts = OxmlElement("w:rFonts")
        r_pr.append(r_fonts)
    r_fonts.set(qn("w:eastAsia"), font_name)
    r_fonts.set(qn("w:ascii"), font_name)
    r_fonts.set(qn("w:hAnsi"), font_name)


def add_page_number_footer(section, label):
    """页脚：文档名 + PAGE 域（打印时自动更新页码）。"""
    footer = section.footer
    paragraph = footer.paragraphs[0]
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER
    run = paragraph.add_run(label + "  ·  第 ")
    run.font.size = Pt(8)
    run.font.color.rgb = GRAY
    set_east_asian_font(run, BODY_FONT)

    fld_begin = OxmlElement("w:fldChar")
    fld_begin.set(qn("w:fldCharType"), "begin")
    instr = OxmlElement("w:instrText")
    instr.set(qn("xml:space"), "preserve")
    instr.text = "PAGE"
    fld_end = OxmlElement("w:fldChar")
    fld_end.set(qn("w:fldCharType"), "end")
    run2 = paragraph.add_run()
    run2._r.append(fld_begin)
    run2._r.append(instr)
    run2._r.append(fld_end)
    run2.font.size = Pt(8)
    run2.font.color.rgb = GRAY

    run3 = paragraph.add_run(" 页")
    run3.font.size = Pt(8)
    run3.font.color.rgb = GRAY
    set_east_asian_font(run3, BODY_FONT)


def setup_styles(document):
    """正文与标题样式统一设置字体、字号、行距。"""
    normal = document.styles["Normal"]
    normal.font.name = BODY_FONT
    normal.font.size = Pt(10.5)
    normal.element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
    normal.paragraph_format.line_spacing = 1.5
    normal.paragraph_format.space_after = Pt(4)

    sizes = {"Heading 1": 18, "Heading 2": 15, "Heading 3": 13, "Heading 4": 11.5}
    for style_name, size in sizes.items():
        style = document.styles[style_name]
        style.font.name = BODY_FONT
        style.font.size = Pt(size)
        style.font.bold = True
        style.font.color.rgb = ACCENT
        style.element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT)
        style.paragraph_format.space_before = Pt(14 if style_name == "Heading 1" else 10)
        style.paragraph_format.space_after = Pt(6)


INLINE_PATTERN = re.compile(
    r"(\*\*[^*]+\*\*|" + BT + r"[^" + BT + r"]+" + BT + r"|\[[^\]]+\]\([^)]+\))"
)


def add_inline_runs(paragraph, text, base_size=None):
    """解析行内加粗、行内代码、链接，生成对应 run。"""
    for part in INLINE_PATTERN.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**") and len(part) > 4:
            run = paragraph.add_run(part[2:-2])
            run.bold = True
        elif part.startswith(BT) and part.endswith(BT) and len(part) > 2:
            run = paragraph.add_run(part[1:-1])
            run.font.name = CODE_FONT
            run.font.size = Pt((base_size or 10.5) - 1)
            run.font.color.rgb = RGBColor(0xB0, 0x30, 0x60)
        elif part.startswith("[") and "](" in part and part.endswith(")"):
            label, url = part[1:-1].split("](", 1)
            run = paragraph.add_run(label)
            run.font.color.rgb = RGBColor(0x1F, 0x4E, 0x79)
            run.underline = True
            run2 = paragraph.add_run("（" + url + "）")
            run2.font.size = Pt(8)
            run2.font.color.rgb = GRAY
        else:
            run = paragraph.add_run(part)
        if base_size:
            run.font.size = Pt(base_size)


def add_table(document, rows):
    """按 Markdown 表格生成 Word 表格：首行为表头、灰底加粗。"""
    if not rows:
        return
    columns = max(len(row) for row in rows)
    table = document.add_table(rows=len(rows), cols=columns)
    table.style = "Table Grid"
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = True
    for r_index, row in enumerate(rows):
        for c_index in range(columns):
            cell = table.cell(r_index, c_index)
            cell.text = ""
            value = row[c_index] if c_index < len(row) else ""
            paragraph = cell.paragraphs[0]
            paragraph.paragraph_format.space_after = Pt(1)
            paragraph.paragraph_format.line_spacing = 1.15
            add_inline_runs(paragraph, value.strip(), base_size=9)
            if r_index == 0:
                set_cell_shading(cell, "DCE6F1")
                for run in paragraph.runs:
                    run.bold = True
                    run.font.size = Pt(9)
    document.add_paragraph()


def parse_table(lines, start):
    """从 start 起解析连续表格行，返回（行内容, 下一行下标）。"""
    rows = []
    i = start
    while i < len(lines) and lines[i].strip().startswith("|"):
        raw = lines[i].strip().strip("|")
        cells = [c.strip() for c in raw.split("|")]
        if not all(re.fullmatch(r":?-{2,}:?", c.replace(" ", "")) for c in cells if c):
            rows.append(cells)
        i += 1
    return rows, i


def add_code_block(document, code_lines):
    """代码块：等宽字体 + 浅灰底 + 缩进。"""
    paragraph = document.add_paragraph()
    paragraph.paragraph_format.left_indent = Cm(0.4)
    paragraph.paragraph_format.line_spacing = 1.0
    paragraph.paragraph_format.space_before = Pt(4)
    paragraph.paragraph_format.space_after = Pt(8)
    set_paragraph_shading(paragraph, "F2F2F2")
    text = "\n".join(code_lines) if code_lines else " "
    run = paragraph.add_run(text)
    run.font.name = CODE_FONT
    run.font.size = Pt(8.5)
    set_east_asian_font(run, CODE_FONT)


def convert(md_path, docx_path, title):
    """主转换流程。"""
    lines = md_path.read_text(encoding="utf-8").splitlines()
    document = Document()
    setup_styles(document)

    section = document.sections[0]
    section.page_height = Cm(29.7)
    section.page_width = Cm(21.0)
    section.top_margin = Cm(2.2)
    section.bottom_margin = Cm(2.0)
    section.left_margin = Cm(2.2)
    section.right_margin = Cm(2.2)
    add_page_number_footer(section, title)

    document.core_properties.title = title
    document.core_properties.author = "Knetsec_Ai 项目组"
    document.core_properties.subject = "AI 安全 x 网络安全实时情报平台"

    in_code = False
    code_buffer = []
    i = 0

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith(FENCE):
            if in_code:
                add_code_block(document, code_buffer)
                code_buffer = []
                in_code = False
            else:
                in_code = True
            i += 1
            continue
        if in_code:
            code_buffer.append(line)
            i += 1
            continue

        if not stripped:
            i += 1
            continue

        if re.fullmatch(r"-{3,}", stripped):
            paragraph = document.add_paragraph()
            paragraph.paragraph_format.space_before = Pt(6)
            paragraph.paragraph_format.space_after = Pt(6)
            p_pr = paragraph._p.get_or_add_pPr()
            p_bdr = OxmlElement("w:pBdr")
            bottom = OxmlElement("w:bottom")
            bottom.set(qn("w:val"), "single")
            bottom.set(qn("w:sz"), "6")
            bottom.set(qn("w:space"), "1")
            bottom.set(qn("w:color"), "BFBFBF")
            p_bdr.append(bottom)
            p_pr.append(p_bdr)
            i += 1
            continue

        heading_match = re.match(r"^(#{1,4})\s+(.*)$", stripped)
        if heading_match:
            level = len(heading_match.group(1))
            text = heading_match.group(2).strip()
            if level == 1:
                document.add_paragraph(text, style="Heading 1")
            elif level == 2:
                document.add_paragraph(text, style="Heading 2")
            elif level == 3:
                document.add_paragraph(text, style="Heading 3")
            else:
                document.add_paragraph(text, style="Heading 4")
            i += 1
            continue

        if stripped.startswith("|"):
            rows, i = parse_table(lines, i)
            add_table(document, rows)
            continue

        if stripped.startswith(">"):
            quote_lines = []
            while i < len(lines) and lines[i].strip().startswith(">"):
                quote_lines.append(lines[i].strip().lstrip(">").strip())
                i += 1
            paragraph = document.add_paragraph()
            paragraph.paragraph_format.left_indent = Cm(0.6)
            paragraph.paragraph_format.space_after = Pt(6)
            add_inline_runs(paragraph, " ".join(quote_lines), base_size=9.5)
            for run in paragraph.runs:
                run.font.color.rgb = GRAY
                run.italic = True
            continue

        bullet_match = re.match(r"^[-*+]\s+(.*)$", stripped)
        if bullet_match:
            paragraph = document.add_paragraph(style="List Bullet")
            add_inline_runs(paragraph, bullet_match.group(1))
            i += 1
            continue

        number_match = re.match(r"^\d+[.)]\s+(.*)$", stripped)
        if number_match:
            paragraph = document.add_paragraph(style="List Number")
            add_inline_runs(paragraph, number_match.group(1))
            i += 1
            continue

        paragraph = document.add_paragraph()
        paragraph.paragraph_format.first_line_indent = Cm(0)
        add_inline_runs(paragraph, stripped)
        i += 1

    if in_code and code_buffer:
        add_code_block(document, code_buffer)

    docx_path.parent.mkdir(parents=True, exist_ok=True)
    document.save(docx_path)
    print("OK  " + md_path.name + " -> " + str(docx_path) + " (" + str(docx_path.stat().st_size) + " bytes)")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("用法: python md2docx.py <input.md> <output.docx> [标题]")
        raise SystemExit(2)
    source = Path(sys.argv[1])
    target = Path(sys.argv[2])
    doc_title = sys.argv[3] if len(sys.argv) > 3 else source.stem
    convert(source, target, doc_title)
