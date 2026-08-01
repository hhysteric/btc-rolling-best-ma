@echo off
rem ---------------------------------------------------------------------------
rem  Commit the current working tree and push to GitHub.
rem  Double-click me after I (Claude) change files, or run with a message:
rem      push_update.bat "feat: something"
rem  ASCII only on purpose: Chinese text in .bat depends on the console code page.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"

set MSG=%~1
if "%MSG%"=="" set MSG=feat: split rolling series into 4 charts, add custom MA backtest, fix axis ticks

echo ===========================================================
echo   commit + push  btc-rolling-best-ma
echo   message: %MSG%
echo ===========================================================
echo.

where git >nul 2>nul
if errorlevel 1 goto no_git
if not exist ".git" goto no_repo

echo [1/3] git add -A
git add -A

git diff --cached --quiet
if not errorlevel 1 goto nothing

echo [2/3] git commit
git commit -m "%MSG%"
if errorlevel 1 goto fail_commit
goto push

:nothing
echo        nothing new to commit, will still try to push
:push
echo [3/3] git push
git push
if errorlevel 1 goto fail_push

echo.
echo [OK] pushed. GitHub Pages rebuilds in about a minute:
echo      https://hhysteric.github.io/btc-rolling-best-ma/
echo      (hard-refresh with Ctrl+F5 to bypass the browser cache)
echo.
pause
exit /b 0

:no_git
echo [X] git not found. Install Git for Windows: https://git-scm.com/download/win
echo.
pause
exit /b 1

:no_repo
echo [X] no .git here. Run push_github.bat first.
echo.
pause
exit /b 1

:fail_commit
echo [X] git commit failed. See the message above.
echo.
pause
exit /b 1

:fail_push
echo [X] git push failed. If it says "no upstream branch", run:
echo       git push -u origin main
echo     If github.com is unreachable, see section 5 of DEPLOY.md.
echo.
pause
exit /b 1
