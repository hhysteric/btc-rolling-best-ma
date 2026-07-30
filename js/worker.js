// 4Y Rolling Best MA 计算 Worker：在后台线程跑寻优，主线程只负责画图，页面不卡。
// 收到 {closes, times, cfg} 后连续驱动 RollingCore 的任务队列，每约 120ms 回报一次进度。
// 若浏览器不支持 Worker（或以 file:// 打开被拦截），app.js 会自动退回主线程分批计算。

self.importScripts('rolling.js');

self.onmessage = function (e) {
    const msg = e.data || {};
    if (msg.cmd !== 'run') return;
    try {
        const job = RollingCore.createJob(msg.closes, msg.times, msg.cfg);
        self.postMessage({ type: 'start', total: job.total });
        let last = 0;
        for (;;) {
            const st = job.runFor(60);
            const now = Date.now();
            if (st.done || now - last > 120) {
                self.postMessage({ type: 'progress', frac: st.frac, label: st.label });
                last = now;
            }
            if (st.done) break;
        }
        const result = job.result();
        self.postMessage({ type: 'done', result }, RollingCore.transferables(result));
    } catch (err) {
        self.postMessage({ type: 'error', message: (err && err.message) || String(err) });
    }
};
