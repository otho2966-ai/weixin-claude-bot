@echo off
chcp 65001 >nul
title WeChat Claude Bot - Login
setlocal enabledelayedexpansion

cd /d D:\code\weixin-claude-bot

echo ============================================
echo  WeChat Claude Bot - Login Setup
echo ============================================
echo.

:: Check Node.js
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org
  pause
  exit /b 1
)
echo [OK] Node.js found
echo.

:: Check npm install
if not exist node_modules (
  echo [..] Installing dependencies...
  call npm install
  if !ERRORLEVEL! neq 0 (
    echo [ERROR] npm install failed
    pause
    exit /b 1
  )
)
echo [OK] Dependencies ready
echo.

:: Check credentials
set CRED_FILE=%USERPROFILE%\.weixin-claude-bot\credentials.json
if exist "%CRED_FILE%" (
  echo [INFO] Already logged in!
  echo.
  set /p RELOGIN="Re-login? (y/N): "
  if /i "!RELOGIN!" neq "y" (
    goto :show_help
  )
  echo.
)

echo Start QR code login...
echo Please scan the QR code with WeChat to connect.
echo.
call npm run login
if !ERRORLEVEL! neq 0 (
  echo [ERROR] Login failed
  pause
  exit /b 1
)

:show_help
echo.
echo ============================================
echo  Ready to go!
echo ============================================
echo.
echo  Next steps:
echo    double-click start-all.bat
echo.
echo  See README.md for full documentation.
echo.
pause