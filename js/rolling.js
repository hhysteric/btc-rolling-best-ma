// ============================================================================
// 4Y Rolling Best MA —— 计算内核（主线程与 Web Worker 共用，无任何 DOM 依赖）
// ============================================================================
// 框架逻辑沿用 btc-quant-backtest/js/backtest.js 的 rollingBestForType：
//   对每根 K 线回看 4 年窗口，在周期范围内遍历所有 MA/EMA 参数，
//   记录该窗口内「最赚钱的参数」及其收益率。
//
// 本文件的关键改动是把窗口内回测从 O(窗口长度) 降到 O(1)，否则
// 「5–250 步长 1 + 双均线全配对」在浏览器里根本跑不完（约 10^11 次运算）。
//
// 【为什么可以降到 O(1)】
// 原实现每个 (日期, 参数) 都从窗口左端重跑一遍择时循环。但满仓择时策略的
// 持仓状态其实与历史路径无关：
//   单均线：收盘价 > 均线 → 持币；< 均线 → 空仓（相等/均线未成形则沿用前值）
//   双均线：短均线 > 长均线 → 持币；反之空仓
// 也就是说 pos[i] 只由第 i 根自身决定，可以全局预计算一次。于是窗口 [lo, hi]
// 的资金曲线就是一串连乘：
//   终值 = ∏_{i=lo}^{hi-1} ( pos[i] ? close[i+1]/close[i] : 1 ) × (1-fee)^交易次数
// 取对数后连乘变连加，用前缀和 G[] 就能 O(1) 取任意窗口：
//   log 终值 = (G[hi] - G[lo]) + log(1-fee) × 交易次数
//   交易次数 = (T[hi] - T[lo]) + (pos[lo] ? 1 : 0)   // 末项是窗口开头那笔建仓
// T[] 是「持仓状态发生变化」的前缀计数。窗口左端一律从空仓起算，故 pos[lo]=1
// 时要补一笔买入手续费。
//
// 结论：与原实现在数值上等价（浮点误差级别），见 scripts/verify_rolling.mjs。
// 唯一的微小差异：某根 K 线收盘价与均线「恰好相等」时，原实现按不动作处理，
// 本实现沿用前一根的持仓状态。这种情况在真实行情里几乎不出现，不影响结论。
//
// 另一个提速点：比较收益率时全程停留在 log 空间（单调变换不改变大小关系），
// 热循环里没有一次 Math.exp，只在最后输出时还原成收益率。
// ============================================================================

