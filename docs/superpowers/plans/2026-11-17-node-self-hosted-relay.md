# Node 自托管中继 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 subagent-driven-development（推荐）或 executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在同一仓库内新增可自托管的 Node.js 中继入口（`npm start` / Docker Compose），帧协议与现有 Cloudflare Worker 完全兼容，并更新中英文部署说明。

**架构：** 把可复用的中继协议（key 鉴权语义、帧编解码、流多路复用）抽到环境无关的 `src/relay.js`；Cloudflare 入口 `src/worker.js` 变成薄壳（Durable Object 仍每 key 一个 `RelayDO`），`src/index.js` 保持为 Worker 入口并 re-export，Wrangler 部署方式不变。Node 入口 `src/server.js` 用 `node:http` + `ws` 装配同一协议：`/agent` 接桌面端 WebSocket，每 key 一个会话对象持单条桌面连接与并发流。

**技术栈：** Node ≥ 18.17（无内置服务端 WebSocket，故用 `ws@8`——registry 无 v9，8.23 为当前最新稳定线）、`node:test` + `node:assert`（零测试依赖）、Docker Compose（`node:20-alpine`）、纯 ESM。

**规格：** docs/superpowers/specs/2026-11-17-node-self-hosted-relay-design.md

## 全局约束

- 现有 Worker 部署方式与 `src/index.js` 入口不得被破坏：`src/index.js` 必须继续导出 `Relay` 类（Wrangler DO 导出）与 default fetch handler；wrangler.toml 的 `main` 改指 `src/worker.js`（两入口互不覆盖）。
- 帧格式逐字段兼容 `src/index.js`：`{t:"open", id, method?, ws?, path, headers}` → `{t:"body", id, b64}` → `{t:"end", id}`；回程 `{t:"head", id, status, headers}`、`{t:"data", id, b64, text}`、`{t:"close", id}`、`{t:"error", id, message}`；桌面连接关闭时向所有活跃流投递 `close`。
- `/agent` 仅接受 WebSocket Upgrade（否则 426）；`?key=` 与 `RELAY_KEY` 严格相等才放行，否则 403；其余路径在无 key/密钥不匹配时同样 403（Worker 语义：key 决定手机路径分片）。
- 无活动桌面连接的普通请求返回 503（文案沿用 Worker 的中文提示）。
- 新配置只用 `RELAY_KEY` 与 `PORT` 环境变量；不引入其他密钥或配置面。
- 桌面重连替换旧连接（旧 socket 以 1012 关闭）；进程重启后桌面按现有逻辑重连。
- HTTP 隧道：请求头剥离 `host`、`connection`、`upgrade`、`sec-websocket-*`；Worker 额外剥的 `cf-connecting-ip`、`cf-ray` 在 Node 场景中替换为剥离 `cf-*` 与 `x-forwarded-*` 前缀（EO/ESA 回源头，桥接不需要）。
- HTTP 流 30s 无 head 回 504；桌面未就绪/中断时该流回 502。
- 测试只依赖 Node 内置模块；`npm test` 必须无需网络即可通过（`ws` 仅作为被测对象之一经由依赖安装）。
- 全部新代码用 ESM；Docker 仅 `node:20-alpine` + Compose，不引入 Caddy/Nginx/TLS。

## 审查重点（Review Focus）

- 同一 key 的桌面重连竞态：旧 socket 的 in-flight 流与新桌面之间的帧是否互串。期待：替换后旧流收到 close，新流只走新 socket。
- 手机 WebSocket 隧道的二进制帧：`text:false` 回传必须保持二进制（Blob/ArrayBuffer 不串类型）。
- 半帧/超大 base64 的 `body`/`data` 帧损坏时不得让进程崩溃。
- 桌面断开后立即重连，此前 503 的手机请求是否正确恢复（不残留空 streams）。
- `PORT` 环境变量为非数字时服务必须拒绝启动而不是回退隐式端口。
- （对应测试钉在各任务的步骤里：任务 2 钉重连竞态与桌面中断 502；任务 3 钉 ws 双向帧与二进制、并通过 `parsePort` 钉 PORT 校验。半帧韧性在任务 2 的 step "onAgentFrame 对坏 JSON 不崩溃" 钉住。）

