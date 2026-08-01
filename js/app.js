// ============================================================================
// App —— 页面装配：加载数据 → 后台寻优 → 渲染图表 → 绑定交互
// ============================================================================
// 计算优先走 Web Worker（页面不卡）；若浏览器/协议不支持（例如直接双击 index.html
// 以 file:// 打开），自动退回主线程分批计算，同样能出结果，只是稍慢。
// ============================================================================

const AppState = {
    theme: 'light',
    metric: 'period',        // 'period' 最优均线周期 | 'ret' 最优策略收益率
    priceLog: true,
    mode: 'peak',            // 'peak' | 'trough' | 'halving'
    seriesKey: 'ma_single',
    cfg: {
        types: ['ma', 'ema'],
        modes: ['single', 'double'],
        periodMin: 5,
        periodMax: 250,
        periodStep: 1,
        feeRate: 0,
        windowYears: 4,
    },
    result: null,
    computing: false,
    // 自定义均线回测栏目
    customLog: true,         // 价格 / 净值轴是否用对数
    sim: null,               // RollingCore.simulate 的最近一次结果
    cacheNote: '',           // 页脚如实标注结果是缓存还是刚算的
};

// cache.js 万一没加载成功，退化成"每次都算"而不是让整页挂掉
const Cache = (typeof RollingCache !== 'undefined') ? RollingCache
    : { load: () => null, save: () => false, sizeKB: () => 0, clear() {} };

const $ = (id) => document.getElementById(id);
const fmtInt = (v) => (v == null || Number.isNaN(v) ? '-' : Math.round(v).toLocaleString('en-US'));

// ---------------------------------------------------------------- 进度与错误
function setProgress(frac, text) {
    const bar = $('progress-bar'), label = $('progress-text');
    if (bar) bar.style.width = Math.max(2, Math.min(100, frac * 100)).toFixed(1) + '%';
    if (label && text) label.textContent = text;
}
function showLoading(show) {
    const el = $('loading');
    if (el) el.style.display = show ? 'flex' : 'none';
}
function showError(html) {
    showLoading(false);
    const el = $('error-panel');
    if (!el) return;
    el.style.display = 'block';
    $('error-text').innerHTML = html;
}

// ---------------------------------------------------------------- 计算调度
function computeAsync(cfg, onProgress) {
    const closes = DataModule.closes();
    const times = DataModule.times();

    // 优先 Worker
    const tryWorker = () => new Promise((resolve, reject) => {
        let w;
        try { w = new Worker('js/worker.js'); } catch (e) { reject(e); return; }
        let settled = false;
        w.onmessage = (ev) => {
            const m = ev.data || {};
            if (m.type === 'progress') onProgress(m.frac, m.label);
            else if (m.type === 'done') { settled = true; w.terminate(); resolve(m.result); }
            else if (m.type === 'error') { settled = true; w.terminate(); reject(new Error(m.message)); }
        };
        w.onerror = (e) => {
            if (settled) return;
            settled = true;
            try { w.terminate(); } catch (_) {}
            reject(new Error((e && e.message) || 'Worker 启动失败'));
        };
        w.postMessage({ cmd: 'run', closes, times, cfg });
    });

    // 主线程分批：每帧算 40ms，让浏览器有机会重绘进度条
    const mainThread = () => new Promise((resolve, reject) => {
        let job;
        try { job = RollingCore.createJob(closes, times, cfg); } catch (e) { reject(e); return; }
        const step = () => {
            try {
                const st = job.runFor(40);
                onProgress(st.frac, st.label + '（主线程模式）');
                if (st.done) resolve(job.result());
                else setTimeout(step, 0);
            } catch (e) { reject(e); }
        };
        setTimeout(step, 0);
    });

    if (typeof Worker === 'undefined') return mainThread();
    return tryWorker().catch(() => mainThread());
}

