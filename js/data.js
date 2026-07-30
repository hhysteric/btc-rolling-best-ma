// ============================================================================
// DataModule —— 数据加载与周期锚点定位（唯一的数据来源，无 DOM 依赖）
// ============================================================================
// 行情主源：data/btc-daily.json（复用 btc-quant-backtest 的内置日线，CoinMarketCap 口径，
//   字段 [date, open, high, low, close]，升序），由 GitHub Actions 每日增量追加。
// 加载后再尽力用 Binance 公开 K 线补到当天；补不上就静默沿用本地数据并在页脚标注截止日。
// 绝不编造数据：拿不到就显示"截止到 X 日"，不做任何插值或外推。
// ============================================================================

const DAY_MS = 86400000;

// 历史减半日（真实区块高度对应日期）+ 下一次减半的估算值（约 2028-04）
const HALVING_DATES = [
    new Date('2012-11-28'),
    new Date('2016-07-09'),
    new Date('2020-05-11'),
    new Date('2024-04-19'),
];
const NEXT_HALVING_ESTIMATE = new Date('2028-04-01');

// 四年大周期日历年模型（3 年涨 + 1 年跌），year % 4 决定阶段。
// 与 btc-cycle-dashboard 保持同一套认知：0=减半年/首轮牛 1=次轮牛/顶部年 2=熊市 3=预备牛。
const CYCLE_YEAR_PHASES = {
    0: { name: '首轮牛市（减半年）', tone: 'up' },
    1: { name: '次轮牛市（顶部年）', tone: 'up' },
    2: { name: '熊市', tone: 'down' },
    3: { name: '预备牛市', tone: 'flat' },
};

// Binance 主站在部分网络不可达，data-api.binance.vision 是官方公开镜像，接口一致。
const BINANCE_HOSTS = [
    'https://api.binance.com',
    'https://data-api.binance.vision',
    'https://api1.binance.com',
];

