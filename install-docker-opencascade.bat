@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul
title CAD Viewer - Docker + OpenCascade installer
cd /d "%~dp0"

echo ============================================================
echo   CAD Viewer — Docker + OpenCascade (chair-cq:local) setup
echo ============================================================
echo.
echo This installs the STEP-file converter that the CAD Viewer needs.
echo Two parts:
echo   1. Docker Desktop (free)            - container runtime
echo   2. "chair-cq:local" image           - OpenCascade CAD kernel
echo.
echo GLB/GLTF files work WITHOUT any of this — it is only required
echo for .step / .stp files.
echo.

:: ---------------- 1. Docker check ----------------
echo [1/4] Checking Docker...
where docker >nul 2>nul
if %errorlevel%==0 (
    echo       Docker found: 
    docker --version
    goto :docker_running
)

echo       Docker is NOT installed.
echo.
echo       Installing Docker Desktop via winget (this may take several minutes
echo       and downloads ~500 MB). You may be prompted to accept agreements.
echo.
choice /c YN /m "Proceed with Docker Desktop installation"
if errorlevel 2 (
    echo       Skipped. You can install Docker Desktop manually from
    echo       https://www.docker.com/products/docker-desktop/
    echo       then re-run this script.
    pause
    exit /b 1
)

winget install --id Docker.DockerDesktop -e --accept-source-agreements --accept-package-agreements
if errorlevel 1 (
    echo.
    echo       Docker Desktop install failed or was cancelled.
    echo       Install it manually from https://www.docker.com/products/docker-desktop/
    echo       then re-run this script.
    pause
    exit /b 1
)

echo.
echo       Docker Desktop installed. Starting it...
if exist "%ProgramFiles%\Docker\Docker\Docker Desktop.exe" (
    start "" "%ProgramFiles%\Docker\Docker\Docker Desktop.exe"
) else if exist "%LOCALAPPDATA%\Docker\Docker Desktop.exe" (
    start "" "%LOCALAPPDATA%\Docker\Docker Desktop.exe"
)

:docker_running
echo.
echo [2/4] Waiting for the Docker engine (first start takes a while)...
set /a tries=0
:wait_loop
docker info >nul 2>nul
if %errorlevel%==0 goto :docker_ok
set /a tries+=1
if %tries% geq 120 (
    echo.
    echo       Docker engine did not come up within ~4 minutes.
    echo       Open "Docker Desktop" and make sure it shows "Engine running",
    echo       then re-run this script.
    pause
    exit /b 1
)
<nul set /p "=.  "
timeout /t 2 /nobreak >nul
goto :wait_loop

:docker_ok
echo.
echo       Docker engine is running.
echo.

:: ---------------- 2. chair-cq:local image ----------------
echo [3/4] Checking for the "chair-cq:local" OpenCascade image...
docker image inspect chair-cq:local >nul 2>nul
if %errorlevel%==0 (
    echo       Image already present:
    docker images chair-cq:local --format "  {{.Repository}}:{{.Tag}}  {{.Size}}"
    goto :verify
)

echo       Image not found. Building it now — first build downloads ~1 GB
echo       (python:3.11-slim + cadquery/OpenCascade) and can take 5-15 min.
echo.
if not exist "Dockerfile" (
    echo       ERROR: Dockerfile not found next to this script.
    echo       Re-copy it from the cad-viewer-web build folder.
    pause
    exit /b 1
)
choice /c YN /m "Proceed with image build"
if errorlevel 2 (
    echo       Skipped. The image can be built later with:
    echo         docker build -t chair-cq:local .
    pause
    exit /b 1
)

echo.
echo       Building chair-cq:local ...
docker build -t chair-cq:local .
if errorlevel 1 (
    echo.
    echo       Build failed. Check your internet connection / Docker and
    echo       re-run this script.
    pause
    exit /b 1
)
echo       Build finished.

:: ---------------- 3. Verify the image works ----------------
:verify
echo.
echo [4/4] Verifying the OpenCascade kernel inside the image...
set "T=%TEMP%\cadv-step-test"
if not exist "%T%" mkdir "%T%"
docker run --rm chair-cq:local python -c "from OCP.STEPControl import STEPControl_Reader; r=STEPControl_Reader(); print('OCP OK - STEP reader ready')" >"%T%\log.txt" 2>&1
if errorlevel 1 (
    echo       Kernel check FAILED. Last log lines:
    type "%T%\log.txt" | findstr /v "^$"
) else (
    type "%T%\log.txt" | findstr "OCP OK"
    echo       Kernel ready — STEP conversion will work.
)

:done
echo.
echo ============================================================
echo   Setup complete.
echo   Start the CAD Viewer with start.bat, then open a .step file.
echo ============================================================
pause
exit /b 0
