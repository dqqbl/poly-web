# BTC5m-Dash 服务器部署指南

> **服务器**: AWS EC2 (eu-west-1)  
> **仓库**: `git@github.com:dqqbl/poly-web.git`  
> **连接**: `ssh -i "/Users/dqqbl/myweb/rsa/poly-Ireland.pem" ubuntu@ec2-52-211-133-152.eu-west-1.compute.amazonaws.com`

---

## 一、连接服务器

```bash
ssh -i "/Users/dqqbl/myweb/rsa/poly-Ireland.pem" ubuntu@ec2-52-211-133-152.eu-west-1.compute.amazonaws.com
```

---

## 二、安装 Node.js 20+

```bash
# 检查当前版本
node -v

# 如果版本低于 20 或未安装，执行以下命令
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 验证
node -v   # v20.x.x
npm -v    # 10.x.x
```

---

## 三、拉取代码

```bash
cd ~
git clone git@github.com:dqqbl/poly-web.git
cd BTC5m-Dash
```

---

## 四、配置环境变量

```bash
# 复制模板
cp .env.example .env

# 编辑配置
nano .env
```

### 最小可用配置示例：

```env
# === 核心配置（必填）===
# Polygon 私钥 — 首次运行用于生成 API 凭证，生成后本地会缓存
POLYMARKET_PRIVATE_KEY=0x你的私钥

# Polymarket 代理钱包地址（充值地址，在 polymarket.com 账户页面找到）
POLYMARKET_PROXY_ADDRESS=0x你的代理钱包地址

# === 运行配置 ===
# full = 带前端面板 | headless = 纯 API 模式
APP_MODE=full

# 自动领取到期仓位
AUTO_CLAIM_ENABLED=true

# 默认滑点
ORDER_DEFAULT_SLIPPAGE=0.05

# === 策略配置（默认全关，启动后在前端面板按需开启更安全）===
STRATEGY_S1_ENABLED=false
STRATEGY_S1_AMOUNT=1
STRATEGY_S2_ENABLED=false
STRATEGY_S2_AMOUNT=1
STRATEGY_S3_ENABLED=false
STRATEGY_S3_AMOUNT=1
STRATEGY_S4_ENABLED=false
STRATEGY_S4_AMOUNT=1
STRATEGY_S5_ENABLED=false
STRATEGY_S5_AMOUNT=1
```

> 💡 **复用 .env.bot 配置**：如果你另一个项目也是 Polymarket 机器人，直接复制 `POLYMARKET_PRIVATE_KEY` 和 `POLYMARKET_PROXY_ADDRESS` 这两项即可，其余配置按上面补齐。

---

## 五、安装依赖

```bash
npm install
```

---

## 六、前台测试启动（验证配置）

```bash
npm start
```

看到类似以下输出即表示启动成功：

```
启动 BTC 5m 盘口监控...
运行模式: full
浏览器地址: http://localhost:3456
```

首次启动时会自动从私钥生成 Polymarket API 凭证并保存到 `.polymarket-creds.json`。

按 `Ctrl + C` 停止。

---

## 七、后台持久化运行（PM2）

SSH 窗口关闭后进程必须保持运行，使用 **PM2** 管理：

```bash
# 安装 PM2
sudo npm install -g pm2

# 启动服务（后台运行）
pm2 start --name btc5m "npx tsx server.ts"

# 保存 PM2 配置，实现开机自启
pm2 save
pm2 startup systemd
# 按照提示执行最后一条命令（通常需要 sudo）
```

---

## 八、本地访问面板（安全方式）

**⚠️ 警告：不要直接把服务器的 3456 端口开放到公网，任何人访问都可以下单！**

### 方式 1：SSH 隧道（推荐，最简单）

在**本地电脑**（Mac/Windows）新开一个终端，执行：

```bash
ssh -i "/Users/dqqbl/myweb/rsa/poly-Ireland.pem" -L 3456:127.0.0.1:3456 ubuntu@ec2-52-211-133-152.eu-west-1.compute.amazonaws.com
```

保持这个窗口运行，然后在本地浏览器打开：

```
http://localhost:3456
```

### 方式 2：带 SSH 隧道的后台连接

如果希望 SSH 隧道也在后台运行，本地执行：

```bash
ssh -i "/Users/dqqbl/myweb/rsa/poly-Ireland.pem" -fN -L 3456:127.0.0.1:3456 ubuntu@ec2-52-211-133-152.eu-west-1.compute.amazonaws.com
```

