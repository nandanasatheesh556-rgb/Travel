@echo off
cd /d "%~dp0"
echo Starting AI Travel Planner...
echo.
echo Keep this window open while using http://127.0.0.1:3000
echo Press Ctrl+C here when you want to stop the server.
echo.
start "" powershell.exe -NoProfile -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:3000'"
npm.cmd start
echo.
echo Server stopped or failed to start.
pause