---

### 任务 1：协议核心 `src/relay.js`（纯逻辑，无 I/O）

**文件：**
- 创建：`src/base64.js`
- 创建：`src/relay.js`
- 测试：`test/base64.test.js`、`test/relay-streams.test.js`

- [ ] **步骤 1：编写失败的测试（base64 + 会话帧路由）**

```js
// test/base64.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { base64FromBytes, bytesFromBase64 } from "../src/base64.js";

test("round-trips arbitrary bytes through base64", () => {
  const bytes = Uint8Array.from([0, 1, 2, 253, 254, 255, 10, 13, 34, 92]);
  assert.deepEqual(Array.from(bytesFromBase64(base64FromBytes(bytes))), Array.from(bytes));
});

test("round-trips utf-8 text through base64", () => {
  const text = "中继 relay 🚀";
  const bytes = new TextEncoder().encode(text);
  assert.equal(new TextDecoder().decode(bytesFromBase64(base64FromBytes(bytes))), text);
});
```

```js
// test/relay-streams.test.js —— 用 FakeSocket 模拟桌面端 WebSocket（有 readyState、send、close、以及触发 message/close 事件的 listeners）
import { test } from "node:test";
import assert from "node:assert/strict";
import { RelaySession } from "../src/relay.js";

function fakeAgent() {
  const listeners = { message: [], close: [] };
  return {
    readyState: "open",
    sent: [],
    closeCalls: [],
    addEventListener(type, fn) { listeners[type].push(fn); },
    emitMessage(data) { for (const fn of listeners.message) fn({ data }); },
    emitClose() { for (const fn of listeners.close) fn({}); },
    send(frame) { this.sent.push(JSON.parse(frame)); },
    close(code, reason) { this.closeCalls.push({ code, reason }); this.readyState = "closed"; },
    get last() { return this.sent[this.sent.length - 1]; },
  };
}

function waitingSession() {
  const session = new RelaySession("k");
  session.attachAgent(fakeAgent());
  return session;
}

test("open+body+end serializes onto agent socket in order", () => {
  const session = waitingSession();
  const req = { method: "POST", path: "/p?x=1", headers: { "content-type": "text/plain" }, body: new TextEncoder().encode("hi") };
  const promise = session.openHttpStream(req);
  const frames = session.agent.sent;
  assert.deepEqual(frames[0], { t: "open", id: 1, method: "POST", path: "/p?x=1", headers: { "content-type": "text/plain" } });
  assert.deepEqual(frames[1], { t: "body", id: 1, b64: base64Of("hi") });
  assert.deepEqual(frames[2], { t: "end", id: 1 });
  assert.ok(promise instanceof Promise);
});

test("head+data+close frames resolve the stream response", async () => {
  const session = waitingSession();
  const pending = session.openHttpStream({ method: "GET", path: "/a", headers: {}, body: new Uint8Array(0) });
  const id = 1;
  session.agent.emitMessage(JSON.stringify({ t: "head", id, status: 200, headers: { "x-a": "b" } }));
  session.agent.emitMessage(JSON.stringify({ t: "data", id, b64: base64Of("part"), text: true }));
  session.agent.emitMessage(JSON.stringify({ t: "close", id }));
  const res = await pending;
  assert.equal(res.status, 200);
  assert.equal(res.headers["x-a"], "b");
  assert.equal(Buffer.concat(res.chunks).toString(), "part");
  assert.equal(res.done, true);
});

test("stream died before head yields 502 and removes the entry", async () => {
  const session = waitingSession();
  const pending = session.openHttpStream({ method: "GET", path: "/a", headers: {}, body: new Uint8Array(0) });
  session.agent.emitMessage(JSON.stringify({ t: "error", id: 1, message: "boom" }));
  const res = await pending;
  assert.equal(res.status, 502);
  assert.equal(Buffer.concat(res.chunks).toString(), "boom");
});

test("desktop close delivers close to every live stream and clears map", async () => {
  const session = waitingSession();
  const p1 = session.openHttpStream({ method: "GET", path: "/1", headers: {}, body: new Uint8Array(0) });
  session.agent.emitClose();
  const res = await p1;
  assert.equal(res.status, 502);
  assert.equal(session.streamCount(), 0);
});

test("replacing the agent closes the old socket with 1012 and orphans its streams", () => {
  const session = new RelaySession("k");
  const old = fakeAgent();
  session.attachAgent(old);
  session.openHttpStream({ method: "GET", path: "/x", headers: {}, body: new Uint8Array(0) });
  const fresh = fakeAgent();
  session.attachAgent(fresh);
  assert.deepEqual(old.closeCalls, [{ code: 1012, reason: "replaced by a new agent connection" }]);
  assert.equal(session.streamCount(), 0); // 旧流已随旧连接清算，不得串到新桌面
});

test("onAgentFrame ignores malformed JSON without throwing", () => {
  const session = waitingSession();
  session.agent.emitMessage("not json at all");
  session.agent.emitMessage("}\u0000{");
  assert.equal(session.streamCount(), 0);
});
```

