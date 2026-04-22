# 与上游开源仓库同步说明

本仓库（`poly-web`）在业务代码上跟踪上游 **BTC5m-Dash**，并额外保留部署相关文档（如 `DEPLOY.md`）。日常用 **两个 Git 远程**：一个只拉开源更新，一个只推自己的部署用仓库。

| 远程名 | 用途 | 地址 |
|--------|------|------|
| `upstream` | 拉取上游代码（不要 `push`） | `git@github.com:doge-8/BTC5m-Dash.git` |
| `origin` | 推送到自己的 GitHub，服务器 `git pull` 用 | `git@github.com:dqqbl/poly-web.git` |

---

## 一、首次配置（每台开发机只做一次）

```bash
cd /path/to/poly-web

# 自己的仓库（部署用）
git remote add origin git@github.com:dqqbl/poly-web.git
# 若已存在 origin，仅改 URL：
# git remote set-url origin git@github.com:dqqbl/poly-web.git

# 上游开源（只读同步源）
git remote add upstream git@github.com:doge-8/BTC5m-Dash.git
# 若已存在 upstream：
# git remote set-url upstream git@github.com:doge-8/BTC5m-Dash.git

git remote -v
```

确认上游默认分支名（一般是 `main`，也可能是 `master`）：

```bash
git ls-remote --symref upstream HEAD
```

下文默认上游主分支为 **`main`**；若输出里是 `master`，请把所有 `upstream/main` 换成 `upstream/master`。

---

## 二、日常同步（重复执行）

在本地 `poly-web` 中：

```bash
git checkout main
git pull origin main

git fetch upstream
git merge upstream/main
```

合并完成后安装依赖（仅当 `package.json` / `package-lock.json` 有变化时需要，无变化可跳过）：

```bash
npm install
```

推送到自己的仓库，供服务器拉取：

```bash
git push origin main
```

服务器上更新部署：

```bash
cd ~/poly-web   # 或你实际克隆目录
git pull origin main
npm install
pm2 restart btc5m   # 进程名以你 DEPLOY.md / 实际为准
```

---

## 三、合并冲突时

若你本地改过与上游相同的文件，会产生冲突：

1. 打开冲突文件，按意图保留或合并内容。  
2. 一般原则：**业务逻辑与 UI 以 `upstream` 为准**；仅部署说明、私有配置保留本地。  
3. `git add` 解决后的文件，`git commit` 完成合并，再 `git push origin main`。

---

## 四、注意事项

1. **不要**执行 `git push upstream …`：通常没有上游写权限，且不应把个人分支强行推到对方仓库。  
2. **`DEPLOY.md` 等仅存在于本仓库的文件**：只要已提交在 `main` 上，每次 `merge upstream/main` 后仍会保留；上游一般不会删除你本地未跟踪的文件（若上游将来增加了同名文件，才可能需要一次冲突处理）。  
3. **首次与上游建立关联**时若 Git 提示 *unrelated histories*，仅第一次需要：

   ```bash
   git merge upstream/main --allow-unrelated-histories
   ```

   解决冲突并提交后，之后按第二节正常 `merge` 即可。

4. 若更偏好线性历史，可将 `git merge upstream/main` 改为 `git rebase upstream/main`，再 `git push origin main`（若已推送过 `main`，有时需 `git push --force-with-lease`，团队分支慎用）。

---

## 五、快速命令汇总

```bash
git checkout main && git pull origin main
git fetch upstream && git merge upstream/main
npm install
git push origin main
```
