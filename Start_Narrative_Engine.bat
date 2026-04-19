@echo off
title Narrative Engine
echo Installing dependencies...
cd /d "%~dp0"
call npm install
echo Starting the application...
start cmd /c "timeout /t 3 /nobreak > nul & start http://localhost:5173"
npm run dev
pause