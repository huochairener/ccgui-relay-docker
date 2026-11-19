CC GUI 外网穿透 · 中继部署包
CC GUI relay deploy pack

一个中继，两种跑法：Cloudflare Worker（原有方式）或你自己的 Node 服务器（新增，
自托管）。两者协议完全一致，CC GUI 客户端无需任何改动。
One relay, two ways to run it: Cloudflare Worker (the original way) or your own
Node server (new, self-hosted). Both speak the same protocol — the CC GUI
client needs no changes.

当前版本包含一轮实战修复（响应背压丢字节、Worker 头过滤、帧上限）与完整的
可观测性（结构化日志、/healthz、零依赖探针），见「排障」一节的案例。
This version ships a battle-tested fix round (response truncation under
backpressure, Worker header filtering, frame caps) plus full observability
(structured logs, /healthz, a zero-dependency probe) — see the Troubleshooting
section for the incident that drove it.

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

【排障 / Troubleshooting】

—— 按顺序快速定位 / Quick triage in order ——

症状 A：手机页能打开，但应用提示「启动失败」，点重新加载也没用。
  Symptom A: the phone page opens but the app reports a startup failure and
  reloading does not help.

第一步：手机浏览器控制台（或用电脑 Chrome 打开同一 URL）看 Console：
  Step 1: open the same URL in desktop Chrome (or read the phone console):
  - 报 SyntaxError: Invalid or unexpected token（某个 bootstrap-xxx.js）
    → JS 文件传输不完整，几乎都是「边缘缓存了坏文件」或旧版中继丢字节，
    直接到【事故案例】一节，照着修。
    A SyntaxError in the app's JS bundle means an incomplete file — almost
    always "the edge cached a broken copy" or the old relay truncating
    responses; jump to the incident writeup below.
  - 页面 200 但控制台没有任何 ws 报错、也没有 ws 请求
    → 同上：JS 根本没跑起来，先解决文件完整性。
    Page loads 200 but no ws request at all → same cause: the JS never ran.
  - 有 ws 请求但握手失败 → 用探针看 [3]。
    A ws request that fails to upgrade → check probe [3].

第二步：服务器上跑探针（零依赖，不需要 npm install）：
  Step 2: run the probe on the server (zero dependencies, no npm install):
    RELAY_KEY=<你的密钥> node probe.js https://<你的边缘域名>
  输出的每一行对应一跳：
    [0] /healthz    → 边缘能否把请求送到源站；返回 JSON 就说明到了
                      JSON 里 desktop:false = 桌面端没连上（电脑端启动中转）
    [1] GET /       → 桌面端应用是否在线（HTML 是桌面端的页面）
    [2] /agent?wrong → 必须是我们的 403 forbidden（证明源站在应答）
    [3] WS /ws      → 手机的 WebSocket 升级是否穿过边缘（必须 UPGRADED）
    [4] WS /agent   → 桌面端长连接升级（会顶掉当前桌面端连接，谨慎跑；
                      不想被顶就不带 RELAY_KEY 跑，[4] 会自动跳过）

第三步：看中继日志（容器：docker compose logs -f；裸机：日志在 stdout）：
  Step 3: read the relay log (docker compose logs -f, or stdout for bare metal):
    级别用 RELAY_LOG 控制：error | warn | info | debug（默认 info）。
    关键行对照表：
      phone request {path, status}      → 每条手机 HTTP 请求与结果
      phone websocket opened / ended    → /ws 控制通道生命周期
      desktop connected / disconnected  → 桌面端长连接生命周期
      relay head-timeout {path}         → 桌面端 30 秒没应答
      relay stream-error / payload-too-large → 桌面端侧异常
    手机点「重新加载」时：只有 GET / 的 phone request、没有 websocket 行
    = 请求根本没到源站或 JS 没跑起来；有 opened 紧接 ended {code:1006}
    = 握手后被断（查边缘空闲超时）。

常见边缘层配置要点：
  - 回源必须启用 WebSocket（EO 规则引擎 / ESA 回源配置），否则 [3]/[4] 失败。
    匹配条件按整个域名（或至少含 /ws 与 /agent），不要只配单独路径。
  - 关闭响应缓冲 / 智能压缩，保留流式（chunked）响应。
  - 空闲连接超时 ≥ 60 秒（中继每 30 秒一次心跳，过短会周期性掐断长连接）。
  - 用 /healthz 作为边缘健康检查目标，它不依赖桌面端在线。
  - 缓存规则：中继是纯动态隧道，建议对该域名禁用边缘缓存（或仅允许
    带哈希文件名的静态资源缓存）。一旦缓存过坏文件，见下文案例。

