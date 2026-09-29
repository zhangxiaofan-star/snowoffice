@echo off
rem ============================================================
rem  GenOffice offline development environment installer.
rem  Lives inside offline-kit\; run it on the FRESH machine after
rem  copying the whole repo folder (kit included) there.
rem  Installs per-user (no admin): Node.js, Rust, MinGW-w64,
rem  copies win-ocr.exe into the repo, extends the user PATH.
rem  npm dependencies are NOT offline: run `npm install` after.
rem ============================================================
setlocal EnableExtensions
cd /d "%~dp0"

rem kit dir = this script's dir; repo = its parent by default
set "KIT=%~dp0"
if "%KIT:~-1%"=="\" set "KIT=%KIT:~0,-1%"
set "REPO=%~dp0.."
if not "%~1"=="" set "REPO=%~1"
set "TOOLS=%LOCALAPPDATA%\GenOfficeTools"

echo === GenOffice offline environment setup ===
echo kit : %KIT%
echo repo: %REPO%
if not exist "%REPO%\package.json" (
  echo [FAIL] repo not found at %REPO% -- pass it as the first argument:
  echo        setup-dev.bat "E:\path\to\genoffice"
  pause
  exit /b 1
)

set "PS=powershell -NoProfile -Command"
set "ADDED="

rem ---- 1. portable Node.js ------------------------------------
where node >nul 2>nul
if not errorlevel 1 (
  echo [node] node.exe already on PATH, skipping
  goto :rust
)
set "NODESRC="
for /d %%D in ("%KIT%\node-v*-win-x64") do set "NODESRC=%%D"
if not defined NODESRC for %%F in ("%KIT%\node-v*-win-x64.zip") do set "NODEZIP=%%~fF"
if defined NODESRC (
  if exist "%NODESRC%\node.exe" set "NODEZIP="
) else if defined NODEZIP (
  echo [node] extracting %NODEZIP% ...
  powershell -NoProfile -Command "Expand-Archive -LiteralPath $env:NODEZIP -DestinationPath $env:TOOLS -Force"
  set "NODESRC="
  for /d %%D in ("%TOOLS%\node-v*-win-x64") do set "NODESRC=%%D"
)
if defined NODESRC if exist "%NODESRC%\node.exe" (
  robocopy "%NODESRC%" "%TOOLS%\node" /E /NFL /NDL /NJH /NJS /NP >nul
  if errorlevel 8 goto :fail
  call :addpath "%TOOLS%\node"
  echo [node] installed to %TOOLS%\node
) else (
  echo [node] not found in kit and no node.exe on PATH -- install Node.js 22+ manually
)

:rust
rem ---- 2. rust toolchain + cargo -------------------------------
if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  echo [rust] already installed, skipping
) else if exist "%KIT%\rust\.cargo\bin\cargo.exe" (
  echo [rust] restoring toolchain ^(about 1 GB, a few minutes^) ...
  robocopy "%KIT%\rust\.cargo" "%USERPROFILE%\.cargo" /E /NFL /NDL /NJH /NJS /NP >nul
  if errorlevel 8 goto :fail
  robocopy "%KIT%\rust\.rustup" "%USERPROFILE%\.rustup" /E /NFL /NDL /NJH /NJS /NP >nul
  if errorlevel 8 goto :fail
  call :addpath "%USERPROFILE%\.cargo\bin"
  echo [rust] installed to %USERPROFILE%
) else (
  echo [rust] not found in kit -- install rustup manually if needed
)

:mingw
rem ---- 3. MinGW-w64 --------------------------------------------
where gcc >nul 2>nul
if not errorlevel 1 (
  echo [mingw] gcc already on PATH, skipping
  goto :ocr
)
if exist "%TOOLS%\mingw64\bin\gcc.exe" (
  echo [mingw] already installed, skipping
) else if exist "%KIT%\mingw64\bin\gcc.exe" (
  echo [mingw] installing ^(about 1 GB, a few minutes^) ...
  robocopy "%KIT%\mingw64" "%TOOLS%\mingw64" /E /NFL /NDL /NJH /NJS /NP >nul
  if errorlevel 8 goto :fail
  call :addpath "%TOOLS%\mingw64\bin"
  echo [mingw] installed to %TOOLS%\mingw64
) else (
  echo [mingw] not found in kit
)

:ocr
rem ---- 4. prebuilt OCR helper into the repo --------------------
if exist "%KIT%\win-ocr.exe" if not exist "%REPO%\packages\pdf2docx\ocr-helper\win-ocr.exe" (
  copy /y "%KIT%\win-ocr.exe" "%REPO%\packages\pdf2docx\ocr-helper\win-ocr.exe" >nul
  echo [ocr] win-ocr.exe copied into the repo
)

echo.
echo === done ===
if defined ADDED echo PATH entries added for NEW terminals: %ADDED%
echo Next steps on this machine:
echo   1. open a NEW terminal ^(so the PATH changes apply^)
echo   2. cd to the repo and run:  npm install
echo   3. then:                    npm run package:win
pause
exit /b 0

:fail
echo [FAIL] robocopy could not copy a toolchain -- check disk space and rights.
pause
exit /b 1

rem ---- helper: append to the USER PATH (dedup, registry-safe) ----
:addpath
set "P=%~1"
if not exist "%P%" goto :eof
echo "%PATH%" | findstr /i /c:"%P%" >nul && goto :eof
%PS% "$p=[Environment]::GetEnvironmentVariable('Path','User'); [Environment]::SetEnvironmentVariable('Path', ($p.TrimEnd(';') + ';%P%'), 'User')" >nul
set "ADDED=%ADDED%; %P%"
goto :eof
