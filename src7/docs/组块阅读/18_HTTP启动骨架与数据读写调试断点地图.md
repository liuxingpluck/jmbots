# 第十八块：HTTP 启动骨架与数据读写调试断点地图

读完这一块，你能直接打开编辑器打中每一个关键断点，讲清楚 5 件事：

1. **HTTP 服务怎么从零立起来**：从 `src7/Main.ts` 挂三件骨架，到唯一 Fastify 实例挂路由、两道门禁鉴权、静态网页兜底、绑上 `30086` 端口。
2. **外网、内网、本机三条路怎么分流**：`WebAuth` 的 `X-External-Proxy: 1` 门禁、`isLocal` 本机直通、`?token=` / `Bearer` 令牌与 `trusted_ips` 只读放行各自改了什么标记。
3. **一条消息全链路在哪几处改数据、写 SQLite**：把飞书与网页两条主线串起来，定位 `web_messages`、`feishu_seen`、`sessions`、`journal_lines` 四张核心表的精确写入行。
4. **为什么全系统改会话只走一个 SQL 口**：`Session.save` 的 `INSERT OR REPLACE INTO sessions` 怎么兜住认领排队、对话追加、状态流转与回执落盘。
5. **二次开发改哪几行**：加新渠道、新工具、新关口钩子、新会话字段或新网页路由的最短改动清单。

建议先读第一块（骨架与四个关口）、第十一块（网页消息 596 全链路）和第十二块（外网门禁）。本块专为**查代码、打断点、做二次开发**设计，所有代码摘录与源码逐字一致。

> **一句话版**：启动时先立 `Resources → Tools → Sessions` 三件骨架并打开 `data/jmbots7.db`，`http` 插件建好全进程唯一的 Fastify 实例与 `onRequest` 门卫，各业务插件在 `ready` 前把 `/api/*` 路由挂完，`ready` 一响再挂 `GET /*` 静态网页兜底并绑 `30086`；运行时不管消息从网页还是飞书进来，都经 `ChannelMessage` → `bots` 认领事务入队 → `Sessions` 四关口循环 → `Session.save` 唯一口落库 → `channel/reply` 幂等回传。

## 一图看懂：两条硬核主线

手机竖着看，左边是**启动 6 步**，右边是**读写落库 6 站**：

```
【启动骨架 6 步】
① Main.ts 挂三件套
  Resources(开 jmbots7.db)
  → Tools → Sessions(建表)
  │
② http 插件建唯一 Fastify
  watchRoutes 记路由归属
  挂 onRequest 总门卫 check
  │
③ check 两道门禁就位
  外网 WebAuth Cookie 门禁
  + 本机/令牌/trustedIps
  │
④ 各插件按配置顺序挂载
  往 ctx.http.app 挂 /api/*
  │
⑤ Main 发 ready 事件
  Static + Embedded 挂网页
  兜底 GET /* 排在最后
  │
⑥ Http.listen 绑 30086
  撞口 80 秒重试 + 写 pid

──────────────────────────

【消息读写 SQLite 6 站】
⑴ 渠道收件落原件
  网页写 web_messages
  飞书写聊天日志 + p2p 表
  │
⑵ emitInbound → 审批口令
  channel/direct|mention|listen
  approval 先拦“同意 N”
  │
⑶ bots 认领 + 事务入队
  拷附件进工作区 inbox
  db.transaction 写队列
  │
⑷ drain → 会话循环四关口
  before-model 拼提示词/调模
  before-tool 审命令跑工具
  │
⑸ Session.save 唯一落盘口
  append / change 全走它
  INSERT OR REPLACE sessions
  │
⑹ channel_reply → 回执
  飞书幂等发信 / 网页写 replies
  journal 全程记 journal_lines
```

---

## 上篇：HTTP 服务精简启动骨架（6 步到 `:30086`）

整个后端进程只有**一个** Fastify 实例，归 `http` 插件管；骨架本身不懂 HTTP，别的插件也不自己开端口（外置记忆服务 `:30087` 和 `programs` 子进程除外）。启动严格按下面 6 步走完。

### 第 1 步：`Main.ts` 按铁律顺序挂三件骨架、打开主库

进程从 `src7/Main.ts:215` 进 `main`（`src7/Main.ts:58`）。先调 `checkArgs` 解析 `--runtime`、`--port`、`--mode candidate`，再建根容器 `new cordis.Context()`，**挂一个等一个**装上三件骨架：

```ts
// src7/Main.ts
72	  const args = checks.checkArgs(argv);
73	  const app = new cordis.Context();
74
75	  //M 骨架三个，挂一个等一个，先后不能换。
76	  await app.plugin(resourcesModule.Resources, { dir: args.dataDir });
77	  await app.plugin(toolsModule.Tools);
78	  await app.plugin(sessionsModule.Sessions);
…
88	  let entries = configured;
89	  if (args.candidate) {
90	    entries = configured.filter((entry) => entry.name === 'http');
91	  }
92
93	  //G 试运行却没配 http → 健康检查没法做，直接报错。
94	  if (args.candidate && entries.length === 0) {
95	    throw new Error('试运行模式需要挂 http 插件，才能做健康检查');
96	  }
```

这三行的先后不能换：

- **`Resources`**（`Resources.constructor`，`src7/Resources.ts:203`）：先把 `config.yaml` 校验成强类型快照，再建并打开全系统唯一的 SQLite 主库 `data/jmbots7.db`（开启 `WAL` 并发读写模式），建好模型供应商集合并监听配置热更新。
- **`Tools`**（`src7/Tools.ts:131`）：挂上工具登记表 `ctx.tools`，本身不碰数据库。
- **`Sessions`**（`Sessions.constructor`，`src7/Sessions.ts:325`）：直接用 `ctx.resources.db` 建出 `sessions` 表。
- 如果是基地换版前的**试运行**（`--mode candidate`），`Main.ts:89` 把插件列表过滤到只剩 `'http'`——不开飞书、不开微信、不跑后台任务，只要 `:30086/api/health` 能回 `{ ok: true }` 就算新包能活。

```ts
// src7/Resources.ts
208	    const file = path.join(this.root, CONFIG_FILE);
209	    this.current = readConfig(file);
210
211	    //M 开数据库 data/jmbots7.db（没有就建）；这个服务被拔掉时关。
212	    const dbFile = path.join(this.ensureRuntimeDir('data'), 'jmbots7.db');
213	    this.db = new Database(dbFile, { create: true });
214	    this.db.exec('PRAGMA journal_mode = WAL;');
215	    this.ctx.effect(() => {
```

```ts
// src7/Sessions.ts
325	  constructor(ctx: cordis.Context) {
326	    super(ctx, 'sessions');
327
328	    //M 一场会话一行，分两块存：meta 是记录去掉对话以后的 JSON，find 照它里面的项找；messages 是整场对话的 JSON。
329	    const sql = 'CREATE TABLE IF NOT EXISTS sessions'
330	      + ' (id TEXT PRIMARY KEY, meta TEXT NOT NULL, messages TEXT NOT NULL)';
331	    this.ctx.resources.db.exec(sql);
332	  }
```

### 第 2 步：`http` 插件建全局唯一 Fastify 实例与路由登记簿

骨架就位后，`Main.ts` 按 `config.yaml` 的 `plugins` 顺序挂载插件。轮到 `http` 时，`apply`（`src7/plugins/http/index.ts:562`）先校验顶层 `server` 段（`port` 必填，不默认 `30086`，防测试误占正式端口），再 `new Http(...)` 把 `ctx.http` 服务挂到 Cordis 上：

```ts
// src7/plugins/http/index.ts
562	export function apply(ctx: cordis.Context, pluginConfig?: unknown): void {
563	  //M server 段是外面进来的（config.yaml 顶层，和基地共用），在这里校验一次；没有主令牌就当空串。
564	  const server = (ctx.resources.raw['server'] ?? {}) as {
565	    port?: unknown; token?: unknown; host?: unknown; trusted_ips?: unknown; web_auth?: unknown;
566	  };
567	  //M 不写 server.port 就报错，不再默认 30086（那是正式运行的端口，免得测试或新目录误占）。
568	  if (server.port === undefined) {
569	    throw new Error('配置里没有 server.port');
570	  }
571	  const port = server.port;
…
601	  //M server 配置校验通过后，实例化 Http 并作为服务挂到 ctx 上供其他插件登记路由。
602	  const trustedIps = (trusted as string[]).map((item) => item.trim());
603	  new Http(ctx, { port: port as number, token, host, trustedIps, webAuth });
604	}
```

`Http.constructor`（`src7/plugins/http/index.ts:223`）一口气搭好骨架，但**故意还不调 `listen`**：

