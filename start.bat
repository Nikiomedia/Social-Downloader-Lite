@echo off
setlocal
title Aurora Vault Lite
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo.
    echo   Node.js was not found.
    echo   Install the LTS version from https://nodejs.org and start this file again.
    echo.
    start "" "https://nodejs.org/en/download"
    pause
    exit /b 1
)

if not exist "node_modules\playwright-core\package.json" (
    echo.
    echo   First start: installing dependencies ^(one time only^) ...
    echo.
    call npm install --no-fund --no-audit --loglevel=error
    if errorlevel 1 (
        echo.
        echo   npm install failed. Check the internet connection and try again.
        pause
        exit /b 1
    )
)

node server.js
if errorlevel 1 pause
