#!/usr/bin/env python3
"""check-obj.py — inspect a Wavefront .obj for part identity.

Shows the `o` (object name) and `g` (group name) statements the CAD viewer's
converter uses to name parts, plus the materials (`usemtl`) that carry colours.

Usage:
    python check-obj.py path/to/file.obj
"""
import os
import re
import sys


def normalize(path):
    # Accept MSYS/git-bash style /c/Users/... as well as native C:\... paths.
    m = re.match(r'^/([a-zA-Z])/(.*)$', path)
    if m and os.name == 'nt':
        return m.group(1) + ':/' + m.group(2)
    return path


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        return 1
    path = normalize(sys.argv[1])
    if not os.path.exists(path):
        print(f"ERROR: no such file: {path}")
        return 1

    objs = []      # 'o' object-name lines (in order)
    groups = []    # 'g' group-name lines (in order)
    mtllibs = []   # 'mtllib' material-library references
    usemtls = []   # 'usemtl' material switches (in order)
    n_verts = n_faces = 0

    with open(path, 'r', errors='replace') as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            # first token defines the statement (v/vt/vn, f, g, o, usemtl, mtllib...)
            parts = line.split()
            cmd = parts[0]
            if cmd == 'o':
                objs.append(line[1:].strip() or '(empty)')
            elif cmd == 'g':
                groups.append(line[1:].strip() or '(empty)')
            elif cmd == 'mtllib':
                mtllibs.append(line[6:].strip())
            elif cmd == 'usemtl':
                usemtls.append(line[6:].strip())
            elif cmd == 'v':
                n_verts += 1
            elif cmd == 'f':
                n_faces += 1

    print(f"file        : {path}")
    print(f"vertices    : {n_verts}")
    print(f"faces       : {n_faces}")
    print()

    def section(title, items, color_after=None):
        print(f"{title} ({len(items)}):")
        if not items:
            print("  (none)")
        for i, it in enumerate(items):
            marker = ""
            if color_after is not None and it == color_after:
                marker = "   <-- applies to faces that follow"
            print(f"  {i+1:>2}. {it}{marker}")
        print()

    section("object names (o)  -> used as part names", objs)
    section("group names  (g)  -> part name fallback", groups)
    section("material libs (mtllib)", mtllibs)
    section("materials (usemtl) -> carry the colours", usemtls)

    # Guidance on what the viewer will show
    print("What the CAD viewer will show:")
    if objs:
        print("  Parts named by the object (o) names, one per distinct object+material.")
    elif groups and len(set(groups)) >= 1:
        uniq = sorted(set(groups))
        print("  No object (o) names; parts fall back to group (g) names.")
        print(f"  Distinct groups: {uniq}")
    else:
        print("  No o/g names at all - parts get sequential names (Part1, Part2, ...).")

    if mtllibs:
        # check the mtl exists alongside
        here = os.path.join(os.path.dirname(path), mtllibs[0])
        if os.path.exists(here):
            print(f"  mtl file found: {here}")
        else:
            print(f"  NOTE: mtl '{mtllibs[0]}' NOT found beside the .obj - colours will be grey "
                  "unless you also open the .mtl with the .obj.")
    else:
        print("  No mtllib reference - no colour file; parts will be grey.")

    return 0


if __name__ == '__main__':
    sys.exit(main())
