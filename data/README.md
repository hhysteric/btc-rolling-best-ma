# data/

本目录放行情数据文件 `btc-daily.json`，格式与 `btc-quant-backtest` 完全一致：

```json
{
  "source": "CoinMarketCap",
  "fields": ["date", "open", "high", "low", "close"],
  "start": "2010-07-13",
  "end":   "2026-04-13",
  "count": 5754,
  "rows": [["2010-07-13", 0.05, 0.06, 0.05, 0.06], ...]
}
```

`rows` 必须按日期升序，日期为 UTC 自然日。页面只读 `rows`（以及 `source` 用于页脚署名），
其余字段由 `scripts/update_data.py` 维护。

准备方式（二选一）：

```bat
copy ..\btc-quant-backtest\data\btc-daily.json btc-daily.json
```

```bash
python ../scripts/update_data.py --bootstrap
```

日常增量更新交给 GitHub Actions（`.github/workflows/update-data.yml`），
也可以手动 `python scripts/update_data.py`。
