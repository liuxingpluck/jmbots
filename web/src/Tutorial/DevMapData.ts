/**
 * 新插件开发速查地图的数据：会话四关口、HTTP 启动骨架、数据读写断点、三类扩展的最小模板。
 * 每个源码位置都是 { file, line, mark }：mark 是那一行该有的一小段原文，
 * DevMapData.test.ts 读真实源码核对 mark 在 line 上下 3 行内，行号漂了测试就红。
 * 设计见 docs/开发进度/教程页_数据携带追踪与开发地图设计_20261121.md 第 2.2 节。
 */

/** 一个源码位置。 */
export interface DevAnchor {
  /** 相对项目根的文件路径。 */
  file: string;
  /** 行号，从 1 数。 */
  line: number;
  /** 这一行里该有的一小段原文，测试用它防漂移。 */
  mark: string;
}

/** 卡片里的一条：一句话说清楚，附上源码位置。 */
export interface DevItem {
  /** 标题，如事件名。 */
  title: string;
  /** 一两句人话：这里流转什么、能改什么。 */
  note: string;
  /** 源码位置，第一个是主位置。 */
  anchors: DevAnchor[];
}

/** 一张速查卡。 */
export interface DevCard {
  /** 卡片键，导航和锚点用。 */
  key: string;
  /** 卡片标题。 */
  title: string;
  /** 一句话说这张卡讲什么。 */
  summary: string;
  /** 卡里的条目。 */
  items: DevItem[];
  /** 可复制的最小模板代码；没有就是空字符串。 */
  template: string;
}


/** 关口钩子插件的最小模板。 */
const GATE_TEMPLATE = `import type * as cordis from 'cordis';

export const name = 'my-gate';
export const version = '1.0.0';
export const inject = ['resources', 'sessions'];

export function apply(ctx: cordis.Context): void {
  //M 关口一：调模型之前，改 request.system / tools / messages；写 request.stop 让会话停。
  ctx.on('session/before-model', (request) => {
    request.system.push('（这里加一段系统提示）');
  });

  //M 关口三：执行工具之前，写 gate.deny 只拦这一个工具。
  ctx.on('session/before-tool', (gate) => {
    if (gate.call.name !== 'shell') return;

    gate.deny = '这个插件不让跑 shell';
  });
}
`;

/** 新工具（服务型插件）的最小模板。 */
const TOOL_TEMPLATE = `import type * as cordis from 'cordis';
import * as piAi from '@earendil-works/pi-ai';

export const name = 'my-tool';
export const version = '1.0.0';
export const inject = ['resources', 'tools'];

export function apply(ctx: cordis.Context): void {
  //M 登记一个给模型用的工具：定义 + 哪类会话能用 + 怎么跑。
  ctx.tools.register({
    definition: {
      name: 'my_echo',
      description: '把收到的话原样交回',
      parameters: piAi.Type.Object({ text: piAi.Type.String() }),
    },
    sessionKinds: ['front', 'work'],
    async run(args) {
      return String(args.text);
    },
  });
}
`;

/** 新渠道插件的最小模板。 */
const CHANNEL_TEMPLATE = `import type * as cordis from 'cordis';
import * as protocol from '../channels/index.ts';

export const name = 'my-channel';
export const version = '1.0.0';
export const inject = ['resources', 'bots', 'sessions'];

export function apply(ctx: cordis.Context): void {
  //M 都挂完再连外部平台；收到一条就拼成标准 ChannelMessage 往里送。
  ctx.on('ready', () => {
    // 连上外部平台，收到消息时：
    // const message = { v: 1, messageId, channel: 'my-channel', chatType: 'p2p', sender, role, text, ... };
    // await protocol.emitInbound(ctx, message, true, control);
  });

  //M 回话：听 channel/reply，按 request.parts 发回外部，再发 channel/replied 报回执。
  ctx.on('channel/reply', (request) => {
    if (request.channel !== 'my-channel') return;
  });
}
`;

/** 新独立页插件（HTTP 路由 + 数据表 + 网页入口）的最小模板。 */
const PAGE_TEMPLATE = `import type * as cordis from 'cordis';

export const name = 'my-page';
export const version = '1.0.0';
export const inject = ['resources', 'http'];

export function apply(ctx: cordis.Context): void {
  //M 表走 db 插件的版本迁移，不自己 ALTER。
  ctx.get('db')?.migrate({ plugin: name, migrations: [{ version: 1, sql: 'CREATE TABLE ...' }] });

  //M 读接口直接回；写接口先过身份核验。
  ctx.http.app.get('/api/my-page/list', () => ({ ok: true, items: [] }));
  ctx.http.app.post('/api/my-page/save', async (request, reply) => {
    if (!ctx.http.isVerified(request)) return reply.code(403).send({ error: '要先核验身份' });

    return { ok: true };
  });
}
// 网页：web/my-page.html + web/src/MyPage/*，并在 web/Build.ts 的入口列表里加上这个 html。
// 登记：src7/plugins/Index.ts 静态 import 并写进插件表；同目录写 说明.md（版本号开头）。
`;


