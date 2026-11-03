@echo off
rem jmbots: double-click this to make the watchdog start automatically at logon.
rem Keep this file ASCII only (cmd.exe misreads UTF-8 batch files).
rem Logic and Chinese text live in scripts\Install_Autostart.ts.
rem To turn it off: run this with the word remove, e.g.  Install_Autostart.cmd --remove

cd /d "%~dp0.."

where bun.cmd >nul 2>nul
if errorlevel 1 (
  echo bun.cmd not found in PATH. Install Bun or add it to PATH, then run this again.
  pause
  exit /b 1
)

call bun.cmd scripts\Install_Autostart.ts %*
echo.
pause
