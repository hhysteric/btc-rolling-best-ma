@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo  复制日线数据到 data\btc-daily.json
echo ============================================================

set "SRC=..\btc-quant-backtest\data\btc-daily.json"

if not exist "%SRC%" (
    echo [x] 找不到 %SRC%
    echo     请确认 btc-quant-backtest 与本项目在同一层目录（都在桌面）。
    echo     也可以改用：python scripts\update_data.py --bootstrap
    echo.
    pause
    exit /b 1
)

if not exist "data" mkdir "data"
copy /y "%SRC%" "data\btc-daily.json"
if errorlevel 1 (
    echo [x] 复制失败。
    pause
    exit /b 1
)

echo.
echo [√] 已复制到 data\btc-daily.json
echo     回到浏览器按 Ctrl+F5 强制刷新即可（本地服务器不用重启）。
echo.
pause
