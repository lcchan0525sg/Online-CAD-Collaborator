@echo off
setlocal
cd /d "%~dp0"

set "PORT=8088"
if not "%~1"=="" set "PORT=%~1"
if exist "port.txt" set /p PORT=<port.txt

if not defined CAD_PYTHON if exist "%~dp0python\python.exe" set "CAD_PYTHON=%~dp0python\python.exe"
if not defined CAD_PYTHON if exist "%USERPROFILE%\venvs\cad-native\Scripts\python.exe" set "CAD_PYTHON=%USERPROFILE%\venvs\cad-native\Scripts\python.exe"
if not defined CAD_BACKEND set "CAD_BACKEND=auto"

echo Starting CAD Viewer on port %PORT% ...
if defined CAD_PYTHON echo CAD backend: native-first (%CAD_PYTHON%)
if not defined CAD_PYTHON echo CAD backend: auto (native if available, Docker fallback)
start "" http://localhost:%PORT%/
set PORT=%PORT%
node src\server.js
pause
