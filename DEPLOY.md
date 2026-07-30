# 推送到 GitHub 与部署

本次会话里的 Linux 沙箱没能启动（`rootfs.vhdx` 缺失），所以我无法代跑 `git`，
只能把命令整理在这里，你在项目目录里按顺序执行即可。

> **最省事：双击 `push_github.bat`。** 它会自动 init / commit，有 GitHub CLI 就直接建仓推送，
> 没有就打印出需要你手动执行的两行命令。账号按 `btc-quant-backtest` 里的配置填的是 `hhysteric`。
> 推完的站点地址：`https://hhysteric.github.io/btc-rolling-best-ma/`

## 0. 先准备数据文件

```bat
cd %USERPROFILE%\Desktop\btc-rolling-best-ma
copy ..\btc-quant-backtest\data\btc-daily.json data\btc-daily.json
```

或者直接双击 `setup.bat`（会自动复制数据并起本地服务器，浏览器打开 http://localhost:8080 自检）。

## 1. 初始化并提交

```bat
cd %USERPROFILE%\Desktop\btc-rolling-best-ma
git init -b main
git add .
git commit -m "feat: 4Y Rolling Best MA 站点（含四年大周期三种对齐对比）"
```

## 2. 建仓库并推送

有 GitHub CLI 最省事（会自动建仓 + 设 remote + 推送）：

```bat
gh repo create btc-rolling-best-ma --public --source=. --remote=origin --push
```

没有 `gh` 就先在网页上建一个空仓库（不要勾选 README / .gitignore），然后：

```bat
git remote add origin https://github.com/<你的用户名>/btc-rolling-best-ma.git
git push -u origin main
```

## 3. 打开 GitHub Pages

仓库 Settings → Pages → Source 选 `Deploy from a branch`，分支 `main`，目录 `/ (root)`，保存。
一两分钟后访问 `https://<你的用户名>.github.io/btc-rolling-best-ma/`。

## 4. 让每日数据更新生效

`.github/workflows/update-data.yml` 已经在仓库里，推送后需要确认一次：
仓库 Settings → Actions → General → Workflow permissions 选 **Read and write permissions**，
否则 Actions 提交数据时会被拒。之后可以在 Actions 页面点 `Run workflow` 手动验证一次。

## 5. 如果 `git push` 卡住 / 连不上 github.com

这是 `btc-cycle-dashboard` 里遇到过的情况：`github.com`（git 协议、443）被墙，
但 `api.github.com` 往往还通。可以走 GitHub REST API 直接提交：

1. 生成一个有 `repo` 权限的 Personal Access Token（Settings → Developer settings → Tokens）。
2. 依次调用：
   - `POST /repos/{owner}/{repo}/git/blobs` 上传每个文件内容，拿到 blob sha
   - `POST /repos/{owner}/{repo}/git/trees` 用这些 blob 组成 tree（`base_tree` 填当前 commit 的 tree）
   - `POST /repos/{owner}/{repo}/git/commits` 建 commit（`parents` 填当前 HEAD）
   - `PATCH /repos/{owner}/{repo}/git/refs/heads/main` 把 main 指向新 commit

也可以先试这两个更省事的办法：

```bat
git config --global http.postBuffer 524288000
git push -u origin main
```

```bat
:: 走 SSH（22 端口不通时可以用 GitHub 的 443 端口 SSH）
git remote set-url origin git@github.com:<你的用户名>/btc-rolling-best-ma.git
ssh -T -p 443 git@ssh.github.com
git config --global url."ssh://git@ssh.github.com:443/".insteadOf "git@github.com:"
git push -u origin main
```

## 6. 自检清单

- [ ] `data/btc-daily.json` 存在，页面页脚显示的数据区间与 `btc-quant-backtest` 一致
- [ ] 首屏进度条走完后主图出现（默认 MA/EMA × 单/双均线，周期 5–250 步长 1）
- [ ] 「最优均线周期 / 最优策略收益率」两个口径都能切
- [ ] 四年大周期对比的三个按钮（最高点 / 最低点 / 减半日）都能切，且下方解读段落跟着变
- [ ] `node scripts/verify_rolling.mjs` 全部 OK（校验快速算法与逐笔模拟等价）
