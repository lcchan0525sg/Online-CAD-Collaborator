@echo off
setlocal
cd /d "%~dp0"

set "PORT=8088"
if not "%~1"=="" set "PORT=%~1"
if exist "port.txt" set /p PORT=<port.txt

echo Starting CAD Viewer on port %PORT% ...
start "" http://localhost:%PORT%/
set PORT=%PORT%
node server.js
pause
