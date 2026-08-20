@echo off
rem convert-cad — Windows launcher for the standalone STEP/IGES/STL -> GLB/GLTF tool.
rem Requires: node.exe on PATH and Docker Desktop running with the chair-cq:local image.
rem
rem Usage:
rem   convert-cad.bat model.step out.glb
setlocal
set "DIR=%~dp0"
node "%DIR%convert-cad.mjs" %*
set "code=%errorlevel%"
endlocal & exit /b %code%
