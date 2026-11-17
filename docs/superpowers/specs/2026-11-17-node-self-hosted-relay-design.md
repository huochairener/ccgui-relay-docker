# Node.js 自托管中继设计

## 意图

让 CC GUI 用户可把当前 Cloudflare Worker 中继部署到自己可从手机访问的服务器，避开对 `workers.dev` 的依赖；保留现有 Worker 部署方式和 CC GUI 客户端协议。

## 目标

- 新增可在普通 Node.js 服务器运行的中继入口，保持 `/agent?key=...`、HTTP 转发、WebSocket 隧道和现有多路复用帧格式兼容。
- 使用 `RELAY_KEY` 环境变量，不在新部署配置中硬编码密钥。
- 支持 `npm start` 直接运行和 Docker Compose 单机运行。
- 更新中英文部署说明，说明服务直接监听公网网卡上的可配置端口，腾讯 EO 或阿里 ESA 可将其作为源站，并注明源站需支持 WebSocket 长连接和流式 HTTP。
- 用自动化测试覆盖鉴权、桌面端离线响应、HTTP 往返和 WebSocket 往返。

## 非目标

- 不修改 CC GUI 客户端，不改动现有 Cloudflare Worker 入口或其 wrangler 部署方式。
- 不实现多机共享状态、数据库持久化、内置 TLS、自动证书签发或账号体系。

## 怎么做

- **建造者决定：** Node.js 版本下限、WebSocket 依赖、内部文件拆分、测试框架以及 Docker 文件布局；选择长期支持的 Node 版本和尽量少的依赖。
- **部署约束（用户已确认）：** Linux 单机部署；服务直接绑定 `0.0.0.0` 和可配置端口；用户会通过腾讯 EO 或阿里 ESA 对接源站 IP 与端口。Docker Compose 为推荐方式，同时提供裸机 Node 启动命令；不要求安装 Caddy/Nginx。
- 单进程内以 relay key 保存一个活动桌面端 WebSocket 和该连接的并发流。新桌面连接替换旧连接，进程重启后桌面端按客户端现有逻辑重新连接。
- 未提供有效 key 的 `/agent` 请求返回 403；没有活动桌面连接的手机请求返回 503。手机侧的应用 token 和设备审批仍交由 CC GUI 桥接处理。
- 普通 HTTP 请求通过现有 `open`、`body`、`end` 和响应帧传输；WebSocket 帧保持文本/二进制类型双向传递。
- 更新后的部署包保留 Wrangler 文件，Node 入口通过独立命令启动，避免两种运行环境互相覆盖。

## 反目标

- 不要求桌面端开放任何入站端口。
- 不改变 CC GUI 使用的 relay URL、密钥字段、配对流程或隧道路径。
- 不把 Docker 设为唯一可运行方式。

## 验收

一个用户可在服务器设置 `RELAY_KEY` 后用 `npm start` 或 Docker Compose 启动服务；腾讯 EO 或阿里 ESA 可回源到该服务器的 IP 和端口，且正确转发 WebSocket 和 HTTP 流量。CC GUI 使用它当前已有的中继地址和密钥字段即可完成桌面端连接、手机 HTTP 请求以及 WebSocket 会话。现有 Wrangler 入口仍可独立部署。
