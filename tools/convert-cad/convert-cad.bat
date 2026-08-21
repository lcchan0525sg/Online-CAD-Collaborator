@echo off
rem convert-cad — Windows launcher for the standalone STEP/IGES/STL -> GLB/GLTF tool.
rem Requires: node.exe on PATH. Docker is the default; use --backend native
rem with a Python/OCP environment to run without Docker.
rem
rem Usage:
rem   convert-cad.bat model.step out.glb
setlocal
set "DIR=%~dp0"
node "%DIR%convert-cad.mjs" %*
set "code=%errorlevel%"
endlocal & exit /b %code%