其中 `base64Of(s)` 是测试文件顶部定义的本地帮助函数：`btoa` 不可用，用 `Buffer.from(s, "utf8").toString("base64")` 实现，两个测试文件各自内联（三行，不值得抽公共 fixture）。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test 2>&1 | grep -E "fail|pass" | head -5`
预期：FAIL —— `Cannot find module .../src/relay.js`（base64 同理）

- [ ] **步骤 3：实现 `src/base64.js` 与 `src/relay.js`**

`src/base64.js` 导出 `base64FromBytes(bytes: Uint8Array): string` 与 `bytesFromBase64(text: string): Uint8Array`。Node 无 `btoa`/`atob` 保障（18.x 下是废弃全局），用 `Buffer.from(bytes).toString("base64")` 与 `new Uint8Array(Buffer.from(text, "base64"))` 实现——注意 Buffer.from(bytes) 对 Uint8Array 是拷贝视图之外的复制，行为正确。

`src/relay.js` 导出 class `RelaySession`，构造签名 `new RelaySession(key: string)`。API（Worker 的 DO 方法搬到会话对象上，I/O 无关）：
- `attachAgent(socket)`：非 null 时替换旧 agent；旧 socket `close(1012, "replaced by a new agent connection")` 并清算其流（每条活跃流收到 close 语义，`streams` 清空）；注册 message/close 监听（close 时 agent 置 null、所有活跃流投递 close、清空）。
- `hasLiveAgent(): boolean`（readyState 为 `"open"`）。
- `async openHttpStream({ method, path, headers, body }): Promise<{ status, headers, chunks: Uint8Array[], done: boolean }>`——为测试可断言而不用 ReadableStream：内部发 `open`/`body`（body 非空才发）/`end` 帧，回程 `head` resolve、`data` 聚合进 chunks、`close`/`error` 结束（error 帧的 message 成为 body；close 帧无 message 时 body 为空）；head 从未到达时 30s 超时回 `{status: 504, headers: {"content-type": "text/plain; charset=utf-8"}}` 并发送 `{t:"close", id}`。**30s 超时必须可注入**：构造选项 `new RelaySession(key, { headTimeoutMs })`，默认 30000，测试传小值。
- `openSocketStream({ path, headers })`：发 `{t:"open", id, ws:true, path, headers}`；返回句柄 `{ onMessage(cb), close() }`——`onMessage(cb)` 注册回调，`data` 帧到达时以 `{ bytes, text }` 调用（`text` 按 `frame.text !== false` 归一化）；`close()` 发送 `{t:"close", id}` 并从 streams 注销。
- `streamCount(): number`。

内部：`nextId` 从 1 自增；`send(frame)` 仅在 `hasLiveAgent()` 时 `JSON.stringify` 后 `socket.send`；`onAgentFrame(raw)` 容忍坏 JSON（静默返回）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test 2>&1 | grep -E "^# (fail|pass)" | head -4`
预期：`# pass 8` / `# fail 0`（base64 2 + streams 7，实际计数以测试文件为准）