关闭隧道时：

```bash
# 查找并杀掉对应的 SSH 进程
lsof -ti:3456 | xargs kill -9
```

---

## 九、常用运维命令

```bash
# 查看运行状态
pm2 status

# 查看实时日志
pm2 logs btc5m

# 查看最近 100 行日志
pm2 logs btc5m --lines 100

# 重启服务
pm2 restart btc5m

# 停止服务
pm2 stop btc5m

# 删除服务（不再自动启动）
pm2 delete btc5m

# 监控面板（CPU/内存）
pm2 monit
```

---

## 十、更新代码

当代码有更新时：

```bash
ssh -i "/Users/dqqbl/myweb/rsa/poly-Ireland.pem" ubuntu@ec2-52-211-133-152.eu-west-1.compute.amazonaws.com

cd ~/BTC5m-Dash

# 拉取最新代码
git pull

# 如有新依赖
npm install

# 重启服务
pm2 restart btc5m

# 查看启动是否正常
pm2 logs btc5m --lines 50
```

---

## 十一、防火墙 & 安全建议

```bash
# 确认 3456 没有对外开放（AWS EC2 需要在安全组里检查）
sudo ufw status

# 如果安装了 ufw，确保只开放必要端口
sudo ufw allow 22/tcp     # SSH
sudo ufw enable

# 3456 端口不应该出现在开放列表中
```

**AWS 安全组检查**：
- 登录 AWS Console → EC2 → 安全组
- 找到实例关联的安全组
- **入站规则**中不应该有 `3456` 端口的规则
- 只保留 `22` (SSH) 端口即可

---

## 十二、文件说明

| 文件 | 说明 | 是否敏感 |
|------|------|---------|
| `.env` | 私钥和配置 | 🔒 绝不上传 |
| `.polymarket-creds.json` | API 凭证缓存 | 🔒 绝不上传 |
| `.trade-history.json` | 交易记录 | 🔒 建议备份 |
| `.strategy-config.json` | 策略持久化配置 | 🔒 建议备份 |
| `backtest-data/` | 回测数据 | 可定期清理 |

---

## 十三、一键部署脚本（可选）

将以下内容保存为 `deploy.sh`，上传到服务器执行即可：

```bash
#!/bin/bash
set -e

REPO="git@github.com:dqqbl/poly-web.git"
DIR="$HOME/BTC5m-Dash"

echo "=== 安装 Node.js 20+ ==="
if ! command -v node &> /dev/null || [ "$(node -v | cut -d'v' -f2 | cut -d'.' -f1)" != "20" ]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
    sudo apt-get install -y nodejs
fi

echo "=== 拉取代码 ==="
if [ -d "$DIR" ]; then
    cd "$DIR"
    git pull
else
    git clone "$REPO" "$DIR"
    cd "$DIR"
fi

echo "=== 安装依赖 ==="
npm install

echo "=== 检查 .env ==="
if [ ! -f .env ]; then
    echo "⚠️ 未找到 .env 文件，请手动配置："
    echo "   cp .env.example .env"
    echo "   nano .env"
    exit 1
fi

echo "=== 安装 PM2 ==="
sudo npm install -g pm2

echo "=== 启动/重启服务 ==="
pm2 delete btc5m 2>/dev/null || true
pm2 start --name btc5m "npx tsx server.ts"
pm2 save

echo "=== 部署完成 ==="
echo "查看日志: pm2 logs btc5m"
echo "本地访问: ssh -i ~/.ssh/你的密钥.pem -L 3456:127.0.0.1:3456 ubuntu@你的服务器IP"
```

---

## 快速参考

```bash
# 连接服务器
ssh -i "/Users/dqqbl/myweb/rsa/poly-Ireland.pem" ubuntu@ec2-52-211-133-152.eu-west-1.compute.amazonaws.com

# 本地开隧道访问面板
ssh -i "/Users/dqqbl/myweb/rsa/poly-Ireland.pem" -L 3456:127.0.0.1:3456 ubuntu@ec2-52-211-133-152.eu-west-1.compute.amazonaws.com
# 浏览器访问 http://localhost:3456

# 服务器上常用命令
pm2 status          # 查看状态
pm2 logs btc5m      # 查看日志
pm2 restart btc5m   # 重启
```
