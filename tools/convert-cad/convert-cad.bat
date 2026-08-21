@echo off
rem convert-cad — Windows launcher for the standalone STEP/IGES/STL -> GLB/GLTF tool.
rem Requires: node.exe on PATH and a Python/OCP environment. Set CAD_PYTHON
rem or pass --python to select the native interpreter.
rem
rem Usage:
rem   convert-cad.bat model.step out.glb
setlocal
set "DIR=%~dp0"
node "%DIR%convert-cad.mjs" %*
set "code=%errorlevel%"
endlocal & exit /b %code%