```ts
// src7/plugins/http/index.ts
223	  constructor(ctx: cordis.Context, private readonly config: HttpConfig) {
224	    super(ctx, 'http');
225
226	    //M forceCloseConnections：拔插件时连着的 keep-alive 连接一起关，不然 close 要等它们自己断。
227	    this.app = fastify.default({ logger: false, bodyLimit: BODY_LIMIT, forceCloseConnections: true });
228
229	    //M 根实例统一生成错误响应，各路由仍保留自己的业务状态码。
230	    registerHttpErrorHandler(this.app);
231
232	    //M 先挂登记簿的钩子，后面登记的每条路径（含下面的健康检查）都记下来。
233	    routesModule.watchRoutes(this.app, this.routes);
234
235	    //M 每个请求先查令牌。用 async 钩子：Bun 上同步钩子返回 undefined 会把请求卡住。
236	    this.app.addHook('onRequest', (request, reply) => this.check(request, reply));
237	    //M 2026-11-16：problems 报插件没挂上/没开工；ok 仍表示 HTTP 服务本身活着（换版、看门狗只认 ok，插件问题不能把服务判死）。
238	    this.app.get('/api/health', () => ({ ok: true, problems: getPluginProblems(this.ctx.resources.pluginStatus) }));
239
…
267	    const file = path.join(this.ctx.resources.ensureRuntimeDir('data'), 'tokens.json');
268	    this.tokens = new tokensModule.Tokens(this, file, config.token);
269	    //M 挂载外网反向代理登录接口（仅当请求带 X-External-Proxy: 1 且配了 web_auth 时启用拦截）。
270	    this.webAuth = new webAuthModule.WebAuth(this.app, config.webAuth, config.now);
271
272	    //M 都挂完了才监听：这时候别的插件的路径都登记好了。
273	    //M 并入原 web 插件：监听之前先登记文件接口、插件页面和网页兜底路由（Static.ts）。
274	    this.ctx.on('ready', (argv) => {
275	      void staticModule.registerStatic(this.ctx, this.app).then(() => this.listen(argv));
276	    });
```

注意 233 行的 `watchRoutes`（`src7/plugins/http/Routes.ts:62`）：它在登记任何路径之前先挂 Fastify 的 `onRoute` 钩子。后面任何插件调 `app.get` / `app.post` 时，钩子同步抓当前调用栈，认出第一个落在 `src7/plugins/<文件夹>/` 里的帧，自动记下这条路由归哪个插件管——教程页展示“每个插件有哪些 HTTP 接口”全靠它自动采集，零手写清单：

```ts
// src7/plugins/http/Routes.ts
62	export function watchRoutes(app: fastify.FastifyInstance, list: RouteInfo[]): void {
63	  app.addHook('onRoute', (options) => {
64	    //M 抓调用栈：临时放宽帧数，抓完还原。
65	    const before = Error.stackTraceLimit;
66	    Error.stackTraceLimit = STACK_LIMIT;
67	    const stack = new Error('route').stack ?? '';
68	    Error.stackTraceLimit = before;
69	    const found = getOwner(stack);
70	    let owner = '';
71	    let site = '';
72	    if (found !== undefined) {
73	      owner = found.owner;
74	      site = found.site;
75	    }
…
78	    const methods = [options.method].flat();
79	    for (const method of methods) {
80	      if (method === 'HEAD') continue;
81
82	      list.push({ method, url: options.url, owner, site });
83	    }
84	  });
```

### 第 3 步：`onRequest` 两道门禁（外网 `WebAuth` + 本机/令牌/受信网关）

每一个进 `:30086` 的请求，在进业务路由前都先过 `Http.check`（`src7/plugins/http/index.ts:398`）。第一步先用 `Http.isGuarded`（`src7/plugins/http/index.ts:454`）判定要不要保护：**路由模式**与 **`decodeURI` 解码后的路径**两边都查 `/api/`、`/files/`、`/programs/`，堵死 `/%61pi/message` 这种 URL 编码绕过：

```ts
// src7/plugins/http/index.ts
398	  private async check(
399	    request: fastify.FastifyRequest,
400	    reply: fastify.FastifyReply,
401	  ): Promise<fastify.FastifyReply | undefined> {
402	    const route = request.url.split('?')[0] ?? '';
403	    //M 路由模式或解码后的路径在要令牌的前缀下，就要令牌（isGuarded 说了为什么两样都查）。
404	    const guarded = this.isGuarded(request, route);
405
406	    //G 外网代理（X-External-Proxy: 1）且配了 web_auth 时优先走会话 Cookie 鉴权；本机与内网无此头不受影响。
407	    const external = await this.webAuth.checkExternal(request, reply, route, guarded);
408	    if (external === 'blocked') return reply;
409	    if (external === 'pass_verified') {
410	      this.verified.add(request);
411	      return undefined;
412	    }
413	    if (external === 'pass_unverified') return undefined;
414
415	    //M 本机来源直接标为已核验，保持免令牌放行。
416	    const local = this.isLocal(request);
417	    if (local) {
418	      this.verified.add(request);
419	      return undefined;
420	    }
421
422	    //G 免查路径或未配置任何令牌时照常放行，远程请求没有身份标记。
423	    if (!guarded || this.open.has(route) || this.tokens.none()) return undefined;
424
425	    const query = (request.query as { token?: unknown }).token;
426	    const header = (request.headers.authorization ?? '').replace(/^Bearer\s+/iu, '');
427	    let value = header;
428	    if (typeof query === 'string' && query !== '') {
429	      value = query;
430	    }
431	    //G 优先拿查询参数 token、其次拿 Bearer 请求头交由令牌表核验，有效即放行。
432	    if (this.tokens.check(value)) {
433	      this.verified.add(request);
434	      return undefined;
435	    }
436
437	    //M 受信网关仍可免令牌浏览；远程请求须自行提供有效令牌才算已核验。
438	    const trusted = trustedIp(request.ip, this.config.trustedIps);
439	    if (trusted) return undefined;
440
441	    //G 先 await 掉 send 再 return reply，Fastify 才停下。只返回 reply 无法结束请求。
442	    await reply.code(401).send({ error: '要带 token：网址后面加 ?token=…，或请求头 Authorization: Bearer …' });
443	    return reply;
444	  }
…
454	  private isGuarded(request: fastify.FastifyRequest, route: string): boolean {
455	    //G 路由模式就是路由的真实决定，不受编码、大小写、重复斜线这些写法影响。
456	    const pattern = request.routeOptions.url ?? '';
457	    if (hasGuardedPrefix(pattern)) return true;
458
459	    //G 没对上的会落到网页的兜底 /*（或 404，模式是 undefined），模式不在前缀下；再按解码后的路径查，不让兜底放行。
460	    try {
461	      const decoded = decodeURI(route);
462	      return hasGuardedPrefix(decoded);
463	    } catch {
464	      //G 解不开的地址（坏的 %xx）按要令牌处理，不因为看不懂就放行。
465	      return true;
466	    }
467	  }
```

看清 `Http.check` 里**身份标记 `this.verified`（即 `ctx.http.isVerified(request)`）**的 4 种分流，查鉴权 Bug 时断在这里一眼见底：

1. **外网反代流**（带 `X-External-Proxy: 1` 且配了 `web_auth`）：进 `WebAuth.checkExternal`（`src7/plugins/http/WebAuth.ts:341`）。带有效 30 天 HMAC 签名 Cookie `jmb_web_session` → 返 `'pass_verified'` 并记入 `this.verified`（手机免传 `?token=`）；未登录访问前端网页或 `/api/auth/*` → 返 `'pass_unverified'` 放行加载登录页；未登录调 `/api/*` → 直接回 `401` 拦死。
2. **家里本机直连**（`127.*` / `::1`，且无外网头）：`isLocal` 为真 → 记入 `this.verified` 免密放行。
3. **局域网 / 远程脚本带令牌**（如 Linux 虚拟机里的 `Run.mjs` 调宿主机 `192.168.200.1:30086`）：核对 `?token=` 或 `Authorization: Bearer`，命中 `data/tokens.json` 或主令牌 → 记入 `this.verified` 放行。
4. **受信网关免密浏览**（`trusted_ips`，如内网指定 IP）：不带令牌也能放行看页面，但**不加进 `this.verified`**——因此它在 `web-api` 里不算 `verifiedOwner`，不能冒充本人批复高危操作。

```ts
// src7/plugins/http/WebAuth.ts
341	  async checkExternal(
342	    request: fastify.FastifyRequest,
343	    reply: fastify.FastifyReply,
344	    route: string,
345	    guarded: boolean,
346	  ): Promise<ExternalAuthDecision> {
347	    //G 未配 web_auth 或未带 X-External-Proxy: 1 时，不启用外网拦截，交回原有本机/内网逻辑。
348	    if (this.spec === undefined || !isExternalProxyRequest(request)) return 'not_external';
349
350	    //M 携带有效签名 Cookie 时放行并标记已核验身份，手机/PC 无需额外传 ?token=。
351	    if (this.readAuthenticatedUser(request) !== undefined) return 'pass_verified';
352
353	    //M 未登录时放行健康检查、登录状态/提交接口与全部前端静态资源，让浏览器加载出 React 登录页。
354	    if (!guarded || PUBLIC_API_ROUTES.has(route)) return 'pass_unverified';
355
356	    //G 其余受保护接口一律返回 401，引导前端渲染 AuthGate 登录界面。
357	    await reply.code(401).send({ error: '请先登录', code: 'unauthorized' });
358	    return 'blocked';
359	  }
```

