@echo off
setlocal
title Aurora Vault - package
cd /d "%~dp0"

rem Creates aurora-vault.zip for sharing or backup.
rem Your login (session\) and your downloads (downloads\) are NOT included.

powershell -NoProfile -Command "Compress-Archive -Force -DestinationPath 'aurora-vault.zip' -Path 'public','lib','server.js','package.json','package-lock.json','start.bat','pack.bat','README.md'"
if errorlevel 1 (
    echo   Packaging failed.
    pause
    exit /b 1
)
echo.
echo   Done: aurora-vault.zip
echo.
pause
