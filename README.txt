CC GUI 外网穿透 · 中继部署包
CC GUI relay deploy pack

【部署步骤 / Steps】
1. 装 Node ≥ 16.17（只为拿 npx wrangler）。
   Install Node ≥ 16.17 (only to get npx wrangler).
2. npx wrangler login      # 浏览器授权一次 / authorize once in the browser
3. npx wrangler deploy     # 输出 https://ccgui-relay.<你的子域>.workers.dev
4. CC GUI → 设置 → 远程访问 → 外网访问：
   中转地址 = 上一步的 URL，中转密钥 = 本包 wrangler.toml 里的 RELAY_KEY。
   CC GUI → Settings → Remote access → Outbound: relay URL = the URL above,
   relay key = RELAY_KEY from this pack's wrangler.toml.
5. 点「连接中转」；手机打开该 URL → 授权页 → 输入 CC GUI 上的 8 位配对密钥。
   Click Connect relay; open that URL on the phone → authorization page →
   enter the 8-character pairing key shown in CC GUI.

【包里有什么 / What's inside】
- src/index.js    Worker 源码 / the Worker source
- wrangler.toml   部署配置：Durable Object 绑定与 RELAY_KEY
                  deploy config: the Durable Object binding and RELAY_KEY

【说明 / Notes】
- RELAY_KEY 是桌面端与 Worker 之间的共享密钥，请勿外传；它同时决定手机访问的
  路径分片，换 key 后手机需重新配对。
  RELAY_KEY is the shared secret between the desktop and the Worker — keep it
  private. It also namespaces the phone's path, so a new key needs re-pairing.
- 部分地区无法直连 *.workers.dev：给这个 Worker 绑定自定义域名
  （Settings → Domains & Routes → Add custom domain），再把该域名填进 CC GUI 的
  「中转地址」—— 地址栏始终可手改。
  If *.workers.dev is unreachable where you are, bind a custom domain to this
  Worker (Settings → Domains & Routes → Add custom domain) and use it as the
  relay URL in CC GUI; that field stays editable.