- [ ] **步骤 5：Commit**

```bash
git add src/base64.js src/relay.js test/base64.test.js test/relay-streams.test.js
git commit -m "feat: environment-agnostic relay session core with frame protocol"
```

### 任务 2：Worker 薄壳与入口兼容

**文件：**
- 创建：`src/worker.js`
- 修改：`src/index.js`（变薄壳：re-export `RelayDO` 与 default handler）
- 修改：`wrangler.toml`（`main = "src/worker.js"`）
- 测试：`test/worker-entry.test.js`

- [ ] **步骤 1：编写失败的测试（入口可导入、协议常量一致）**

```js
// test/worker-entry.test.js
import { test } from "node:test";
import assert from "node:assert/strict";

test("worker entry re-exports RelayDO and default handler", async () => {
  const entry = await import("../src/index.js");
  const worker = await import("../src/worker.js");
  assert.equal(typeof entry.RelayDO, "function");
  assert.equal(typeof entry.default.fetch, "function");
  assert.equal(entry.RelayDO, worker.RelayDO);
  assert.equal(entry.default.fetch, worker.default.fetch);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test 2>&1 | grep -E "RelayDO|fail [1-9]" | head -5`
预期：FAIL —— `assert.equal(typeof entry.RelayDO, "function")` 失败（现导出名为 `Relay`）

- [ ] **步骤 3：实现 `src/worker.js` 与 `src/index.js` 薄壳**

`src/worker.js`：把现 `src/index.js` 的 DO 类重命名导出为 `RelayDO`（内部改用任务 1 的 `RelaySession` 持有协议状态——DO 构造函数 `new RelaySession(key)`，fetch 分派到 session 的 `attachAgent`/`openHttpStream`/`openSocketStream`；`WebSocketPair`/`accept` 等 Workers 运行时 API 留在 DO 内，不改语义），default fetch handler 原样保留（AGENT_PATH、403/426/503、idFromName(key)）。同时导出 `AGENT_PATH` 常量供测试复用。

`src/index.js`：整体替换为薄壳：

```js
export { RelayDO as Relay, AGENT_PATH, default } from "./worker.js";
```

`wrangler.toml`：`main = "src/worker.js"`，其余不动。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test 2>&1 | grep -E "^# (fail|pass)" | head -4`
预期：`# fail 0`，总数 +1

- [ ] **步骤 5：Commit**

```bash
git add src/worker.js src/index.js wrangler.toml test/worker-entry.test.js
git commit -m "feat: split worker entry into thin shell over RelayDO; wrangler main points at src/worker.js"
```

### 任务 3：Node 服务器入口 `src/server.js`

**文件：**
- 创建：`src/server.js`
- 测试：`test/server.integration.test.js`

- [ ] **步骤 1：编写失败的测试（真实端口上的 HTTP + WS 集成）**

测试用例（`node:test`，全部对真实监听的 server 发请求；`ws` 客户端来自依赖）：

```js
// test/server.integration.test.js（骨架；断言文字为规格取值）
// startServer(port=0, {relayKey, headTimeoutMs}) → {port, close()} 是 src/server.js 导出的测试帮助函数；RELAY_KEY 缺省时抛错的行为单独测
import { test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { startServer } from "../src/server.js";

const KEY = "test-key-123";

test("rejects /agent without the right key with 403", async () => {
  const { port, close } = startServer({ relayKey: KEY, port: 0 });
  const res = await fetch(`http://127.0.0.1:${port}/agent?key=wrong`);
  assert.equal(res.status, 403);
  await close();
});

test("rejects non-upgrade /agent with 426", async () => { /* fetch 同路径带正确 key、无 Upgrade → 426 */ });

