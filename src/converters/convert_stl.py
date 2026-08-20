"""STL -> GLB/GLTF converter module.

STL is already triangulated, so reading it is simple: StlAPI_Reader loads the
facets into a TopoDS compound, which is meshed and registered as a single part
with the fallback colour before the shared export.
"""

import sys

from OCP.TopoDS import TopoDS_Compound
from OCP.BRep import BRep_Builder
from OCP.StlAPI import StlAPI_Reader
from OCP.XCAFDoc import XCAFDoc_DocumentTool, XCAFDoc_ColorType

from common import log, new_doc, mesh, export_doc, FALLBACK


def convert_stl(src, out, stem):
    doc, root = new_doc()
    shapeTool = XCAFDoc_DocumentTool.ShapeTool_s(root)
    colorTool = XCAFDoc_DocumentTool.ColorTool_s(root)

    compound = TopoDS_Compound()
    builder = BRep_Builder()
    builder.MakeCompound(compound)
    reader = StlAPI_Reader()
    if not reader.Read(compound, src):
        log("ERROR: STL read failed"); sys.exit(1)

    mesh(compound)
    lab = shapeTool.NewShape()
    shapeTool.SetShape(lab, compound)
    colorTool.SetColor(lab, FALLBACK, XCAFDoc_ColorType.XCAFDoc_ColorGen)

    export_doc(doc, out, stem)
