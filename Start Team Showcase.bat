@echo off
REM ===================================================================
REM  Team Showcase launcher
REM  Double-click to start. For start-up on boot, create a Task Scheduler
REM  task ("At log on" or "At startup") that runs this file.
REM ===================================================================
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo Python was not found on this machine.
  echo Please install Python 3.10+ from https://www.python.org/downloads/
  echo Make sure to tick "Add Python to PATH" during install.
  pause
  exit /b 1
)

echo Starting Team Showcase ...
start "" http://127.0.0.1:8090
python server.py
pause