(function (root) {
    'use strict';

    const DAY_MS = 86400000;

    // ---- 均线（与 btc-quant-backtest/js/indicators.js 完全一致，前置不足周期为 NaN）----
    function sma(closes, period) {
        const n = closes.length;
        const out = new Float64Array(n).fill(NaN);
        let sum = 0;
        for (let i = 0; i < n; i++) {
            sum += closes[i];
            if (i >= period) sum -= closes[i - period];
            if (i >= period - 1) out[i] = sum / period;
        }
        return out;
    }

    function ema(closes, period) {
        const n = closes.length;
        const out = new Float64Array(n).fill(NaN);
        const k = 2 / (period + 1);
        let prev = NaN;
        for (let i = 0; i < n; i++) {
            if (i < period - 1) continue;
            if (prev !== prev) {
                // 以前 period 个值的简单均值作为首个 EMA 种子
                let sum = 0;
                for (let j = i - period + 1; j <= i; j++) sum += closes[j];
                prev = sum / period;
            } else {
                prev = closes[i] * k + prev * (1 - k);
            }
            out[i] = prev;
        }
        return out;
    }

    const maFnOf = (type) => (type === 'ema' ? ema : sma);

    // ---- 持仓信号：pos[i] ∈ {0,1}，只看第 i 根自身，与路径无关 ----
    // 下面两个独立版本供阅读与校验用；热路径里已把它们与前缀和扫描融合成一次遍历（见 scanSingle/scanCross）。
    function buildPosSingle(closes, ma, pos) {
        let cur = 0;
        for (let i = 0; i < pos.length; i++) {
            const m = ma[i];
            if (m === m) {                       // 非 NaN（均线已成形）
                if (closes[i] > m) cur = 1;
                else if (closes[i] < m) cur = 0; // 相等则沿用前值
            }
            pos[i] = cur;
        }
    }

    function buildPosCross(shortMa, longMa, pos) {
        let cur = 0;
        for (let i = 0; i < pos.length; i++) {
            const s = shortMa[i], l = longMa[i];
            if (s === s && l === l) {
                if (s > l) cur = 1;
                else if (s < l) cur = 0;
            }
            pos[i] = cur;
        }
    }

    // ---- 核心扫描：一次 O(n) 遍历里同时做三件事 ----
    //   1) 算出本参数下每根 K 线的持仓 pos[i]
    //   2) 累出对数收益前缀和 G[i] 与换手次数前缀和 T[i]
    //   3) 对每个满窗日期取窗口收益，命中更优就写入 best
    // pos / G / T 必须写进数组：窗口左端 lo 是历史位置，需要随机读取。
    // 融合成一次遍历（而不是先 buildPos 再 scan）能省掉一半的内存读写，实测快近一倍。
    function scanSingle(closes, ma, lnR, loIdx, logFee, pos, G, T, best, p) {
        const n = closes.length;
        const score = best.score, arrA = best.a;
        let cur = 0, prev = 0, g = 0, t = 0;
        for (let i = 0; i < n; i++) {
            const m = ma[i];
            if (m === m) {                            // 非 NaN（均线已成形）
                const c = closes[i];
                if (c > m) cur = 1;
                else if (c < m) cur = 0;              // 相等则沿用前值
            }
            if (i > 0) {
                if (prev) g += lnR[i - 1];            // 上一根持币 → 吃到这一段涨跌
                if (cur !== prev) t++;
            }
            pos[i] = cur; G[i] = g; T[i] = t;
            prev = cur;
            const lo = loIdx[i];
            if (lo < 0) continue;                                  // 窗口不足 4 年
            const trans = (t - T[lo]) + (pos[lo] ? 1 : 0);         // 含窗口开头那笔建仓
            const s = (g - G[lo]) + logFee * trans;
            if (s > score[i]) { score[i] = s; arrA[i] = p; }
        }
    }

    function scanCross(closes, shortMa, longMa, lnR, loIdx, logFee, pos, G, T, best, p, q) {
        const n = closes.length;
        const score = best.score, arrA = best.a, arrB = best.b;
        let cur = 0, prev = 0, g = 0, t = 0;
        for (let i = 0; i < n; i++) {
            const s1 = shortMa[i], l1 = longMa[i];
            if (s1 === s1 && l1 === l1) {
                if (s1 > l1) cur = 1;
                else if (s1 < l1) cur = 0;
            }
            if (i > 0) {
                if (prev) g += lnR[i - 1];
                if (cur !== prev) t++;
            }
            pos[i] = cur; G[i] = g; T[i] = t;
            prev = cur;
            const lo = loIdx[i];
            if (lo < 0) continue;
            const trans = (t - T[lo]) + (pos[lo] ? 1 : 0);
            const sc = (g - G[lo]) + logFee * trans;
            if (sc > score[i]) { score[i] = sc; arrA[i] = p; arrB[i] = q; }
        }
    }

    // ---- 参考实现（原始 O(窗口) 版，逐笔模拟）：仅供 verify 脚本比对，不参与页面计算 ----
    function bruteWindowReturn(closes, maArr, lo, hi, feeRate) {
        let cash = 1, coin = 0;
        for (let i = lo; i <= hi; i++) {
            const m = maArr[i];
            if (m !== m) continue;
            const price = closes[i];
            if (price > m && cash > 0) { coin = (cash * (1 - feeRate)) / price; cash = 0; }
            else if (price < m && coin > 0) { cash = coin * price * (1 - feeRate); coin = 0; }
        }
        return cash + coin * closes[hi] - 1;
    }

    function bruteWindowReturnCross(closes, shortArr, longArr, lo, hi, feeRate) {
        let cash = 1, coin = 0;
        for (let i = lo; i <= hi; i++) {
            const s = shortArr[i], l = longArr[i];
            if (s !== s || l !== l) continue;
            const price = closes[i];
            if (s > l && cash > 0) { coin = (cash * (1 - feeRate)) / price; cash = 0; }
            else if (s < l && coin > 0) { cash = coin * price * (1 - feeRate); coin = 0; }
        }
        return cash + coin * closes[hi] - 1;
    }

    function periodRange(min, max, step) {
        const arr = [];
        for (let p = min; p <= max; p += step) arr.push(p);
        return arr;
    }

    const SERIES_LABEL = {
        ma_single: 'MA 单均线',
        ema_single: 'EMA 单均线',
        ma_double: 'MA 双均线（金叉）',
        ema_double: 'EMA 双均线（金叉）',
    };

    // ========================================================================
    // simulate：单组参数的逐笔回测（给「自定义均线回测」栏目用）
    // ------------------------------------------------------------------------
    // 与 bruteWindowReturn 同一套规则（满仓择时、按收盘价成交、每笔收单边手续费），
    // 但额外记录每一笔买卖、净值曲线、最大回撤，供画买卖点与统计用。
    // 均线用**全历史**计算后再截区间，等于让指标在区间开始前就已预热；
    // 若区间起点处均线还没成形（历史不足），会如实返回 warmup 提示。
    // ========================================================================
    function simulate(closes0, times0, cfg0) {
        const closes = closes0 instanceof Float64Array ? closes0 : Float64Array.from(closes0);
        const times = times0 instanceof Float64Array ? times0 : Float64Array.from(times0);
        const n = closes.length;
        const cfg = Object.assign({
            type: 'ma', mode: 'single',
            period: 200, short: 50, long: 200,
            feeRate: 0, lo: 0, hi: n - 1,
        }, cfg0 || {});

        const lo = Math.max(0, Math.min(n - 1, cfg.lo | 0));
        const hi = Math.max(lo, Math.min(n - 1, cfg.hi | 0));
        const fn = maFnOf(cfg.type);
        const single = cfg.mode !== 'double';
        const pShort = single ? Math.max(2, cfg.period | 0) : Math.max(2, cfg.short | 0);
        const pLong = single ? 0 : Math.max(pShort + 1, cfg.long | 0);
        const maA = fn(closes, pShort);
        const maB = single ? null : fn(closes, pLong);
        const fee = Math.max(0, cfg.feeRate || 0);

        const trades = [];
        const equity = [];          // [{x: time, y: 净值}]，起点 1
        const maPts = [];           // [{x, y}] 快线（或单均线）
        const maPts2 = [];          // 慢线
        let cash = 1, coin = 0, entryCash = 0, entryPrice = 0, entryTime = 0;
        let hold = 0, peak = 1, maxDD = 0, wins = 0, closed = 0;
        let warmupMissing = 0;

        for (let i = lo; i <= hi; i++) {
            const price = closes[i], a = maA[i], b = maB ? maB[i] : NaN;
            const ready = single ? (a === a) : (a === a && b === b);
            if (!ready) warmupMissing++;
            if (ready) {
                if (single) { if (price > a) hold = 1; else if (price < a) hold = 0; }
                else { if (a > b) hold = 1; else if (a < b) hold = 0; }
            }
            if (hold && cash > 0) {
                entryCash = cash; entryPrice = price; entryTime = times[i];
                coin = (cash * (1 - fee)) / price; cash = 0;
                trades.push({ side: 'buy', time: times[i], index: i, price, ret: null });
            } else if (!hold && coin > 0) {
                const proceeds = coin * price * (1 - fee);
                const r = entryCash > 0 ? proceeds / entryCash - 1 : null;
                cash = proceeds; coin = 0;
                trades.push({ side: 'sell', time: times[i], index: i, price, ret: r, heldDays: Math.round((times[i] - entryTime) / DAY_MS) });
                closed++;
                if (r > 0) wins++;
            }
            const eq = cash + coin * price;
            equity.push({ x: times[i], y: eq });
            if (eq > peak) peak = eq;
            const dd = 1 - eq / peak;
            if (dd > maxDD) maxDD = dd;
            if (a === a) maPts.push({ x: times[i], y: a });
            if (maB && b === b) maPts2.push({ x: times[i], y: b });
        }

        const finalEq = cash + coin * closes[hi];
        const bh = closes[hi] / closes[lo] - 1;
        return {
            cfg: { type: cfg.type, mode: single ? 'single' : 'double', short: pShort, long: pLong, feeRate: fee, lo, hi },
            label: (cfg.type === 'ema' ? 'EMA' : 'MA') + (single ? ` ${pShort}` : ` ${pShort}/${pLong} 金叉`),
            trades, equity, maPts, maPts2,
            ret: finalEq - 1,
            bhRet: bh,
            excess: (finalEq - 1) - bh,
            finalEq,
            maxDD,
            tradeCount: trades.length,
            roundTrips: closed,
            winRate: closed ? wins / closed : null,
            holdingNow: coin > 0,
            warmupMissing,
            startDate: new Date(times[lo]).toISOString().slice(0, 10),
            endDate: new Date(times[hi]).toISOString().slice(0, 10),
        };
    }

    // ========================================================================
    // createJob：把整轮寻优拆成可中断的小任务，调用方用 runFor(预算毫秒) 驱动。
    // Worker 里连续驱动并回报进度；无 Worker 时主线程分批驱动，页面不卡死。
    // ========================================================================
    function createJob(closes0, times0, cfg0) {
        const closes = closes0 instanceof Float64Array ? closes0 : Float64Array.from(closes0);
        const times = times0 instanceof Float64Array ? times0 : Float64Array.from(times0);
        const n = closes.length;

        const cfg = Object.assign({
            types: ['ma', 'ema'],
            modes: ['single', 'double'],
            periodMin: 5,
            periodMax: 250,
            periodStep: 1,
            feeRate: 0,
            windowYears: 4,
        }, cfg0 || {});

        const periods = periodRange(cfg.periodMin, cfg.periodMax, cfg.periodStep);
        if (periods.length < 2) throw new Error('周期范围至少要包含 2 个取值');
        if (n < 50) throw new Error('行情数据太少，无法计算');

        const logFee = Math.log(1 - (cfg.feeRate || 0));
        const winMs = cfg.windowYears * 365 * DAY_MS;

        // 每根 K 线对应的窗口左端（不足 4 年记 -1）。与原实现同样留 5% 容差。
        const loIdx = new Int32Array(n).fill(-1);
        let lo = 0, firstHi = -1;
        for (let i = 0; i < n; i++) {
            while (times[i] - times[lo] > winMs) lo++;
            if (times[i] - times[lo] >= winMs * 0.95) {
                loIdx[i] = lo;
                if (firstHi < 0) firstHi = i;
            }
        }

        // 相邻收盘的对数收益（连乘 → 连加的基础）
        const lnR = new Float64Array(n);
        for (let i = 0; i < n - 1; i++) lnR[i] = Math.log(closes[i + 1] / closes[i]);

        // 复用的暂存数组：避免每个参数组合都重新分配
        const pos = new Int8Array(n);
        const G = new Float64Array(n);
        const T = new Int32Array(n);

        // 各线型的全周期均线缓存（懒加载）。246 个周期 × 5700 天 × 8B ≈ 11MB / 线型
        const maCache = {};
        function maArrs(type) {
            if (!maCache[type]) {
                const fn = maFnOf(type);
                const m = {};
                for (const p of periods) m[p] = fn(closes, p);
                maCache[type] = m;
            }
            return maCache[type];
        }

        // 结果容器
        const series = {};
        const tasks = [];
        for (const type of cfg.types) {
            for (const mode of cfg.modes) {
                const key = `${type}_${mode}`;
                const best = {
                    score: new Float64Array(n).fill(-Infinity),
                    a: new Int16Array(n),                              // 单均线周期 / 双均线快线周期
                    b: mode === 'double' ? new Int16Array(n) : null,   // 双均线慢线周期
                };
                series[key] = { key, type, mode, label: SERIES_LABEL[key] || key, best };
                tasks.push({ key, type, mode });
            }
        }
        if (!tasks.length) throw new Error('至少要选择一种线型与一种模式');

        // 单元清单：单均线 = 每个周期一单元；双均线 = 每个「快线周期」一单元（内层扫全部慢线）
        const units = [];
        let totalWeight = 0;
        tasks.forEach((task, ti) => {
            for (let u = 0; u < periods.length; u++) {
                if (task.mode === 'double' && u === periods.length - 1) continue; // 最快的那根没有更慢的可配
                const w = task.mode === 'single' ? 1 : (periods.length - 1 - u);
                units.push({ ti, u, w });
                totalWeight += w;
            }
        });

        let cursor = 0, doneWeight = 0;

        function runUnit(unit) {
            const task = tasks[unit.ti];
            const best = series[task.key].best;
            const arrs = maArrs(task.type);
            const p = periods[unit.u];
            if (task.mode === 'single') {
                scanSingle(closes, arrs[p], lnR, loIdx, logFee, pos, G, T, best, p);
            } else {
                const fast = arrs[p];
                for (let j = unit.u + 1; j < periods.length; j++) {
                    const q = periods[j];
                    scanCross(closes, fast, arrs[q], lnR, loIdx, logFee, pos, G, T, best, p, q);
                }
            }
        }

        return {
            get total() { return units.length; },
            get firstIndex() { return firstHi; },
            periods,
            cfg,
            /**
             * 驱动一段时间的计算。
             * @param {number} budgetMs 本次最多占用的毫秒数
             * @returns {{done:boolean, frac:number, label:string}}
             */
            runFor(budgetMs) {
                const t0 = (root.performance && root.performance.now) ? root.performance.now() : Date.now();
                const now = () => ((root.performance && root.performance.now) ? root.performance.now() : Date.now());
                while (cursor < units.length) {
                    const unit = units[cursor];
                    runUnit(unit);
                    doneWeight += unit.w;
                    cursor++;
                    if (now() - t0 >= (budgetMs || 40)) break;
                }
                const cur = units[Math.min(cursor, units.length - 1)];
                const task = tasks[cur.ti];
                return {
                    done: cursor >= units.length,
                    frac: totalWeight ? doneWeight / totalWeight : 1,
                    label: `${task.type.toUpperCase()} ${task.mode === 'single' ? '单均线' : '双均线'}`,
                };
            },
            /** 收尾：log 收益还原成收益率，输出可直接 postMessage / 供图表使用的结构 */
            result() {
                const out = { firstIndex: firstHi, windowYears: cfg.windowYears, cfg, series: {} };
                for (const key of Object.keys(series)) {
                    const s = series[key];
                    const ret = new Float64Array(n).fill(NaN);
                    const score = s.best.score;
                    let lastIdx = -1;
                    for (let i = 0; i < n; i++) {
                        if (score[i] === -Infinity) continue;
                        ret[i] = Math.exp(score[i]) - 1;
                        lastIdx = i;
                    }
                    out.series[key] = {
                        key, type: s.type, mode: s.mode, label: s.label,
                        ret,
                        period: s.mode === 'single' ? s.best.a : null,
                        short: s.mode === 'double' ? s.best.a : null,
                        long: s.mode === 'double' ? s.best.b : null,
                        lastIndex: lastIdx,
                    };
                }
                return out;
            },
        };
    }

    // 结果里需要随 postMessage 一起转移的 ArrayBuffer 列表（零拷贝）
    function transferables(result) {
        const list = [];
        for (const key of Object.keys(result.series)) {
            const s = result.series[key];
            for (const f of ['ret', 'period', 'short', 'long']) {
                if (s[f] && s[f].buffer) list.push(s[f].buffer);
            }
        }
        return list;
    }

    root.RollingCore = {
        DAY_MS,
        sma, ema, maFnOf, periodRange,
        buildPosSingle, buildPosCross, scanSingle, scanCross,
        bruteWindowReturn, bruteWindowReturnCross,
        simulate,
        createJob, transferables,
        SERIES_LABEL,
    };
})(typeof self !== 'undefined' ? self : this);
