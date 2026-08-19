#!/usr/bin/env python
"""Build a self-contained HTML version of the CAD Viewer user manual.

Reads doc/USER-MANUAL.md, converts it to a styled HTML page, and embeds every
referenced screenshot as a base64 data URI so the result opens standalone
(double-click / serve from anywhere, no sibling files needed).

Usage:
    python build-manual.py            # writes doc/USER-MANUAL.html

Requires: python 3.8+ (stdlib only).
"""
import base64
import html
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
MD = os.path.join(HERE, 'USER-MANUAL.md')
OUT = os.path.join(HERE, 'USER-MANUAL.html')

STYLE = """
  :root { --blue:#2563eb; --ink:#1f2937; --muted:#6b7280; --line:#e5e7eb; }
  * { box-sizing: border-box; }
  body { font-family:'Segoe UI',Roboto,Helvetica,Arial,sans-serif; color:var(--ink);
         margin:0; background:#f8fafc; line-height:1.6; }
  .page { max-width:860px; margin:0 auto; padding:36px 40px 80px; background:#fff;
          border-left:1px solid var(--line); border-right:1px solid var(--line);
          min-height:100vh; }
  h1 { font-size:30px; border-bottom:3px solid var(--blue); padding-bottom:10px; margin:8px 0 6px; }
  .ver { color:var(--muted); font-size:14px; margin-bottom:28px; }
  h2 { font-size:22px; color:#1e3a8a; margin-top:40px; border-bottom:1px solid var(--line); padding-bottom:6px; }
  h3 { font-size:17px; color:var(--blue); margin-top:28px; }
  p  { margin:10px 0; }
  code { background:#eef2ff; padding:1px 6px; border-radius:4px; font-size:0.92em;
         font-family:Consolas,'Courier New',monospace; }
  pre { background:#0f172a; color:#e2e8f0; padding:14px 16px; border-radius:8px;
        overflow-x:auto; font-size:13px; }
  pre code { background:none; color:inherit; padding:0; }
  img { max-width:100%; border:1px solid var(--line); border-radius:8px; margin:12px 0;
        box-shadow:0 1px 3px rgba(0,0,0,.08); }
  blockquote { border-left:4px solid var(--blue); margin:12px 0; padding:2px 16px;
               background:#f0f6ff; color:#334155; }
  ul,ol { padding-left:26px; }
  li { margin:4px 0; }
  /* Welcome page: hero banner */
  .hero { border-radius:14px; overflow:hidden; margin:16px 0 6px; box-shadow:0 4px 18px rgba(0,0,0,.18); }
  .hero img { display:block; width:100%; border:0; margin:0; border-radius:14px; }
  .hero-caption { text-align:center; color:var(--muted); font-size:13px; margin:6px 0 18px; }
  /* Feature cards */
  .features { display:grid; grid-template-columns:1fr 1fr; gap:14px; margin:14px 0; }
  .feature { background:#f7f9fc; border:1px solid var(--line); border-left:4px solid var(--blue);
             border-radius:10px; padding:14px 16px; }
  .feature strong { color:#1e3a8a; display:block; margin-bottom:4px; }
  .feature .ico { color:var(--blue); font-weight:700; margin-right:6px; }
  @media (max-width:640px){ .features{grid-template-columns:1fr;} }
  /* Callout */
  .callout { border-left:5px solid var(--blue); background:#eef4ff; padding:12px 18px;
             border-radius:8px; margin:16px 0; }
  .callout strong { color:#1e3a8a; }
  /* Comparison table highlight */
  .comp td:first-child { font-weight:600; }
  .comp th { background:var(--blue); color:#fff; }
  table { border-collapse:collapse; width:100%; margin:14px 0; }
  th,td { border:1px solid var(--line); padding:8px 12px; text-align:left; font-size:14px; }
  th { background:#f1f5f9; }
  hr { border:0; border-top:1px solid var(--line); margin:30px 0; }
  a { color:var(--blue); }
  @media print { body{background:#fff} .page{border:0;max-width:100%} }
  @media (max-width:640px){ .page{padding:20px 16px} }
"""


