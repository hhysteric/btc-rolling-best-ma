#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
data/btc-daily.json 增量更新脚本（供 GitHub Actions 每日调用，也可本地手动跑）。

设计原则（与项目其余部分一致）：
  * 绝不编造数据。拿不到就不写，宁可让页面显示"数据截止到 X 日"。
  * 只写"已收盘"的完整 UTC 日，当天未走完的行情不入库。
  * 只追加与覆盖已有日期，不改动历史区间的既有数值（除非 --overwrite）。

数据源（都提供真实 OHLC，无需近似）：
  1. Binance BTCUSDT 1d —— api.binance.com / data-api.binance.vision / api1.binance.com
  2. Coinbase Exchange BTC-USD 1d —— api.exchange.coinbase.com（Binance 全部不可达时的备份）

用法：
  python scripts/update_data.py                # 增量补到昨天（UTC）
  python scripts/update_data.py --dry-run      # 只打印会补哪些天，不写文件
  python scripts/update_data.py --bootstrap    # 文件不存在时，用公开接口新建（历史起点受接口限制）
"""

import argparse
import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request

DAY = 86400
UA = "btc-rolling-best-ma/1.0 (+https://github.com/)"

BINANCE_HOSTS = [
    "https://api.binance.com",
    "https://data-api.binance.vision",
    "https://api1.binance.com",
]
COINBASE = "https://api.exchange.coinbase.com"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_FILE = os.path.join(ROOT, "data", "btc-daily.json")


def log(*a):
    print(*a, flush=True)


def http_json(url, timeout=20, retries=2):
    last = None
    for attempt in range(retries + 1):
        req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, ValueError) as e:
            last = e
            if attempt < retries:
                time.sleep(1.5 * (attempt + 1))
    raise RuntimeError("%s -> %s" % (url, last))


def utc_today_ms():
    d = dt.datetime.now(dt.timezone.utc).date()
    return int(dt.datetime(d.year, d.month, d.day, tzinfo=dt.timezone.utc).timestamp()) * 1000


def day_str(ms):
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%d")


# ----------------------------------------------------------------- 数据源
def fetch_binance(start_ms, end_ms):
    """返回 [[date, open, high, low, close], ...]，只含 [start_ms, end_ms) 内的完整日。"""
    rows, cursor = [], start_ms
    while cursor < end_ms:
        path = ("/api/v3/klines?symbol=BTCUSDT&interval=1d"
                "&startTime=%d&endTime=%d&limit=1000" % (cursor, end_ms - 1))
        data = None
        err = None
        for host in BINANCE_HOSTS:
            try:
                data = http_json(host + path)
                break
            except RuntimeError as e:
                err = e
        if data is None:
            raise RuntimeError("Binance 全部节点不可达：%s" % err)
        if not data:
            break
        for k in data:
            t = int(k[0])
            if t >= end_ms:
                continue
            rows.append([day_str(t), float(k[1]), float(k[2]), float(k[3]), float(k[4])])
        if len(data) < 1000:
            break
        cursor = int(data[-1][0]) + 1
    return rows


def fetch_coinbase(start_ms, end_ms):
    """Coinbase 每次最多 300 根，按段抓取。"""
    rows = []
    cursor = start_ms // 1000
    end_s = end_ms // 1000
    while cursor < end_s:
        stop = min(cursor + 300 * DAY, end_s)
        url = ("%s/products/BTC-USD/candles?granularity=86400&start=%s&end=%s"
               % (COINBASE, dt.datetime.fromtimestamp(cursor, dt.timezone.utc).isoformat(),
                  dt.datetime.fromtimestamp(stop, dt.timezone.utc).isoformat()))
        data = http_json(url)
        # Coinbase: [time, low, high, open, close, volume]，倒序返回
        for c in sorted(data, key=lambda x: x[0]):
            t = int(c[0])
            if t * 1000 >= end_ms or t * 1000 < start_ms:
                continue
            rows.append([day_str(t * 1000), float(c[3]), float(c[2]), float(c[1]), float(c[4])])
        cursor = stop
        time.sleep(0.35)          # 尊重限流
    return rows


def fetch_range(start_ms, end_ms):
    try:
        rows = fetch_binance(start_ms, end_ms)
        if rows:
            return rows, "Binance"
    except RuntimeError as e:
        log("  Binance 失败：%s" % e)
    rows = fetch_coinbase(start_ms, end_ms)
    return rows, "Coinbase"


# ----------------------------------------------------------------- 文件读写
def load_payload(path):
    with open(path, "r", encoding="utf-8") as f:
        payload = json.load(f)
    if not isinstance(payload.get("rows"), list) or not payload["rows"]:
        raise SystemExit("%s 内容为空或格式不符" % path)
    return payload


def save_payload(path, payload):
    payload["rows"].sort(key=lambda r: r[0])
    payload["start"] = payload["rows"][0][0]
    payload["end"] = payload["rows"][-1][0]
    payload["count"] = len(payload["rows"])
    payload["updated_at"] = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    # 单行紧凑写法：与 btc-quant-backtest 的文件风格一致，diff 小、体积小
    with open(path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    log("已写入 %s（%s ~ %s，共 %d 天）" % (path, payload["start"], payload["end"], payload["count"]))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", default=DEFAULT_FILE)
    ap.add_argument("--bootstrap", action="store_true", help="文件不存在时用公开接口新建")
    ap.add_argument("--overwrite", action="store_true", help="允许覆盖已有日期的数值")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    today_ms = utc_today_ms()

    if not os.path.exists(args.file):
        if not args.bootstrap:
            log("找不到 %s。" % args.file)
            log("推荐直接复用 btc-quant-backtest 的完整历史（2010 年起）：")
            log(r"  copy ..\btc-quant-backtest\data\btc-daily.json data\btc-daily.json")
            log("或加 --bootstrap 从公开接口新建（历史起点受接口限制，Binance 最早 2017-08）。")
            return 1
        log("bootstrap：从公开接口新建数据文件…")
        start_ms = int(dt.datetime(2017, 8, 17, tzinfo=dt.timezone.utc).timestamp()) * 1000
        rows, src = fetch_range(start_ms, today_ms)
        if not rows:
            log("没有取到任何数据，未写文件。")
            return 1
        payload = {
            "source": src,
            "fields": ["date", "open", "high", "low", "close"],
            "note": "bootstrap 生成，历史起点受公开接口限制；完整 2010 年起历史请复用 btc-quant-backtest 的数据文件",
            "rows": rows,
        }
        if args.dry_run:
            log("dry-run：将新建 %d 天（%s ~ %s）" % (len(rows), rows[0][0], rows[-1][0]))
            return 0
        save_payload(args.file, payload)
        return 0

    payload = load_payload(args.file)
    have = {r[0]: r for r in payload["rows"]}
    last_date = max(have)
    last_ms = int(dt.datetime.strptime(last_date, "%Y-%m-%d")
                    .replace(tzinfo=dt.timezone.utc).timestamp()) * 1000
    start_ms = last_ms + DAY * 1000
    if start_ms >= today_ms:
        log("已经是最新（截止 %s，UTC 今天 %s 尚未收盘）。" % (last_date, day_str(today_ms)))
        return 0

    log("现有数据截止 %s，尝试补 %s ~ %s…" % (last_date, day_str(start_ms), day_str(today_ms - DAY * 1000)))
    rows, src = fetch_range(start_ms, today_ms)
    if not rows:
        log("接口没有返回可用数据，保持原样（页面会如实显示截止 %s）。" % last_date)
        return 0

    added, updated = 0, 0
    for r in rows:
        if r[0] in have:
            if args.overwrite and have[r[0]][1:] != r[1:]:
                have[r[0]][1:] = r[1:]
                updated += 1
            continue
        payload["rows"].append(r)
        have[r[0]] = r
        added += 1

    log("新增 %d 天，覆盖 %d 天（来源 %s）。" % (added, updated, src))
    if args.dry_run:
        log("dry-run：不写文件。")
        return 0
    if added == 0 and updated == 0:
        return 0
    srcs = payload.get("source", "")
    if src not in srcs:
        payload["source"] = (srcs + " + " + src).strip(" +")
    save_payload(args.file, payload)
    return 0


if __name__ == "__main__":
    sys.exit(main())
