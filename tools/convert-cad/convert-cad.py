#!/usr/bin/env python
"""Standalone CAD -> GLB/GLTF converter (STEP / IGES / OBJ).

A self-contained tool that runs inside the `chair-cq:local` container
(OpenCascade kernel — no Windows wheels, so conversion always runs in Docker)
and produces a glTF asset from one STEP (.step/.stp), IGES (.igs/.iges) or
OBJ (.obj) file. Output is either a single binary .glb or a text .gltf
(+ a sibling .bin), chosen by the output filename's extension.

It is intentionally self-contained (does NOT import the web app's
chair-3d-web/converters modules) so this tool can never disturb a finished
converter and works standalone with just the Docker image.

Per-format logic is isolated in its own function (convert_step/convert_iges/
convert_obj); adding a format means adding one function + one FORMATS entry.

Usage (inside the container):
  python convert-cad.py <in.(step|stp|igs|iges|obj)> <out.glb|out.gltf> [--stem NAME]

Exit codes:
  0 success (prints RESULT_OK)
  1 conversion/verification failure (message on stderr)
  2 usage / unsupported extension
"""
import os
import sys

from OCP.TDocStd import TDocStd_Document
from OCP.TCollection import TCollection_ExtendedString, TCollection_AsciiString
from OCP.XCAFApp import XCAFApp_Application
from OCP.BRepMesh import BRepMesh_IncrementalMesh
from OCP.RWGltf import RWGltf_CafWriter
from OCP.TColStd import TColStd_IndexedDataMapOfStringString
from OCP.Message import Message_ProgressRange
from OCP.XCAFDoc import (XCAFDoc_DocumentTool, XCAFDoc_ColorType, XCAFDoc_ShapeTool)
from OCP.Quantity import Quantity_Color, Quantity_TOC_RGB
from OCP.TopExp import TopExp_Explorer
from OCP.TopAbs import TopAbs_SOLID

FALLBACK = Quantity_Color(0.62, 0.66, 0.72, Quantity_TOC_RGB)
MESH_DEFLECTION, MESH_ANGULAR, MESH_RUN_OUT = 0.2, 0.5, True

# ---------------------------------------------------------------- helpers ----

def log(msg):
    print(msg, file=sys.stderr, flush=True)


def new_doc():
    app = XCAFApp_Application.GetApplication_s()
    doc = TDocStd_Document(TCollection_ExtendedString("doc"))
    app.InitDocument(doc)
    return doc, doc.Main()


def walk_labels(lab, fn):
    fn(lab)
    for i in range(1, lab.NbChildren() + 1):
        walk_labels(lab.FindChild(i), fn)


def shape_colour(colorTool, s):
    c = Quantity_Color()
    for t in (XCAFDoc_ColorType.XCAFDoc_ColorGen,
              XCAFDoc_ColorType.XCAFDoc_ColorSurf,
              XCAFDoc_ColorType.XCAFDoc_ColorCurv):
        if colorTool.GetColor(s, t, c):
            return c
    return None


def collect_solids(shape, solids):
    exp = TopExp_Explorer(); exp.Init(shape, TopAbs_SOLID)
    found = []
    while exp.More():
        exp.Next(); found.append(exp.Current())
    solids.extend(found if found else [shape])


def mesh(shape):
    BRepMesh_IncrementalMesh(shape, MESH_DEFLECTION, False, MESH_ANGULAR, MESH_RUN_OUT)


# ------------------------------------------------------- naming post-pass ----

def _clean(name):
    if name is None:
        return None
    n = name.strip()
    if not n or n in ('DEFAULT', 'UNKNOWN', '<NONE>') or n.startswith('=>['):
        return None
    return n


def _rename_parts(json_obj, stem):
    """Deterministic node/mesh names in scene order. Root -> stem;
    geometry children -> Part1..PartN; only JUNK names are replaced, so real
    source names (STEP) survive."""
    nodes = json_obj.get('nodes', [])
    if not nodes:
        return
    scenes = json_obj.get('scenes', [])
    root_idx = scenes[0]['nodes'][0] if scenes and scenes[0].get('nodes') else 0
    name_of = {}
    part_no = [0]
    stack = [root_idx]
    while stack:
        i = stack.pop()
        n = nodes[i]
        cur = _clean(n.get('name'))
        if i == root_idx:
            name_of[i] = cur or stem
        elif n.get('mesh') is not None:
            if cur is None:
                part_no[0] += 1
                name_of[i] = 'Part%d' % part_no[0]
        for c in reversed(n.get('children') or []):
            stack.append(c)
    for i, n in enumerate(nodes):
        nm = name_of.get(i)
        if nm and _clean(n.get('name')) != nm:
            n['name'] = nm
    mesh_name_of = {n.get('mesh'): name_of[i]
                    for i, n in enumerate(nodes)
                    if n.get('mesh') is not None and i in name_of}
    for i, m in enumerate(json_obj.get('meshes', [])):
        if i in mesh_name_of:
            m['name'] = mesh_name_of[i]


