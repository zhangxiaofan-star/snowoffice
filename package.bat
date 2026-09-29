@echo off
rem GenOffice one-command Windows packaging.
rem Double-click me, or run from a terminal:  package.bat [flags]
rem Flags are passed straight through to scripts/package-win.mjs:
rem   --version 1.2.3        set the app version
rem   --bump patch|minor|major
rem   --skip-build           reuse the previous build output
rem   --skip-smoke           skip the launch check at the end
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo [FAIL] Node.js not found in PATH. Install Node.js 22+ first.
  pause
  exit /b 1
)

node scripts\package-win.mjs %*
set EXITCODE=%ERRORLEVEL%

echo.
if %EXITCODE%==0 (
  echo Packaging finished. Installer is in apps\shell\release\
) else (
  echo Packaging FAILED with exit code %EXITCODE%. See the log above.
)
pause
exit /b %EXITCODE%