// ---------------------------------------------------------------- 概览卡片
function renderOverview(result) {
    const latest = DataModule.getLatest();
    const phase = DataModule.getCyclePhase();
    $('stat-price').textContent = fmtMoney(latest.close);
    $('stat-date').textContent = latest.dateStr;
    $('stat-phase').textContent = phase.name;
    $('stat-phase-sub').textContent = `${phase.year} 年（year % 4 = ${phase.year % 4}）`;

    // 最新一天各序列的最优参数与收益率，如实列出
    const rows = [];
    for (const key of Object.keys(result.series)) {
        const s = result.series[key];
        const i = s.lastIndex;
        if (i < 0) continue;
        const param = s.mode === 'single' ? `${s.period[i]} 天` : `${s.short[i]} / ${s.long[i]} 天`;
        // 颜色跟着真实符号走：即便是"窗口内最优"，也可能是负收益，不能一律涂绿
        const v = s.ret[i];
        const cls = v > 0 ? 'pos' : (v < 0 ? 'neg' : '');
        rows.push(`<tr><td>${s.label}</td><td class="num">${param}</td><td class="num ${cls}">${fmtPct(v)}</td></tr>`);
    }
    $('best-table').innerHTML = rows.length
        ? `<table class="mini-table"><thead><tr><th>线型</th><th>最优参数</th><th>窗口收益率</th></tr></thead><tbody>${rows.join('')}</tbody></table>`
        : '<p class="muted">暂无满窗数据</p>';

    const first = DataModule.processedData[result.firstIndex];
    $('stat-window').textContent = first ? `${first.dateStr} 起` : '-';
    $('stat-window-sub').textContent = `回看 ${result.windowYears} 年，周期 ${result.cfg.periodMin}–${result.cfg.periodMax} 步长 ${result.cfg.periodStep}`;
}

// ---------------------------------------------------------------- 周期对比解读
// 全部数字来自已算出的序列，不做任何推测性表述。
function buildInsight(info, state) {
    if (!info || !info.cycles.length) return '当前口径下没有足够的对齐数据。';
    const isRet = info.isRet;
    const unit = (v) => (isRet ? (v * 100).toFixed(0) + '%' : Math.round(v) + ' 天');
    const stats = info.cycles.map((cy) => {
        let sum = 0, max = cy.data[0].y, min = cy.data[0].y, maxDay = cy.data[0].day;
        for (const p of cy.data) {
            sum += p.y;
            if (p.y > max) { max = p.y; maxDay = p.day; }
            if (p.y < min) min = p.y;
        }
        return {
            label: cy.label, n: cy.data.length, avg: sum / cy.data.length,
            max, min, maxDay,
            start: cy.data[0].y, end: cy.data[cy.data.length - 1].y,
            endDay: cy.data[cy.data.length - 1].day,
            anchor: cy.anchorDate.toISOString().slice(0, 10),
        };
    });
    const cur = stats[stats.length - 1];
    const past = stats.slice(0, -1);
    const parts = [];
    parts.push(`口径：${DataModule.ANCHOR_MODES[state.mode].label}，序列 = ${info.sel.name}。`);
    parts.push(stats.map((s) => `${s.label} 锚点 ${s.anchor}，均值 ${unit(s.avg)}，区间 ${unit(s.min)} ~ ${unit(s.max)}（峰值出现在第 ${s.maxDay} 天）`).join('；') + '。');
    if (past.length) {
        const pastAvg = past.reduce((a, s) => a + s.avg, 0) / past.length;
        const cmp = cur.avg > pastAvg ? '高于' : (cur.avg < pastAvg ? '低于' : '持平于');
        // 取历史各轮在"相同周期位置"（同一天数）上的取值，做同位比较
        const sameDay = past.map((s, i) => {
            const cy = info.cycles[i];
            let hit = null;
            for (const p of cy.data) { if (p.day <= cur.endDay) hit = p; else break; }
            return hit ? `${s.label} ${unit(hit.y)}` : `${s.label} 无数据`;
        });
        parts.push(`本轮当前位于第 ${cur.endDay} 天，取值 ${unit(cur.end)}，本轮均值 ${cmp}历史各轮均值（${unit(pastAvg)}）。历史同位取值：${sameDay.join('、')}。`);
    }
    parts.push(isRet
        ? '注：收益率为「该 4 年窗口内最优参数」的事后收益，属于回看寻优结果，不代表可实盘复现的收益。'
        : '注：最优周期是每天回看 4 年窗口逐个参数穷举后的最赚钱周期，反映的是过去 4 年行情最适配的均线快慢，参数漂移本身即信息。');
    return parts.join(' ');
}

// ---------------------------------------------------------------- 渲染
function renderAll() {
    if (!AppState.result) return;
    ChartsModule.renderMainSplit(AppState.result, AppState);
    const info = ChartsModule.renderCycle(AppState.result, AppState);
    $('cycle-insight').textContent = buildInsight(info, AppState);
    syncControls();
    if (AppState.sim) ChartsModule.renderCustom(AppState.sim, AppState);   // 主题/重绘时保留回测图
}

