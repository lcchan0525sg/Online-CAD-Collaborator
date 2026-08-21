"""Shared helpers for the CAD -> GLB/GLTF converter.

Holds everything that every format shares: XCAF document setup, meshing,
the naming post-pass, GLB/GLTF verification and export, plus constants.
A format module imports these and implements ONLY its own reader/parser.

This module is deliberately flat-importable (no package prefix) so it can be
mounted directly at /converters in the main viewer (server.js runs
`python /converters/step2glb.py` with common.py + convert_*.py as siblings).
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
_mesh_quality_logged = False


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
    global _mesh_quality_logged
    def number(name, fallback, low, high):
        try:
            return max(low, min(high, float(os.environ.get(name, fallback))))
        except (TypeError, ValueError):
            return fallback
    optimize = os.environ.get('CQ_OPTIMIZE', '1').lower() not in ('0', 'false', 'off', 'no')
    deflection = number('CQ_DEFLECTION', MESH_DEFLECTION, 0.01, 10.0) if optimize else MESH_DEFLECTION
    angular = number('CQ_ANGULAR', MESH_ANGULAR, 0.05, 5.0) if optimize else MESH_ANGULAR
    if not _mesh_quality_logged:
        profile = os.environ.get('CQ_PROFILE', 'faithful' if not optimize else 'custom')
        log(f"mesh quality: {'optimized' if optimize else 'faithful'} profile={profile} deflection={deflection:g} angular={angular:g}")
        _mesh_quality_logged = True
    BRepMesh_IncrementalMesh(shape, deflection, False, angular, MESH_RUN_OUT)


def add_shape(root, shapeTool, colorTool, shape):
    """Mesh a shape and register it as a part with the fallback colour.

    Returns the part label so callers can attach a real name if they have one.
    """
    mesh(shape)
    lab = shapeTool.NewShape()
    shapeTool.SetShape(lab, shape)
    colorTool.SetColor(lab, FALLBACK, XCAFDoc_ColorType.XCAFDoc_ColorGen)
    return lab


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
