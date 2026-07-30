// ============================================================================
// ChartsModule —— 所有图表渲染（Chart.js）
// ============================================================================
// 配色、主题、十字准线、修饰键分轴缩放的实现沿用 btc-cycle-dashboard/js/charts.js，
// 保证两个站点的交互手感一致：滚轮 = 缩 xy，Shift = 只缩纵轴，Ctrl = 只缩横轴，拖动 = 平移。
// ============================================================================

const CHART_COLORS = {
    gold: '#f7931a',
    green: '#00d395',
    red: '#ff4757',
    blue: '#0ea5e9',
    purple: '#a855f7',
    gray: '#8b98a5',
    cycleColors: ['#60a5fa', '#34d399', '#fbbf24', '#f87171'],
};

// 各条 rolling 序列在主图上的颜色与线型
const SERIES_STYLE = {
    ma_single: { color: '#f7931a', dash: [], name: 'MA 单均线' },
    ema_single: { color: '#0ea5e9', dash: [], name: 'EMA 单均线' },
    ma_double_short: { color: '#a855f7', dash: [5, 3], name: 'MA 双均线·快' },
    ma_double_long: { color: '#6d28d9', dash: [5, 3], name: 'MA 双均线·慢' },
    ema_double_short: { color: '#10b981', dash: [2, 2], name: 'EMA 双均线·快' },
    ema_double_long: { color: '#047857', dash: [2, 2], name: 'EMA 双均线·慢' },
};

const THEMES = {
    dark: { tick: '#6b7280', grid: '#1f2937', legend: '#9ca3af', tooltipBg: '#1a1a2e', tooltipBorder: '#374151', crosshair: 'rgba(148,163,184,0.7)' },
    light: { tick: '#64748b', grid: '#e5e7eb', legend: '#475569', tooltipBg: '#ffffff', tooltipBorder: '#cbd5e1', crosshair: 'rgba(100,116,139,0.7)' },
};

// 十字准线插件：鼠标在绘图区内移动时画跟随光标的横竖虚线。
const crosshairPlugin = {
    id: 'crosshair',
    afterEvent(chart, args) {
        const e = args.event, area = chart.chartArea;
        if (!area) return;
        const inside = e.x >= area.left && e.x <= area.right && e.y >= area.top && e.y <= area.bottom;
        if (e.type === 'mousemove' && inside) chart._crosshair = { x: e.x, y: e.y };
        else if (!inside || e.type === 'mouseout') chart._crosshair = null;
        chart.draw();
    },
    afterDraw(chart, args, opts) {
        if (!opts || !opts.enabled) return;
        const p = chart._crosshair, area = chart.chartArea;
        if (!p || !area) return;
        const ctx = chart.ctx;
        ctx.save();
        ctx.beginPath();
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = opts.color || 'rgba(148,163,184,0.7)';
        ctx.moveTo(p.x, area.top); ctx.lineTo(p.x, area.bottom);
        ctx.moveTo(area.left, p.y); ctx.lineTo(area.right, p.y);
        ctx.stroke();
        ctx.restore();
    },
};
if (typeof Chart !== 'undefined') Chart.register(crosshairPlugin);

// plugin-zoom v2 会把函数型 mode 归一化成字符串，导致"按修饰键选轴"失效，
// 因此关掉插件自带的滚轮缩放，改由 attachModifierZoom 挂原生 wheel 监听。
const makeZoomConfig = () => ({
    pan: { enabled: true, mode: 'xy', modifierKey: null },
    zoom: { wheel: { enabled: false }, pinch: { enabled: true }, mode: 'xy' },
});

function zoomOneAxis(chart, id, factor, pos) {
    const sc = chart.scales[id];
    if (!sc) return;
    let anchor = sc.getValueForPixel(pos);
    if (anchor == null || !isFinite(anchor)) anchor = (sc.min + sc.max) / 2;
    let lo = sc.min, hi = sc.max;
    if (sc.type === 'logarithmic') {
        if (anchor <= 0) anchor = Math.sqrt(Math.max(1e-9, lo) * Math.max(1e-9, hi));
        const la = Math.log(anchor);
        lo = Math.exp(la - (la - Math.log(Math.max(1e-9, lo))) / factor);
        hi = Math.exp(la + (Math.log(Math.max(1e-9, hi)) - la) / factor);
    } else {
        lo = anchor - (anchor - lo) / factor;
        hi = anchor + (hi - anchor) / factor;
    }
    if (!isFinite(lo) || !isFinite(hi) || hi <= lo) return;
    // zoom 插件没加载成功时退回直接改坐标轴范围，保证滚轮至少还能用
    if (typeof chart.zoomScale === 'function') chart.zoomScale(id, { min: lo, max: hi }, 'none');
    else {
        const opt = chart.options.scales[id];
        if (!opt) return;
        opt.min = lo; opt.max = hi;
        chart.update('none');
    }
}

