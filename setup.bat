@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================================
echo  4Y Rolling Best MA - 本地启动
echo ============================================================

if exist "data\btc-daily.json" (
    echo [1/2] 数据文件已存在，跳过复制。
) else (
    if exist "..\btc-quant-backtest\data\btc-daily.json" (
        echo [1/2] 从 btc-quant-backtest 复制日线数据...
        copy /y "..\btc-quant-backtest\data\btc-daily.json" "data\btc-daily.json" >nul
        echo       完成。
    ) else (
        echo [1/2] 未找到 ..\btc-quant-backtest\data\btc-daily.json
        echo       请手动放入 data\btc-daily.json，或运行：
        echo         python scripts\update_data.py --bootstrap
        pause
        exit /b 1
    )
)

echo [2/2] 启动本地服务器 http://localhost:8080
echo       ( file:// 打开会被浏览器拦掉 fetch 和 Worker，必须走 http )
echo       按 Ctrl+C 结束。
start "" http://localhost:8080
python -m http.server 8080
