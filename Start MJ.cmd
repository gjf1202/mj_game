@echo off
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required: https://nodejs.org/
  pause
  exit /b 1
)
node -e "const major=Number(process.versions.node.split('.')[0]);if(major<18){console.error('Node.js 18 or newer is required.');process.exit(1)}"
if errorlevel 1 (
  pause
  exit /b 1
)
echo.
echo Keep this window open while playing. Press Ctrl+C to stop.
echo.
npm start
pause