—— 事故案例：EO 缓存了截断的 JS，页面永远起不来 ——
 Incident: EdgeOne cached a truncated JS bundle and the page never booted

现象（2026-11，腾讯 EO 回源 + Docker 部署）：
  What we saw (Tencent EO origin pull + Docker deployment):
  - 手机/电脑都能打开页面（HTML 200），但应用「启动失败」，重新加载无效；
  - 控制台每次都在同一个位置报
    SyntaxError: Invalid or unexpected token (at bootstrap-Bg3bO0Q7.js:1031:3515)；
  - 中继日志只有 GET / 一条，之后零请求（JS 没跑起来，自然没有 /ws）；
  - 探针 [0]-[4] 全通（边缘 HTTP/WS 都放行）——边缘传输层被洗清了嫌疑。

根因链（两层叠加，缺一不可）：
  The two-layer root cause (both needed):
  1. 中继 bug（已修复，commit 061d308）：响应回程在客户端背压时丢块/提前收尾
     （flushPendingChunks splice 后 break、endRes 丢弃缓冲块、bufferedBytes
     只加不减、wss maxPayload 贴着分帧上限）——大 JS 文件经过高延迟边缘必触发，
     传到手机的是被截断的 bootstrap.js；低延迟链路（Cloudflare 直连）偶尔
     侥幸不触发，所以「Cloudflare 多试几次能成，EO 从来不成」。
  2. 边缘缓存钉死坏副本：bootstrap-xxx.js 带内容哈希文件名，EO 按静态资源
     长期缓存——坏文件以完整 200 响应的姿态被缓存，之后无论重试多少次、
     服务端修没修好，边缘永远吐同一个坏副本，永远报同一个行列号的错。

识别特征（遇到同款问题的判据）：
  How to recognize it:
  - SyntaxError 的位置每次完全相同（行列号一模一样）——随机网络丢包不会
    这样，同一位置必是同一份缓存副本；
  - 清缓存后立刻恢复 = 实锤；
  - 用电脑 Chrome DevTools → Network → 勾 Disable cache 重新加载能恢复 = 实锤。

修复与验证：
  Fix and verification:
  1. 更新中继（≥ commit 061d308）并重启：git pull && docker compose up -d --build，
     curl https://<域名>/healthz 看 uptime 确认真重启了；
  2. EO 控制台 → 缓存配置 → 缓存刷新：先刷那个 bootstrap-xxx.js 的完整 URL，
     不确定就整个域名全刷；顺手关掉智能压缩/页面优化类开关；
  3. 手机端清站点数据（或换浏览器）重新打开；电脑验证用 Disable cache。
  4. 预防：对该域名禁用边缘缓存，或只允许带哈希的静态资源缓存；每次更新
     中继版本后主动刷一次缓存。

教训（对本仓库维护者）：
  Lessons for maintainers of this repo:
  - 传输完整性必须有字节级回归测试：新增「3MiB 响应 + 客户端背压暂停 500ms」
    逐字节比对用例，旧代码跑它直接挂死；
  - 「改了服务端没效果」时第一怀疑对象是某层缓存：浏览器、边缘，逐层用
    Disable cache / 直连源站 md5 对比法排除；
  - 完整 200 + 截断 body 的响应能被缓存层永久固化——动态隧道前的边缘缓存
    要默认关掉。

【包里有什么 / What's inside】
- src/relay.js     中继协议核心（帧编解码、流多路复用）/ protocol core (framing, stream multiplexing)
- src/worker.js    Cloudflare Worker 入口（RelayDO + fetch handler）/ Worker entry (RelayDO + fetch handler)
- src/index.js     Worker 兼容薄壳（保持旧导入路径）/ thin shell keeping the old import path
- src/server.js    自托管 Node 入口（npm start，含结构化日志）/ self-hosted Node entry (npm start, structured logs)
- src/base64.js    base64 编解码 / base64 helpers
- probe.js         零依赖探针（排障第一步，见排障章节）/ zero-dependency probe (troubleshooting step 1)
- wrangler.toml    Worker 部署配置 / Worker deploy config
- Dockerfile + docker-compose.yml   Docker 单机部署 / Docker Compose deployment
- test/            集成与协议测试（npm test，34 例）/ integration + protocol tests (npm test, 34 cases)

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
- 边缘缓存：中继是动态隧道，所有响应都由桌面端实时生成。建议对中继域名禁用
  边缘缓存，或只允许带哈希文件名的静态资源缓存；否则一次坏响应会被缓存层
  固化，表现见「事故案例」。
  Edge caching: every response is generated live by the desktop. Disable edge
  caching for the relay domain (or allow only hashed static assets) — one bad
  response can otherwise be pinned by the cache layer (see the incident).
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
