# 🌩️ OKX Cloudflare Worker Proxy (Enhanced)

这是一个部署在 Cloudflare Workers 上的高性能反向代理，专为解决开发环境无法直连 OKX API 而设计。

**此版本已针对生产环境优化，解决了 CORS 跨域问题及 WebSocket 长连接断连问题。**

## ✨ 核心特性

- **🔄 全能转发**：完美支持 HTTP (REST API) 和 WebSocket 长连接。
- **❤️ 连接保活**：优化了 WebSocket 管道处理，配合客户端心跳机制，解决 Cloudflare 100秒超时断连问题。
- **🌐 CORS 支持**：内置跨域资源共享（CORS）头，支持本地前端（Web）直接调试。
- **🧠 智能路由**：自动区分 **实盘** (`ws.okx.com`) 和 **模拟盘** (`wspap.okx.com`)。
- **🛡️ 隐私保护**：自动剥离路由参数，确保上游 OKX 服务器接收到合法的请求路径。
- **💰 零成本**：基于 Cloudflare Workers 免费版，每日 **100,000 次** 请求额度。

---

## 🚀 部署步骤

1.  登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2.  进入 **Workers & Pages** -> **Create Application** -> **Create Worker**。
3.  命名你的 Worker（例如 `okx-proxy`），点击 **Deploy**。
4.  点击 **Edit code**，清空内容，复制下方 **增强版代码** 并保存。
5.  **绑定域名（⚠️ 必须）**：
    *   在 Worker 的 **Settings** -> **Triggers** -> **Custom Domains** 中绑定子域名（如 `api.yourdomain.com`）。
    *   *注意：请勿使用 `*.workers.dev` 默认域名。*

### 🛠️ Worker 增强版代码 (`worker.js`)

```javascript
const UPSTREAM_REAL = 'ws.okx.com';
const UPSTREAM_SIM = 'wspap.okx.com';
const REST_REAL = 'www.okx.com';

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const upgradeHeader = request.headers.get('Upgrade');
  
  // === 1. WebSocket 处理 (包含管道转发) ===
  if (upgradeHeader === 'websocket') {
    const isSim = url.searchParams.get('sim') === '1';
    const targetHost = isSim ? UPSTREAM_SIM : UPSTREAM_REAL;
    const upstreamUrl = new URL(url.pathname, `https://${targetHost}`);
    
    const newRequest = new Request(upstreamUrl, request);
    const response = await fetch(newRequest);
    
    const [client, server] = Object.values(new WebSocketPair());
    
    server.accept();
    response.webSocket.accept();

    // 双向转发
    server.addEventListener('message', event => response.webSocket.send(event.data));
    response.webSocket.addEventListener('message', event => server.send(event.data));

    // 错误与关闭处理
    const closeHandler = () => {
        try { server.close(); } catch(e){}
        try { response.webSocket.close(); } catch(e){}
    };
    server.addEventListener('close', closeHandler);
    response.webSocket.addEventListener('close', closeHandler);
    server.addEventListener('error', closeHandler);
    response.webSocket.addEventListener('error', closeHandler);

    return new Response(null, { status: 101, webSocket: client });
  }

  // === 2. REST API 处理 (HTTP) ===
  // 模拟盘 HTTP 通常与实盘共用 www.okx.com，通过 Header 区分
  const targetHostHttp = REST_REAL; 
  const upstreamUrl = new URL(url.pathname + url.search, `https://${targetHostHttp}`);
  
  const newRequest = new Request(upstreamUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body
  });

  // 关键：强制重写 Host 头，避免 OKX 403 错误
  newRequest.headers.set('Host', targetHostHttp);
  
  const response = await fetch(newRequest);

  // === 3. CORS 跨域支持 (方便本地 Web 调试) ===
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('Access-Control-Allow-Origin', '*');
  newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, x-simulated-trading, OK-ACCESS-KEY, OK-ACCESS-SIGN, OK-ACCESS-TIMESTAMP, OK-ACCESS-PASSPHRASE');

  return newResponse;
}
```

---

## 💻 客户端调用指南

假设你的 Worker 域名为：`api.yourdomain.com`

### 1. WebSocket 连接 (推荐)

*   **实盘地址**：`wss://api.yourdomain.com/ws/v5/public`
*   **模拟盘地址**：`wss://api.yourdomain.com/ws/v5/public?sim=1`

