# 4Y Rolling Best MA

比特币「四年窗口最优均线」观察站。纯前端静态站点，无构建步骤，可直接部署到 GitHub Pages。

指标定义：对每一根日线，回看过去 **4 年**，在给定周期网格里**穷举所有均线参数**（MA/EMA，单均线与双均线金叉），
跑一遍满仓择时回测，记录该窗口内**最赚钱的参数**及其收益率。把这个"最优参数"逐日连成时间序列，
就能看到不同市场结构下最适配的均线快慢如何漂移。

计算框架逻辑沿用同作者的 `btc-quant-backtest`（`js/backtest.js` 里的 `rollingBestForType`），
页面结构、配色与交互沿用 `btc-cycle-dashboard`。

## 两个栏目

1. **4Y Rolling Best MA 时间序列** —— 左轴为每日最优均线周期（或切换为最优策略收益率），
   右轴为 BTC 收盘价（可切对数）。双均线模式会画出快线与慢线两条参数曲线。

2. **4Y Rolling Best MA 四年大周期对比** —— 把同一条序列按四年大周期锚点对齐后叠在一起比较：
   - 「从各轮最高点对齐」：各轮牛市顶（区间内最高收盘价）
   - 「从各轮最低点对齐」：各轮熊市大底（顶之后的最低收盘价）
   - 「从各轮减半日对齐」：2012-11-28 / 2016-07-09 / 2020-05-11 / 2024-04-19

   横轴是「距锚点天数」，三角形是该轮极值，菱形是本轮最新位置，下方段落给出各轮均值、区间、
   峰值出现日与历史同位取值的对比（全部由数据算出，不含任何推测性表述）。

## 目录结构

```
index.html                    页面骨架与 CDN 依赖
css/style.css                 亮色为默认，data-theme="dark" 切深色
js/rolling.js                 计算内核（无 DOM 依赖，主线程与 Worker 共用）
js/worker.js                  Web Worker 驱动，回报进度
js/data.js                    数据加载、四年周期阶段、三种对齐锚点
js/charts.js                  Chart.js 渲染（含十字准线、修饰键分轴缩放）
js/app.js                     装配：加载 → 寻优 → 渲染 → 交互
data/btc-daily.json           日线数据（date, open, high, low, close），升序
scripts/update_data.py        增量补最新日线（GitHub Actions 每日调用）
scripts/verify_rolling.mjs    校验快速实现与原始逐笔模拟等价
.github/workflows/update-data.yml   每日 01:10 UTC 自动更新数据并提交
```

## 第一步：准备数据文件

仓库不含行情数据。最省事的做法是**双击 `copy_data.bat`**，它会从同级的 `btc-quant-backtest`
复用完整历史（2010-07-13 起）。等价的手动命令：

```bat
copy ..\btc-quant-backtest\data\btc-daily.json data\btc-daily.json
```

（macOS / Linux：`cp ../btc-quant-backtest/data/btc-daily.json data/btc-daily.json`）

也可以从公开接口新建，但历史起点受接口限制（Binance 最早 2017-08，意味着满 4 年窗口后
指标只能从 2021 年开始）：

```bash
python scripts/update_data.py --bootstrap
```

缺少数据文件时页面**不会**用任何估算值凑数，而是直接显示一张说明卡片。

## 本地运行

必须用 HTTP 打开：`file://` 协议下 `fetch` 与 `Worker` 都会被浏览器拦截。

```bash
python -m http.server 8080
# 然后浏览 http://localhost:8080
```

（真的以 `file://` 打开时，页面会自动退回主线程分批计算，进度条照常走，只是慢一些。）

## 性能说明

默认配置是「MA + EMA × 单均线 + 双均线，周期 5–250 步长 1」，其中双均线是全配对穷举，
每种线型 246 个周期共 30,135 对。若按原始写法（每个日期、每个参数都从窗口左端重跑一遍择时循环），
量级在 10¹¹ 次运算，浏览器里根本跑不完。

`js/rolling.js` 把窗口内回测改写成**对数前缀和**：满仓择时的持仓状态只由当根 K 线自身决定
（收盘价与均线、或快慢均线的大小关系），与历史路径无关，因此可以全局预计算持仓序列，
窗口收益退化为一串连乘 → 取对数后是前缀和之差，任意窗口 O(1) 取值。热循环里没有一次 `Math.exp`，
比较全程停留在 log 空间。这样每种线型只剩约 1.7 亿次简单循环，Worker 里几秒到几十秒可完成。

推导与唯一的微小差异（收盘价与均线**恰好相等**时，原实现按不动作处理，本实现沿用前一根持仓状态）
写在 `js/rolling.js` 文件头。等价性用抽样复核：

```bash
node scripts/verify_rolling.mjs
# 更严格：SAMPLES=20 PMAX=120 PSTEP=3 node scripts/verify_rolling.mjs
```

## 数据更新

`scripts/update_data.py` 只追加**已收盘的完整 UTC 日**，来源优先 Binance BTCUSDT 1d
（三个节点轮询），全不可达时退到 Coinbase Exchange BTC-USD 1d，两者都是真实 OHLC。
GitHub Actions 每天 UTC 01:10（北京时间 09:10）跑一次，有变化才提交。

页面加载后还会再用 Binance 公开接口把最后几天补齐；补不上就**静默沿用本地数据**，
并在页脚如实标注「数据截止到 X 日」。

## 部署到 GitHub Pages

推送后进入仓库 Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`、目录 `/ (root)`。

## 项目底线

- **绝不编造数据。** 拿不到就显示截止日期，不做插值、不做外推、不用近似值凑数。
- 四年大周期日历年模型（`year % 4`：0 首轮牛/减半年、1 次轮牛/顶部年、2 熊市、3 预备牛）是作者的核心框架，不改。
- 无后端、无构建工具、无框架，保持双击即可维护。
- 窗口寻优是**事后回看**的最优参数，用于观察行情结构，不构成投资建议。
