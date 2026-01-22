# 🌩️ OKX Cloudflare Worker Proxy

这是一个部署在 Cloudflare Workers 上的轻量级反向代理，专门用于解决开发环境无法直连 OKX API 的网络问题。

## ✨ 主要特性

- **🔄 全能转发**：同时支持 HTTP (REST API) 和 WebSocket 长连接。
- **🧠 智能路由**：自动区分 **实盘** (`ws.okx.com`) 和 **模拟盘** (`wspap.okx.com`)。
- **⚡️ 消息队列**：内置 WebSocket 消息队列，解决客户端连接成功瞬间发送数据丢失的问题（消除竞态条件）。
- **🛡️ 隐私保护**：自动剥离路由辅助参数，确保上游 OKX 服务器接收到合法的请求路径。
- **💰 零成本**：基于 Cloudflare Workers 免费版，每日 **100,000 次** 请求额度，足够个人量化策略使用。

## 🚀 部署步骤

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 进入 **Workers & Pages** -> **Create Application** -> **Create Worker**。
3. 命名你的 Worker（例如 `okx-proxy`），点击 **Deploy**。
4. 点击 **Edit code**，将 `worker.js` 中的代码清空，复制粘贴本项目提供的代码。
5. **绑定域名（⚠️ 必须）**：
   - 在 Worker 的 **Settings** -> **Triggers** -> **Custom Domains** 中，绑定一个你自己的子域名（例如 `api.yourdomain.com`）。
   > **注意**：请勿使用 Cloudflare 默认提供的 `*.workers.dev` 域名，否则大概率无法连接。

## 💻 客户端调用指南

假设你的 Worker 域名为：`api.yourdomain.com`

### 1. WebSocket 连接 (推荐)

- **实盘地址**：`wss://api.yourdomain.com/ws/v5/public`
- **模拟盘地址**：`wss://api.yourdomain.com/ws/v5/public?sim=1`

> 💡 **提示**：只需在 URL 后添加 `?sim=1`，Worker 会自动路由到模拟盘网关。

**Python 示例 (websocket-client):**

```python
import json
import time
from websocket import create_connection

# 模拟盘加上 ?sim=1，实盘去掉即可
url = "wss://api.yourdomain.com/ws/v5/public?sim=1"

ws = create_connection(url)

# 发送订阅指令
payload = {
    "op": "subscribe",
    "args": [{"channel": "tickers", "instId": "BTC-USDT"}]
}
ws.send(json.dumps(payload))

while True:
    result = ws.recv()
    print(result)
	```
### 2. REST API 请求

- **实盘/模拟盘地址**：`https://api.yourdomain.com/api/v5/...`

**区分方法：**

| 模式 | 请求头 (Header) | 说明 |
| :--- | :--- | :--- |
| **实盘** | 无 | 正常请求即可 |
| **模拟盘** | `x-simulated-trading: 1` | 必须在 Header 中添加此字段 |

**Python 示例 (requests):**

```python
import requests

url = "https://api.yourdomain.com/api/v5/public/time"

# 模拟盘必须加这个 Header
headers = {
    "x-simulated-trading": "1"
}

res = requests.get(url, headers=headers)
print(res.json())```

## ⚠️ 注意事项

1. **Cloudflare 额度限制**
   免费版每日限制 **100,000 次** 请求。请务必使用 **WebSocket 长连接**，避免使用高频 HTTP 轮询。

2. **断线重连**
   客户端代码必须包含断线重连机制，并且在重连前加入 `time.sleep(5)` 等待时间，防止瞬间耗尽请求额度。

3. **安全提示**
   请勿将你的 API Key 和 Secret 硬编码在 Worker 代码中。Worker 仅作为透明传输通道，鉴权应在客户端进行。	
