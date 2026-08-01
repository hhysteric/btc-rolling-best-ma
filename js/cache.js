// ============================================================================
// RollingCache —— 把寻优结果存进 localStorage，下次进站直接出图
// ============================================================================
// 全参数穷举一次要几秒到几十秒，但结果只取决于两件事：
//   1) 计算配置（线型 / 模式 / 周期网格 / 手续费 / 窗口年数）
//   2) 行情数据（起点、终点、天数）
// 两者都没变，结果必然一模一样，没有任何理由重算。因此用「配置 + 数据指纹」
// 做 key，命中就直接还原。指纹不一致时不会拿旧结果糊弄：要么后台补算，要么重算。
//
// 存储形态：类型化数组 → ArrayBuffer → base64 → JSON。
// 体量估算（约 5900 天 × 4 条序列）：收益率 Float64 每条 ~63KB base64，
// 周期 Int16 每条 ~16KB，合计约 350KB 字符，远低于 localStorage 的 5MB 配额。
// 一旦写入失败（隐私模式、配额满），静默降级成"每次重算"，绝不影响出图。
// ============================================================================

(function (root) {
    'use strict';

    const KEY = 'brbm.rolling.v1';
    const VER = 1;                 // 结果结构或计算规则改动时 +1，旧缓存自动失效

    // --- base64 <-> ArrayBuffer（分块避免 apply 的参数个数上限）---
    function b64FromBuf(buf) {
        const bytes = new Uint8Array(buf);
        const CH = 0x8000;
        let s = '';
        for (let i = 0; i < bytes.length; i += CH) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return btoa(s);
    }
    function bufFromB64(b64) {
        const s = atob(b64);
        const out = new Uint8Array(s.length);
        for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out.buffer;
    }

    // 配置指纹：只包含真正影响结果的字段
    function cfgSig(cfg) {
        const c = cfg || {};
        return [
            'v' + VER,
            (c.types || []).slice().sort().join('+'),
            (c.modes || []).slice().sort().join('+'),
            `${c.periodMin}-${c.periodMax}/${c.periodStep}`,
            'fee' + (c.feeRate || 0),
            'win' + (c.windowYears || 4),
        ].join('|');
    }

    const RollingCache = {
        available() {
            try {
                const k = KEY + '.probe';
                root.localStorage.setItem(k, '1');
                root.localStorage.removeItem(k);
                return true;
            } catch (e) { return false; }
        },

        /**
         * 保存一次寻优结果。
         * @param {object} result createJob().result() 的返回值
         * @param {object} cfg    本次计算配置
         * @param {object} meta   DataModule.meta（取 start / end / count 当数据指纹）
         * @returns {boolean} 是否写入成功（失败不抛错，调用方可忽略）
         */
        save(result, cfg, meta) {
            if (!result || !meta) return false;
            try {
                const series = {};
                for (const key of Object.keys(result.series)) {
                    const s = result.series[key];
                    const o = {
                        key: s.key, type: s.type, mode: s.mode, label: s.label,
                        lastIndex: s.lastIndex,
                        ret: b64FromBuf(s.ret.buffer),
                    };
                    if (s.period) o.period = b64FromBuf(s.period.buffer);
                    if (s.short) o.short = b64FromBuf(s.short.buffer);
                    if (s.long) o.long = b64FromBuf(s.long.buffer);
                    series[key] = o;
                }
                const payload = {
                    sig: cfgSig(cfg),
                    dataStart: meta.start, dataEnd: meta.end, dataCount: meta.count,
                    savedAt: new Date().toISOString(),
                    firstIndex: result.firstIndex,
                    windowYears: result.windowYears,
                    cfg: result.cfg || cfg,
                    series,
                };
                root.localStorage.setItem(KEY, JSON.stringify(payload));
                return true;
            } catch (e) {
                // 配额不足 / 隐私模式：清掉可能写坏的半份，下次照常重算
                try { root.localStorage.removeItem(KEY); } catch (_) {}
                if (root.console) console.warn('[cache] 结果缓存写入失败，本次不缓存：', e && e.message);
                return false;
            }
        },

        /**
         * 读取缓存。
         * @returns {null | {result, fresh:boolean, cachedEnd:string, cachedCount:number, savedAt:string}}
         *   fresh = true  数据指纹完全一致，可直接当最终结果用
         *   fresh = false 缓存算到更早的某天（数据后来长了），可先出图再后台补算
         */
        load(cfg, meta) {
            let raw;
            try { raw = root.localStorage.getItem(KEY); } catch (e) { return null; }
            if (!raw) return null;
            let p;
            try { p = JSON.parse(raw); } catch (e) { this.clear(); return null; }
            if (!p || p.sig !== cfgSig(cfg)) return null;
            // 起点必须一致（换了数据源就不能混用），且缓存不能比当前数据还长
            if (!meta || p.dataStart !== meta.start) return null;
            if (!(p.dataCount > 0) || p.dataCount > meta.count) return null;

            try {
                const series = {};
                for (const key of Object.keys(p.series)) {
                    const s = p.series[key];
                    const ret = new Float64Array(bufFromB64(s.ret));
                    if (ret.length !== p.dataCount) return null;      // 存坏了，宁可重算
                    series[key] = {
                        key: s.key, type: s.type, mode: s.mode, label: s.label,
                        lastIndex: s.lastIndex,
                        ret,
                        period: s.period ? new Int16Array(bufFromB64(s.period)) : null,
                        short: s.short ? new Int16Array(bufFromB64(s.short)) : null,
                        long: s.long ? new Int16Array(bufFromB64(s.long)) : null,
                    };
                }
                if (!Object.keys(series).length) return null;
                return {
                    result: {
                        firstIndex: p.firstIndex, windowYears: p.windowYears,
                        cfg: p.cfg, series, fromCache: true, cachedEnd: p.dataEnd,
                    },
                    fresh: p.dataCount === meta.count,
                    cachedEnd: p.dataEnd,
                    cachedCount: p.dataCount,
                    savedAt: p.savedAt,
                };
            } catch (e) {
                this.clear();
                return null;
            }
        },

        clear() { try { root.localStorage.removeItem(KEY); } catch (e) {} },

        // 缓存占用（KB），用于页脚如实显示
        sizeKB() {
            try {
                const raw = root.localStorage.getItem(KEY);
                return raw ? Math.round(raw.length / 1024) : 0;
            } catch (e) { return 0; }
        },
    };

    root.RollingCache = RollingCache;
})(typeof self !== 'undefined' ? self : this);