def image_data_uri(path):
    ext = os.path.splitext(path)[1].lower()
    mime = 'image/png' if ext == '.png' else ('image/jpeg' if ext in ('.jpg', '.jpeg') else 'image/gif')
    with open(path, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode()
    return f'data:{mime};base64,{b64}'


def render_paragraph(text):
    """Convert inline markdown to HTML, embedding images. Text may span lines."""
    # images first (so [..](img.png) isn't mistaken for a link)
    def img(m):
        alt = html.escape(m.group(1))
        rel = m.group(2)
        path = os.path.join(HERE, rel) if not os.path.isabs(rel) else rel
        if os.path.isfile(path):
            src = image_data_uri(path)
        else:
            src = html.escape(rel)
        return f'<img src="{src}" alt="{alt}">'
    s = re.sub(r'!\[([^\]]*)\]\(([^)]+)\)', img, text)
    # links
    s = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', lambda m: f'<a href="{html.escape(m.group(2))}">{html.escape(m.group(1))}</a>', s)
    # inline code
    s = re.sub(r'`([^`]+)`', lambda m: f'<code>{html.escape(m.group(1))}</code>', s)
    # bold and italic (allow across line breaks)
    s = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', s, flags=re.S)
    s = re.sub(r'(?<!\*)\*([^*]+)\*(?!\*)', r'<em>\1</em>', s, flags=re.S)
    return s


def slugify(text):
    """GitHub-style heading anchor: lowercase, strip non-alphanumeric (keep
    letters/digits/hyphens), spaces -> hyphens. Matches the TOC anchors."""
    s = text.lower()
    s = re.sub(r'[^a-z0-9 -]', '', s)
    s = s.replace(' ', '-')
    return s


def convert():
    text = open(MD, encoding='utf-8').read()
    lines = text.split('\n')
    out = []
    i = 0
    n = len(lines)
    while i < n:
        raw = lines[i].rstrip()
        # fenced code block
        if raw.startswith('```'):
            buf = []
            i += 1
            while i < n and not lines[i].startswith('```'):
                buf.append(lines[i]); i += 1
            out.append('<pre><code>' + html.escape('\n'.join(buf)) + '</code></pre>')
            i += 1
            continue
        if raw.startswith('### '):
            out.append(f'<h3 id="{slugify(raw[4:])}">{render_paragraph(raw[4:])}</h3>')
        elif raw.startswith('## '):
            out.append(f'<h2 id="{slugify(raw[3:])}">{render_paragraph(raw[3:])}</h2>')
        elif raw.startswith('# '):
            out.append(f'<h1 id="{slugify(raw[2:])}">{render_paragraph(raw[2:])}</h1>')
        elif raw.strip() == '---':
            out.append('<hr>')
        elif raw.startswith('> '):
            out.append(f'<blockquote>{render_paragraph(raw[2:])}</blockquote>')
        elif re.match(r'^\s*[-*] ', raw):
            items = []
            while i < n and re.match(r'^\s*[-*] ', lines[i].rstrip()):
                item = re.sub(r'^\s*[-*] ', '', lines[i].strip())
                items.append(f'<li>{render_paragraph(item)}</li>')
                i += 1
            out.append('<ul>' + ''.join(items) + '</ul>')
            i -= 1
        elif re.match(r'^\s*\d+\. ', raw):
            items = []
            while i < n and re.match(r'^\s*\d+\. ', lines[i].rstrip()):
                item = re.sub(r'^\s*\d+\. ', '', lines[i].strip())
                items.append(f'<li>{render_paragraph(item)}</li>')
                i += 1
            out.append('<ol>' + ''.join(items) + '</ol>')
            i -= 1
        elif raw.startswith('|') and i + 1 < n and re.match(r'^\s*\|?[\s:|-]+\|?\s*$', lines[i + 1].strip()):
            # table
            head = [c.strip() for c in raw.strip('|').split('|')]
            rows = []
            i += 2
            while i < n and lines[i].strip().startswith('|'):
                rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')])
                i += 1
            out.append('<table><thead><tr>' + ''.join(f'<th>{html.escape(h)}</th>' for h in head) + '</tr></thead><tbody>'
                       + ''.join('<tr>' + ''.join(f'<td>{render_paragraph(c)}</td>' for c in r) + '</tr>' for r in rows)
                       + '</tbody></table>')
            i -= 1
        elif raw == '':
            out.append('')
        elif raw.startswith(':::') and not raw.startswith('::::'):
            # custom directive block: :::hero / :::callout / :::features
            name = raw[3:].strip().split()[0] if raw[3:].strip() else ''
            body = []
            i += 1
            while i < n and not lines[i].strip().startswith(':::'):
                body.append(lines[i]); i += 1
            # i now points at the closing ::: (or past end)
            joined = '\n'.join(body).strip()
            if name == 'hero':
                out.append(f'<div class="hero">{render_paragraph(joined)}</div>')
            elif name == 'callout':
                out.append(f'<div class="callout">{render_paragraph(joined)}</div>')
            elif name == 'features':
                # Each card is a paragraph: consecutive non-blank lines joined
                # with a space; a blank line starts the next card. This keeps a
                # wrapped paragraph intact instead of splitting it per line.
                cards = []
                for chunk in re.split(r'\n\s*\n', joined):
                    chunk = ' '.join(l.strip() for l in chunk.split('\n') if l.strip()).strip()
                    if not chunk: continue
                    # Title is the FIRST bold run at the start; the rest (minus a
                    # leading "—"/":") is the body. Anchoring avoids backtracking
                    # into a bold token later in the sentence.
                    m = re.match(r'^\*\*(.+?)\*\*(?:\s*[—\-:]\s*|\s+)(.*)$', chunk, re.S)
                    if m:
                        title = render_paragraph(m.group(1))
                        body = re.sub(r'^\s*[—\-:]\s*', '', m.group(2))
                        cards.append(f'<div class="feature"><strong><span class="ico">▸</span>{title}</strong>{render_paragraph(body)}</div>')
                    else:
                        cards.append(f'<div class="feature">{render_paragraph(chunk)}</div>')
                out.append('<div class="features">' + ''.join(cards) + '</div>')
            # else: unrecognised -> emit the body as paragraphs
            else:
                for ln in body:
                    out.append(f'<p>{render_paragraph(ln)}</p>')
        else:
            out.append(f'<p>{render_paragraph(raw)}</p>')
        i += 1

    body = '\n'.join(out)
    doc = f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CAD Viewer — User Manual</title>
<style>{STYLE}</style>
</head>
<body>
<div class="page">
{body}
</div>
</body>
</html>
"""
    with open(OUT, 'w', encoding='utf-8') as f:
        f.write(doc)
    return len(doc)


if __name__ == '__main__':
    size = convert()
    print(f'wrote {OUT} ({size:,} bytes)')
