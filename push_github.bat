@echo off
rem ---------------------------------------------------------------------------
rem  push btc-rolling-best-ma to GitHub
rem  Messages are ASCII on purpose: Chinese text inside .bat files depends on the
rem  console code page and can break parsing on some systems.
rem  If the window still closes instantly, run it from a console:
rem      cmd /k "%USERPROFILE%\Desktop\btc-rolling-best-ma\push_github.bat"
rem ---------------------------------------------------------------------------
cd /d "%~dp0"

set REPO=btc-rolling-best-ma
set OWNER=hhysteric

echo ===========================================================
echo   Push %REPO% to GitHub (%OWNER%)
echo ===========================================================
echo.

where git >nul 2>nul
if errorlevel 1 goto no_git

if not exist "data\btc-daily.json" goto no_data

if exist ".git" goto have_repo
echo [1/4] git init
git init -b main
if errorlevel 1 goto fail_init
git config user.name "hhysteric"
git config user.email "55535959+hhysteric@users.noreply.github.com"
goto staged

:have_repo
echo [1/4] already a git repo, skip init

:staged
echo [2/4] git add / commit
git add -A
git diff --cached --quiet
if not errorlevel 1 goto nothing_to_commit
git commit -m "feat: 4Y Rolling Best MA site (with 4-year cycle alignment views)"
if errorlevel 1 goto fail_commit
goto check_remote

:nothing_to_commit
echo        nothing to commit

:check_remote
echo [3/4] check remote
git remote get-url origin >nul 2>nul
if not errorlevel 1 goto do_push

where gh >nul 2>nul
if errorlevel 1 goto no_remote_no_gh
echo        creating repo with GitHub CLI
gh repo create %REPO% --public --source=. --remote=origin --push
if errorlevel 1 goto fail_gh
goto done

:do_push
echo [4/4] git push
git push -u origin main
if errorlevel 1 goto fail_push
goto done

:done
echo.
echo [OK] pushed.
echo.
echo Next, two switches on the GitHub website:
echo   1. Settings ^> Pages ^> Source = Deploy from a branch, branch main, folder / (root)
echo      Site URL: https://%OWNER%.github.io/%REPO%/
echo   2. Settings ^> Actions ^> General ^> Workflow permissions = Read and write
echo      (otherwise the daily data-update Action cannot commit)
echo.
pause
exit /b 0

:no_git
echo [X] git not found. Install Git for Windows first: https://git-scm.com/download/win
echo.
pause
exit /b 1

:no_data
echo [X] data\btc-daily.json is missing. Double-click copy_data.bat first.
echo.
pause
exit /b 1

:fail_init
echo [X] git init failed. See the message above.
echo.
pause
exit /b 1

:fail_commit
echo [X] git commit failed. Often this is a missing identity; try:
echo       git config --global user.name  "hhysteric"
echo       git config --global user.email "55535959+hhysteric@users.noreply.github.com"
echo.
pause
exit /b 1

:no_remote_no_gh
echo [!] No "origin" remote and GitHub CLI is not installed.
echo     1. Create an EMPTY repo at https://github.com/new named %REPO%
echo        (do NOT add README or .gitignore)
echo     2. Then run these two commands here:
echo          git remote add origin https://github.com/%OWNER%/%REPO%.git
echo          git push -u origin main
echo.
pause
exit /b 1

:fail_gh
echo [X] "gh repo create" failed. See the message above, or do it manually:
echo       git remote add origin https://github.com/%OWNER%/%REPO%.git
echo       git push -u origin main
echo.
pause
exit /b 1

:fail_push
echo [X] git push failed.
echo     If github.com is unreachable, see section 5 of DEPLOY.md
echo     (SSH over port 443, or committing through api.github.com).
echo.
pause
exit /b 1