// 原生滚轮缩放：无修饰键 = 缩光标所在纵轴 + 横轴；Shift = 只缩纵轴；Ctrl = 只缩横轴。
// 监听挂在 canvas 上（重绘会 destroy 旧图但复用同一 canvas），每次只更新引用。
function attachModifierZoom(chart, yAxes) {
    const canvas = chart.canvas;
    if (!canvas) return;
    canvas._modZoomChart = chart;
    canvas._modZoomAxes = (yAxes && yAxes.length) ? yAxes : ['y'];
    if (canvas._modZoom) return;
    canvas._modZoom = true;
    const axisAtY = (c, axes, py) => {
        for (const id of axes) {
            const sc = c.scales[id];
            if (sc && py >= sc.top && py <= sc.bottom) return id;
        }
        return axes[0];
    };
    canvas.addEventListener('wheel', (e) => {
        const c = canvas._modZoomChart, axes = canvas._modZoomAxes;
        if (!c || !c.scales) return;
        e.preventDefault();
        let d = e.deltaY;
        if (d === 0 && e.deltaX !== 0) d = e.deltaX;
        if (d === 0) return;
        const factor = d < 0 ? 1.15 : 1 / 1.15;
        const rect = canvas.getBoundingClientRect();
        const px = e.clientX - rect.left, py = e.clientY - rect.top;
        if (e.ctrlKey) { zoomOneAxis(c, 'x', factor, px); return; }
        zoomOneAxis(c, axisAtY(c, axes, py), factor, py);
        if (!e.shiftKey) zoomOneAxis(c, 'x', factor, px);
    }, { passive: false });
}

const fmtMoney = (v) => {
    if (v == null || Number.isNaN(v)) return '-';
    if (v >= 1000) return '$' + Math.round(v).toLocaleString('en-US');
    return '$' + v.toFixed(2);
};
const fmtPct = (v) => (v == null || Number.isNaN(v) ? '-' : (v * 100).toFixed(v > 10 ? 0 : 1) + '%');

