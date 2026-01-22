# OKX Cloudflare Worker Proxy

这是一个部署在 Cloudflare Workers 上的轻量级反向代理，用于解决开发环境无法直连 OKX API 的问题。

## ✨ 特性

- **全能转发**：同时支持 HTTP (REST API) 和 WebSocket。
- **智能路由**：自动区分**实盘** (`ws.okx.com`) 和 **模拟盘** (`wspap.okx.com`)。
- **消息队列**：内置 WebSocket 消息队列，解决客户端连接成功瞬间发送数据丢失的问题（消除竞态条件）。
- **隐私保护**：自动剥离路由参数，确保上游 OKX 服务器接收到合法的请求路径。
- **零成本**：基于 Cloudflare Workers 免费版，每日 100,000 次请求额度，足够个人量化策略使用。

## 🚀 部署步骤

1. 登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2. 进入 **Workers & Pages** -> **Create Application** -> **Create Worker**。
3. 命名你的 Worker（例如 `okx-proxy`），点击 **Deploy**。
4. 点击 **Edit code**，将 `worker.js` 中的代码清空，复制粘贴本项目提供的代码。
5. **绑定域名（必须）**：
   - 在 Worker 的 **Settings** -> **Triggers** -> **Custom Domains** 中，绑定一个你自己的子域名（例如 `api.yourdomain.com`）。
   - *注意：不要使用默认的 `*.workers.dev` 域名，否则无法连接。*

## 🛠️ 服务端代码 (Worker.js)

```javascript
export default {
  async fetch(request, env, ctx) {
    const upgradeHeader = request.headers.get('Upgrade');
    const url = new URL(request.url);

    // ================= 配置区域 =================
    const HOST_REST = 'www.okx.com';
    const HOST_WS_REAL = 'ws.okx.com:8443';
    const HOST_WS_SIM = 'wspap.okx.com:8443';
    // ===========================================

    if (upgradeHeader === 'websocket') {
      // 1. 识别并剥离 sim 参数
      const isSim = url.searchParams.get('sim') === '1';
      url.searchParams.delete('sim');
      const targetHost = isSim ? HOST_WS_SIM : HOST_WS_REAL;
      const targetUrl = `wss://${targetHost}${url.pathname}${url.search}`;

      // 2. 建立双向连接
      const okxSocket = new WebSocket(targetUrl);
      const { 0: client, 1: server } = new WebSocketPair();

      // 3. 消息队列机制 (防止连接未建立时的丢包)
      server.accept();
      let messageQueue = [];
      let isBackendReady = false;

      server.addEventListener('message', event => {
        if (isBackendReady) {
          try { okxSocket.send(event.data); } catch(e){}
        } else {
          messageQueue.push(event.data);
        }
      });

      okxSocket.addEventListener('open', () => {
        isBackendReady = true;
        while (messageQueue.length > 0) {
          try { okxSocket.send(messageQueue.shift()); } catch(e){}
        }
        okxSocket.addEventListener('message', event => {
          try { server.send(event.data); } catch(e){}
        });
      });

      const closeBoth = () => {
        try { server.close(); } catch(e){}
        try { okxSocket.close(); } catch(e){}
      };
      server.addEventListener('close', closeBoth);
      okxSocket.addEventListener('close', closeBoth);
      server.addEventListener('error', closeBoth);
      okxSocket.addEventListener('error', closeBoth);

      return new Response(null, { status: 101, webSocket: client });
    }

    // HTTP 请求处理
    url.hostname = HOST_REST;
    url.searchParams.delete('sim');
    const newRequest = new Request(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.body,
      redirect: 'follow'
    });

    try {
      const response = await fetch(newRequest);
      const newResponse = new Response(response.body, response);
      // 处理 CORS
      newResponse.headers.set('Access-Control-Allow-Origin', '*');
      newResponse.headers.set('Access-Control-Allow-Headers', '*');
      newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      return newResponse;
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  },
};