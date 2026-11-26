@echo off
title Narrative Engine
cd /d "%~dp0"

REM ===== Pre-flight checks =====
where node >nul 2>nul
if not errorlevel 1 goto :node_found

REM Fallback: Explorer sometimes spawns cmd with a stale PATH that
REM predates the Node.js install. Try the default install locations.
if exist "C:\Program Files\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files\nodejs\"

where node >nul 2>nul
if not errorlevel 1 goto :node_found

if exist "C:\Program Files (x86)\nodejs\node.exe" set "PATH=%PATH%;C:\Program Files (x86)\nodejs\"

where node >nul 2>nul
if not errorlevel 1 goto :node_found

echo.
echo [STOP] Node.js is not installed on this computer.
echo.
echo This app needs Node.js to run. To install it:
echo   1. Open your web browser and go to https://nodejs.org/
echo   2. Download the "LTS" version (the green button)
echo   3. Run the installer - just click Next through all the steps
echo   4. Close this window and double-click
echo      Start_Narrative_Engine.bat again
echo.
pause
exit /b 1

:node_found
REM Get clean Node version string (e.g. 22.14.0)
for /f "delims=" %%v in ('node -p "process.versions.node" 2^>nul') do set "NODE_VERSION=%%v"

REM Guard: if node.exe exists but would not run, NODE_VERSION stays
REM empty and the version compare below would be a syntax error that
REM closes the window with no message.
if defined NODE_VERSION goto :node_version_read
echo [STOP] Node.js is installed but could not be started.
echo.
echo Your Node.js installation may be damaged.
echo Reinstalling it usually fixes this:
echo   1. Open your web browser and go to https://nodejs.org/
echo   2. Download the "LTS" version - the green button
echo   3. Run the installer - just click Next through all steps
echo   4. Come back and double-click this file again
echo.
pause
exit /b 1

:node_version_read

REM Parse major and minor
for /f "tokens=1,2 delims=." %%a in ("%NODE_VERSION%") do (
    set "NODE_MAJOR=%%a"
    set "NODE_MINOR=%%b"
)

REM Remove leading zeros so 09 doesn't break comparison
if "%NODE_MAJOR:~0,1%"=="0" set "NODE_MAJOR=%NODE_MAJOR:~1%"
if "%NODE_MINOR:~0,1%"=="0" set "NODE_MINOR=%NODE_MINOR:~1%"

REM Compare against required 20.19.0
set "REQUIRED_MAJOR=20"
set "REQUIRED_MINOR=19"

REM If major is greater than required, we're fine
if %NODE_MAJOR% GTR %REQUIRED_MAJOR% goto :node_ok
REM If major equals required, check minor
if %NODE_MAJOR% EQU %REQUIRED_MAJOR% (
    if %NODE_MINOR% GEQ %REQUIRED_MINOR% goto :node_ok
)

REM Too old
echo.
echo [STOP] Your version of Node.js is too old for this app.
echo.
echo You have version %NODE_VERSION%. The app needs version 20.19 or newer.
echo.
echo To fix this:
echo   1. Open your web browser and go to https://nodejs.org/
echo   2. Download the "LTS" version (the green button)
echo   3. Run the installer - just click Next through all the steps
echo   4. Close this window and double-click
echo      Start_Narrative_Engine.bat again
echo.
echo --------------------------------------------
echo Already upgraded Node but the app still won't start?
echo --------------------------------------------
echo There is a second file in this folder called
echo "Repair_Narrative_Engine.bat". Double-click it
echo and it will fix the app's database file to match
echo your new Node version. It will:
echo   - Ask you to type YES before doing anything
echo   - NOT change your Node.js version
echo   - NOT delete your saved campaigns or data
echo   - NOT touch any other programs on your computer
echo You must open that file yourself - this window
echo will not do it for you.
echo.
pause
exit /b 1

:node_ok
echo Node %NODE_VERSION% detected - OK.
echo.

REM ===== Main flow =====
REM Only run npm install when dependencies changed since the last
REM good install (or Node was upgraded), so normal starts stay fast.
node scripts\check-install.mjs
if not errorlevel 1 goto :deps_ok
echo Installing dependencies...
call npm install
if errorlevel 1 goto :deps_done
node scripts\check-install.mjs stamp
goto :deps_done

:deps_ok
echo Dependencies up to date - OK.

:deps_done
echo.

REM ===== Build the local engine package if its output is missing =====
REM The app imports @narrative/engine from packages/engine, whose
REM compiled dist/ output is git-ignored and must be built locally.
REM Without it the app fails on startup with:
REM   Failed to resolve import "@narrative/engine"
REM Only built when missing, so normal starts stay fast.
if not exist "packages\engine\package.json" goto :engine_ok
if exist "packages\engine\dist\index.js" goto :engine_ok
echo.
echo Building the game engine - this only happens
echo when it is missing, usually just the first run...
echo.
call npm run build --prefix packages/engine
if errorlevel 1 goto :engine_build_failed
if not exist "packages\engine\dist\index.js" goto :engine_build_failed
echo.
echo Engine build complete - OK.
echo.
goto :engine_ok

:engine_build_failed
echo.
echo ============================================
echo   [STOP] The game engine could not be built.
echo ============================================
echo.
echo One part of the app - the game engine - could
echo not be compiled, so the app cannot start yet.
echo.
echo Your saved campaigns and settings are safe.
echo.
echo What to do:
echo   1. Close this window and double-click this
echo      file again - this can be a one-off problem.
echo   2. If it fails again, take a screenshot or
echo      photo of ALL the text in this window -
echo      especially any lines containing the word
echo      "error" - and send it to support.
echo.
pause
exit /b 1

:engine_ok
echo Starting the application...
start cmd /c "timeout /t 3 /nobreak > nul & start http://localhost:5173"
npm run dev
pause