test("phone request without a desktop answers 503 with the Chinese message", async () => {
  const { port, close } = startServer({ relayKey: KEY, port: 0 });
  const res = await fetch(`http://127.0.0.1:${port}/whatever?token=x`);
  assert.equal(res.status, 503);
  assert.ok((await res.text()).includes("桌面端未连接到中继"));
  await close();
});

test("HTTP round-trip through the desktop socket", async () => {
  const { port, close } = startServer({ relayKey: KEY, port: 0 });
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?key=${KEY}`);
  await onceOpen(agent);
  const phone = fetch(`http://127.0.0.1:${port}/api/data?token=app-token`, { method: "POST", body: "payload" });
  // 桌面端收到 open(含 method/path/headers, 无 host/cf-*/x-forwarded-*)、body、end → 回 head 200 {content-type}、data(base64 of "ok")、close
  const open = await nextFrame(agent);
  assert.equal(open.t, "open");
  assert.equal(open.method, "POST");
  assert.equal(open.path, "/api/data?token=app-token");
  assert.ok(!("host" in open.headers));
  assert.ok(Object.keys(open.headers).every((h) => !h.startsWith("cf-") && !h.startsWith("x-forwarded-")));
  const body = await nextFrame(agent);
  assert.equal(Buffer.from(body.b64, "base64").toString(), "payload");
  const end = await nextFrame(agent);
  assert.equal(end.t, "end");
  agent.send(JSON.stringify({ t: "head", id: open.id, status: 200, headers: { "content-type": "text/plain" } }));
  agent.send(JSON.stringify({ t: "data", id: open.id, b64: Buffer.from("ok").toString("base64"), text: true }));
  agent.send(JSON.stringify({ t: "close", id: open.id }));
  const res = await phone;
  assert.equal(res.status, 200);
  assert.equal(await res.text(), "ok");
  await close();
});

test("websocket round-trip keeps text and binary frame types", async () => {
  const { port, close } = startServer({ relayKey: KEY, port: 0 });
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?key=${KEY}`);
  await onceOpen(agent);
  const app = new WebSocket(`ws://127.0.0.1:${port}/ws?token=app-token`);
  await onceOpen(app);
  const open = await nextFrame(agent);
  assert.equal(open.t, "open");
  assert.equal(open.ws, true);
  // app → 中继 → 桌面：文本帧 b64+text:true；二进制帧 text:false
  app.send("hello");
  const d1 = await nextFrame(agent);
  assert.equal(d1.t, "data");
  assert.equal(d1.text, true);
  assert.equal(Buffer.from(d1.b64, "base64").toString(), "hello");
  app.send(Uint8Array.from([0, 255, 1]));
  const d2 = await nextFrame(agent);
  assert.equal(d2.text, false);
  assert.deepEqual(Array.from(Buffer.from(d2.b64, "base64")), [0, 255, 1]);
  // 桌面 → 中继 → app：text:true 回文本帧，text:false 回二进制帧
  agent.send(JSON.stringify({ t: "data", id: open.id, b64: Buffer.from("re:hi").toString("base64"), text: true }));
  assert.equal(await nextMessage(app), "re:hi");
  agent.send(JSON.stringify({ t: "data", id: open.id, b64: Buffer.from([9, 250]).toString("base64"), text: false }));
  assert.deepEqual(Array.from(await nextBinary(app)), [9, 250]);
  // app 关闭 → 桌面收到 close
  const appClosed = onceClosed(app);
  app.close();
  assert.equal((await nextFrame(agent)).t, "close");
  await appClosed;
  await close();
});