function syncControls() {
    document.querySelectorAll('[data-metric]').forEach((b) => {
        b.classList.toggle('active', b.dataset.metric === AppState.metric);
    });
    document.querySelectorAll('[data-anchor]').forEach((b) => {
        b.classList.toggle('active', b.dataset.anchor === AppState.mode);
    });
    const legNote = $('cycle-leg-note');
    if (legNote) legNote.style.display = AppState.metric === 'ret' ? 'inline' : 'none';
}

function fillSeriesSelect(result) {
    const sel = $('cycle-series');
    if (!sel) return;
    const opts = ChartsModule.seriesOptions(result);
    sel.innerHTML = opts.map((o) => `<option value="${o.value}">${o.label}</option>`).join('');
    if (!opts.some((o) => o.value === AppState.seriesKey)) AppState.seriesKey = opts[0] ? opts[0].value : '';
    sel.value = AppState.seriesKey;
}

function renderFooter() {
    const m = DataModule.meta;
    const bits = [`数据 ${m.start} ~ ${m.end}（${fmtInt(m.count)} 天，来源 ${m.source}）`];
    if (m.appended) bits.push(`Binance 已补最新 ${m.appended} 天`);
    if (m.fillError) bits.push(`补新未成功：${m.fillError}，页面数据截止到 ${m.end}`);
    if (AppState.cacheNote) bits.push(AppState.cacheNote);
    $('footer-meta').textContent = bits.join(' · ');
}

// ---------------------------------------------------------------- 结果导出
// 单 MA（ma_single）序列导出成 Excel。优先写真正的 .xlsx（按需从 CDN 取 SheetJS），
// 取不到就退回 UTF-8 BOM 的 CSV —— Excel 双击同样能正常打开，不会因为没网就导不出。
function exportRows(result) {
    const s = result && result.series.ma_single;
    if (!s) return null;
    const data = DataModule.processedData;
    const rows = [];
    const n = Math.min(data.length, s.ret.length);
    for (let i = 0; i < n; i++) {
        const r = s.ret[i];
        if (r == null || Number.isNaN(r)) continue;          // 窗口不足 4 年的日子如实跳过
        rows.push({
            日期: data[i].dateStr,
            收盘价: data[i].close,
            最优MA周期天: s.period ? s.period[i] : null,
            窗口收益率: r,                                    // 小数，Excel 里套百分比格式
            窗口收益率百分比: r * 100,
        });
    }
    return rows;
}

