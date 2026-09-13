"""Build the Chinese manual PDF. Requires reportlab, Pillow, and Microsoft YaHei.

Run from any directory: python doc/build-manual-zh.py
Override CAD_MANUAL_FONT / CAD_MANUAL_BOLD_FONT for compatible Chinese TTF fonts.
"""
from pathlib import Path
import html
import os
import re

from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Image, Table, TableStyle,
    KeepTogether, PageBreak, CondPageBreak,
)
from PIL import Image as PILImage

HERE = Path(__file__).resolve().parent
OUT = HERE / 'USER-MANUAL.zh-CN.pdf'
pdfmetrics.registerFont(TTFont('Chinese', os.environ.get('CAD_MANUAL_FONT', 'C:/Windows/Fonts/msyh.ttc')))
pdfmetrics.registerFont(TTFont('ChineseBold', os.environ.get('CAD_MANUAL_BOLD_FONT', 'C:/Windows/Fonts/msyhbd.ttc')))
pdfmetrics.registerFontFamily('Chinese', normal='Chinese', bold='ChineseBold', italic='Chinese', boldItalic='ChineseBold')
WIDTH = A4[0] - 88
base = dict(fontName='Chinese', fontSize=9.5, leading=16, wordWrap='CJK', spaceAfter=7, textColor=colors.HexColor('#263449'))
styles = {'body': ParagraphStyle('body', **base)}
for name, size, leading, before in [('title', 23, 33, 0), ('h2', 16, 24, 15), ('h3', 11.5, 19, 10)]:
    styles[name] = ParagraphStyle(name, parent=styles['body'], fontName='ChineseBold', fontSize=size, leading=leading, spaceBefore=before, keepWithNext=True, textColor=colors.HexColor('#17477d'))
styles['cell'] = ParagraphStyle('cell', parent=styles['body'], fontSize=8, leading=13, spaceAfter=0)
styles['caption'] = ParagraphStyle('caption', parent=styles['body'], fontSize=8, leading=12, alignment=TA_CENTER, textColor=colors.HexColor('#64748b'))
styles['code'] = ParagraphStyle('code', parent=styles['body'], fontSize=8, leading=13, backColor=colors.HexColor('#eef3f8'), borderPadding=7)
styles['quote'] = ParagraphStyle('quote', parent=styles['body'], leftIndent=10, borderPadding=6, backColor=colors.HexColor('#eef5fc'))
styles['list'] = ParagraphStyle('list', parent=styles['body'], leftIndent=12, firstLineIndent=-9)

def inline(raw):
    # Replace screen-only icon labels with printable Chinese equivalents.
    raw = raw.replace('📷', '截图').replace('⬇', '下载').replace('✕', '×')
    raw = raw.replace('—', '-').replace('–', '-')
    saved = []
    def protect(markup):
        saved.append(markup)
        return f'ZZTOKEN{len(saved)-1}ZZ'
    def link(match):
        label, target = match.groups()
        if not target.startswith(('http:', 'https:', '#')):
            target = 'https://github.com/lcchan0525sg/Online-CAD-Collaborator/blob/main/' + ('doc/' + target if not target.startswith('../') else target[3:])
        return protect(f'<a href="{html.escape(target, quote=True)}" color="#1d5fab">{inline(label)}</a>')
    raw = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', link, raw)
    raw = re.sub(r'<(https?://[^>]+)>', lambda m: protect(f'<a href="{html.escape(m[1], quote=True)}" color="#1d5fab">{html.escape(m[1])}</a>'), raw)
    raw = html.escape(raw)
    raw = re.sub(r'`([^`]+)`', r'<font color="#17477d">\1</font>', raw)
    raw = re.sub(r'\*\*([^*]+)\*\*', r'<b>\1</b>', raw)
    for i, value in enumerate(saved):
        raw = raw.replace(f'ZZTOKEN{i}ZZ', value)
    return raw