test("desktop reconnect replaces the old socket; orphaned streams get closed", async () => {
  const { port, close } = startServer({ relayKey: KEY, port: 0 });
  const a1 = new WebSocket(`ws://127.0.0.1:${port}/agent?key=${KEY}`);
  await onceOpen(a1);
  fetch(`http://127.0.0.1:${port}/pending`, { method: "GET" }); // 产生一条 in-flight 流
  const open = await nextFrame(a1);
  const a2 = new WebSocket(`ws://127.0.0.1:${port}/agent?key=${KEY}`);
  await onceOpen(a2);
  await onceClosed(a1, 1012);
  // 新连接上发 head，必须由新连接处理而不是旧流残留
  const phone = fetch(`http://127.0.0.1:${port}/after`, { method: "GET" });
  const open2 = await nextFrame(a2);
  assert.equal(open2.path, "/after");
  a2.send(JSON.stringify({ t: "head", id: open2.id, status: 201, headers: {} }));
  a2.send(JSON.stringify({ t: "close", id: open2.id }));
  assert.equal((await phone).status, 201);
  await close();
});

test("desktop disconnect mid-stream answers 502 and later requests 503 again", async () => {
  const { port, close } = startServer({ relayKey: KEY, port: 0 });
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?key=${KEY}`);
  await onceOpen(agent);
  const phone = fetch(`http://127.0.0.1:${port}/x`, { method: "GET" });
  await nextFrame(agent); // open
  agent.close();
  const res = await phone;
  assert.equal(res.status, 502);
  const after = await fetch(`http://127.0.0.1:${port}/y`, { method: "GET" });
  assert.equal(after.status, 503);
  await close();
});

test("malformed agent frame does not kill the server", async () => {
  const { port, close } = startServer({ relayKey: KEY, port: 0 });
  const agent = new WebSocket(`ws://127.0.0.1:${port}/agent?key=${KEY}`);
  await onceOpen(agent);
  agent.send("this is not json");
  agent.send("}\u0000{");
  const res = await fetch(`http://127.0.0.1:${port}/still-alive`, { method: "GET" });
  assert.equal(res.status, 503); // 桌面连接未因坏帧断开——但请求仍无活跃流 → 503 语义仍可达
  await close();
});
```

帮助函数 `onceOpen(ws)`、`onceClosed(ws, code?)`、`nextFrame(agentWs)`（等下一条 JSON 帧）、`nextMessage(ws)`、`nextBinary(ws)` 在测试文件顶部用事件监听 + Promise 实现。

- [ ] **步骤 2：运行测试验证失败**

运行：`npm test 2>&1 | grep -E "Cannot find module|fail [1-9]" | head -5`
预期：FAIL —— `Cannot find module .../src/server.js`

- [ ] **步骤 3：实现 `src/server.js`**

导出两个东西：
- `startServer(options)` → `{ port, close(): Promise<void> }`。options：`relayKey`（必填，缺失抛 `Error("RELAY_KEY is not set")`）、`port`（默认 0=随机；**非数字或 NaN 时抛错**，不静默回退）、`headTimeoutMs`（默认 30000，测试注入小值）。`host` 固定 `0.0.0.0`。
- default export `main()`：从 `process.env.RELAY_KEY`、`process.env.PORT`（存在则必须能 `Number()` 成正数，否则 `console.error` 并 `process.exit(1)`）读配置，调 `startServer`，`console.log` 一行启动信息（端口 + 「等待桌面端连接 /agent?key=…」提示）；`main()` 仅在 `import.meta.url` 与 `process.argv[1]` 解析为同一路径时执行（可被测试导入而不自启）。

装配：`node:http` createServer 处理普通请求（`req`/`res`）+ `new WebSocketServer({ noServer: true })`；`server.on("upgrade")` 里按路径分派 `/agent` 与其余（其余视为手机 ws）。逻辑映射（全部落在任务 1 的 RelaySession 上，单 key 单会话，`sessions = new Map([[relayKey, session]])`）：

- 普通请求：无 `session.hasLiveAgent()` → 503（文案与 Worker 相同）；否则把 `req.method`、`req.url`（原样含 query）、过滤后的头、聚合的 body 交给 `openHttpStream`，回程 `res.writeHead(status, headers)`、逐 chunk `res.write`、`done` 后 `res.end()`。
- `/agent`：先做 key 检查（query `key` !== relayKey → 403 纯文本 "forbidden"）；非 Upgrade 请求 → 426 "expected a websocket"；通过后 `wss.handleUpgrade`，`session.attachAgent(ws)`。
- 手机 ws：`wss.handleUpgrade` 后 `session.openSocketStream({path: req.url, headers: filtered})`，句柄 `onMessage` 把 `{bytes, text}` 回发给手机 ws（text → `ws.send(str)`，binary → `ws.send(bytes)`）；手机 ws 的 `message` 事件（字符串/Buffer）经 base64 发 `{t:"data", id, b64, text}`；手机 ws `close` → 句柄 `close()`。
- 头过滤（两处共用一个 `filterHeaders` 内部函数）：删 `host`、`connection`、`upgrade`、`sec-websocket-*` 前缀、`cf-` 前缀、`x-forwarded-` 前缀。
- 依赖安装：`npm install ws@8 --save`（唯一运行时依赖）。

- [ ] **步骤 4：运行测试验证通过**

运行：`npm test 2>&1 | grep -E "^# (fail|pass)" | head -4`
预期：`# fail 0`，总数 +7