def _rename_glb(out, stem):
    import json
    b = open(out, 'rb').read()
    if b[:4] != b'glTF':
        return
    off = 12
    chunks = {}
    while off + 8 <= len(b):
        ln = int.from_bytes(b[off:off + 4], 'little')
        t = int.from_bytes(b[off + 4:off + 8], 'little')
        chunks[t] = b[off + 8:off + 8 + ln]
        off += 8 + ln + (ln % 4)
    j = json.loads(chunks[0x4E4F534A])
    _rename_parts(j, stem)
    # Rebuild GLB: BIN chunk payload-only (offsets are relative to the chunk
    # payload, AFTER the 8-byte header). Writing the raw chunk shifts every
    # bufferView by 8 bytes -> garbage geometry.
    new_json = json.dumps(j, separators=(',', ':')).encode('utf-8')
    new_json += b' ' * ((4 - len(new_json) % 4) % 4)
    bin_payload = chunks[0x004E4942]
    bin_out = bin_payload + b'\x00' * ((4 - len(bin_payload) % 4) % 4)
    total = 12 + 8 + len(new_json) + 8 + len(bin_out)
    head = b'glTF' + (2).to_bytes(4, 'little') + total.to_bytes(4, 'little')
    out_b = (head
             + len(new_json).to_bytes(4, 'little') + (0x4E4F534A).to_bytes(4, 'little') + new_json
             + len(bin_out).to_bytes(4, 'little') + (0x004E4942).to_bytes(4, 'little') + bin_out)
    open(out, 'wb').write(out_b)


def _rename_gltf(gltf, stem):
    import json
    with open(gltf, 'r', encoding='utf-8') as fh:
        j = json.load(fh)
    _rename_parts(j, stem)
    with open(gltf, 'w', encoding='utf-8') as fh:
        json.dump(j, fh, indent=2)
        fh.write('\n')


# ------------------------------------------------------------ verification ----

_GLB_FMT = {5120: ('b', 1), 5121: ('B', 1), 5122: ('h', 2), 5123: ('H', 2),
            5125: ('I', 4), 5126: ('f', 4)}


def verify_glb(out):
    import json as _j
    import struct as _s
    b = open(out, 'rb').read()
    if b[:4] != b'glTF':
        return False, 'not a GLB (bad magic)'
    off = 12; j = None; binb = b''
    while off + 8 <= len(b):
        ln = int.from_bytes(b[off:off + 4], 'little')
        t = int.from_bytes(b[off + 4:off + 8], 'little')
        if t == 0x4E4F534A:
            j = _j.loads(b[off + 8:off + 8 + ln])
        elif t == 0x004E4942:
            binb = b[off + 8:off + 8 + ln]
        off += 8 + ln + (ln % 4)
    if j is None:
        return False, 'no JSON chunk'
    bad = []; tris = 0
    for mi, mesh_ in enumerate(j.get('meshes', [])):
        for pi, prim in enumerate(mesh_.get('primitives', [])):
            ia = prim.get('indices'); pa = prim['attributes'].get('POSITION')
            if ia is None or pa is None:
                continue
            ai = j['accessors'][ia]; posn = j['accessors'][pa]['count']
            f, w = _GLB_FMT[ai['componentType']]
            bv = j['bufferViews'][ai['bufferView']]
            base = bv.get('byteOffset', 0) + ai.get('byteOffset', 0)
            mx = max(_s.unpack_from('<' + f, binb, base + k * w)[0] for k in range(ai['count']))
            tris += ai['count'] // 3
            if mx >= posn:
                bad.append((mi, pi, mx, posn))
    if bad:
        return False, f"{len(bad)} primitive(s) with out-of-range indices: {bad[:5]}"
    if tris == 0:
        return False, 'no triangles in any primitive'
    return True, f'{tris} triangles, all indices in range'


def verify_gltf(gltf, binf):
    import json
    if not os.path.exists(gltf) or not os.path.exists(binf):
        return False, 'missing .gltf or .bin output'
    j = json.load(open(gltf, 'r', encoding='utf-8'))
    tris = sum(a['count'] // 3
               for a in j.get('accessors', [])
               if a.get('componentType') in (5123, 5125) and a.get('count'))
    if tris == 0:
        return False, 'no triangles'
    return True, f'{tris} index-elements (triangles implied) in .gltf/.bin'


def export_doc(doc, out, stem):
    """Write the XCAF doc to GLB (binary) or GLTF (text + .bin) by extension,
    run the naming post-pass, verify, and report."""
    binary = out.lower().endswith('.glb')
    writer = RWGltf_CafWriter(TCollection_AsciiString(out), binary)
    st = writer.Perform(doc, TColStd_IndexedDataMapOfStringString(), Message_ProgressRange())
    log(f"gltf status: {st}")
    if binary:
        if not os.path.exists(out):
            log("ERROR: glb file was not written"); sys.exit(1)
        _rename_glb(out, stem)
        ok, msg = verify_glb(out)
    else:
        gltf, binf = out, os.path.splitext(out)[0] + '.bin'
        if not os.path.exists(gltf):
            log("ERROR: gltf file was not written"); sys.exit(1)
        _rename_gltf(gltf, stem)
        ok, msg = verify_gltf(gltf, binf)
    if not ok:
        log(f"ERROR: output failed verification: {msg}"); sys.exit(1)
    log(f"bytes: {os.path.getsize(out)}")
    log(f"RESULT_OK")


