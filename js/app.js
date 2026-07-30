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
};

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
    ChartsModule.renderMain(AppState.result, AppState);
    const info = ChartsModule.renderCycle(AppState.result, AppState);
    $('cycle-insight').textContent = buildInsight(info, AppState);
    syncControls();
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
    $('footer-meta').textContent = bits.join(' · ');
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
        b.addEventListener('click', () => ChartsModule.resetZoom(b.dataset.reset));
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

async function runCompute() {
    if (AppState.computing) return;
    AppState.computing = true;
    AppState.cfg = readCfgFromForm();
    showLoading(true);
    setProgress(0.01, '准备计算…');
    try {
        const result = await computeAsync(AppState.cfg, (frac, label) => {
            setProgress(frac, `${label} 寻优中… ${(frac * 100).toFixed(0)}%`);
        });
        AppState.result = result;
        fillSeriesSelect(result);
        renderOverview(result);
        renderAll();
        showLoading(false);
    } catch (e) {
        showError(`计算失败：${(e && e.message) || e}`);
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
    await runCompute();
}

document.addEventListener('DOMContentLoaded', init);