/** 全部速查卡，按页面上从上到下的顺序。 */
export const DEV_CARDS: DevCard[] = [
  {
    key: 'gates',
    title: '会话四关口',
    summary: '会话每一步都发这四个事件，挨个 await 听的插件；插件在这里改数据、拦工具、喊停。',
    items: [
      {
        title: '关口一 session/before-model · ChatRequest',
        note: '调模型之前。能改 system、tools、messages、model、thinking；写 stop 让会话停。',
        anchors: [
          { file: 'src7/Sessions.ts', line: 697, mark: "serial('session/before-model'" },
          { file: 'src7/plugins/context-fit/index.ts', line: 322, mark: "on('session/before-model'" },
          { file: 'src7/plugins/memory/index.ts', line: 157, mark: "on('session/before-model'" },
          { file: 'src7/plugins/approval/index.ts', line: 476, mark: "on('session/before-model'" },
        ],
      },
      {
        title: '关口二 session/after-model · AnsweredRequest',
        note: '模型回来之后。answer 里是正文、思考、工具调用和 usage；写 stop 丢掉这次回答。',
        anchors: [
          { file: 'src7/Sessions.ts', line: 719, mark: "serial('session/after-model'" },
        ],
      },
      {
        title: '关口三 session/before-tool · ToolGate',
        note: '执行工具之前。call 里有工具名和参数；写 deny 只拦这一个，写 stop 停整个会话。',
        anchors: [
          { file: 'src7/Tools.ts', line: 187, mark: "serial('session/before-tool'" },
          { file: 'src7/plugins/approval/index.ts', line: 481, mark: "on('session/before-tool'" },
        ],
      },
      {
        title: '关口四 session/after-tool · ToolDone',
        note: '工具跑完之后。能改 outcome（交回模型的文字、图片、isError）；写 stop 停这一轮。',
        anchors: [
          { file: 'src7/Sessions.ts', line: 672, mark: "serial('session/after-tool'" },
          { file: 'src7/plugins/bots/ChannelTools.ts', line: 73, mark: "on('session/after-tool'" },
        ],
      },
    ],
    template: GATE_TEMPLATE,
  },
  {
    key: 'http',
    title: 'HTTP 服务精简启动骨架',
    summary: '进程起来到端口能访问，只走这几行：骨架三个挨个挂，http 插件建 Fastify、挂鉴权、等 ready 再监听。',
    items: [
      {
        title: '骨架三个按顺序挂',
        note: 'Resources（目录、配置、数据库）→ Tools（工具表）→ Sessions（会话循环），挂一个等一个。',
        anchors: [
          { file: 'src7/Main.ts', line: 76, mark: 'resourcesModule.Resources' },
          { file: 'src7/Main.ts', line: 77, mark: 'toolsModule.Tools' },
          { file: 'src7/Main.ts', line: 78, mark: 'sessionsModule.Sessions' },
        ],
      },
      {
        title: '建 Fastify 实例',
        note: 'http 插件的构造函数里建 app，插件的路由都挂在 ctx.http.app 上。',
        anchors: [
          { file: 'src7/plugins/http/index.ts', line: 232, mark: 'fastify.default(' },
        ],
      },
      {
        title: '每个请求先过鉴权',
        note: 'onRequest 钩子：本机不查令牌，别的机器要带 server.token。',
        anchors: [
          { file: 'src7/plugins/http/index.ts', line: 241, mark: "addHook('onRequest'" },
        ],
      },
      {
        title: 'ready 之后挂静态页、开始监听',
        note: '所有插件都挂好才发 ready；先注册 dist/web 静态页，再定端口 listen，端口被占会隔一会儿重试。',
        anchors: [
          { file: 'src7/plugins/http/index.ts', line: 280, mark: 'registerStatic(this.ctx, this.app)' },
          { file: 'src7/plugins/http/index.ts', line: 495, mark: 'private async listen(' },
          { file: 'src7/plugins/http/index.ts', line: 512, mark: 'this.app.listen(' },
        ],
      },
    ],
    template: '',
  },
  {
    key: 'data',
    title: '数据读写 6 大核心断点',
    summary: '会话的数据都在 sessions 表：调试“数据什么时候落库、谁先知道”，在这 6 行下断点就够。',
    items: [
      {
        title: '① 读：按会话号取回',
        note: '取 meta 和完整对话数组，恢复成内存里的会话。',
        anchors: [
          { file: 'src7/Sessions.ts', line: 383, mark: 'SELECT meta, messages FROM sessions' },
        ],
      },
      {
        title: '② 写：save 落库',
        note: '对话一块、别的字段一块，各转 JSON，按主键整行覆盖。',
        anchors: [
          { file: 'src7/Sessions.ts', line: 771, mark: 'query.run(meta.id, metaJson, messagesJson)' },
        ],
      },
      {
        title: '③ 加一条消息：先进内存',
        note: 'append 先 push 进 row.messages，再 save，保证不丢。',
        anchors: [
          { file: 'src7/Sessions.ts', line: 780, mark: 'this.row.messages.push(message)' },
        ],
      },
      {
        title: '④ 加一条消息：再通知',
        note: '落库之后才发 session/new-message，journal、对话.md、网页时间线都听它。',
        anchors: [
          { file: 'src7/Sessions.ts', line: 782, mark: "emit('session/new-message'" },
        ],
      },
      {
        title: '⑤ 改状态：先改再存',
        note: 'change 记下原状态，改 state 和 reply，再 save。',
        anchors: [
          { file: 'src7/Sessions.ts', line: 793, mark: 'this.row.state = state' },
        ],
      },
      {
        title: '⑥ 改状态：通知带上原状态',
        note: '发 session/change(session, stateBefore)；做完时渠道插件据此发回复。',
        anchors: [
          { file: 'src7/Sessions.ts', line: 796, mark: "emit('session/change'" },
        ],
      },
    ],
    template: '',
  },
  {
    key: 'channel',
    title: '模板：新渠道',
    summary: '把外部平台的消息拼成标准 ChannelMessage 交给 emitInbound，回复听 channel/reply。',
    items: [
      {
        title: '渠道协议入口 emitInbound',
        note: '按私聊、@、旁听分别发 channel/direct、channel/mention、channel/listen，一条只发一个。',
        anchors: [
          { file: 'src7/plugins/channels/Message.ts', line: 280, mark: 'export async function emitInbound(' },
        ],
      },
      {
        title: '参考：飞书和命令行怎么送进来',
        note: '飞书在 Inbound 里拼好消息再送；命令行渠道最短，适合照着抄。',
        anchors: [
          { file: 'src7/plugins/feishu/Inbound.ts', line: 776, mark: 'protocol.emitInbound(this.ctx' },
          { file: 'src7/plugins/cli/index.ts', line: 195, mark: 'protocol.emitInbound(this.ctx' },
          { file: 'src7/plugins/feishu/index.ts', line: 1031, mark: "ctx.provide('feishu'" },
        ],
      },
    ],
    template: CHANNEL_TEMPLATE,
  },
  {
    key: 'tool',
    title: '模板：新工具',
    summary: '给模型加一个工具：在 apply 里 ctx.tools.register，写定义、哪类会话能用、怎么跑。',
    items: [
      {
        title: '参考：知识库的 kb_search',
        note: 'inject 里带上 tools，apply 里登记；参数用 piAi.Type 描述，run 交回给模型的文字。',
        anchors: [
          { file: 'src7/plugins/knowledge/Tools.ts', line: 68, mark: 'ctx.tools.register({' },
          {
            file: 'src7/plugins/knowledge/index.ts',
            line: 45,
            mark: "export const inject = ['resources', 'http', 'tools', 'db']",
          },
        ],
      },
    ],
    template: TOOL_TEMPLATE,
  },
  {
    key: 'page',
    title: '模板：新独立页插件',
    summary: '自己的 HTTP 接口 + 数据表 + 一个网页：参考 frpc（纯接口）和 knowledge（带表带网页）。',
    items: [
      {
        title: '参考：frpc 的入口和接口',
        note: '路由都写在 apply 里；写接口先 requireVerified。',
        anchors: [
          { file: 'src7/plugins/frpc/index.ts', line: 216, mark: 'export function apply(' },
          { file: 'src7/plugins/frpc/index.ts', line: 227, mark: "app.get('/api/frpc/status'" },
          { file: 'src7/plugins/frpc/index.ts', line: 233, mark: 'ctx.http.requireVerified(request' },
        ],
      },
      {
        title: '参考：knowledge 的表和网页入口',
        note: '表走 db 迁移；网页的 html 加进 web/Build.ts 入口；插件在 Index.ts 登记。',
        anchors: [
          { file: 'src7/plugins/knowledge/index.ts', line: 99, mark: 'ctx.db.migrate(knowledgeMigrations)' },
          { file: 'web/Build.ts', line: 271, mark: "'knowledge.html'" },
          { file: 'src7/plugins/Index.ts', line: 103, mark: "'knowledge': knowledge" },
        ],
      },
    ],
    template: PAGE_TEMPLATE,
  },
];


/**
 * 拼成 SourceToggle、SiteLink 认的“文件:行号”。
 * @param anchor 源码位置。
 */
export function getSite(anchor: DevAnchor): string {
  return `${anchor.file}:${String(anchor.line)}`;
}
