@echo off
rem convert-cad-web — launch the drag & drop web UI for the CAD -> GLB/GLTF tool.
rem Requires: node.exe on PATH and a Python/OCP environment. Set CAD_PYTHON
rem or pass --python to select the native interpreter.
rem Then open the printed http://localhost:8787 URL in a browser.
rem
rem Usage:
rem   convert-cad-web.bat              (port 8787, all interfaces)
rem   convert-cad-web.bat --port 9000  (custom port)
setlocal
set "DIR=%~dp0"
node "%DIR%convert-cad-server.mjs" %*
set "code=%errorlevel%"
endlocal & exit /b %code%