> 💡 **提示**：只需在 URL 后添加 `?sim=1`，Worker 会自动路由到模拟盘网关。

**🐍 Python 示例 (带心跳保活 - 生产必备):**

Cloudflare 若检测到 60-100秒无数据传输会强制断开连接，因此**必须**开启心跳线程。

```python
import json
import time
import threading
from websocket import create_connection, WebSocketConnectionClosedException

# 填入你的 Worker 域名
url = "wss://api.yourdomain.com/ws/v5/public"

def on_message(ws):
    while True:
        try:
            result = ws.recv()
            print(f"收到数据: {result}")
        except WebSocketConnectionClosedException:
            print("连接已断开")
            break
        except Exception as e:
            print(f"发生错误: {e}")
            break

def keep_alive(ws):
    """
    关键：每 20 秒发送一次 ping。
    Cloudflare 和 OKX 都需要这个来维持连接不被杀掉。
    """
    while ws.connected:
        try:
            ws.send("ping")
            # print("Ping sent")
            time.sleep(20)
        except Exception as e:
            print(f"Ping failed: {e}")
            break

if __name__ == "__main__":
    # 建立连接
    ws = create_connection(url)
    print("连接成功...")

    # 1. 启动接收数据线程
    t_recv = threading.Thread(target=on_message, args=(ws,))
    t_recv.start()
    
    # 2. 启动心跳保活线程 (防止断连)
    t_ping = threading.Thread(target=keep_alive, args=(ws,))
    t_ping.start()
    
    # 3. 发送业务订阅 (例如订阅 BTC 价格)
    payload = {
        "op": "subscribe",
        "args": [{"channel": "tickers", "instId": "BTC-USDT"}]
    }
    ws.send(json.dumps(payload))
```

### 2. REST API 请求

*   **通用地址**：`https://api.yourdomain.com/api/v5/...`

**区分方法：**

| 模式 | 请求头 (Header) | 说明 |
| :--- | :--- | :--- |
| **实盘** | 无 | 正常请求即可 |
| **模拟盘** | `x-simulated-trading: 1` | 必须在 Header 中添加此字段 |

**🐍 Python 示例 (requests):**

```python
import requests

url = "https://api.yourdomain.com/api/v5/public/time"

# 模拟盘必须加这个 Header
headers = {
    "x-simulated-trading": "1"
}

res = requests.get(url, headers=headers)
print(res.json())
```

---

## ⚠️ 关键注意事项

1.  **心跳机制 (Keep-Alive)**
    Cloudflare 免费版 Workers 对空闲连接非常敏感。请务必在客户端实现定时发送 `ping` 字符串的逻辑（如上方 Python 示例所示），建议间隔 **20秒**。

2.  **额度限制**
    免费版每日 **100,000 次** 请求。WebSocket 建立连接仅算 1 次请求，后续数据传输不消耗请求次数。因此，**强烈建议使用 WebSocket**，避免高频 HTTP 轮询耗尽额度。

3.  **安全提示**
    *   API Key / Secret **不要**硬编码在 Worker 代码中。
    *   Worker 仅做数据透传，鉴权逻辑应完全在客户端完成。

---

## 📄 License & Disclaimer

本项目基于 **MIT License** 开源。

**免责声明**：
本工具仅供技术研究与测试使用。使用本代理服务进行实盘交易产生的任何资金损失（包括但不限于网络延迟、服务中断导致的亏损），开发者不承担任何责任。请妥善保管您的 API 密钥。

Copyright (c) 2024. All rights reserved.
