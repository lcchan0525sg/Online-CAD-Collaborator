"""STEP -> GLB/GLTF converter module."""

import sys

from OCP.XCAFDoc import (XCAFDoc_DocumentTool, XCAFDoc_ColorType, XCAFDoc_ShapeTool)

from common import (log, new_doc, walk_labels, shape_colour, mesh, collect_solids,
                    FALLBACK, add_shape, export_doc)


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
            add_shape(root, shapeTool, colorTool, s)
            collect_solids(s, solids)
    if not solids:
        log("ERROR: no shapes transferred from STEP"); sys.exit(1)
    export_doc(doc, out, stem)
