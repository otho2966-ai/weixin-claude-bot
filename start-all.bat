@echo off
chcp 65001 >nul
title WeChat Claude Bot - All Services

cd /d D:\code\weixin-claude-bot

echo ==============================================
echo  WeChat Claude Bot - One-Click Start
echo ==============================================
echo.

:: Use existing env vars or set defaults
if "%ANTHROPIC_BASE_URL%"=="" set ANTHROPIC_BASE_URL=https://api.deepseek.com/anthropic
if "%ANTHROPIC_API_KEY%"=="" (
  echo [WARNING] ANTHROPIC_API_KEY not set!
  echo   Create a .env file or set it manually.
  echo   Press any key to continue anyway...
  pause >nul
)
echo.

echo [1/3] Starting WeChat Agent...
start "WeChat Agent" cmd /c "chcp 65001 >nul ^&^& title WeChat Agent ^&^& cd /d D:\code\weixin-claude-bot ^&^& node wechat-agent.js"
timeout /t 3 /nobreak >nul
echo [2/3] Starting Auto-Reply...
start "Auto-Reply" cmd /c "chcp 65001 >nul ^&^& title Auto-Reply ^&^& cd /d D:\code\weixin-claude-bot ^&^& set ANTHROPIC_BASE_URL=%ANTHROPIC_BASE_URL% ^&^& set ANTHROPIC_API_KEY=%ANTHROPIC_API_KEY% ^&^& node wechat-autoreply.js"
echo.
echo [3/3] Both services started!
echo.
echo ==============================================
echo  Agent:     http://localhost:3456
echo  Autoreply: watching WeChat messages
echo  Close windows to stop services.
echo ==============================================
echo.
pause