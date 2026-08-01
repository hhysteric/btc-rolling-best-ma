@echo off
rem ---------------------------------------------------------------------------
rem  Commit, sync with GitHub, then push.
rem  Double-click me, or run with a message:  push_update.bat "feat: something"
rem
rem  Why the sync step: the daily update-data Action commits data/btc-daily.json
rem  on GitHub, so the remote is often one commit ahead of your machine and a
rem  plain "git push" is rejected with "fetch first". This script rebases your
rem  commits on top of the remote, and if the only clash is that machine-made
rem  data file it keeps the remote copy (it is the fresher one).
rem
rem  ASCII only on purpose: Chinese text in .bat depends on the console code page.
rem ---------------------------------------------------------------------------
cd /d "%~dp0"
set GIT_EDITOR=true

set MSG=%~1
if "%MSG%"=="" set MSG=feat: split rolling series into 4 charts, add custom MA backtest, fix axis ticks

echo ===========================================================
echo   commit + sync + push   btc-rolling-best-ma
echo   message: %MSG%
echo ===========================================================
echo.

where git >nul 2>nul
if errorlevel 1 goto no_git
if not exist ".git" goto no_repo

echo [1/4] git add -A
git add -A

git diff --cached --quiet
if not errorlevel 1 goto nothing

echo [2/4] git commit
git commit -m "%MSG%"
if errorlevel 1 goto fail_commit
goto sync

:nothing
echo        nothing new to commit

:sync
echo [3/4] git fetch + rebase onto origin/main
git fetch origin main
if errorlevel 1 goto fail_fetch
git rebase origin/main
if errorlevel 1 goto conflict
goto push

:conflict
echo.
echo [!] rebase stopped on a conflict. Checking whether it is only the data file...
git diff --name-only --diff-filter=U > "%TEMP%\brbm_conflicts.txt"
type "%TEMP%\brbm_conflicts.txt"
findstr /v /c:"data/btc-daily.json" "%TEMP%\brbm_conflicts.txt" | findstr /r /c:"." >nul
if not errorlevel 1 goto fail_conflict_other

echo     Only data/btc-daily.json clashed. Keeping the copy from GitHub
echo     (it is produced by the daily Action, so it is the fresher one).
git checkout --ours -- data/btc-daily.json
git add data/btc-daily.json
git rebase --continue
if errorlevel 1 goto fail_conflict_other
goto push

:push
echo [4/4] git push
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

:fail_fetch
echo [X] git fetch failed - cannot reach github.com right now.
echo     Your commit is safe locally; just run this script again later.
echo.
pause
exit /b 1

:fail_conflict_other
echo.
echo [X] Real conflicts in source files (listed above). Nothing was lost.
echo     Either resolve them by hand:
echo         git status
echo         (edit the files, then)  git add ^<file^>  ^&^&  git rebase --continue
echo     Or back out of the rebase and ask for help:
echo         git rebase --abort
echo.
pause
exit /b 1

:fail_push
echo [X] git push still failed. Show me the message above.
echo     If it says "no upstream branch":  git push -u origin main
echo     If github.com is unreachable, see section 5 of DEPLOY.md.
echo.
pause
exit /b 1
