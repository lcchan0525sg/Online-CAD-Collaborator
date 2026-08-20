"""CAD -> GLB/GLTF dispatcher (entry point the main viewer mounts at /converters).

`server.js` runs `python /converters/step2glb.py <in> <out>` with the per-format
convert_*.py modules and common.py as siblings. It dispatches purely on the
input extension, so adding a format = one convert_<fmt>.py module + one entry
in FORMATS here.
"""

import os
import sys

from convert_step import convert_step
from convert_iges import convert_iges
from convert_stl import convert_stl
from common import log

FORMATS = {
    '.step': convert_step,
    '.stp': convert_step,
    '.igs': convert_iges,
    '.iges': convert_iges,
    '.stl': convert_stl,
}


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    rest = [a for a in sys.argv[1:] if a.startswith('--')]
    stem = None
    for a in rest:
        if a.startswith('--stem='):
            stem = a.split('=', 1)[1]
    if len(args) != 2:
        log("usage: converter <in.(step|stp|igs|iges|stl)> <out.glb|out.gltf> [--stem NAME]")
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