story = []
lines = (HERE / 'USER-MANUAL.zh-CN.md').read_text(encoding='utf-8').splitlines()
i = 0
pending_anchor = ''
while i < len(lines):
    line = lines[i].strip()
    i += 1
    if not line or line == '---':
        continue
    if line.startswith('<a id='):
        pending_anchor = re.search(r'id="([^"]+)"', line)[1]
        continue
    if line.startswith('```'):
        code = []
        while i < len(lines) and not lines[i].startswith('```'):
            code.append(html.escape(lines[i]))
            i += 1
        i += 1
        story.append(Paragraph('<br/>'.join(code), styles['code']))
        continue
    if line.startswith('|'):
        rows = []
        i -= 1
        while i < len(lines) and lines[i].strip().startswith('|'):
            row = lines[i].strip()
            i += 1
            if re.fullmatch(r'[|:\-\s]+', row):
                continue
            rows.append([Paragraph(inline(c.strip()), styles['cell']) for c in row.strip('|').split('|')])
        n = len(rows[0])
        fractions = {2: [0.32, 0.68], 3: [0.30, 0.23, 0.47], 4: [0.24, 0.43, 0.16, 0.17]}[n]
        table = Table(rows, colWidths=[WIDTH*f for f in fractions], repeatRows=1, hAlign='LEFT')
        table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), colors.HexColor('#e6eff8')),
            ('VALIGN', (0, 0), (-1, -1), 'TOP'),
            ('GRID', (0, 0), (-1, -1), .4, colors.HexColor('#ccd7e4')),
            ('LEFTPADDING', (0, 0), (-1, -1), 7),
            ('RIGHTPADDING', (0, 0), (-1, -1), 7),
            ('TOPPADDING', (0, 0), (-1, -1), 6),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
        ]))
        story.extend([table, Spacer(1, 10)])
        continue
    match = re.fullmatch(r'!\[([^\]]*)\]\(([^)]+)\)', line)
    if match:
        caption, target = match.groups()
        path = HERE / target
        with PILImage.open(path) as image:
            w, h = image.size
        scale = min(WIDTH/w, 265/h)
        story.append(KeepTogether([Spacer(1, 5), Image(str(path), width=w*scale, height=h*scale), Paragraph(inline(caption), styles['caption']), Spacer(1, 5)]))
        continue
    if line.startswith('#'):
        level = len(line) - len(line.lstrip('#'))
        title = line[level:].strip()
        if level == 2 and (title == '目录' or pending_anchor == 'section-1'):
            story.append(PageBreak())
        elif level == 2 and pending_anchor:
            story.append(CondPageBreak(200))
        prefix = f'<a name="{pending_anchor}"/>' if pending_anchor else ''
        pending_anchor = ''
        story.append(Paragraph(prefix + inline(title), styles['title' if level == 1 else 'h2' if level == 2 else 'h3']))
        continue
    style = 'body'
    if line.startswith('> '):
        line, style = line[2:], 'quote'
    elif line.startswith('- '):
        line, style = '• ' + line[2:], 'list'
    elif re.match(r'^\d+\. ', line):
        style = 'list'
    story.append(Paragraph(inline(line), styles[style]))

def page_decoration(canvas, doc):
    canvas.saveState()
    canvas.setFont('Chinese', 8)
    canvas.setFillColor(colors.HexColor('#64748b'))
    canvas.drawString(44, A4[1]-28, 'Online CAD Collaborator | 简体中文用户手册')
    canvas.drawRightString(A4[0]-44, 25, f'{doc.page}')
    canvas.setStrokeColor(colors.HexColor('#dce4ed'))
    canvas.line(44, 39, A4[0]-44, 39)
    canvas.restoreState()

doc = SimpleDocTemplate(str(OUT), pagesize=A4, rightMargin=44, leftMargin=44, topMargin=48, bottomMargin=50,
                        title='Online CAD Collaborator - 简体中文用户手册', author='Online CAD Collaborator')
doc.build(story, onFirstPage=page_decoration, onLaterPages=page_decoration)
print(OUT)