- [ ] **步骤 5：Commit**

```bash
git add src/server.js test/server.integration.test.js package.json
git commit -m "feat: Node self-hosted relay server speaking the same frame protocol"
```

### 任务 4：package.json、npm start 与 Docker Compose

**文件：**
- 创建：`package.json`（若任务 3 已为安装 `ws` 创建，则此任务补齐 scripts/engines 字段）
- 创建：`Dockerfile`
- 创建：`docker-compose.yml`
- 创建：`.dockerignore`
- 测试：无新测试文件；验收 = `npm start` 冒烟 + 现有套件全绿

- [ ] **步骤 1：编写失败的冒烟脚本（验证 npm start 真的拉起服务）**

```bash
# 手动步骤（验证步骤 4 时执行）：RELAY_KEY=smoke PORT=0 npm start 应打印启动行且进程保持前台
# 自动检查：任务 5 的 docs 校验之外，本任务以现有集成测试 + 下面的冒烟命令为关
```

冒烟实现为一次性命令（不落盘）：`RELAY_KEY=smoke PORT=0 npm start` 观察输出。自动断言由任务 3 的集成测试承担；此任务的可检查结果是 scripts/engines 与 Docker 文件存在且 compose 配置合法。

- [ ] **步骤 2：package.json 定稿**

```json
{
  "name": "ccgui-relay",
  "version": "1.0.0",
  "private": true,
  "type": "module",
  "description": "CC GUI relay: self-hosted Node entry + Cloudflare Worker",
  "scripts": {
    "start": "node src/server.js",
    "test": "node --test test/"
  },
  "engines": { "node": ">=18.17" },
  "dependencies": { "ws": "^8.23.0" }
}
```

（`main` 字段不要指向 server——这包同时含 Worker 与 Node 两个入口，语义冲突。）

- [ ] **步骤 3：Dockerfile、docker-compose.yml、.dockerignore**

```dockerfile
# Dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev || npm install --omit=dev
COPY src/ ./src/
ENV NODE_ENV=production
EXPOSE 8787
CMD ["node", "src/server.js"]
```

```yaml
# docker-compose.yml
services:
  relay:
    build: .
    restart: unless-stopped
    environment:
      - RELAY_KEY=${RELAY_KEY:?set RELAY_KEY in .env or your shell}
      - PORT=8787
    ports:
      - "${RELAY_PORT:-8787}:8787"
```

`.dockerignore`：`node_modules`、`docs`、`test`、`.git`、`*.md`。

- [ ] **步骤 4：运行验证**

运行：`npm test 2>&1 | grep -E "^# (fail|pass)" | head -4`
预期：全绿（无行为改动）。若本机有 docker：`docker compose config -q` 退出码 0；无 docker（本机现状）则在账本记录该验证跳过，依赖 CI/用户侧验证。

