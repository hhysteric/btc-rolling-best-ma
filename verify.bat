@echo off
rem ---------------------------------------------------------------------------
rem  Run scripts/verify_rolling.mjs and keep the window open.
rem
rem  What it checks: js/rolling.js computes each 4-year window return with
rem  log-space prefix sums (O(1) per window). This script re-computes the same
rem  windows with the plain bar-by-bar simulation and compares them, so the
rem  speed optimisation is proven not to have changed any conclusion.
rem
rem  Double-click me for the default sampling, or pass a stricter grid:
rem      verify.bat 20 120 3      ->  SAMPLES=20 PMAX=120 PSTEP=3
rem
rem  ASCII only on purpose: Chinese text in .bat depends on the console code page.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto no_node
if not exist "data\btc-daily.json" goto no_data

if not "%~1"=="" set SAMPLES=%~1
if not "%~2"=="" set PMAX=%~2
if not "%~3"=="" set PSTEP=%~3

echo ===========================================================
echo   verify_rolling.mjs
node --version
echo   SAMPLES=%SAMPLES%  PMAX=%PMAX%  PSTEP=%PSTEP%   (blank = script default)
echo ===========================================================
echo.

node scripts/verify_rolling.mjs
if errorlevel 1 goto failed

echo.
echo [OK] fast implementation matches the bar-by-bar simulation.
echo.
pause
exit /b 0

:failed
echo.
echo [X] the script reported a problem (see the lines above).
echo     Copy the output and show it to me.
echo.
pause
exit /b 1

:no_node
echo [X] node not found on this machine.
echo     Install Node.js LTS from https://nodejs.org/ (default options are fine),
echo     then close every console window and double-click this file again.
echo.
pause
exit /b 1

:no_data
echo [X] data\btc-daily.json is missing. Double-click copy_data.bat first.
echo.
pause
exit /b 1