function loadScriptOnce(src) {
    if (window.__loadedScripts && window.__loadedScripts[src]) return Promise.resolve();
    return new Promise((resolve, reject) => {
        const el = document.createElement('script');
        el.src = src;
        el.onload = () => {
            window.__loadedScripts = window.__loadedScripts || {};
            window.__loadedScripts[src] = true;
            resolve();
        };
        el.onerror = () => reject(new Error('脚本加载失败：' + src));
        document.head.appendChild(el);
    });
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function csvFallback(rows, base) {
    const head = ['日期', '收盘价', '最优MA周期(天)', '窗口收益率(小数)', '窗口收益率(%)'];
    const lines = [head.join(',')];
    for (const r of rows) {
        lines.push([r.日期, r.收盘价, r.最优MA周期天, r.窗口收益率, r.窗口收益率百分比.toFixed(4)].join(','));
    }
    // 前置 BOM 让 Excel 认出 UTF-8，否则中文表头会乱码
    const BOM = String.fromCharCode(0xFEFF);
    downloadBlob(new Blob([BOM + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }), base + '.csv');
}

async function exportSingleMA() {
    const btn = $('btn-export-ma');
    const result = AppState.result;
    const rows = exportRows(result);
    if (!rows || !rows.length) {
        if (btn) { btn.textContent = '无可导出数据'; setTimeout(() => (btn.textContent = '导出单 MA 结果（Excel）'), 2200); }
        return;
    }
    const m = DataModule.meta;
    const cfg = result.cfg || AppState.cfg;
    const base = `4Y-Rolling-Best-MA_单MA_${m.start}_${m.end}`;
    const setLabel = (t) => { if (btn) btn.textContent = t; };
    const restore = () => setTimeout(() => setLabel('导出单 MA 结果（Excel）'), 2200);

    setLabel('导出中…');
    try {
        await loadScriptOnce('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js');
        if (!window.XLSX) throw new Error('XLSX 未就绪');
        const XLSX = window.XLSX;
        const wb = XLSX.utils.book_new();

        const sheet = XLSX.utils.json_to_sheet(rows, {
            header: ['日期', '收盘价', '最优MA周期天', '窗口收益率', '窗口收益率百分比'],
        });
        // 表头改成带单位的中文，并给收益率列套百分比格式
        XLSX.utils.sheet_add_aoa(sheet, [['日期', '收盘价(USD)', '最优MA周期(天)', '窗口收益率', '窗口收益率(%)']], { origin: 'A1' });
        sheet['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 16 }, { wch: 14 }, { wch: 14 }];
        for (let i = 2; i <= rows.length + 1; i++) {
            const cell = sheet['D' + i];
            if (cell) cell.z = '0.00%';
        }
        XLSX.utils.book_append_sheet(wb, sheet, '单MA最优周期');

        const info = [
            ['指标', '4Y Rolling Best MA（单均线 MA）'],
            ['定义', '对每一根日线回看 4 年窗口，在周期网格内穷举所有 MA 周期，记录该窗口内最赚钱的周期及其收益率'],
            ['交易规则', '满仓择时：收盘价 > MA 持币，收盘价 < MA 空仓；按当日收盘价成交，每笔收一次单边手续费'],
            ['窗口长度', `${result.windowYears} 年（允许 5% 容差，不足则该日无值，表中已跳过）`],
            ['周期网格', `${cfg.periodMin} ~ ${cfg.periodMax}，步长 ${cfg.periodStep}`],
            ['单边手续费', `${((cfg.feeRate || 0) * 100).toFixed(3)}%`],
            ['行情区间', `${m.start} ~ ${m.end}（${m.count} 天）`],
            ['数据来源', m.source],
            ['导出时间', new Date().toISOString().slice(0, 19).replace('T', ' ') + ' UTC'],
            ['有效行数', String(rows.length)],
            ['说明', '窗口收益率是「事后回看」的最优参数收益，不代表可实盘复现的收益；空缺的日子表示历史不足 4 年，未做任何插值或估算'],
        ];
        const infoSheet = XLSX.utils.aoa_to_sheet([['项目', '内容']].concat(info));
        infoSheet['!cols'] = [{ wch: 14 }, { wch: 96 }];
        XLSX.utils.book_append_sheet(wb, infoSheet, '说明');

        const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
        downloadBlob(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), base + '.xlsx');
        setLabel(`已导出 ${fmtInt(rows.length)} 行`);
    } catch (e) {
        // 没网 / CDN 被拦：退回 CSV，并如实说明换了格式
        csvFallback(rows, base);
        setLabel('已导出 CSV（xlsx 库取不到）');
    }
    restore();
}

// ---------------------------------------------------------------- 自定义回测
// 表单默认值：区间取全历史，周期取常用的 MA200。
function initBacktest() {
    const m = DataModule.meta;
    if ($('bt-start') && !$('bt-start').value) $('bt-start').value = m.start;
    if ($('bt-end') && !$('bt-end').value) $('bt-end').value = m.end;
    if ($('bt-start')) { $('bt-start').min = m.start; $('bt-start').max = m.end; }
    if ($('bt-end')) { $('bt-end').min = m.start; $('bt-end').max = m.end; }
    syncBtMode();
}

// 单均线只需要一个周期，双均线需要快慢两个：按模式显示对应输入框
function syncBtMode() {
    const double = $('bt-mode') && $('bt-mode').value === 'double';
    const show = (id, on) => { const el = $(id); if (el) el.style.display = on ? '' : 'none'; };
    show('bt-period-wrap', !double);
    show('bt-short-wrap', double);
    show('bt-long-wrap', double);
}

// 日期 → 数据下标：取「不早于该日的第一根」/「不晚于该日的最后一根」，
// 不存在则退到边界。绝不为了凑区间去插值。
function indexForDate(str, side) {
    const data = DataModule.processedData;
    if (!data.length) return side === 'start' ? 0 : 0;
    const t = Date.parse(str + 'T00:00:00Z');
    if (!Number.isFinite(t)) return side === 'start' ? 0 : data.length - 1;
    if (side === 'start') {
        for (let i = 0; i < data.length; i++) if (data[i].time >= t) return i;
        return data.length - 1;
    }
    for (let i = data.length - 1; i >= 0; i--) if (data[i].time <= t) return i;
    return 0;
}

function runBacktest() {
    const data = DataModule.processedData;
    if (!data.length) return;
    const num = (id, dflt) => {
        const el = $(id);
        const v = el ? parseFloat(el.value) : NaN;
        return Number.isFinite(v) ? v : dflt;
    };
    let lo = indexForDate($('bt-start').value, 'start');
    let hi = indexForDate($('bt-end').value, 'end');
    if (hi <= lo) { hi = Math.min(data.length - 1, lo + 1); }

    const mode = $('bt-mode').value === 'double' ? 'double' : 'single';
    const cfg = {
        type: $('bt-type').value === 'ema' ? 'ema' : 'ma',
        mode,
        period: Math.max(2, Math.round(num('bt-period', 200))),
        short: Math.max(2, Math.round(num('bt-short', 50))),
        long: Math.max(3, Math.round(num('bt-long', 200))),
        feeRate: Math.max(0, Math.min(0.01, num('bt-fee', 0) / 100)),
        lo, hi,
    };
    if (mode === 'double' && cfg.long <= cfg.short) cfg.long = cfg.short + 1;   // 慢线必须比快线慢

    const sim = RollingCore.simulate(DataModule.closes(), DataModule.times(), cfg);
    AppState.sim = sim;
    const empty = $('custom-empty');
    if (empty) empty.style.display = 'none';
    ChartsModule.renderCustom(sim, AppState);
    renderBtStats(sim);
    renderBtTrades(sim);
}

function renderBtStats(sim) {
    const el = $('bt-stats');
    if (!el) return;
    const sgn = (v) => (v > 0 ? 'pos' : (v < 0 ? 'neg' : ''));
    const cell = (label, value, cls) =>
        `<div class="stat"><div class="stat-label">${label}</div><div class="stat-value ${cls || ''}">${value}</div></div>`;
    const bits = [
        cell('参数', sim.label),
        cell('区间', `${sim.startDate} ~ ${sim.endDate}`),
        cell('策略收益率', fmtPct(sim.ret), sgn(sim.ret)),
        cell('买入持有', fmtPct(sim.bhRet), sgn(sim.bhRet)),
        cell('超额', fmtPct(sim.excess), sgn(sim.excess)),
        cell('净值', sim.finalEq.toFixed(2) + '×'),
        cell('最大回撤', fmtPct(-sim.maxDD), 'neg'),
        cell('成交笔数', `${sim.tradeCount}（完整回合 ${sim.roundTrips}）`),
        cell('回合胜率', sim.winRate == null ? '-' : fmtPct(sim.winRate)),
        cell('当前状态', sim.holdingNow ? '持币' : '空仓'),
    ];
    let html = `<div class="stat-grid">${bits.join('')}</div>`;
    if (sim.warmupMissing > 0) {
        html += `<p class="note warn">区间开头有 ${sim.warmupMissing} 天均线还没成形（历史长度不足该周期），这些天按空仓处理，不做任何补值。</p>`;
    }
    el.innerHTML = html;
}

function renderBtTrades(sim) {
    const el = $('bt-trades');
    if (!el) return;
    if (!sim.trades.length) {
        el.innerHTML = '<p class="muted">该区间内没有产生任何买卖信号。</p>';
        return;
    }
    // 只列最近 40 笔，避免长区间把页面拉得过长；完整清单可在控制台取 AppState.sim.trades
    const list = sim.trades.slice(-40).reverse();
    const rows = list.map((t) => {
        const d = new Date(t.time).toISOString().slice(0, 10);
        const side = t.side === 'buy' ? '<span class="tag buy">买入</span>' : '<span class="tag sell">卖出</span>';
        const ret = t.ret == null ? '' : `<span class="${t.ret > 0 ? 'pos' : (t.ret < 0 ? 'neg' : '')}">${fmtPct(t.ret)}</span>`;
        return `<tr><td>${d}</td><td>${side}</td><td class="num">${fmtMoney(t.price)}</td><td class="num">${ret}</td><td class="num">${t.heldDays == null ? '' : t.heldDays + ' 天'}</td></tr>`;
    });
    el.innerHTML = `
        <table class="mini-table trades"><thead>
            <tr><th>日期</th><th>方向</th><th>成交价</th><th>本回合收益</th><th>持有天数</th></tr>
        </thead><tbody>${rows.join('')}</tbody></table>
        <p class="muted sm">共 ${sim.trades.length} 笔，上表只显示最近 ${list.length} 笔（倒序）。</p>`;
}

// ---------------------------------------------------------------- 交互绑定
function bindControls() {
    document.querySelectorAll('[data-metric]').forEach((b) => {
        b.addEventListener('click', () => {
            AppState.metric = b.dataset.metric;
            renderAll();
        });
    });
    document.querySelectorAll('[data-anchor]').forEach((b) => {
        b.addEventListener('click', () => {
            AppState.mode = b.dataset.anchor;
            renderAll();
        });
    });
    $('cycle-series').addEventListener('change', (e) => {
        AppState.seriesKey = e.target.value;
        renderAll();
    });
    $('btn-price-log').addEventListener('click', () => {
        AppState.priceLog = !AppState.priceLog;
        $('btn-price-log').textContent = AppState.priceLog ? '价格：对数' : '价格：线性';
        renderAll();
    });
    document.querySelectorAll('[data-reset]').forEach((b) => {
        b.addEventListener('click', () => {
            if (b.dataset.reset === 'main-all') {
                ChartsModule.MAIN_CELLS.forEach((s) => ChartsModule.resetZoom(s.id));
                return;
            }
            ChartsModule.resetZoom(b.dataset.reset);
        });
    });
    if ($('bt-mode')) $('bt-mode').addEventListener('change', syncBtMode);
    if ($('btn-backtest')) $('btn-backtest').addEventListener('click', () => runBacktest());
    if ($('btn-bt-log')) $('btn-bt-log').addEventListener('click', () => {
        AppState.customLog = !AppState.customLog;
        $('btn-bt-log').textContent = AppState.customLog ? '纵轴：对数' : '纵轴：线性';
        if (AppState.sim) ChartsModule.renderCustom(AppState.sim, AppState);
    });
    document.querySelectorAll('[data-full]').forEach((b) => {
        b.addEventListener('click', () => {
            const box = document.getElementById(b.dataset.full);
            if (!box) return;
            box.classList.toggle('fullscreen');
            setTimeout(() => ChartsModule.resizeAll(), 60);
        });
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        document.querySelectorAll('.chart-box.fullscreen').forEach((el) => el.classList.remove('fullscreen'));
        setTimeout(() => ChartsModule.resizeAll(), 60);
    });
    $('btn-theme').addEventListener('click', () => {
        AppState.theme = AppState.theme === 'light' ? 'dark' : 'light';
        document.documentElement.setAttribute('data-theme', AppState.theme);
        $('btn-theme').textContent = AppState.theme === 'light' ? '深色' : '亮色';
        ChartsModule.setTheme(AppState.theme);
        renderAll();
    });
    $('btn-recompute').addEventListener('click', () => runCompute());
    if ($('btn-export-ma')) $('btn-export-ma').addEventListener('click', () => exportSingleMA());
    window.addEventListener('resize', () => ChartsModule.resizeAll());
}

function readCfgFromForm() {
    const types = [];
    if ($('cfg-ma').checked) types.push('ma');
    if ($('cfg-ema').checked) types.push('ema');
    const modes = [];
    if ($('cfg-single').checked) modes.push('single');
    if ($('cfg-double').checked) modes.push('double');
    const num = (id, dflt) => {
        const v = parseFloat($(id).value);
        return Number.isFinite(v) ? v : dflt;
    };
    return Object.assign({}, AppState.cfg, {
        types: types.length ? types : ['ma'],
        modes: modes.length ? modes : ['single'],
        periodMin: Math.max(2, Math.round(num('cfg-period-min', 5))),
        periodMax: Math.max(3, Math.round(num('cfg-period-max', 250))),
        periodStep: Math.max(1, Math.round(num('cfg-period-step', 1))),
        feeRate: Math.max(0, Math.min(0.01, num('cfg-fee', 0) / 100)),
    });
}

// background = true：页面已经用缓存结果出图了，这次只是把新增的几天补算上，
// 所以不弹遮罩、不打断浏览，进度写在页脚。
async function runCompute(opts) {
    const o = opts || {};
    if (AppState.computing) return;
    AppState.computing = true;
    AppState.cfg = readCfgFromForm();
    if (!o.background) {
        showLoading(true);
        setProgress(0.01, '准备计算…');
    }
    try {
        const result = await computeAsync(AppState.cfg, (frac, label) => {
            if (o.background) {
                AppState.cacheNote = `后台补算至 ${DataModule.meta.end}… ${(frac * 100).toFixed(0)}%`;
                renderFooter();
            } else {
                setProgress(frac, `${label} 寻优中… ${(frac * 100).toFixed(0)}%`);
            }
        });
        AppState.result = result;
        const saved = Cache.save(result, AppState.cfg, DataModule.meta);
        AppState.cacheNote = saved
            ? `结果已缓存（${Cache.sizeKB()}KB），配置与数据不变时下次进站直接出图`
            : '本地缓存不可用（配额或隐私模式），下次进站会重新计算';
        fillSeriesSelect(result);
        renderOverview(result);
        renderAll();
        renderFooter();
        showLoading(false);
    } catch (e) {
        if (o.background) {
            // 后台补算失败不能影响已经可用的页面：如实说明页面上是缓存值
            AppState.cacheNote = `后台补算失败（${(e && e.message) || e}），当前展示的是缓存结果`;
            renderFooter();
        } else {
            showError(`计算失败：${(e && e.message) || e}`);
        }
    } finally {
        AppState.computing = false;
    }
}

async function init() {
    document.documentElement.setAttribute('data-theme', AppState.theme);
    ChartsModule.setTheme(AppState.theme);
    showLoading(true);
    setProgress(0.02, '加载行情数据…');
    try {
        await DataModule.load();
    } catch (e) {
        if (e && e.needServer) {
            showError(`
                <p><strong>读不到数据文件：${e.message}。</strong></p>
                <p>本页必须通过 HTTP 打开（浏览器地址栏是 <code>http://localhost:...</code>，
                   不能是 <code>file:///...</code>）。<strong>双击项目根目录的 <code>setup.bat</code></strong>
                   即可自动复制数据、起服务器并打开浏览器。</p>
                <p>手动做法：在项目根目录执行</p>
                <pre>python -m http.server 8080</pre>
                <p>然后访问 <a href="http://localhost:8080">http://localhost:8080</a>。
                   注意跑服务器的那个命令行窗口要一直开着，关掉或按 Ctrl+C 就会变成现在这个错误。</p>`);
        } else if (e && e.missingData) {
            showError(`
                <p><strong>缺少行情数据文件 <code>data/btc-daily.json</code>。</strong></p>
                <p>最快的补齐方式：<strong>双击项目根目录里的 <code>copy_data.bat</code></strong>，
                   然后回到本页按 <code>Ctrl+F5</code> 强制刷新（本地服务器不用重启）。</p>
                <p>等价的手动命令（在项目根目录执行）：</p>
                <pre>copy ..\\btc-quant-backtest\\data\\btc-daily.json data\\btc-daily.json</pre>
                <p>或用脚本从公开接口重建（需要 Python 3，历史起点受接口限制，最早 2017-08）：</p>
                <pre>python scripts/update_data.py --bootstrap</pre>
                <p>为避免任何编造，缺数据时页面不做任何插值或估算，直接停在这里。</p>`);
        } else {
            showError(`数据加载失败：${(e && e.message) || e}`);
        }
        return;
    }
    renderFooter();
    bindControls();
    initBacktest();

    // 先查本地缓存：配置与数据指纹都没变就直接出图，不重算（这是"每次进站不用等"的关键）。
    AppState.cfg = readCfgFromForm();
    const hit = Cache.load(AppState.cfg, DataModule.meta);
    if (hit) {
        AppState.result = hit.result;
        fillSeriesSelect(hit.result);
        renderOverview(hit.result);
        renderAll();
        showLoading(false);
        if (hit.fresh) {
            AppState.cacheNote = `结果取自本地缓存（${String(hit.savedAt).slice(0, 10)} 存，${Cache.sizeKB()}KB），未重算`;
            renderFooter();
        } else {
            // 数据后来长了几天：先把缓存结果摆出来，再后台补算，绝不拿旧值冒充最新
            AppState.cacheNote = `缓存结果算到 ${hit.cachedEnd}，正在后台补算到 ${DataModule.meta.end}…`;
            renderFooter();
            runCompute({ background: true });
        }
        return;
    }
    await runCompute();
}

document.addEventListener('DOMContentLoaded', init);
