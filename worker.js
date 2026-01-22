/**
 * OKX Cloudflare Proxy (Production Ready)
 * 1. 支持 CORS，方便本地前端调试
 * 2. 自动处理 HTTP/WebSocket
 * 3. 模拟盘/实盘自动路由
 */

const UPSTREAM_REAL = 'ws.okx.com';
const UPSTREAM_SIM = 'wspap.okx.com';
const REST_REAL = 'www.okx.com';

addEventListener('fetch', event => {
  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const url = new URL(request.url);
  const upgradeHeader = request.headers.get('Upgrade');
  
  // === 1. 处理 WebSocket 连接 ===
  if (upgradeHeader === 'websocket') {
    const isSim = url.searchParams.get('sim') === '1';
    const targetHost = isSim ? UPSTREAM_SIM : UPSTREAM_REAL;
    
    // 构建上游 URL，保留路径但不带 Query (OKX WS 鉴权不认多余参数)
    const upstreamUrl = new URL(url.pathname, `https://${targetHost}`);
    
    // 初始化 WS 请求
    const newRequest = new Request(upstreamUrl, request);
    
    // 关键：Cloudflare Workers 处理 WS 需要 fetch
    const response = await fetch(newRequest);
    
    // 创建 WebSocket 对 (Client <-> Worker <-> OKX)
    const [client, server] = Object.values(new WebSocketPair());
    
    // 建立连接
    server.accept();
    response.webSocket.accept();

    // 管道转发：Client -> OKX
    server.addEventListener('message', event => {
        response.webSocket.send(event.data);
    });

    // 管道转发：OKX -> Client
    response.webSocket.addEventListener('message', event => {
        server.send(event.data);
    });

    // 错误与关闭处理
    const closeHandler = () => {
        try { server.close(); } catch(e){}
        try { response.webSocket.close(); } catch(e){}
    };
    
    server.addEventListener('close', closeHandler);
    response.webSocket.addEventListener('close', closeHandler);
    server.addEventListener('error', closeHandler);
    response.webSocket.addEventListener('error', closeHandler);

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  // === 2. 处理 REST API (HTTP) ===
  const isSimHttp = request.headers.get('x-simulated-trading') === '1';
  // 注意：REST API 模拟盘通常也是 www.okx.com，只是通过 Header 区分，
  // 除非是特定的模拟盘独立域名。OKX V5 API 统一入口通常是 www.okx.com
  const targetHostHttp = REST_REAL; 

  const upstreamUrl = new URL(url.pathname + url.search, `https://${targetHostHttp}`);
  
  // 构造新请求
  const newRequest = new Request(upstreamUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body
  });

  // 强制覆盖 Host 头，否则 OKX 会拒绝
  newRequest.headers.set('Host', targetHostHttp);
  
  const response = await fetch(newRequest);

  // === 3. 处理 CORS (关键：解决本地 localhost 调试跨域问题) ===
  const newResponse = new Response(response.body, response);
  newResponse.headers.set('Access-Control-Allow-Origin', '*');
  newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  newResponse.headers.set('Access-Control-Allow-Headers', 'Content-Type, x-simulated-trading, OK-ACCESS-KEY, OK-ACCESS-SIGN, OK-ACCESS-TIMESTAMP, OK-ACCESS-PASSPHRASE');

  return newResponse;
}