### 第 4 步：各业务插件挂载，往同一个 `ctx.http.app` 登记路由

`Main.ts:136` 循环加载 `config.yaml` 里的其余插件。凡是在 `inject` 里写了 `'http'` 的插件（`web-api`、`tutorial`、`settings`、`knowledge`、`work-decision`、`frpc`、`programs` 等），都在 `http` 服务就绪后拿到同一个 `ctx.http.app` 挂自己的 `/api/*` 路由。

以网页收发话插件 `WebApi`（`src7/plugins/web-api/index.ts:192`、`:288`）为例：

```ts
// src7/Main.ts
146	      const plugin = await pluginIndex.loadPlugin(entry.name, app.resources.root);
147
148	      //M 等待 Cordis apply。状态监听使用 thenable 后面的原 fiber。
149	      row.inject = plugin.inject ?? [];
150	      const mounted = app.plugin(plugin, entry.config);
151	      const fiber = mounted.ctx.fiber;
152	      starting.set(fiber, row);
```

```ts
// src7/plugins/web-api/index.ts
191	    //M Fastify 在 http 开始监听时才执行这个函数，那时别的插件的路径都登记好了，hasRoute 查得到。
192	    ctx.http.app.register(async (scope) => {
193	      //M 延迟登记网页路由，等其他插件先挂好自己的路径。
194	      this.routes(scope);
195	      this.views.routes(scope);
…
288	  private routes(scope: fastify.FastifyInstance): void {
289	    //M 登记网页发话入口，交给渠道入站逻辑统一校验和分派。
290	    scope.post<{ Body: unknown }>('/api/message', async (request) => {
291	      //M 来源标记取自 HTTP 钩子，正文里的身份字段不会进入可信快照。
292	      const verified = this.ctx.http.isVerified(request);
293	      return this.accept(request.body, verified);
294	    });
```

### 第 5 步：`ready` 信号发出，`Static.ts` + `Embedded.ts` 挂网页兜底

等 `config.yaml` 里的插件一轮挂完（超时的转后台继续起），`Main.ts:205` 广播 `app.emit('ready', args.rest)`，紧接着把上次进程退出时库里还处于 `'running'` 的会话捞出来续跑：

```ts
// src7/Main.ts
204	  //M 配置的插件都已发起挂载，告诉大家开工，带上命令行里剩下的参数。
205	  app.emit('ready', args.rest);
206
207	  //M 上次没跑完的会话（库里还是 running 的），接着跑。
208	  for (const row of app.sessions.find({ state: 'running' })) {
209	    void app.sessions.open(row.id).run();
210	  }
```

`http` 插件在前面 274 行埋好的 `ready` 监听这时触发：先调 `registerStatic`（`src7/plugins/http/Static.ts:34`）装上 `/files/*` 文件接口、各插件独立子页面 `/<插件名>/`（如 `/memory/`、`/tutorial/`），最后挂上全站兜底路由 `GET /*`：

```ts
// src7/plugins/http/Static.ts
34	export async function registerStatic(ctx: cordis.Context, app: fastify.FastifyInstance): Promise<void> {
35	  //M HTTP 与 resources 已就绪，先登记文件接口；Fastify 按具体路径优先匹配，不会落入静态兜底。
36	  new filesModule.FilesApi(ctx, app);
37
…
41	  for (const entry of ctx.resources.config.plugins) {
42	    const name = entry.name;
43	    if (!/^[a-z][a-z0-9-]*$/u.test(name) || name === 'index'
44	      || (await assets.readAsset(`${name}.html`)) === undefined) continue;
45	    app.get(`/${name}`, (_request, reply) => reply.redirect(`/${name}/`, 301));
46	    app.get(`/${name}/`, async (_request, reply) => {
47	      const html = await assets.readAsset(`${name}.html`);
48	      return reply.header('Cache-Control', 'no-cache').type('text/html; charset=utf-8').send(html ?? NOT_BUILT);
49	    });
50	  }
…
53	  app.get<{ Params: { '*': string } }>('/*', async (request, reply) => {
54	    //M Fastify 已经把路径里的 %xx 解开了，这里拿到的就是相对 dist/web 的路径。
55	    const relative = request.params['*'];
56
57	    //G 没被别的插件对上的接口回 404，不回网页。
58	    if (relative === 'api' || relative.startsWith('api/')) {
59	      return reply.code(404).send({ error: `没有这个接口：${request.method} /${relative}` });
60	    }
…
83	    //G 带扩展名的文件（.js、.css、.png…）找不到就回 404，不回 index.html，免得脚本被当成网页。
84	    if (found === undefined && /\.[a-z0-9]{1,8}$/iu.test(relative)) {
85	      return reply.code(404).type('text/plain; charset=utf-8').send(`没有这个文件：/${relative}`);
86	    }
87
88	    //M 没有就给 index.html（前端的路径，比如 /sessions/abc）。
89	    const data = found ?? (await assets.readAsset('index.html'));
90	    if (data === undefined) return reply.code(404).type('text/plain; charset=utf-8').send(NOT_BUILT);
91
92	    //M assets/ 下的长缓存；别的（主要是 index.html）每次都问，换版本马上生效。
93	    let cache = 'no-cache';
94	    if (found !== undefined && file.startsWith('assets/')) {
95	      cache = LONG_CACHE;
96	    }
97	    if (found === undefined) file = 'index.html';
98	    //M 按最终文件的 MIME 类型与缓存策略发回静态资源字节。
99	    return reply.header('Cache-Control', cache).type(mime.getMimeType(file)).send(data);
100	  });
```

`Static.ts` 读网页字节统一调骨架的 `readAsset`（`src7/utils/Embedded.ts:78`）：

- **单文件编译版**（`jmbots.exe`）：从打包生成的内存表里按 `web/<路径>` 取出字节，完全不碰磁盘；
- **源码开发版**：读仓库 `dist/web/`，并在 91–93 行做路径越界守卫（静态网页免令牌，若无 `inside.startsWith('..')` 拦截，恶意请求就能跨目录读源码）。

```ts
// src7/utils/Embedded.ts
78	export async function readAsset(relative: string): Promise<Buffer | undefined> {
79	  //M 编译版网页资产统一从 web/ 登记项查找。
80	  const name = `web/${relative}`;
81	  const file = findEmbeddedFilePath(name);
82	  if (file !== undefined) {
83	    const content = await Bun.file(file).arrayBuffer();
84	    return Buffer.from(content);
85	  }
86
87	  //G 编译版表里没有 → 就是没有，不去磁盘上找。
88	  if (isCompiled()) return undefined;
89
90	  //G 空路径、跳出 dist/web 的不给：网页不查令牌，没有这一行，别的机器能读代码目录下任何文件。
91	  const full = path.resolve(WEB_DIR, relative);
92	  const inside = path.relative(WEB_DIR, full);
93	  if (relative === '' || inside.startsWith('..') || path.isAbsolute(inside)) return undefined;
94
95	  //M 源码版：是文件才读。
96	  const stat = await fs.promises.stat(full).catch(() => undefined);
97	  if (stat?.isFile() !== true) return undefined;
98	  return fs.promises.readFile(full);
99	}
```

### 第 6 步：`Http.listen` 绑 `30086`、80 秒让口重试、落 `pid` 文件

`registerStatic` 一完成，`.then(() => this.listen(argv))` 进入最后一步 `Http.listen`（`src7/plugins/http/index.ts:474`）：

- 命令行传了 `--port N` 就覆盖配置的 `30086`（基地试运行新包时用临时端口探活）；
- 遇到端口还被旧进程占着（`EADDRINUSE`），在 80 秒期限内每 2 秒重试一次，配合基地平滑换版无缝接棒；
- 监听成功后把进程号写进 `data/serve_30086.pid`，并挂好 `exit` / `SIGTERM` / `SIGINT` 自动清理钩子。至此 `:30086` 正式对外接客！