const ChartsModule = {
    charts: {},
    themeName: 'light',      // 'light' | 'dark'，默认亮色

    t() { return THEMES[this.themeName] || THEMES.light; },
    setTheme(name) { this.themeName = name === 'dark' ? 'dark' : 'light'; },

    defaults() {
        const c = this.t();
        return {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            normalized: true,
            interaction: { mode: 'nearest', axis: 'x', intersect: false },
            plugins: {
                legend: { labels: { color: c.legend, font: { size: 11 }, boxWidth: 14, usePointStyle: false } },
                tooltip: { backgroundColor: c.tooltipBg, borderColor: c.tooltipBorder, borderWidth: 1, titleColor: c.legend, bodyColor: c.legend },
                crosshair: { enabled: true, color: c.crosshair },
                zoom: makeZoomConfig(),
            },
        };
    },

    destroyChart(id) {
        if (this.charts[id]) { this.charts[id].destroy(); delete this.charts[id]; }
    },
    resetZoom(id) {
        const c = this.charts[id];
        if (!c) return;
        if (typeof c.resetZoom === 'function') { c.resetZoom(); return; }
        Object.values(c.options.scales || {}).forEach((s) => { delete s.min; delete s.max; });
        c.update('none');
    },
    toggleLogScale(id, axis) {
        const c = this.charts[id];
        if (!c || !c.options.scales[axis]) return null;
        const next = c.options.scales[axis].type === 'logarithmic' ? 'linear' : 'logarithmic';
        c.options.scales[axis].type = next;
        c.update();
        return next;
    },
    resizeAll() { Object.values(this.charts).forEach((c) => c.resize()); },

    // ------------------------------------------------------------------
    // 主图：4Y Rolling Best MA
    //   左轴 = 每日回看 4 年窗口内的「最优均线周期」或「最优策略收益率」
    //   右轴 = BTC 收盘价（可切对数），用来对照参数变动与行情阶段的关系
    // ------------------------------------------------------------------
    renderMain(result, state) {
        this.destroyChart('main');
        const el = document.getElementById('main-chart');
        if (!el || !result) return;
        const data = DataModule.processedData;
        const metric = state.metric === 'ret' ? 'ret' : 'period';
        const datasets = [];

        const pushLine = (styleKey, values, isRet, labelOverride) => {
            const st = SERIES_STYLE[styleKey] || { color: CHART_COLORS.gold, dash: [], name: styleKey };
            const pts = [];
            for (let i = 0; i < data.length; i++) {
                const v = values[i];
                if (v == null || Number.isNaN(v) || (!isRet && v === 0)) continue;
                pts.push({ x: data[i].time, y: isRet ? v * 100 : v });
            }
            if (!pts.length) return;
            datasets.push({
                label: labelOverride || st.name, data: pts, borderColor: st.color, backgroundColor: st.color,
                borderWidth: 1.4, borderDash: st.dash, pointRadius: 0, tension: 0,
                yAxisID: 'y', parsing: false,
            });
        };

        for (const key of Object.keys(result.series)) {
            const s = result.series[key];
            if (metric === 'ret') {
                // 收益率是"该组参数整体"的结果，双均线不分快慢，故用序列自身名称
                pushLine(s.mode === 'single' ? key : key + '_short', s.ret, true, s.label);
            } else if (s.mode === 'single') {
                pushLine(key, s.period, false);
            } else {
                pushLine(key + '_short', s.short, false);
                pushLine(key + '_long', s.long, false);
            }
        }

        datasets.push({
            label: 'BTC 收盘价', yAxisID: 'y2', parsing: false,
            data: data.map((d) => ({ x: d.time, y: d.close })),
            borderColor: CHART_COLORS.gray, backgroundColor: CHART_COLORS.gray,
            borderWidth: 1, pointRadius: 0, tension: 0,
        });

        const c = this.t();
        this.charts.main = new Chart(el.getContext('2d'), {
            type: 'line',
            data: { datasets },
            options: Object.assign({}, this.defaults(), {
                plugins: Object.assign({}, this.defaults().plugins, {
                    tooltip: Object.assign({}, this.defaults().plugins.tooltip, {
                        callbacks: {
                            title: (items) => (items.length ? new Date(items[0].parsed.x).toISOString().slice(0, 10) : ''),
                            label: (item) => {
                                const v = item.parsed.y;
                                if (item.dataset.yAxisID === 'y2') return ` BTC ${fmtMoney(v)}`;
                                return ` ${item.dataset.label}: ${metric === 'ret' ? v.toFixed(1) + '%' : v + ' 天'}`;
                            },
                        },
                    }),
                }),
                scales: {
                    x: {
                        type: 'time',
                        time: { unit: 'year' },
                        ticks: { color: c.tick, maxTicksLimit: 12 },
                        grid: { color: c.grid },
                    },
                    y: {
                        type: 'linear',
                        position: 'left',
                        title: { display: true, text: metric === 'ret' ? '窗口内最优策略收益率 (%)' : '窗口内最优均线周期 (天)', color: c.tick },
                        ticks: { color: c.tick, callback: (v) => (metric === 'ret' ? v + '%' : v) },
                        grid: { color: c.grid },
                    },
                    y2: {
                        type: state.priceLog ? 'logarithmic' : 'linear',
                        position: 'right',
                        title: { display: true, text: 'BTC 价格', color: CHART_COLORS.gray },
                        ticks: { color: CHART_COLORS.gray, callback: (v) => fmtMoney(v) },
                        grid: { drawOnChartArea: false },
                    },
                },
            }),
        });
        attachModifierZoom(this.charts.main, ['y', 'y2']);
    },

    // ------------------------------------------------------------------
    // 新栏目：4Y Rolling Best MA 四年大周期对比
    //   把同一条 rolling 序列按「各轮最高点 / 最低点 / 减半日」对齐，
    //   横轴 = 距锚点天数，看不同周期在相同"周期位置"上最优参数的高低与走向。
    // ------------------------------------------------------------------
    renderCycle(result, state) {
        this.destroyChart('cycle');
        const el = document.getElementById('cycle-chart');
        if (!el || !result) return null;
        const sel = this.pickSeries(result, state);
        if (!sel) return null;
        const isRet = state.metric === 'ret';
        const cycles = DataModule.alignByCycle(sel.values, state.mode, !isRet);
        const c = this.t();
        const datasets = [];
        const annotations = {};

        cycles.forEach((cy, i) => {
            const color = CHART_COLORS.cycleColors[i % CHART_COLORS.cycleColors.length];
            datasets.push({
                label: cy.label, parsing: false,
                data: cy.data.map((p) => ({ x: p.day, y: isRet ? p.y * 100 : p.y })),
                borderColor: color, backgroundColor: color,
                borderWidth: 1.6, pointRadius: 0, tension: 0.1,
            });
            // 标注该轮的极大值（最优周期最长 / 收益率最高的时点）
            let hi = cy.data[0];
            for (const p of cy.data) if (p.y > hi.y) hi = p;
            const hiY = isRet ? hi.y * 100 : hi.y;
            datasets.push({
                label: cy.label + ' 极值', parsing: false,
                data: [{ x: hi.day, y: hiY }],
                borderColor: color, backgroundColor: color,
                pointRadius: 6, pointStyle: 'triangle', showLine: false,
            });
            annotations['hi' + i] = {
                type: 'label', xValue: hi.day, yValue: hiY,
                content: `${cy.label.replace(/ .*/, '')}: ${isRet ? hiY.toFixed(0) + '%' : hi.y + '天'} (第${hi.day}天)`,
                color: '#fff', font: { size: 10, weight: 'bold' }, position: 'center',
                xAdjust: -38, yAdjust: 8 + i * 16,
                backgroundColor: color, borderRadius: 3, padding: 3,
            };
            // 当前进行中的这一轮，额外标出最新值所处位置
            if (i === cycles.length - 1) {
                const last = cy.data[cy.data.length - 1];
                const lastY = isRet ? last.y * 100 : last.y;
                datasets.push({
                    label: '本轮最新', parsing: false,
                    data: [{ x: last.day, y: lastY }],
                    borderColor: '#111827', backgroundColor: color,
                    pointRadius: 5, pointStyle: 'rectRot', borderWidth: 1.5, showLine: false,
                });
                annotations.now = {
                    type: 'label', xValue: last.day, yValue: lastY,
                    content: `本轮最新: ${isRet ? lastY.toFixed(0) + '%' : last.y + '天'} (第${last.day}天)`,
                    color: '#fff', font: { size: 10, weight: 'bold' }, position: 'center',
                    xAdjust: 52, yAdjust: -14,
                    backgroundColor: '#111827', borderRadius: 3, padding: 3,
                };
            }
        });

        this.charts.cycle = new Chart(el.getContext('2d'), {
            type: 'line',
            data: { datasets },
            options: Object.assign({}, this.defaults(), {
                plugins: Object.assign({}, this.defaults().plugins, {
                    legend: { labels: { color: c.legend, font: { size: 11 }, filter: (it) => !it.text.includes('极值') } },
                    annotation: { annotations },
                    tooltip: Object.assign({}, this.defaults().plugins.tooltip, {
                        callbacks: {
                            title: (items) => (items.length ? `第 ${items[0].parsed.x} 天` : ''),
                            label: (item) => ` ${item.dataset.label}: ${isRet ? item.parsed.y.toFixed(1) + '%' : item.parsed.y + ' 天'}`,
                        },
                    }),
                }),
                scales: {
                    x: {
                        type: 'linear',
                        title: { display: true, text: DataModule.ANCHOR_MODES[state.mode].xTitle, color: c.tick },
                        ticks: { color: c.tick }, grid: { color: c.grid },
                    },
                    y: {
                        type: 'linear',
                        title: { display: true, text: isRet ? '窗口内最优策略收益率 (%)' : '窗口内最优均线周期 (天)', color: c.tick },
                        ticks: { color: c.tick, callback: (v) => (isRet ? v + '%' : v) },
                        grid: { color: c.grid },
                    },
                },
            }),
        });
        attachModifierZoom(this.charts.cycle, ['y']);
        return { cycles, sel, isRet };
    },

    // 按下拉框的选择（"序列键:腿"）取出要画的那一条数组
    pickSeries(result, state) {
        const [key, leg] = String(state.seriesKey || '').split(':');
        const s = result.series[key];
        if (!s) return null;
        if (state.metric === 'ret') return { name: s.label + ' 最优收益率', values: s.ret, series: s, leg: null };
        if (s.mode === 'single') return { name: s.label + ' 最优周期', values: s.period, series: s, leg: null };
        const useLong = leg === 'long';
        return {
            name: s.label + (useLong ? '·慢线' : '·快线') + '最优周期',
            values: useLong ? s.long : s.short, series: s, leg: useLong ? 'long' : 'short',
        };
    },

    // 下拉框可选项：随实际算出来的序列动态生成
    seriesOptions(result) {
        const out = [];
        for (const key of Object.keys(result.series)) {
            const s = result.series[key];
            if (s.mode === 'single') out.push({ value: key, label: s.label });
            else {
                out.push({ value: key + ':short', label: s.label + '·快线' });
                out.push({ value: key + ':long', label: s.label + '·慢线' });
            }
        }
        return out;
    },
};
