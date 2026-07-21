@echo off
setlocal
title SceneColor Workbench

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-workbench.ps1"
set "EXIT_CODE=%ERRORLEVEL%"

if not "%EXIT_CODE%"=="0" (
  echo.
  echo [ERROR] SceneColor did not start successfully.
  pause
)

exit /b %EXIT_CODE%