```ts
// src7/plugins/http/index.ts
474	  private async listen(argv: string[]): Promise<void> {
475	    //M 命令行是外面进来的：--port 在这里校验一次。
476	    const at = argv.indexOf('--port');
477	    let port = this.config.port;
478	    if (at >= 0) {
479	      port = Number(argv[at + 1]);
480	    }
…
487	    const deadline = Date.now() + LISTEN_WAIT_MS;
488	    for (;;) {
489	      try {
490	        await this.app.listen({ host: this.config.host, port });
491	        break;
492	      } catch (error) {
493	        const text = textModule.getErrorMessage(error);
494	        const inUse = (error as NodeJS.ErrnoException).code === 'EADDRINUSE' || /in use/iu.test(text);
495	        if (!inUse || Date.now() > deadline) {
496	          console.error(`HTTP 服务没起来：${text}`);
497	          return;
498	        }
499	        console.error(`端口 ${String(port)} 被占着，${String(LISTEN_RETRY_MS / 1000)} 秒后再试`);
500	        await Bun.sleep(LISTEN_RETRY_MS);
501	      }
502	    }
503
504	    //M 进程号写进 data/serve_<端口>.pid，基地换版本时按它停旧进程；被拔掉、进程退出、收到 SIGTERM/SIGINT 时删掉。
505	    this.pidFile = path.join(this.ctx.resources.ensureRuntimeDir('data'), `serve_${String(port)}.pid`);
506	    fs.writeFileSync(this.pidFile, String(process.pid));
…
513	    const vars = { host: this.config.host, port: port, hasToken: !this.tokens.none() };
514	    this.ctx.emit('trace', 'Http.listen', 'trace.http.listen', "app.listen({ host, port })", vars);
515	    console.log(`HTTP 服务已开：http://<本机地址>:${String(port)}（本机请求不用令牌；别的机器要带令牌）`);
516	  }
```

---

## 下篇：改数据 / 存 SQLite 核心调试断点全链

服务起来以后，一条消息从进来到回话落盘，到底改了哪几份内存对象、写了哪几张 SQLite 表？下面把**网页私聊**（`web-api`）和**飞书消息**（`feishu`）两条入口合在一张地图里拆到底。

### 2.1 主库 `data/jmbots7.db` 的核心写盘点

整个主进程共用 `ctx.resources.db`（`data/jmbots7.db`），消息主线上最常断住看的写盘点只有 **4 处**：

1. **`web_messages` 表**（`src7/plugins/web-api/Timeline.ts`）：网页自己的收件、以及从飞书/微信/命令行同步过来的时间线都在这。收件时 `INSERT`，认领后 `UPDATE ... SET session_id`，回话时 `UPDATE ... SET replies`。
2. **`feishu_p2p` / `feishu_seen` 表**（`src7/plugins/feishu/Inbound.ts`）：飞书入站先更新私聊联系人映射 `feishu_p2p`，等同步分派完才写 `feishu_seen` 去重（防止分派中途崩溃把消息白白吞掉）。
3. **`sessions` 表**（`src7/Sessions.ts`）：**全系统所有会话的唯一持久化出口**！不管是 bots 事务认领排队、用户话进历史、模型答完、工具跑完、还是记发送回执，最终全都汇聚到 `Session.save` 那一句 `INSERT OR REPLACE INTO sessions (id, meta, messages) VALUES (?, ?, ?)`。
4. **`journal_lines` 表**（`src7/plugins/journal/index.ts`）：`Journal.record` 全程旁听所有 `trace` 和非只读事件，按 `message_id`、`session_id`、`source_id` 串起整条留痕。

下面按执行先后看这几处真实源码。

#### 写盘点 A：网页收件表写入、绑会话与追加回话（`Timeline.ts`）

网页点发送进 `WebApi.accept`（`src7/plugins/web-api/index.ts:381`），先调 `Timeline.insert` 拿自增收件号；别的渠道来话则在 `bot/receive` 时由 `WebApi.onReceive`（`src7/plugins/web-api/index.ts:244`）补记一行并带上 `source_id`（标准消息号）：

```ts
// src7/plugins/web-api/Timeline.ts
288	  insert(input: NewMessage): number {
289	    //M 把入站原文和来源写入收件表，保留新编号供会话绑定与通知使用。
290	    const now = Date.now();
291	    const createdAt = input.createdAt ?? now;
292	    const sql = 'INSERT INTO web_messages (bot, channel, source, address, text, session_id, status, replies,'
293	      + ' created_at, updated_at, reply_to, source_id)'
294	      + " VALUES (?, ?, ?, ?, ?, NULL, 'taken', '[]', ?, ?, ?, ?)";
295	    const row = [
296	      input.bot, input.channel, input.source, input.address, input.text,
297	      createdAt, now, input.reply_to ?? null, input.source_id ?? null,
298	    ];
299	    //M 保存可排序的原话时刻和用于增量轮询的写入时刻。
300	    const result = this.ctx.resources.db.query(sql).run(...row);
301	    const id = Number(result.lastInsertRowid);
302
…
368	  bindSession(id: number, sessionId: string): void {
369	    //M 记录第一次认领，同时把收件号和会话号交给流水，供回复之前查询轨迹。
370	    const sql = 'UPDATE web_messages SET session_id = ? WHERE id = ? AND session_id IS NULL';
371	    const updated = this.ctx.resources.db.query(sql).run(sessionId, id);
372	    if (updated.changes === 0) return;
…
427	    const sql = 'UPDATE web_messages SET replies = ?, session_id = COALESCE(session_id, ?), status = ?, updated_at = ?'
428	      + ' WHERE id = ?';
429	    const replies = JSON.stringify(record.replies);
430	    this.ctx.resources.db.query(sql).run(replies, sessionId, status, now, id);
431
```

#### 写盘点 B：飞书入站 6 步、拼 `ChannelMessage` 与后置去重（`feishu/Inbound.ts`）

飞书 WebSocket 推来 `im.message.receive_v1` 后，进 `FeishuInbound.handleInboundMessage`（`src7/plugins/feishu/Inbound.ts:214`）：先认人认群认 `@`、更新 `feishu_p2p`、挂“敲键盘”表情、把图片/文件下载到渠道目录、拼成全渠道统一的 `ChannelMessage`（定义在 `src7/plugins/channels/Message.ts:107`），最后进 `deliver` 发事件，**等下游认领完毕才调 `markSeen` 写 `feishu_seen`**：

```ts
// src7/plugins/feishu/Inbound.ts
214	  private async handleInboundMessage(appId: string, app: AppState, data: ReceiveData): Promise<void> {
215	    const message = data.message;
216
217	    //M 1. 认出 @ 了哪些机器人、引用的是不是机器人的话、文字、谁在哪个群说的、投给哪些机器人。
218	    const facts = await this.getFacts(appId, app, data);
219
220	    //M 2. 私聊的记成这个应用最近私聊的人，再拼回话地址。
221	    this.rememberPrivate(facts);
222	    const address = this.getAddress(facts);
223
…
251	      //M 5. 拼成标准消息，先持久化渠道原始记录。
252	      const channelMessage = this.getChannelMessage(facts, app.config.bot, address, more, saved);
253	      this.saveChatEntry(facts, channelMessage);
254
255	      //M 6. 经 emitInbound 发出三个事件之一；短分派完成后才记 feishu_seen 去重，再汇总认领结果写流水。
256	      await this.deliver(facts, address, channelMessage);
…
774	    //M 照叫没叫机器人分好事件发出：私聊 direct、群里叫了 mention、别的 listen。
775	    const control: protocol.ChannelMessageControl = { claims: [] };
776	    await protocol.emitInbound(this.ctx, channelMessage, facts.called, control);
777
778	    //M 确认原消息存盘且同步分发流程完成后才写 feishu_seen，防止崩溃丢消息。
779	    this.markSeen(appId, messageId);
780
…
800	  private markSeen(appId: string, messageId: string): void {
801	    const sql = 'INSERT OR IGNORE INTO feishu_seen (message_id, app_id, kind, at) VALUES (?, ?, ?, ?)';
802	    //M 分派完成后记住消息号与时间，后续重推可以跳过。
803	    this.ctx.resources.db.query(sql).run(messageId, appId, 'in', Date.now());
804	  }
```

#### 写盘点 C：机器人认领、附件进工作区与前台单队列事务（`bots`）

`emitInbound`（`src7/plugins/channels/Message.ts:280`）按私聊/群提及/旁听发出 `channel/direct`、`channel/mention` 或 `channel/listen`。`approval` 先用 `{ prepend: true }` 拦截“同意 3”这类批复口令（命中就标 `control.approvalHandled = true`）；没拦住就到 `Bots.onChannelMessage`（`src7/plugins/bots/index.ts:589`）：

- 对 `targetBots` 里的每个机器人独立算去重键 `claimKey = JSON.stringify([messageId, botName])`；
- 深拷贝一份互不污染的 `botOrigin`，调 `materializeAttachments` 把刚下载的附件拷进该机器人本轮授权工作区的 `inbox/<日期>/`，并在正文附上 `@绝对路径`；
- 串行发 `bot/receive`：给 `relay`（如“cc / 哈基米”前缀转外部助手）和 `tutorial`（剥离 `#调试` 关键词）留出改道口；
- 没人截走就交 `frontDesk.claimChannelMessage` 排进前台单队列。

```ts
// src7/plugins/bots/index.ts
589	  private async onChannelMessage(
590	    message: protocol.ChannelMessage,
591	    listen: boolean,
592	    control?: protocol.ChannelMessageControl,
593	    fromChannelEvent = true,
594	  ): Promise<void> {
595	    if (control?.approvalHandled === true) return;
596
…
614	      const claimKey = protocol.getClaimKey(message.messageId, botName);
615	      const botOrigin: { channel: string; address: Record<string, unknown> } = {
616	        channel: message.origin.channel,
617	        address: structuredClone(message.origin.address),
618	      };
619
620	      //M 只听的话：在这个机器人的地址副本上标 listenOnly（bots 内部的标记，前台、relay 读它；渠道的原地址不动）。
621	      if (listen) {
622	        botOrigin.address['listenOnly'] = true;
623	      }
624
625	      //M 按该机器人此轮授权目录把渠道保存的附件物化到 inbox。
626	      const botText = this.materializeAttachments(bot, botOrigin.address, message);
627	      const incoming: IncomingMessage = {
628	        channel: message.channel,
629	        bot: botName,
630	        text: botText,
631	        time: message.createdAt,
632	        address: botOrigin.address,
633	        sourceId: message.messageId,
634	      };
635	      const receiveEvent: ReceiveEvent = {
636	        bot,
637	        message: incoming,
638	        fromChannelEvent,
639	      };
…
647	      await this.home.serial('bot/receive', receiveEvent);
648
649	      if (receiveEvent.handled === true) {
650	        claimModule.pushClaim(control, botName, claimKey, 'handled');
651	        continue;
652	      }
…
687	      //M 未被其他插件接管 → 按来源范围进该机器人的前台单队列（channel_tool 模式）。话用 incoming.text（理由同上）。
688	      await this.home.frontDesk.claimChannelMessage(bot, message, botOrigin, incoming.text, claimKey, control);
689	    }
```

进 `DispatchClaim.claimChannelMessage`（`src7/plugins/bots/DispatchClaim.ts:94`）后，先查 `isClaimed` 防渠道重推，再拼好带不可变来源快照 `SourceSnapshot` 的排队项 `QueueItem`，在 `DispatchClaim.persistClaim`（`src7/plugins/bots/DispatchClaim.ts:223`）里用 **`db.transaction` 原子写入 `sourceClaims`、`resultQueue`、`sourceScope` 并调 `front.save()`**：

```ts
// src7/plugins/bots/DispatchClaim.ts
223	  private persistClaim(
224	    front: Session,
225	    item: QueueItem,
226	    scope: NonNullable<SessionMeta['sourceScope']>,
227	    explicit: boolean,
228	  ): void {
229	    const claimKey = item.key;
230	    //M 认领键和队列项在一个数据库事务里一起写：排队、记已认领、存库，任何一步抛错整个回滚，内存里的值还原。
231	    const db = this.home.resources.db;
232	    const beforeClaims = front.row.sourceClaims;
233	    const beforeQueue = front.row.resultQueue;
234	    const commitClaim = db.transaction(() => {
235	      rememberClaim(front, claimKey);
236	      front.row.resultQueue = [...(beforeQueue ?? []), item];
237
238	      //M 按范围找到的前台记下范围；指定的前台可能是别的渠道的（网页接着飞书群的前台说），不改它的范围。
239	      if (!explicit) {
240	        front.row.sourceScope = scope;
241	      }
242
243	      //M 认领键、队列项、来源范围都改好了，存库（和上面同属一个事务）。
244	      front.save();
245	    });
```

只要当前前台空着（`state !== 'running'` 且 `activeKey === undefined`），立刻调 `DispatchResults.drain`（`src7/plugins/bots/DispatchResults.ts:853`）→ `startQueuedUser`（`:920`）：把 `activeKey` 和 `activeSourceSnapshot` 挂到 `session.row` 上落库，再调 `session.queueUserMessage` + `void session.run()` 推会话开跑：

```ts
// src7/plugins/bots/DispatchResults.ts
853	  drain(session: Session): void {
854	    const row = session.row;
855	    if (row.state === 'running' || row.activeKey !== undefined) return;
856
857	    if (row.frontTask?.paused === true) return;
858
859	    const queue = row.resultQueue ?? [];
860
861	    //M 用户排着的话：自动回话项取出直跑；channel_tool 项留在队列并占有 activeKey 与快照后直接启动。
862	    const said = queue.find((item) => item.kind === 'user' && item.stage === 'queued');
863	    if (said !== undefined) {
864	      //M 优先接排着的用户话，沿用它原先的渠道模式。
865	      this.startQueuedUser(session, said, queue);
866	      return;
867	    }
…
920	  private startQueuedUser(session: Session, said: QueueItem, queue: QueueItem[]): void {
921	    const row = session.row;
922
923	    if (said.deliveryMode === 'channel_tool') {
924	      row.activeKey = said.key;
925	      said.stage = 'working';
926	      row.quiet = true;
927	      if (said.payload.sourceSnapshot !== undefined) {
928	        row.activeSourceSnapshot = structuredClone(said.payload.sourceSnapshot);
929	      }
930	      if (said.replyControl !== undefined && said.alreadyRecorded !== true) {
931	        said.replyControl.startMessageIndex = row.messages.length;
932	      }
933
934	      //M 回话地址换成这一条话的来源，存库；原话没记进对话的才加进去（延迟接话的已经记过）。
935	      this.home.bots.route(session, said.origin);
936	      session.save();
937	      if (said.alreadyRecorded !== true) {
938	        session.queueUserMessage(said.payload.text);
939	      }
940
941	      //M 推会话跑一轮，不等；回话由 channel_tool 的回复工具发。
942	      void session.run();
943	      return;
```

#### 写盘点 D：会话循环四关口与全系统唯一 `sessions` 落盘口（`Sessions.ts`）

`Session.loop`（`src7/Sessions.ts:613`）每走一步，依次过四个 `ctx.serial` 关口：

- **关口一 `session/before-model`**（`src7/Sessions.ts:697`）：`bots` 拼最近往来、人设和回复规则，`memory` 拼召回，`context-fit` 做 80% 窗口压缩裁剪，排最后的 `model-catalog` 选模型并发起真实请求，把回答塞进 `request.answer`；
- **关口二 `session/after-model`**（`src7/Sessions.ts:719`）：模型回答接进历史前允许插件检查或喊停；
- **关口三 `session/before-tool`**（在 `Tools.execute` 里，`src7/Tools.ts:187`）：`approval` 在这里做命令四档把关，不许跑单次写 `gate.deny`，整轮喊停写 `gate.stop`；
- **关口四 `session/after-tool`**（`src7/Sessions.ts:672`）：工具结果打包进 `toolResult` 前允许插件检查或改写。

```ts
// src7/Sessions.ts
632	      for (const waiting of this.inbox.splice(0)) {
633	        this.append(waiting);
634	      }
635
636	      //M 关口一，调模型之前：备好这一步的请求，交给插件挨个改（session/before-model）。
637	      const request: ChatRequest = {
638	        session: this,
639	        model: this.row.model,
640	        thinking: this.row.thinking,
641	        system: [],
642	        tools: this.ctx.tools.listToolsForSessionKind(this.row.kind),
643	        messages: [...this.row.messages],
644	        signal: modelSignal,
645	      };
646	      //M 经过两个模型关口后接入回答；这一步被取消时，重新从队列取话。
647	      const answer = await this.getStepAnswer(request);
648	      if (answer === undefined || modelSignal.aborted) continue;
649
650	      //M 插件可能改了、换了回答，以最后这一份为准，接进对话。
651	      this.append(answer);
652
…
660	      if (calls.length === 0) {
661	        const reply = piAi.contentText(answer.content);
662	        this.change('done', reply);
663	        return;
664	      }
665
666	      //M 模型要了工具 → 一个个执行（关口三 session/before-tool 在 Tools.execute 里），结果接进对话，回到开头走下一步。
667	      for (const call of calls) {
668	        const executed = await this.ctx.tools.execute(call, this, signal, stepSignal);
669
670	        //M 关口四，工具执行之后：结果接进对话之前，交给插件挨个看（session/after-tool）。
671	        const done: ToolDone = { session: this, call, outcome: executed };
672	        await this.ctx.serial('session/after-tool', done);
673
…
677	        this.append(result);
678
```

```ts
// src7/Sessions.ts
696	      //M 关口一：插件在这里修改请求，也可以提供现成回答。
697	      await this.ctx.serial('session/before-model', request);
698	      if (signal.aborted) return;
…
711	      let answer = request.answer;
712	      if (answer === undefined) {
713	        answer = await this.ctx.sessions.chat(request);
714	      }
715	      if (signal.aborted) return;
716
717	      //M 关口二：插件在回答进入历史前检查或替换回答。
718	      const answered: AnsweredRequest = { ...request, answer };
719	      await this.ctx.serial('session/after-model', answered);
720	      if (signal.aborted) return;
```

最关键的设计在文件最底下这 38 行——`Session.save`（`src7/Sessions.ts:760`）、`Session.append`（`src7/Sessions.ts:778`）与 `Session.change`（`src7/Sessions.ts:790`）：

- `row` 在内存里把字段摊平，存库时 `const { messages, ...meta } = this.row` 一刀拆成两列：`meta` 存除对话外的一切状态与插件扩展字段（`Sessions.find` 靠 SQLite 的 `json_extract(meta, '$.xxx')` 直接检索，插件加字段永远不用 `ALTER TABLE`），`messages` 存完整对话数组；
- `append` 和 `change` 严格遵守**先 `this.save()` 落盘、再 `this.ctx.emit(...)` 广播**——任何监听 `session/new-message` 或 `session/change` 的插件去读库，读到的永远是已经落盘的最新状态！

```ts
// src7/Sessions.ts
760	  save(): void {
761	    this.row.updatedAt = Date.now();
762
763	    //M 记录拆成两块：对话一块，别的项（连同插件加的）一块，各自转成 JSON。
764	    const { messages, ...meta } = this.row;
765	    const metaJson = JSON.stringify(meta);
766	    const messagesJson = JSON.stringify(messages);
767
768	    //M 按主键覆盖持久化这一场会话的元信息与完整对话数组。
769	    const sql = 'INSERT OR REPLACE INTO sessions (id, meta, messages) VALUES (?, ?, ?)';
770	    const query = this.ctx.resources.db.query(sql);
771	    query.run(meta.id, metaJson, messagesJson);
772	  }
773
774	  /**
775	   * 往对话后面接一条：存库，通知大家。
776	   * @param message 接进对话并通知插件的新消息。`Message` 的四种形状见本文件 L96。
777	   */
778	  private append(message: piAi.Message): void {
779	    //M 先写进内存与库中保证不丢消息，再通知订阅该会话新消息的插件。
780	    this.row.messages.push(message);
781	    this.save();
782	    this.ctx.emit('session/new-message', this, message);
783	  }
784
785	  /**
786	   * 改状态：存库，通知大家。
787	   * @param state 新状态。
788	   * @param reply 这一轮的结果，要回给用户的话；刚开始转时是空的。
789	   */
790	  private change(state: SessionState, reply: string): void {
791	    //M 同步更新状态与结果正文并落库，再连同原状态通知监听状态变更的插件。
792	    const stateBefore = this.row.state;
793	    this.row.state = state;
794	    this.row.reply = reply;
795	    this.save();
796	    this.ctx.emit('session/change', this, stateBefore);
797	  }
```

#### 写盘点 E：回复工具幂等键、飞书发信与回执落库（`ChannelTools.ts` / `feishu/Reply.ts`）

模型决定回话时调 `channel_reply` 工具，进 `ChannelTools.runReply`（`src7/plugins/bots/ChannelTools.ts:172`）：先用本轮 `replyRoundKey` + 工具 `callId` 算出幂等键 `replyRequestKey`，更新 `nextReplyIndex` 落一次库；再调 `requestTextReply`（`src7/plugins/channels/Reply.ts:238`）→ `requestChannelReply`（`:196`）发一问一答事件 `channel/reply`；拿到渠道回执后写进 `active.deliveryReceipt` 再落一次库：

```ts
// src7/plugins/bots/ChannelTools.ts
280	    //M 基于回复轮键和调用号算出本次发信的幂等键。
281	    const replyControl = active?.replyControl;
282	    const replyRoundKey = replyControl?.roundKey ?? snapshot.replyRoundKey;
283	    const replyRequestKey = protocol.getReplyRequestKey(replyRoundKey, callId);
284
285	    //M 同一 replyRequestKey 重试保持原序号；新调用从 nextReplyIndex 取值并加一。
286	    let replyIndex = replyControl?.nextReplyIndex ?? 0;
287	    if (replyControl !== undefined) {
288	      const existingIndex = replyControl.receiptKeys.indexOf(replyRequestKey);
289	      if (existingIndex >= 0) {
290	        replyIndex = existingIndex;
291	      }
292	      if (existingIndex < 0) {
293	        replyControl.nextReplyIndex += 1;
294	        replyControl.receiptKeys.push(replyRequestKey);
295	        session.save();
296	      }
297	    }
…
327	    const options = { replyRequestKey, replyRoundKey, replyIndex, kind, target };
328	    //M 统一发送文字，让目标渠道识别指定的聊天并交回回执。
329	    const receipt = await protocol.requestTextReply(this.ctx, snapshot, text, options);
330
331	    if (active !== undefined) {
332	      //M 将渠道返回的真实发送回执落盘记到当前活动队列项。
333	      active.deliveryReceipt = receipt;
334	      session.save();
335	    }
336	    return JSON.stringify(receipt);
```

渠道侧各自认领自己的 `channel`：

- **网页渠道**（`web-api`）：经 `registerTextReply`（`src7/plugins/channels/TextReply.ts:49`）调 `Timeline.reply`（`src7/plugins/web-api/Timeline.ts:385`），把回话追加进 `web_messages.replies` JSON 列，前端 1.5 秒增量轮询立刻刷出气泡。
- **飞书渠道**（`FeishuReply.onChannelReply`，`src7/plugins/feishu/Reply.ts:74`）：标 `request.handled = true` 接单，先查 `replyRequestKey` 历史记录（同键同内容直接重播旧回执，同键不同内容拒发 `reply_conflict`），再调飞书发信接口并发出 `channel/replied` 回执事件（同时 `web-api` 听 `channel/replied` 把飞书回话也挂回网页时间线）：

```ts
// src7/plugins/feishu/Reply.ts
74	  private async onChannelReply(request: protocol.ChannelReplyRequest): Promise<void> {
75	    if (request.channel !== this.name || request.handled === true) return;
76
77	    request.handled = true;
78
…
99	    const existing = this.getReplyRecord(appId, request.replyRequestKey);
100	    if (existing !== undefined) {
101	      if (existing.payloadHash === request.payloadHash) {
102	        //M 同键同载荷命中幂等记录，直接复播原有回执。
103	        protocol.emitReplied(this.ctx, request, existing.receipt);
104	        return;
105	      }
106	      //M 同键不同载荷说明重放冲突，拒绝发送并告知上游拒绝回执。
107	      const reason = 'reply_conflict：同一 replyRequestKey 的发送内容不一致';
108	      const rejected = protocol.getReceipt(request, 'rejected', reason);
109	      protocol.emitReplied(this.ctx, request, rejected);
110	      return;
111	    }
…
141	      //M 普通回复：非空白正文经统一发信方法发出（按原消息号回复，必要时退回直发）。
142	      if (request.atFiles !== true && body.trim() !== '') {
143	        const messageBody = { text: body };
144	        const replyTo = address.messageId || undefined;
145	        providerId = await media.message(this.feishu, appId, chatId, 'text', messageBody, replyTo);
146	      }
```

---

### 2.2 开发者打断点必中清单（12 大排障场景）

线上或本地复现问题时，不用满仓翻代码，按症状直接断下面这 12 个位置，100% 必中：

| 排障症状 | 必中断点位置 | 断住看什么变量 |
|---|---|---|
| 接口报 `401` / 外网登录跳回登录页 | `Http.check`（`src7/plugins/http/index.ts:398`）、`WebAuth.checkExternal`（`src7/plugins/http/WebAuth.ts:341`） | `route`、`guarded`、`external`、`local`、`this.verified.has(request)` |
| 网页点发送报 `400` 或没进会话 | `WebApi.accept`（`src7/plugins/web-api/index.ts:381`）、`Timeline.insert`（`src7/plugins/web-api/Timeline.ts:288`） | `verifiedOwner`、`body`、返回的收件号 `id`、`control.claims` |
| 飞书发了话没动静 / 敲键盘表情不退 | `FeishuInbound.handleInboundMessage`（`src7/plugins/feishu/Inbound.ts:214`）、`FeishuInbound.deliver`（`src7/plugins/feishu/Inbound.ts:759`） | `facts.called`、`facts.targetBots`、`channelMessage`、`outcome` |
| 发“同意 3”没批掉反而当普通话聊了 | `Approval.onChannelMessage`（`src7/plugins/approval/index.ts:1151`） | `said`、`speaker`、`owner`、`verified`、`waiting`、`control.approvalHandled` |
| 话被外部助手截走 / 附件没拷进工作区 | `Bots.onChannelMessage`（`src7/plugins/bots/index.ts:589`） | `claimKey`、`botText`、`receiveEvent.session`、`receiveEvent.handled` |
| 消息被判重复丢掉 / 进错了前台会话 | `DispatchClaim.claimChannelMessage`（`src7/plugins/bots/DispatchClaim.ts:94`）、`DispatchClaim.persistClaim`（`src7/plugins/bots/DispatchClaim.ts:223`） | `scope`、`front.id`、`isClaimed(front, claimKey)`、`item.replyControl` |
| 消息进了 `resultQueue` 却一直卡着不跑 | `DispatchResults.drain`（`src7/plugins/bots/DispatchResults.ts:853`）、`DispatchResults.startQueuedUser`（`src7/plugins/bots/DispatchResults.ts:920`） | `row.state`、`row.activeKey`、`row.frontTask?.paused`、`queue` |
| 想看真正喂给模型的完整提示词与压缩后历史 | `Session.getStepAnswer`（`src7/Sessions.ts:689`）、`Sessions.chat`（`src7/Sessions.ts:513`） | `814` 行前后的 `request.system`、`request.messages`、`request.tools`、`request.answer` |
| 工具为什么被拒（`deny`）或整轮被停（`stop`） | `Tools.execute`（`src7/Tools.ts:170`） | `187` 行后的 `gate.deny`、`gate.stop`、`spec.sessionKinds`、`args` |
| 抓到底是谁偷偷改了 `sessions` 表（看调用栈） | `Session.save`（`src7/Sessions.ts:760`）、`Session.append`（`src7/Sessions.ts:778`）、`Session.change`（`src7/Sessions.ts:790`） | 调用栈 `Error().stack`、`this.row.state`、`this.row.messages.at(-1)` |
| 模型调了回复但飞书/网页没收到或报幂等冲突 | `ChannelTools.runReply`（`src7/plugins/bots/ChannelTools.ts:172`）、`FeishuReply.onChannelReply`（`src7/plugins/feishu/Reply.ts:74`）、`Timeline.reply`（`src7/plugins/web-api/Timeline.ts:385`） | `replyRequestKey`、`requested.isElsewhere`、`existing`、`receipt.status` |
| 教程页画布漏步骤 / 查 SQLite 原始流水 | `Journal.listen`（`src7/plugins/journal/index.ts:230`）、`Journal.record`（`src7/plugins/journal/index.ts:304`） | `line.name`、`line.messageId`、`line.sessionId`、`line.sourceId` |

---

### 2.3 每跳数据前后变形表（10 跳逐字段对照）

把一条消息（以飞书私聊带截图发「帮我查报销流程」为主线，括号对照网页 `POST /api/message` 差异）从进门到回执的 **10 次对象变形与落库动作**逐跳摊开，手机竖屏逐条对照：

| 跳 | 经手位置与事件 | 数据变形（入 → 出 / 落库） |
|---|---|---|
| ① | 原始入口：`FeishuInbound.handleInboundMessage`（`src7/plugins/feishu/Inbound.ts:214`） / 网页 `WebApi.accept`（`src7/plugins/web-api/index.ts:381`） | **入**：飞书 SDK `ReceiveData`（`om_xxx`、`oc_xxx`、`ou_xxx`）或网页 JSON `{ text, bot, uploads }`。<br>**落库**：网页先 `Timeline.insert` 写 `web_messages` 拿收件号 `id`；飞书更新 `feishu_p2p`。 |
| ② | 标准化：`ChannelMessage`（`src7/plugins/channels/Message.ts:107`） | **出**：统一成 `v: 1` 标准消息：`messageId = '["feishu","cli_a1","om_xxx"]'`、`role`（`owner`/`builder`/`guest`）、`targetBots`、下载好的 `attachments`、`origin.address`（含 `customer`、群 `judge` 配置）；网页额外带 `routing.autoFinal = true`。 |
| ③ | 分拣广播：`emitInbound`（`src7/plugins/channels/Message.ts:280`） | **入 → 出**：数据字段不变，`getInboundEvent`（`src7/plugins/channels/Message.ts:263`）按 `chatType` 与 `called` 三选一 `ctx.serial` 发出 `channel/direct`、`channel/mention` 或 `channel/listen`，附可变协调单 `control: { claims: [] }`。 |
| ④ | 口令拦截：`Approval.onChannelMessage`（`src7/plugins/approval/index.ts:1151`） | **改写**：若认出本人发“同意 3 / 拒绝 2”，办结审批并写 `control.approvalHandled = true`（后续机器人全部跳过）；普通消息原样放行，`Grants` 顺手往地址写授权目录。 |
| ⑤ | 逐机器人认领：`Bots.onChannelMessage`（`src7/plugins/bots/index.ts:589`） | **出**：每个目标机器人算 `claimKey`（`getClaimKey`，`src7/plugins/channels/Message.ts:311`），深拷贝 `botOrigin`（只听标 `listenOnly: true`），附件拷进 `<工作区>/inbox/<日期>/` 拼进 `botText`（`@绝对路径`），包成 `ReceiveEvent` 串行问 `bot/receive`（`relay` 可填 `event.session` 截走，`web-api` 把非网页消息补记进 `web_messages`）。 |
| ⑥ | 事务排入单队列：`DispatchClaim.claimChannelMessage`（`src7/plugins/bots/DispatchClaim.ts:94`） | **改写与落库**：按 `scope` 找或建前台 `Session`，调 `getSourceSnapshot`（`src7/plugins/channels/Message.ts:325`）冻结本轮来源快照，拼 `QueueItem { stage: 'queued', deliveryMode: 'channel_tool', replyControl }`；`persistClaim` 用 `db.transaction` 原子写 `row.sourceClaims`、`row.resultQueue`、`row.sourceScope` → `Session.save` 写 `sessions` 表；返回后飞书 `deliver` 写 `feishu_seen`、`web-api` 调 `bindSession` 绑上 `session_id`。 |
| ⑦ | 出队激活开跑：`DispatchResults.drain`（`src7/plugins/bots/DispatchResults.ts:853`） | **改写与落库**：`said.stage = 'working'`、`row.activeKey = claimKey`、`row.activeSourceSnapshot = 快照`、`Bots.route` 更新回话地址 → `Session.save`；`queueUserMessage` 入 `inbox` → `Session.run()` 把 `row.state` 改为 `'running'` 落库，循环开头 `Session.append` 把用户话推入 `row.messages` 落库并发 `session/new-message`（记忆与归档旁听）。 |
| ⑧ | 四关口模型与工具循环：`Session.loop`（`src7/Sessions.ts:613`） | **改写与落库**：组 `ChatRequest`（`messages` 是浅拷贝副本）→ 关口一各插件往 `request.system` 塞上下文与压缩历史、`model-catalog` 调模型填 `request.answer` → 关口二审回答 → `Session.append(answer)` 落库；有 `toolCall` 则进 `Tools.execute`（关口三审命令、跑工具）→ 关口四 → `Session.append(toolResult)` 落库再走下一步；无工具则 `Session.change('done', reply)` 落库。 |
| ⑨ | 发起渠道回复：`ChannelTools.runReply`（`src7/plugins/bots/ChannelTools.ts:172`） | **出与落库**：算幂等键 `replyRequestKey = replyRoundKey + callId`，递增 `replyControl.nextReplyIndex` 调 `Session.save`；若网页一轮零次调工具且带 `autoFinal`，收尾时由 `DispatchResults` 自动把 `reply` 补发出去；统一经 `requestChannelReply`（`src7/plugins/channels/Reply.ts:196`）发 `channel/reply` 等回执。 |
| ⑩ | 渠道投递与回执收尾：`FeishuReply.onChannelReply`（`src7/plugins/feishu/Reply.ts:74`） / `Timeline.reply`（`src7/plugins/web-api/Timeline.ts:385`） | **落库与闭环**：飞书核对幂等键、发消息、写回执并发 `channel/replied { receipt: { status: 'sent' } }`；网页直接更新 `web_messages.replies` 与 `status = 'replied'`；`ChannelTools` 把 `receipt` 存入 `active.deliveryReceipt` 落库；本轮 `done` 后 `DispatchResults` 清掉 `activeKey` 继续 `drain` 队列下一项，`journal` 全程写 `journal_lines`。 |

---

### 2.4 二次开发速查：加新渠道 / 新工具 / 新钩子改哪几行？

遵循项目铁律——**骨架 4 文件不动，插件之间互不 `import`、只走事件**。常见 5 类需求精确落点如下：

#### 1. 加一个全新的消息渠道（如钉钉、Telegram、企业内部 IM）

**不动 `bots`、不动 `Sessions`**，新建 `src7/plugins/<渠道名>/index.ts` 只接两头：

- **入站收话**：把平台回调转成 `ChannelMessage`（`src7/plugins/channels/Message.ts:107`），调 `emitInbound`（`src7/plugins/channels/Message.ts:280`）即可自动接入审批口令、多机器人认领、时间线同步和记忆归档。一对一且不希望跑零次回复修复轮的渠道，在 `routing` 里写 `autoFinal: true`（照 `src7/plugins/web-api/index.ts:490`）。
- **出站回话**：纯文字渠道直接调 `registerTextReply`（`src7/plugins/channels/TextReply.ts:49`）交一个 `sendDirectText` 回调（自动获得幂等重放与 `channel/replied` 回执）；需要自定义富媒体或附件协议的，照 `FeishuReply`（`src7/plugins/feishu/Reply.ts:65`）自己 `ctx.on('channel/reply', ...)` 标 `request.handled = true` 后调 `emitReplied`（`src7/plugins/channels/Reply.ts:354`）。
- **登记渠道名与入口**：在插件里调 `ctx.effect(() => ctx.bots.channel('<渠道名>'))`（照 `src7/plugins/web-api/index.ts:151`），把模块加进 `BUILT_IN`（`src7/plugins/Index.ts:82`）并在 `config.yaml` 的 `plugins` 段挂上（外部独立插件连 `Index.ts` 都不用改，直接在 `config.yaml` 写文件夹路径，`loadPlugin` 在 `src7/Main.ts:146` 动态加载）。

#### 2. 给模型加一个新工具

- 在你的插件 `inject` 里写上 `'tools'`，在 `apply` 里调 `ctx.tools.register`（`src7/Tools.ts:131`）：填好 JSON Schema 参数定义 `definition`、允许使用的会话种类 `sessionKinds`（如 `['front', 'work']`，小会话不给工具）、以及执行函数 `run(args, session, signal, callId)`。
- 参数不用在 `run` 里手写类型校验：`Tools.execute` 在 `src7/Tools.ts:220` 已经统一跑过 `piAi.validateToolArguments`。
- 如果这个工具允许群聊外人（`guest`）或协作者（`builder`）调用，再去 `Approval.onBeforeModel`（`src7/plugins/approval/index.ts:515`）核对角色工具白名单；默认外人会被自动摘除高权工具。

#### 3. 加一个新钩子（改提示词 / 审工具 / 加新口令 / 消息改道）

按你想介入的时机，对号选事件（全部在自己的插件里 `ctx.on(...)`，拔掉插件自动卸载）：

| 想做的事 | 挂哪个事件 | 改哪个字段（参考实现） |
|---|---|---|
| 往系统提示词塞上下文，或临时裁剪发给模型的历史 | `session/before-model`（`src7/Sessions.ts:697`） | `request.system.push(...)` 或改 `request.messages`（它是当步副本，不会弄脏 `sessions` 表原记录） |
| 代调模型或拦截模型不当回答 | `session/before-model` / `session/after-model`（`src7/Sessions.ts:719`） | 填 `request.answer`（代调），或设 `answered.stop = '原因'`（整轮喊停，不入对话） |
| 拦住某次危险工具调用，或直接停掉整轮 | `session/before-tool`（`src7/Tools.ts:187`） | 单次拒绝写 `gate.deny = '理由'`（模型能看到理由并换招）；整轮停写 `gate.stop = '理由'` |
| 给工具输出脱敏、截断或补附图 | `session/after-tool`（`src7/Sessions.ts:672`） | 改写 `done.outcome.text` 或 `done.outcome.images` |
| 加“暂停 5”这类消息级快捷口令 | `channel/direct` + `channel/mention`，传 `{ prepend: true }` | 照 `Approval.constructor`（`src7/plugins/approval/index.ts:458`），消费后写 `control.approvalHandled = true` |
| 把带特定前缀（如 `#报销`）的话改道进专用会话 | `bot/receive`（`src7/plugins/bots/index.ts:647`） | 把 `event.session` 填成你开的 `Session`，或完全吃掉写 `event.handled = true` |
| 回复发出前统一加落款，或旁听已发回执做统计 | `channel/reply`（改字） / `channel/replied`（只读统计） | 改字在渠道接单前改 `request.parts`；统计只听 `channel/replied` 读 `event.receipt.status` |

#### 4. 存新数据：扩会话字段 vs 建插件新表

- **跟单场会话走的状态**（比如某场会话绑定的工单号）：用 TypeScript 模块扩充 `declare module '../../Sessions.ts' { interface SessionMeta { ticketId?: string } }`，直接赋值 `session.row.ticketId = 'T100'` 再调 `session.save()`（`src7/Sessions.ts:760`）。它自动存进 `sessions.meta` JSON 列，且立刻能用 `ctx.sessions.find({ ticketId: 'T100' })`（`src7/Sessions.ts:453`）按字段反查，**零建表、零迁移**。
- **跨会话的独立业务表**（比如知识库、用量账单）：`inject` 写 `'db'` 和 `'resources'`，把建表/加列 SQL 登记进 `ctx.db.migrate(...)`（照 `src7/plugins/journal/index.ts:216`），读写直接用 `ctx.resources.db.query(...)`。

#### 5. 加新的 HTTP 接口或独立前端页面

- **新后端接口**：`inject` 写 `'http'`，在 `ctx.http.app` 上挂 `/api/<插件名>/...`。默认自带外网 Cookie 门禁与内网令牌保护；公开接口调 `ctx.http.allow('/api/...')`（`src7/plugins/http/index.ts:385`）；涉及改配置或替本人发话的接口，先查 `ctx.http.isVerified(request)`（`src7/plugins/http/index.ts:375`）。
- **新独立前端页**：在 `web/` 里多打一个 `<插件名>.html` 到 `dist/web/`，只要该插件在 `config.yaml` 的 `plugins` 段里启用，`registerStatic`（`src7/plugins/http/Static.ts:41`）在 `ready` 时自动把它挂到 `/<插件名>/`，后端一行路由代码都不用加。

---

## 自测题

1. 为什么 `Http.constructor` 不在构造时直接 `app.listen(30086)`，非要等 `Main.ts` 发出 `ready` 事件才先跑 `registerStatic`、再调 `listen`？

<details><summary>参考答案</summary>

两个原因：第一，Fastify 一旦调用 `listen` 开始监听端口，就不再允许继续往实例上注册新路由——必须等排在 `http` 后面的所有业务插件（`web-api`、`tutorial`、`settings` 等）在挂载阶段把各自的 `/api/*` 路由全部登记完；第二，`registerStatic` 里会遍历 `ctx.resources.config.plugins` 挂载 `/<插件名>/` 独立页面和 `GET /*` 兜底路由，放在 `ready` 里能确保所有具体路由都已就位，再一次性封口开张。

</details>

2. 内网配置在 `server.trusted_ips` 里的机器不带令牌访问网页时，能看聊天记录，但为什么不能冒充本人触发需要核验身份的操作？

<details><summary>参考答案</summary>

看 `Http.check`（`src7/plugins/http/index.ts:407–440`）：只有通过外网有效登录 Cookie（`pass_verified`）、本机直连（`isLocal`）、或带对有效令牌（`this.tokens.check`）这三条路，才会执行 `this.verified.add(request)`；而 `trustedIp` 分支（438–439 行）只是 `return undefined` 放行请求，**没有**把 `request` 放进 `this.verified`。下游如 `WebApi` 调 `ctx.http.isVerified(request)` 拿到的是 `false`。

</details>

3. 飞书收到一条私聊消息时，为什么不在 WebSocket 刚收到的第一行就写 `feishu_seen` 去重表，而要放到 `FeishuInbound.deliver` 里 `await protocol.emitInbound(...)` 之后才调 `markSeen`？

<details><summary>参考答案</summary>

防止崩溃丢消息。如果刚收到还没跑完 `bots` 的 `persistClaim` 事务入队就先写了 `feishu_seen`，一旦中途进程重启或抛错，这条消息既没进任何会话的 `resultQueue`，下次飞书重推时又会被 `feishu_seen` 当成已处理直接丢弃。放到 `emitInbound` 同步认领落盘之后再记 `feishu_seen`（即使前面挂掉重推，下游也有 `claimKey` 幂等兜底），两边合起来做到不丢不重。

</details>

4. 你在关口一 `session/before-model` 里为了省窗口删掉了 `request.messages` 前面的几条旧消息，会不会把数据库 `sessions` 表里的原始聊天记录也删掉？如果想给会话永久存一个自定义标记该调什么？

<details><summary>参考答案</summary>

不会删掉原记录。`Session.loop` 在 `src7/Sessions.ts:643` 构造 `request` 时写的是 `messages: [...this.row.messages]`（浅拷贝新数组），`context-fit` 等插件在关口一里替换或裁剪 `request.messages` 只影响当步发给模型的那一次请求，不动 `session.row.messages`。想给会话永久存自定义标记，直接改 `session.row.<字段名>` 后调 `session.save()`（`src7/Sessions.ts:760`），它会随 `meta` JSON 列一起通过 `INSERT OR REPLACE INTO sessions` 落盘。

</details>