const DataModule = {
    processedData: [],          // [{ date: Date, time: ms, dateStr, open, high, low, close }] 升序
    meta: {                     // 数据来源与新鲜度，页脚与概览卡如实展示
        source: '',
        start: '',
        end: '',
        count: 0,
        appended: 0,            // Binance 补了多少天
        fillError: '',
    },

    // ---------------- 加载 ----------------
    async load() {
        let resp;
        try {
            resp = await fetch('data/btc-daily.json', { cache: 'no-cache' });
        } catch (e) {
            // fetch 直接抛异常（不是 404）只有两种常见原因：以 file:// 打开，或本地服务器没在跑
            const isFile = typeof location !== 'undefined' && location.protocol === 'file:';
            const err = new Error(isFile
                ? 'file:// 协议下浏览器禁止用 fetch 读取本地文件'
                : '无法连接到本地服务器（连接被拒绝或已停止）');
            err.needServer = true;
            err.isFile = isFile;
            throw err;
        }
        if (!resp.ok) {
            const err = new Error(`data/btc-daily.json 加载失败（HTTP ${resp.status}）`);
            err.missingData = true;
            throw err;
        }
        const payload = await resp.json();
        if (!payload || !Array.isArray(payload.rows) || !payload.rows.length) {
            const err = new Error('data/btc-daily.json 内容为空或格式不符');
            err.missingData = true;
            throw err;
        }
        this.processedData = payload.rows.map((r) => {
            const time = Date.parse(r[0] + 'T00:00:00.000Z');
            return { date: new Date(time), time, dateStr: r[0], open: r[1], high: r[2], low: r[3], close: r[4] };
        }).sort((a, b) => a.time - b.time);

        this.meta.source = payload.source || 'data/btc-daily.json';
        await this._fillLatest();
        this._syncMeta();
        return this.processedData;
    },

    // 用 Binance 增量补到今天。失败只记录原因，不抛错（保证页面照常可用）。
    async _fillLatest() {
        const last = this.processedData[this.processedData.length - 1];
        const startMs = last.time + DAY_MS;
        // 只补"已收盘"的完整 UTC 日，不把当天未走完的行情当日线用
        const todayUtc = Date.parse(new Date().toISOString().slice(0, 10) + 'T00:00:00.000Z');
        if (startMs >= todayUtc) return;
        try {
            const rows = await this._fetchBinance('BTCUSDT', '1d', startMs, todayUtc - 1);
            const have = new Set(this.processedData.map((d) => d.dateStr));
            let added = 0;
            for (const c of rows) {
                if (have.has(c.dateStr) || c.time >= todayUtc) continue;
                this.processedData.push(c);
                have.add(c.dateStr);
                added++;
            }
            if (added) this.processedData.sort((a, b) => a.time - b.time);
            this.meta.appended = added;
        } catch (e) {
            this.meta.fillError = (e && e.message) || String(e);
        }
    },

    async _fetchBinance(symbol, interval, startMs, endMs) {
        const out = [];
        let cursor = startMs;
        const LIMIT = 1000;
        while (cursor < endMs) {
            const path = `/api/v3/klines?symbol=${symbol}&interval=${interval}&startTime=${cursor}&endTime=${endMs}&limit=${LIMIT}`;
            const rows = await this._tryHosts(path);
            if (!Array.isArray(rows) || !rows.length) break;
            for (const r of rows) {
                const t = r[0];
                out.push({
                    date: new Date(t), time: t, dateStr: new Date(t).toISOString().slice(0, 10),
                    open: +r[1], high: +r[2], low: +r[3], close: +r[4],
                });
            }
            if (rows.length < LIMIT) break;
            cursor = rows[rows.length - 1][0] + 1;
        }
        return out;
    },

    async _tryHosts(path) {
        let lastErr = null;
        for (const host of BINANCE_HOSTS) {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 8000);
            try {
                const resp = await fetch(host + path, { signal: ctrl.signal });
                if (!resp.ok) { lastErr = new Error(`${host} 返回 ${resp.status}`); continue; }
                return await resp.json();
            } catch (e) {
                lastErr = new Error(`${host} 连接失败`);
            } finally {
                clearTimeout(timer);
            }
        }
        throw new Error(`Binance 补新失败（${lastErr ? lastErr.message : '未知'}）`);
    },

    _syncMeta() {
        const d = this.processedData;
        this.meta.start = d[0].dateStr;
        this.meta.end = d[d.length - 1].dateStr;
        this.meta.count = d.length;
    },

    getLatest() { return this.processedData[this.processedData.length - 1] || null; },
    closes() { return Float64Array.from(this.processedData, (d) => d.close); },
    times() { return Float64Array.from(this.processedData, (d) => d.time); },

    // ---------------- 四年大周期阶段（日历年 3 涨 1 跌模型）----------------
    getCyclePhase() {
        const latest = this.getLatest();
        const now = latest ? latest.date : new Date();
        const year = now.getUTCFullYear();
        const info = CYCLE_YEAR_PHASES[year % 4];
        const nextHalvingDays = Math.round((NEXT_HALVING_ESTIMATE - now) / DAY_MS);
        return { year, name: info.name, tone: info.tone, nextHalvingDays };
    },

    // ---------------- 周期锚点：最高点 / 最低点 / 减半日 ----------------
    // 三种对齐口径与 btc-cycle-dashboard 的三张周期对比图完全一致，便于横向印证。
    ANCHOR_MODES: {
        peak: { label: '从各轮最高点对齐', xTitle: '距该轮最高点天数' },
        trough: { label: '从各轮最低点对齐', xTitle: '距该轮最低点天数' },
        halving: { label: '从各轮减半日对齐', xTitle: '距该轮减半日天数' },
    },

    // 各轮"顶"所在的检索区间（在区间内取最高收盘价）
    PEAK_RANGES: [
        { start: '2011-01-01', end: '2015-01-01', label: '周期1 (2013顶)' },
        { start: '2015-01-01', end: '2019-01-01', label: '周期2 (2017顶)' },
        { start: '2019-01-01', end: '2023-01-01', label: '周期3 (2021顶)' },
        { start: '2023-01-01', end: '2027-01-01', label: '周期4 (当前)' },
    ],
    // 各轮"熊市大底"的检索区间（右界比顶部区间后移半年，覆盖跨年的大底）
    TROUGH_RANGES: [
        { start: '2011-01-01', end: '2015-07-01', label: '周期1 (2015底)' },
        { start: '2015-01-01', end: '2019-07-01', label: '周期2 (2018底)' },
        { start: '2019-01-01', end: '2023-07-01', label: '周期3 (2022底)' },
        { start: '2023-01-01', end: '2027-01-01', label: '周期4 (当前)' },
    ],

    /**
     * 取某种对齐口径下的各轮锚点。
     * @param {'peak'|'trough'|'halving'} mode
     * @returns {Array<{label, anchorIndex, anchorDate, maxDay, anchorPrice}>}
     */
    getAnchors(mode) {
        const d = this.processedData;
        if (!d.length) return [];
        const out = [];

        if (mode === 'halving') {
            const bounds = [...HALVING_DATES, NEXT_HALVING_ESTIMATE];
            for (let c = 0; c < HALVING_DATES.length; c++) {
                const start = bounds[c], end = bounds[c + 1];
                const idx = d.findIndex((x) => x.date >= start && x.date < end);
                if (idx < 0) continue;
                out.push({
                    label: `减半${c + 1} (${start.getUTCFullYear()})`,
                    anchorIndex: idx,
                    anchorDate: d[idx].date,
                    anchorPrice: d[idx].close,
                    maxDay: Math.round((end - start) / DAY_MS),
                });
            }
            return out;
        }

        const ranges = mode === 'trough' ? this.TROUGH_RANGES : this.PEAK_RANGES;
        for (const r of ranges) {
            const start = new Date(r.start), end = new Date(r.end);
            let lo = -1, hi = -1;
            for (let i = 0; i < d.length; i++) {
                if (d[i].date >= start && d[i].date < end) { if (lo < 0) lo = i; hi = i; }
            }
            if (lo < 0) continue;
            // 先定位区间内最高收盘价（牛市顶）
            let peak = lo;
            for (let i = lo + 1; i <= hi; i++) if (d[i].close > d[peak].close) peak = i;
            let anchor = peak;
            if (mode === 'trough') {
                // 再在"顶之后"找最低收盘价 = 该轮熊市大底；周期4 = 见顶以来的最低点，随数据推进
                let trough = peak;
                for (let i = peak + 1; i <= hi; i++) if (d[i].close < d[trough].close) trough = i;
                anchor = trough;
            }
            out.push({
                label: r.label,
                anchorIndex: anchor,
                anchorDate: d[anchor].date,
                anchorPrice: d[anchor].close,
                maxDay: 1600,
            });
        }
        return out;
    },

    /**
     * 把一条 rolling 结果序列按周期锚点切成多条对齐曲线。
     * @param {Float64Array|Int16Array} values 与 processedData 等长的取值数组
     * @param {'peak'|'trough'|'halving'} mode
     * @param {boolean} zeroIsEmpty 取值为 0 时视为无数据（Int16Array 的周期用）
     */
    alignByCycle(values, mode, zeroIsEmpty) {
        const d = this.processedData;
        const anchors = this.getAnchors(mode);
        return anchors.map((a) => {
            const pts = [];
            for (let i = a.anchorIndex; i < d.length; i++) {
                const day = Math.round((d[i].time - d[a.anchorIndex].time) / DAY_MS);
                if (day > a.maxDay) break;
                const v = values[i];
                if (v == null || Number.isNaN(v) || (zeroIsEmpty && v === 0)) continue;
                pts.push({ day, y: v });
            }
            return { label: a.label, anchorDate: a.anchorDate, anchorPrice: a.anchorPrice, maxDay: a.maxDay, data: pts };
        }).filter((c) => c.data.length > 1);
    },
};