- [ ] **步骤 5：Commit**

```bash
git add package.json Dockerfile docker-compose.yml .dockerignore
git commit -m "feat: npm start script and Docker Compose deployment"
```

### 任务 5：部署文档（README 更新）

**文件：**
- 修改：`README.txt`

- [ ] **步骤 1：编写失败的文档校验脚本（一次性，跑完即删）**

一次性检查（bash，不落盘）：README 同时包含 `npm start`、`RELAY_KEY`、`docker compose up -d`、`腾讯` 或 `阿里 ESA`、`WebSocket` 五个关键词（中英文任一节覆盖均可）。

运行：上述 grep 管道
预期：FAIL —— 现有 README 无 `npm start`、`docker compose` 等关键词

- [ ] **步骤 2：重写 README.txt（保留双语风格与 Worker 部分）**

结构（双语对照，沿用现有「【】」小节风格）：
- 标题与一句话意图（保留现文案）
- 「【方式一：Cloudflare Worker（原有方式）】」：现有 4 步部署原样保留；`src/index.js` / `wrangler.toml` 的描述更新为指向新文件布局
- 「【方式二：自托管 Node 服务器（新增）】」：
  - 前置：一台 Linux 服务器、Node ≥ 18.17 或 Docker Compose、一个你能开放 TCP 的端口
  - 裸机：克隆/上传本目录 → `npm install` → `RELAY_KEY=<你的密钥> npm start`（可加 `PORT=<端口>`，默认 8787）
  - Docker Compose（推荐）：`echo "RELAY_KEY=<你的密钥>" > .env` → `docker compose up -d`
  - 安全组：放行你选定的端口（TCP）；EO/ESA 回源填服务器公网 IP + 该端口
  - CC GUI 填写：中转地址 = `http://<服务器IP>:<端口>`（或 EO/ESA 域名）、中转密钥 = `RELAY_KEY`
- 「【注意事项 / Notes】」（合并原 Notes 并追加）：
  - 源站要求：**必须支持 WebSocket 长连接与流式 HTTP（chunked 响应）**；腾讯 EO / 阿里 ESA 回源规则里启用 WebSocket，不要缓冲流式响应
  - `RELAY_KEY` 同步决定手机路径分片，换 key 需重新配对（沿用原文案）
  - 服务直接监听 `0.0.0.0`；无需在本机再装 Caddy/Nginx；TLS 由 EO/ESA 边缘提供
  - 桌面端重连/进程重启会自动恢复，手机侧无需操作

- [ ] **步骤 3：重跑关键词校验**

运行：`grep -c -E "npm start|RELAY_KEY|docker compose|WebSocket" README.txt`
预期：各关键词命中 ≥ 1（脚本退出码 0）

- [ ] **步骤 4：Commit**

```bash
git add README.txt
git commit -m "docs: bilingual deployment guide for self-hosted Node relay and edge-origin notes"
```

### 任务 6：收尾校验（验收清单）

**文件：** 无新文件；只跑验证与最终审查

- [ ] **步骤 1：全测试套件 + 双入口冒烟**

运行：`npm test 2>&1 | grep -E "^# (tests|suites|pass|fail)" | head -5`
预期：fail 0。

运行（Worker 入口语法可加载性，Node 下无法真跑 Workers API，只验模块图完整）：`node -e "import('./src/index.js').then(m => console.log('worker entry OK', typeof m.Relay, typeof m.default.fetch))"`
预期：`worker entry OK function function`

- [ ] **步骤 2：`npm start` 冒烟**

运行：`RELAY_KEY=smoke PORT=0 npm start`（后台起 3 秒后 curl 403 路径再杀进程，或直接观察启动行）
预期：打印启动信息；`curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:<port>/agent?key=wrong"` → 403

- [ ] **步骤 3：最终整分支审查**（executing-plans 的 review-package 流程；无 subagent 工具则按 code-reviewer.md 自审）

- [ ] **步骤 4：修复轮 + 账本收尾**（如有 Critical/Important 发现）
