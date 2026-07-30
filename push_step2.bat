@echo off
rem ---------------------------------------------------------------------------
rem  Step 2: after you created the EMPTY repo on github.com, this adds the
rem  remote and pushes main. Safe to run more than once.
rem      https://github.com/new  ->  name: btc-rolling-best-ma  (no README!)
rem ---------------------------------------------------------------------------
cd /d "%~dp0"

set REPO=btc-rolling-best-ma
set OWNER=hhysteric
set URL=https://github.com/%OWNER%/%REPO%.git

echo ===========================================================
echo   Step 2: set remote + push
echo   %URL%
echo ===========================================================
echo.

if not exist ".git" goto no_repo

rem commit anything added since the first run (e.g. this script itself)
git add -A
git diff --cached --quiet
if errorlevel 1 git commit -m "chore: add push helper scripts"

git remote get-url origin >nul 2>nul
if errorlevel 1 goto add_remote
echo [1/2] origin already set, pointing it at %URL%
git remote set-url origin %URL%
goto push

:add_remote
echo [1/2] git remote add origin %URL%
git remote add origin %URL%
if errorlevel 1 goto fail_remote

:push
echo [2/2] git push -u origin main
git push -u origin main
if errorlevel 1 goto fail_push

echo.
echo [OK] pushed. Now on the website:
echo   1. Settings ^> Pages ^> Source = Deploy from a branch, branch main, folder / (root)
echo      Site URL: https://%OWNER%.github.io/%REPO%/
echo   2. Settings ^> Actions ^> General ^> Workflow permissions = Read and write
echo.
pause
exit /b 0

:no_repo
echo [X] no .git here. Run push_github.bat first.
echo.
pause
exit /b 1

:fail_remote
echo [X] git remote add failed. See the message above.
echo.
pause
exit /b 1

:fail_push
echo [X] push failed. Common causes:
echo   * "Repository not found"  -> the repo does not exist yet, or the name/owner
echo     is different. Create it at https://github.com/new named %REPO%.
echo   * Auth prompt / 403       -> sign in via the Git Credential Manager window,
echo     or use a Personal Access Token as the password.
echo   * Cannot reach github.com -> see section 5 of DEPLOY.md (SSH over 443,
echo     or committing through api.github.com).
echo.
pause
exit /b 1
