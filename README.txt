CC GUI 外网穿透 · 中继部署包
CC GUI relay deploy pack

一个中继，两种跑法：Cloudflare Worker（原有方式）或你自己的 Node 服务器（新增，
自托管）。两者协议完全一致，CC GUI 客户端无需任何改动。
One relay, two ways to run it: Cloudflare Worker (the original way) or your own
Node server (new, self-hosted). Both speak the same protocol — the CC GUI
client needs no changes.

【方式一：Cloudflare Worker（原有方式） / Option 1: Cloudflare Worker (original)】
1. 装 Node ≥ 16.17（只为拿 npx wrangler）。
   Install Node ≥ 16.17 (only to get npx wrangler).
2. npx wrangler login      # 浏览器授权一次 / authorize once in the browser
3. npx wrangler secret put RELAY_KEY   # 按提示粘贴密钥 / paste the key when prompted
   （密钥不进 wrangler.toml / the key never lives in wrangler.toml）
4. npx wrangler deploy     # 输出 https://ccgui-relay.<你的子域>.workers.dev
5. CC GUI → 设置 → 远程访问 → 外网访问：
   中转地址 = 上一步的 URL，中转密钥 = 你在 secret 里设置的 RELAY_KEY。
   CC GUI → Settings → Remote access → Outbound: relay URL = the URL above,
   relay key = the RELAY_KEY you set via wrangler secret.
6. 点「连接中转」；手机打开该 URL → 授权页 → 输入 CC GUI 上的 8 位配对密钥。
   Click Connect relay; open that URL on the phone → authorization page →
   enter the 8-character pairing key shown in CC GUI.

【方式二：自托管 Node 服务器（新增） / Option 2: Self-hosted Node server (new)】
前置：一台 Linux 服务器、Node ≥ 18.17 或 Docker Compose、一个能开放 TCP 的端口。
Prerequisites: a Linux server, Node ≥ 18.17 or Docker Compose, and a TCP port
you are allowed to open.

裸机 Node（Bare metal）：
1. 上传本目录到服务器（例如 /opt/ccgui-relay）。Upload this folder, e.g. /opt/ccgui-relay.
2. npm install
3. RELAY_KEY=<你的密钥> npm start        # 默认端口 8787 / default port 8787
   换端口：RELAY_KEY=<你的密钥> PORT=<端口> npm start
   Change port: RELAY_KEY=<your key> PORT=<port> npm start

Docker Compose（推荐 / recommended）：
1. 上传本目录到服务器。Upload this folder to the server.
2. echo "RELAY_KEY=<你的密钥>" > .env
3. docker compose up -d
   日志：docker compose logs -f    停止：docker compose down

放行端口与回源（Open the port / edge origin）：
- 服务器安全组/防火墙放行你选定的 TCP 端口（默认 8787）。
  Allow your chosen TCP port in the server's security group / firewall (default 8787).
- 腾讯 EO 或阿里 ESA 回源填服务器公网 IP + 该端口；边缘域名填进 CC GUI 的
  「中转地址」。
  In Tencent EdgeOne or Alibaba ESA, set the origin to the server's public IP
  and that port; put the edge domain into CC GUI's relay URL field.
- 无外网边缘时手机可直接填 http://<服务器IP>:<端口>（明文 HTTP，请自行权衡）。
  Without an edge, the phone can use http://<server IP>:<port> directly
  (plain HTTP — weigh that yourself).

CC GUI 填写（Fill in CC GUI）：中转地址 = 上述 URL，中转密钥 = RELAY_KEY。
Relay URL = the URL above; relay key = RELAY_KEY.

【包里有什么 / What's inside】
- src/relay.js     中继协议核心（帧编解码、流多路复用）/ protocol core (framing, stream multiplexing)
- src/worker.js    Cloudflare Worker 入口（RelayDO + fetch handler）/ Worker entry (RelayDO + fetch handler)
- src/index.js     Worker 兼容薄壳（保持旧导入路径）/ thin shell keeping the old import path
- src/server.js    自托管 Node 入口（npm start）/ self-hosted Node entry (npm start)
- src/base64.js    base64 编解码 / base64 helpers
- wrangler.toml    Worker 部署配置 / Worker deploy config
- Dockerfile + docker-compose.yml   Docker 单机部署 / Docker Compose deployment

【注意事项 / Notes】
- RELAY_KEY 是桌面端与中继之间的共享密钥，请勿外传；它同时决定手机访问的
  路径分片，换 key 后手机需重新配对。
  RELAY_KEY is the shared secret between the desktop and the relay — keep it
  private. It also namespaces the phone's path, so a new key needs re-pairing.
- 源站要求：必须支持 WebSocket 长连接与流式 HTTP（chunked 响应）；在腾讯 EO /
  阿里 ESA 的回源规则里启用 WebSocket，不要缓冲流式响应。
  Origin requirements: WebSocket long connections and streaming HTTP (chunked
  responses) must be supported; enable WebSocket in the EO/ESA origin rules and
  do not buffer streamed responses.
- 服务直接监听 0.0.0.0；无需在服务器上再装 Caddy/Nginx；TLS 由边缘（EO/ESA）
  提供，或直接明文回源由你自行权衡。
  The server binds 0.0.0.0 directly; no Caddy/Nginx required; TLS terminates at
  the edge (EO/ESA), or you accept plain HTTP yourself.
- 桌面端断线或中继进程重启会自动恢复：桌面端按现有逻辑重连，手机侧无需操作。
  Desktop disconnects or relay restarts recover automatically: the desktop
  reconnects with its existing logic, and the phone needs no action.
- 部分地区无法直连 *.workers.dev：给 Worker 绑定自定义域名（Settings →
  Domains & Routes → Add custom domain），或改用方式二。
  If *.workers.dev is unreachable where you are, bind a custom domain to the
  Worker (Settings → Domains & Routes → Add custom domain) or use Option 2.
