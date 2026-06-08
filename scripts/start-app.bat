@echo off
rem 免安裝啟動器（Windows）：啟動公文系統伺服器並開啟瀏覽器。
rem 需求：已安裝 Node.js。直接雙擊本檔即可。

cd /d "%~dp0.."

where node >nul 2>nul
if errorlevel 1 (
  echo 找不到 Node.js，請先安裝： https://nodejs.org/
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=3000
echo 啟動公文系統... http://localhost:%PORT%
start "" http://localhost:%PORT%
node server.js
pause
