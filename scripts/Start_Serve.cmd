@echo off
rem jmbots: double-click this to start the service with a watchdog.
rem Keep this file ASCII only. cmd.exe reads batch files with the local code page
rem and once executed fragments of UTF-8 Chinese comments as commands.
rem All logic and Chinese text live in scripts\Start_Serve.ts.

cd /d "%~dp0.."

where bun.cmd >nul 2>nul
if errorlevel 1 (
  echo bun.cmd not found in PATH. Install Bun or add it to PATH, then run this again.
  pause
  exit /b 1
)

call bun.cmd scripts\Start_Serve.ts %*
echo.
pause
