"""OBJ (+ companion .mtl) -> GLB/GLTF converter module.

Parses vertices and faces (ignoring UVs/normals), groups them into parts by
(o-group, material), and builds a compound of BRep faces per part with a
per-material diffuse colour from the .mtl. NOTE: only diffuse colour (Kd) is
carried today; texture (map_Kd) is a planned follow-up.
"""

import os
import sys

from OCP.gp import gp_Pnt
from OCP.BRepBuilderAPI import (BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeWire,
                                BRepBuilderAPI_MakeFace)
from OCP.TopoDS import TopoDS_Compound
from OCP.BRep import BRep_Builder
from OCP.TDataStd import TDataStd_Name
from OCP.TCollection import TCollection_ExtendedString
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorType
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB

from common import log, new_doc, mesh, export_doc, FALLBACK


def parse_mtl(path):
    mats = {}
    if not path or not os.path.exists(path):
        return mats
    try:
        with open(path, 'r', errors='replace') as fh:
            name = None
            for line in fh:
                line = line.strip()
                if not line or line.startswith('#'):
                    continue
                toks = line.split()
                if toks[0] == 'newmtl':
                    name = toks[1]; mats.setdefault(name, Quantity_Color())
                elif toks[0] == 'Kd' and name is not None:
                    try:
                        r, g, b = float(toks[1]), float(toks[2]), float(toks[3])
                        mats[name] = Quantity_Color(r, g, b, Quantity_TOC_RGB)
                    except (ValueError, IndexError):
                        pass
    except Exception as e:
        log(f"mtl parse skipped: {e}")
    return mats


def find_mtl(src):
    base = os.path.splitext(src)[0]
    guess = base + '.mtl'
    if os.path.exists(guess):
        return guess
    try:
        d = os.path.dirname(src) or '.'
        low = os.path.basename(base).lower() + '.mtl'
        for entry in os.listdir(d):
            if entry.lower() == low:
                return os.path.join(d, entry)
    except OSError:
        pass
    return guess


def convert_obj(src, out, stem):
    doc, root = new_doc()
    shapeTool = XCAFDoc_DocumentTool.ShapeTool_s(root)
    colorTool = XCAFDoc_DocumentTool.ColorTool_s(root)

    mats = parse_mtl(find_mtl(src))
    log(f"mtl materials: {len(mats)}")

    verts = []
    parts = {}      # (gname, mname) -> {'faces': [...], 'obj': str}
    order = []
    cur_group = 'default'; cur_mtl = 'default'; cur_obj = None

    def ensure_part(g, m):
        key = (g, m)
        if key not in parts:
            parts[key] = {'faces': [], 'obj': cur_obj}
            order.append(key)

    with open(src, 'r', errors='replace') as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith('#'):
                continue
            toks = line.split(None, 1)
            cmd = toks[0].lower()
            args = toks[1] if len(toks) > 1 else ''
            if cmd == 'v':
                try:
                    p = args.split()
                    verts.append((float(p[0]), float(p[1]), float(p[2])))
                except (ValueError, IndexError):
                    pass
            elif cmd == 'o':
                obj = args.strip()
                if obj:
                    cur_obj = obj; cur_group = obj; ensure_part(obj, cur_mtl)
            elif cmd == 'g':
                gname = args.strip() or 'unnamed'
                cur_group = gname; ensure_part(gname, cur_mtl)
            elif cmd == 'usemtl':
                cur_mtl = args.strip() or 'default'; ensure_part(cur_group, cur_mtl)
            elif cmd == 'f':
                ensure_part(cur_group, cur_mtl)
                idx = []
                for tok in args.split():
                    p = tok.split('/')
                    if p and p[0]:
                        try:
                            idx.append(int(p[0]))
                        except ValueError:
                            pass
                if len(idx) >= 3:
                    parts[(cur_group, cur_mtl)]['faces'].append(tuple(idx))

    per_group = {}
    for g, m in order:
        per_group[g] = per_group.get(g, 0) + 1

    log(f"verts: {len(verts)}, groups: {len(per_group)}, parts: {len(order)}")
    if not verts:
        log("ERROR: OBJ file has no vertices"); sys.exit(1)

    total_tris = 0; part_no = 0; total_parts = len(order)
    for (gname, mname) in order:
        faces = parts[(gname, mname)]['faces']
        if not faces:
            continue
        tris = []
        for f_ in faces:
            if len(f_) == 3:
                tris.append(f_)
            else:
                for i in range(1, len(f_) - 1):
                    tris.append((f_[0], f_[i], f_[i + 1]))
        if not tris:
            continue
        builder = BRep_Builder()
        compound = TopoDS_Compound()
        builder.MakeCompound(compound)
        added = 0
        for tri in tris:
            try:
                p1 = gp_Pnt(*verts[tri[0] - 1]); p2 = gp_Pnt(*verts[tri[1] - 1])
                p3 = gp_Pnt(*verts[tri[2] - 1])
                wire = BRepBuilderAPI_MakeWire(
                    BRepBuilderAPI_MakeEdge(p1, p2).Edge(),
                    BRepBuilderAPI_MakeEdge(p2, p3).Edge(),
                    BRepBuilderAPI_MakeEdge(p3, p1).Edge()).Wire()
                face = BRepBuilderAPI_MakeFace(wire, True).Face()
                builder.Add(compound, face); added += 1
            except Exception:
                continue
        if added == 0:
            continue
        mesh(compound)   # REQUIRED: RWGltf_CafWriter emits zero meshes otherwise
        total_tris += len(tris); part_no += 1
        lab = shapeTool.NewShape(); shapeTool.SetShape(lab, compound)
        objname = (parts[(gname, mname)].get('obj') or '').strip()
        if objname and objname not in ('unnamed', 'default'):
            pname = objname
        elif total_parts == 1:
            pname = gname
        else:
            pname = 'Part%d' % part_no
        try:
            TDataStd_Name.Set_s(lab, TCollection_ExtendedString(pname))
        except Exception as e:
            log(f"part name skipped: {e}")
        colorTool.SetColor(lab, mats.get(mname, FALLBACK), XCAFDoc_ColorType.XCAFDoc_ColorGen)

    if total_tris == 0:
        log("ERROR: OBJ file produced no triangles"); sys.exit(1)
    log(f"OBJ triangles: {total_tris}, parts: {len(order)}")
    export_doc(doc, out, stem)