# ------------------------------------------------------------ format modules ----

def convert_step(src, out, stem):
    from OCP.STEPControl import STEPControl_Reader
    from OCP.STEPCAFControl import STEPCAFControl_Reader
    doc, root = new_doc()
    shapeTool = XCAFDoc_DocumentTool.ShapeTool_s(root)
    colorTool = XCAFDoc_DocumentTool.ColorTool_s(root)
    caf = STEPCAFControl_Reader(); caf.SetColorMode(True); caf.SetNameMode(True)
    read_ok = caf.ReadFile(src)
    log(f"STEP caf read status: {read_ok}")
    transferred = caf.Transfer(doc) if "RetDone" in str(read_ok) else False
    solids = []
    if transferred:
        def prep(lab):
            if not XCAFDoc_ShapeTool.IsShape_s(lab):
                return
            s = XCAFDoc_ShapeTool.GetShape_s(lab)
            if s is None or s.IsNull():
                return
            mesh(s)
            if shape_colour(colorTool, s) is None:
                colorTool.SetColor(lab, FALLBACK, XCAFDoc_ColorType.XCAFDoc_ColorGen)
            solids.append(s)
        walk_labels(root, prep)
    if not solids:
        r = STEPControl_Reader()
        r.ReadFile(src); r.TransferRoots()
        for i in range(1, r.NbShapes() + 1):
            s = r.Shape(i)
            mesh(s)
            lab = shapeTool.NewShape(); shapeTool.SetShape(lab, s)
            colorTool.SetColor(lab, FALLBACK, XCAFDoc_ColorType.XCAFDoc_ColorGen)
            collect_solids(s, solids)
    if not solids:
        log("ERROR: no shapes transferred from STEP"); sys.exit(1)
    export_doc(doc, out, stem)


def convert_iges(src, out, stem):
    from OCP.IGESControl import IGESControl_Reader
    from OCP.IGESCAFControl import IGESCAFControl_Reader
    doc, root = new_doc()
    shapeTool = XCAFDoc_DocumentTool.ShapeTool_s(root)
    colorTool = XCAFDoc_DocumentTool.ColorTool_s(root)
    caf = IGESCAFControl_Reader(); caf.SetColorMode(True); caf.SetNameMode(True)
    read_ok = caf.ReadFile(src)
    log(f"IGES caf read status: {read_ok}")
    transferred = caf.Transfer(doc) if "RetDone" in str(read_ok) else False
    solids = []
    if transferred:
        def prep(lab):
            if not XCAFDoc_ShapeTool.IsShape_s(lab):
                return
            s = XCAFDoc_ShapeTool.GetShape_s(lab)
            if s is None or s.IsNull():
                return
            mesh(s)
            if shape_colour(colorTool, s) is None:
                colorTool.SetColor(lab, FALLBACK, XCAFDoc_ColorType.XCAFDoc_ColorGen)
            solids.append(s)
        walk_labels(root, prep)
    if not solids:
        r = IGESControl_Reader()
        r.ReadFile(src); r.TransferRoots()
        for i in range(1, r.NbShapes() + 1):
            s = r.Shape(i)
            mesh(s)
            lab = shapeTool.NewShape(); shapeTool.SetShape(lab, s)
            colorTool.SetColor(lab, FALLBACK, XCAFDoc_ColorType.XCAFDoc_ColorGen)
            collect_solids(s, solids)
    if not solids:
        log("ERROR: no shapes transferred from IGES"); sys.exit(1)
    export_doc(doc, out, stem)


def convert_obj(src, out, stem):
    from OCP.gp import gp_Pnt
    from OCP.BRepBuilderAPI import (BRepBuilderAPI_MakeEdge, BRepBuilderAPI_MakeWire,
                                    BRepBuilderAPI_MakeFace)
    from OCP.TopoDS import TopoDS_Compound
    from OCP.BRep import BRep_Builder
    from OCP.TDataStd import TDataStd_Name

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


FORMATS = {
    '.step': convert_step,
    '.stp': convert_step,
    '.igs': convert_iges,
    '.iges': convert_iges,
    '.obj': convert_obj,
}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    rest = [a for a in sys.argv[1:] if a.startswith('--')]
    stem = None
    for a in rest:
        if a.startswith('--stem='):
            stem = a.split('=', 1)[1]
    if len(args) != 2:
        log("usage: convert-cad.py <in.(step|stp|igs|iges|obj)> <out.glb|out.gltf> [--stem NAME]")
        sys.exit(2)
    src, out = args
    ext = os.path.splitext(src)[1].lower()
    fn = FORMATS.get(ext)
    if fn is None:
        log(f"ERROR: unsupported extension: {ext}"); sys.exit(2)
    if stem is None:
        stem = os.path.splitext(os.path.basename(src))[0]
    fn(src, out, stem)


if __name__ == '__main__':
    main()
