#!/usr/bin/env python
"""Standalone CAD -> GLB/GLTF converter entry point (STEP / IGES / STL).

Thin wrapper over the modular `converters/` package. Kept so the standalone
tool's web UI (convert-cad-server.mjs runs `python /tool/convert-cad.py`) and
any scripts that call this exact path keep working unchanged.

The actual logic lives in converters/ (step2glb.py dispatcher + per-format
convert_*.py modules + common.py) — the same layout the main viewer mounts at
/converters, so this tool's converters/ folder migrates as-is.

Usage (inside the container):
  python convert-cad.py <in.(step|stp|igs|iges|stl)> <out.glb|out.gltf> [--stem NAME]

Exit codes:
  0 success (prints RESULT_OK)
  1 conversion/verification failure (message on stderr)
  2 usage / unsupported extension
"""

import os
import sys

# Make the sibling converters/ package importable (it is flat, no __init__).
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'converters'))

from step2glb import main  # noqa: E402


if __name__ == '__main__':
    main()
