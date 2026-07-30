// ============================================================================
// 校验脚本：确认 js/rolling.js 的「前缀和 O(1) 窗口收益」与原始逐笔模拟等价
// ============================================================================
// 页面为了能在浏览器里跑完「5–250 步长 1 + 双均线全配对」，把窗口内回测改写成
// 对数前缀和（见 js/rolling.js 顶部注释）。这里用原始的逐笔模拟实现
// （RollingCore.bruteWindowReturn / bruteWindowReturnCross）抽样复核，
// 确保这项优化没有改变任何结论。
//
// 运行：node scripts/verify_rolling.mjs
// 需要 data/btc-daily.json 存在。为了控制耗时，默认用较小的参数网格抽样 12 个日期，
// 可用环境变量调整：SAMPLES=20 PMAX=80 PSTEP=5 node scripts/verify_rolling.mjs
// ============================================================================

import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

// rolling.js 是浏览器 UMD 风格（挂到 self 上），用 vm 造一个 self 就能直接复用。
const sandbox = { self: {}, console };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'js', 'rolling.js'), 'utf8'), sandbox);
const RC = sandbox.self.RollingCore;
if (!RC) throw new Error('未能从 js/rolling.js 载入 RollingCore');

const dataPath = path.join(ROOT, 'data', 'btc-daily.json');
if (!fs.existsSync(dataPath)) {
    console.error('缺少 data/btc-daily.json，请先复制或运行 scripts/update_data.py --bootstrap');
    process.exit(1);
}
const payload = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
const rows = payload.rows.slice().sort((a, b) => (a[0] < b[0] ? -1 : 1));
const closes = Float64Array.from(rows, (r) => r[4]);
const times = Float64Array.from(rows, (r) => Date.parse(r[0] + 'T00:00:00.000Z'));

const cfg = {
    types: ['ma', 'ema'],
    modes: ['single', 'double'],
    periodMin: 5,
    periodMax: Number(process.env.PMAX || 80),
    periodStep: Number(process.env.PSTEP || 5),
    feeRate: 0.001,                    // 带手续费，一并验证 log(1-fee)×交易次数 那一项
    windowYears: 4,
};
const SAMPLES = Number(process.env.SAMPLES || 12);
const DAY_MS = 86400000;
const TOL = 1e-8;                      // 相对误差容差（纯浮点累加差异）

// 与 rolling.js 完全一致的窗口左端（含 5% 容差）
function windowLo(i) {
    const winMs = cfg.windowYears * 365 * DAY_MS;
    let lo = 0;
    while (times[i] - times[lo] > winMs) lo++;
    return (times[i] - times[lo] >= winMs * 0.95) ? lo : -1;
}

console.log(`数据 ${rows[0][0]} ~ ${rows[rows.length - 1][0]}（${rows.length} 天）`);
console.log(`网格 ${cfg.periodMin}–${cfg.periodMax} 步长 ${cfg.periodStep}，手续费 ${cfg.feeRate * 100}%，抽样 ${SAMPLES} 个日期\n`);

const job = RC.createJob(closes, times, cfg);
while (!job.runFor(2000).done) { /* 一直跑到结束 */ }
const result = job.result();
const periods = RC.periodRange(cfg.periodMin, cfg.periodMax, cfg.periodStep);

// 预算所有周期的均线，供逐笔模拟复用
const maArrs = { ma: {}, ema: {} };
for (const type of cfg.types) {
    const fn = RC.maFnOf(type);
    for (const p of periods) maArrs[type][p] = fn(closes, p);
}

// 在有效区间里均匀取样
const first = result.firstIndex;
const last = closes.length - 1;
const idxs = [];
for (let k = 0; k < SAMPLES; k++) {
    idxs.push(Math.round(first + ((last - first) * k) / Math.max(1, SAMPLES - 1)));
}

let fails = 0, checks = 0;
for (const key of Object.keys(result.series)) {
    const s = result.series[key];
    const arrs = maArrs[s.type];
    for (const i of idxs) {
        const lo = windowLo(i);
        if (lo < 0) continue;
        // 逐笔模拟：穷举同一网格，取最优
        let bestRet = -Infinity, bestDesc = '';
        if (s.mode === 'single') {
            for (const p of periods) {
                const r = RC.bruteWindowReturn(closes, arrs[p], lo, i, cfg.feeRate);
                if (r > bestRet) { bestRet = r; bestDesc = `${p}`; }
            }
        } else {
            for (let a = 0; a < periods.length; a++) {
                for (let b = a + 1; b < periods.length; b++) {
                    const r = RC.bruteWindowReturnCross(closes, arrs[periods[a]], arrs[periods[b]], lo, i, cfg.feeRate);
                    if (r > bestRet) { bestRet = r; bestDesc = `${periods[a]}/${periods[b]}`; }
                }
            }
        }
        const fast = s.ret[i];
        const fastDesc = s.mode === 'single' ? `${s.period[i]}` : `${s.short[i]}/${s.long[i]}`;
        const rel = Math.abs(fast - bestRet) / Math.max(1e-12, Math.abs(bestRet));
        checks++;
        const ok = rel <= TOL;
        if (!ok) fails++;
        const flag = ok ? 'OK  ' : 'FAIL';
        const paramNote = fastDesc === bestDesc ? '' : `  （参数 ${fastDesc} vs ${bestDesc}，同分并列时可不同）`;
        console.log(`${flag} ${s.label.padEnd(16)} ${rows[i][0]}  快速 ${(fast * 100).toFixed(4)}%  逐笔 ${(bestRet * 100).toFixed(4)}%  相对差 ${rel.toExponential(2)}${paramNote}`);
    }
}

console.log(`\n共 ${checks} 项，失败 ${fails} 项。`);
if (fails) {
    console.error('存在不一致，请检查 js/rolling.js 的前缀和推导。');
    process.exit(1);
}
console.log('全部一致：前缀和实现与原始逐笔模拟在浮点误差内等价。');
