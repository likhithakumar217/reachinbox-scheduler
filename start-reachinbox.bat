
@echo off
title ReachInbox Startup

cd /d C:\Users\kavan\reachinbox-scheduler

echo Starting Docker services...
docker compose up -d

if errorlevel 1 (
    echo Docker services failed to start. Please check Docker Desktop.
    pause
    exit /b 1
)

echo Starting Backend API...
start "ReachInbox Backend" cmd /k "cd /d C:\Users\kavan\reachinbox-scheduler\backend && npm run dev"

timeout /t 5 /nobreak >nul

echo Starting Email Worker...
start "ReachInbox Worker" cmd /k "cd /d C:\Users\kavan\reachinbox-scheduler\backend && npm run worker"

echo Starting Frontend...
start "ReachInbox Frontend" cmd /k "cd /d C:\Users\kavan\reachinbox-scheduler && npm run dev"

echo.
echo Startup commands launched.
echo Wait for the frontend terminal to show its Local URL.
pause
