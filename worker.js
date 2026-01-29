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
          const isSim = url.searchParams.get('sim') === '1';
          url.searchParams.delete('sim');
          const targetHost = isSim ? HOST_WS_SIM : HOST_WS_REAL;
          const targetUrl = `wss://${targetHost}${url.pathname}${url.search}`;

          // 1. 建立与 OKX 的连接
          const okxSocket = new WebSocket(targetUrl);

          // 2. 建立与客户端的连接
          const { 0: client, 1: server } = new WebSocketPair();

          // 3. 【关键修改】接受连接，并准备消息队列
          server.accept();
          let messageQueue = []; // 暂存消息的队列
          let isBackendReady = false;

          // 4. 立即监听客户端发来的消息
          server.addEventListener('message', event => {
              if (isBackendReady) {
                  // 如果后台连上了，直接发
                  try { okxSocket.send(event.data); } catch (e) { }
              } else {
                  // 如果后台没连上，先存进队列
                  messageQueue.push(event.data);
              }
          });

          // 5. 监听 OKX 连接成功事件
          okxSocket.addEventListener('open', () => {
              isBackendReady = true;

              // 把队列里暂存的消息全部发出去
              while (messageQueue.length > 0) {
                  const msg = messageQueue.shift();
                  try { okxSocket.send(msg); } catch (e) { }
              }

              // 设置反向转发：OKX -> 客户端
              okxSocket.addEventListener('message', event => {
                  try { server.send(event.data); } catch (e) { }
              });
          });

          // 6. 错误与关闭处理
          const closeBoth = () => {
              try { server.close(); } catch (e) { }
              try { okxSocket.close(); } catch (e) { }
          };
          server.addEventListener('close', closeBoth);
          okxSocket.addEventListener('close', closeBoth);
          server.addEventListener('error', closeBoth);
          okxSocket.addEventListener('error', closeBoth);

          return new Response(null, { status: 101, webSocket: client });
      }

      // HTTP 处理保持不变
      url.hostname = HOST_REST;
      url.searchParams.delete('sim');
      // 修正 Headers: 必须移除 Host 头，否则 OKX 会因为 SNI 不匹配返回 403/404
      const newHeaders = new Headers(request.headers);
      newHeaders.delete('Host');
      newHeaders.delete('cf-connecting-ip'); // 可选：移除 CF 内部头

      const newRequest = new Request(url.toString(), {
          method: request.method,
          headers: newHeaders,
          body: request.body,
          redirect: 'follow'
      });

      try {
          const response = await fetch(newRequest);
          const newResponse = new Response(response.body, response);
          newResponse.headers.set('Access-Control-Allow-Origin', '*');
          newResponse.headers.set('Access-Control-Allow-Headers', '*');
          newResponse.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
          return newResponse;
      } catch (e) {
          return new Response(JSON.stringify({ error: e.message }), { status: 500 });
      }
  },
};
