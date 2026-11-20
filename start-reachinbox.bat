@echo off
cd /d "%~dp0"
if not exist backend\.env (
  echo Copy backend\.env.example to backend\.env and fill Ethereal SMTP credentials first.
  pause
  exit /b 1
)
docker compose up -d
if errorlevel 1 exit /b 1
start "ReachInbox Backend" cmd /k "cd backend && npm run dev"
start "ReachInbox Worker" cmd /k "cd backend && npm run worker"
call npm run dev
pause
