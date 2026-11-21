/**
 * 教程页「竖线全景」原生手机友好交互画布（/tutorial/?view=spine）：
 *   1. 顶部常驻图形图例栏：蓝圆角框 = 模块动作、黄菱形 = 事件（SVG 描边文字居中不碰斜边）、
 *      绿胶囊 = 写 SQLite 落盘（save()）、紫侧卡 = 外部模块插进来干活；
 *   2. 上段展示三大骨架怎么启动（Main.ts:73-78 → 按序挂插件 → ready → Http.listen(30086)）；
 *   3. 下段展示 Sessions 竖线主轴：最简消息「你好」从头到尾 + 可选工具循环支路；
 *   4. 点任意动作框、黄菱形、绿胶囊或紫侧卡，原地展开精炼说明 + file:line（SourceToggle 看真实源码 + SiteLink 跳 VS Code
 *      + CopySiteButton 复制 file:line 断点）。
 */
import { useCallback, useState, type JSX } from 'react';
import { SiteLink } from '../VscodeLink.tsx';
import { SourceToggle } from './Code.tsx';
import { CopySiteButton } from './PayloadDiff.tsx';
import { TutorialScrollContext } from './TutorialContext.tsx';
import './SpineCanvas.css';


/** 单个可定位的真实源码锚点。 */
export interface SpineAnchor {
  /** 源码文件:行号（供 SiteLink 与 SourceToggle 直接读取）。 */
  site: string;
  /** 那一行源码里一定有的一段字：SpineCanvas.test.ts 照它查行号漂没漂（上下 3 行内找得到才算对）。 */
  mark: string;
  /** 一句话说明这一行在干什么。 */
  why: string;
}

/** 主轴上的三类基础几何形状。 */
export type SpineShape = 'action' | 'event' | 'save';

/** 主轴单个可点击节点的数据。 */
export interface SpineNode {
  /** 节点唯一 ID（控制展开态）。 */
  id: string;
  /** 节点图形类别：动作蓝框、事件黄菱形、SQLite 绿胶囊。 */
  shape: SpineShape;
  /** 黄菱形顶上的小标签（如「事件 emit」「关口一 · serial」），其他形状留空串。 */
  tag: string;
  /** 节点主标题（黄菱形内是事件名，绿胶囊内是 save 表达式，蓝框内是动作名）。 */
  title: string;
  /** 蓝框与绿胶囊展示的一行副标题；黄菱形为保持菱形内紧凑不在框内渲染它，展开后完整显示。 */
  subtitle: string;
  /** 点击展开后的精炼人话说明。 */
  detail: string;
  /** 关联的真实源码位置清单。 */
  anchors: SpineAnchor[];
}

/** 挂在主轴节点旁边的紫色外部模块侧卡。 */
export interface SpineSideCard {
  /** 侧卡唯一 ID（独立支持点击展开源码）。 */
  id: string;
  /** 紫色模块角标（如「外部插件 · inject」「bots 认领」）。 */
  badge: string;
  /** 侧卡主标题。 */
  title: string;
  /** 侧卡表面直接展示的要点短句（手机一眼扫清谁插进来干了什么）。 */
  points: string[];
  /** 点击侧卡展开后的完整说明。 */
  detail: string;
  /** 侧卡对应的插件源码锚点。 */
  anchors: SpineAnchor[];
}

/** 竖线主轴上的一行：普通行（带可选紫侧卡）或可选工具循环支路框。 */
export type SpineTrackStep =
  | {
    /** 普通主轴行。 */
    kind: 'row';
    /** 行唯一键。 */
    key: string;
    /** 主轴节点。 */
    node: SpineNode;
    /** 可选的外部模块紫侧卡。 */
    side?: SpineSideCard;
    /** 连往下一行的箭头旁注（无旁注留空串）。 */
    arrowNote: string;
  }
  | {
    /** 可选工具循环支路虚线容器。 */
    kind: 'tool-loop';
    /** 行唯一键。 */
    key: string;
    /** 支路标题。 */
    badge: string;
    /** 最简消息跳过提示。 */
    skipText: string;
    /** 支路内部按顺序串联的三个可点击节点（before-tool → Tools.execute → after-tool）。 */
    steps: SpineNode[];
    /** 支路底部的回环说明胶囊。 */
    loopBackText: string;
    /** 连往下一行的箭头旁注。 */
    arrowNote: string;
  };


//==========================================================
//M 上段数据：三大骨架怎么启动（Main.ts:73-78）
//==========================================================

/** 上段：从 new Context() 到 Http.listen(30086) 的完整启动竖线。 */
export const BOOT_SPINE_STEPS: SpineTrackStep[] = [
  {
    kind: 'row',
    key: 'boot-ctx',
    arrowNote: '挂一个等一个，先后不换',
    node: {
      id: 'boot-ctx-node',
      shape: 'action',
      tag: '',
      title: 'new cordis.Context()',
      subtitle: '校验启动参数后建空总控容器 app',
      detail: '入口先调 checkArgs 校验命令行与运行时目录，再新建唯一的 cordis.Context 容器 app；'
        + '它自身不带业务，只负责托管服务注入与事件派发。',
      anchors: [
        { site: 'src7/Main.ts:72', mark: 'checks.checkArgs(argv)', why: '入口只做一次命令行参数校验，算出 dataDir 与剩余参数' },
        { site: 'src7/Main.ts:73', mark: 'new cordis.Context()', why: '创建全局唯一的 Cordis 上下文容器 app' },
      ],
    },
  },
  {
    kind: 'row',
    key: 'boot-resources',
    arrowNote: '',
    node: {
      id: 'boot-resources-node',
      shape: 'action',
      tag: '',
      title: '① 挂 Resources',
      subtitle: '读 config.yaml · 开 SQLite (jmbots7.db) · 建 pi 供应商',
      detail: '第一个挂上的骨架服务（ctx.resources）：读取并校验 config.yaml，以 WAL 模式打开 data/jmbots7.db，'
        + '并向 pi-ai 注册配置好的各家模型供应商，同时监听配置热更新。',
      anchors: [
        { site: 'src7/Main.ts:76', mark: 'resourcesModule.Resources', why: 'await 挂上第一个骨架 Resources' },
        {
          site: 'src7/Resources.ts:203',
          mark: 'constructor(ctx: cordis.Context, config: ResourcesConfig)',
          why: 'Resources 构造函数：注册 ctx.resources 服务并读入配置快照',
        },
        { site: 'src7/Resources.ts:213', mark: 'new Database(dbFile', why: '打开运行时 SQLite 数据库 jmbots7.db 并启用 WAL' },
      ],
    },
  },
  {
    kind: 'row',
    key: 'boot-tools',
    arrowNote: '',
    node: {
      id: 'boot-tools-node',
      shape: 'action',
      tag: '',
      title: '② 挂 Tools',
      subtitle: '建空工具登记表 ctx.tools（自身不带任何业务工具）',
      detail: '第二个挂上的骨架服务（ctx.tools）：只管一张工具登记表，提供 register 登记、'
        + 'listToolsForSessionKind 按会话种类取清单、execute 过关口三执行工具。',
      anchors: [
        { site: 'src7/Main.ts:77', mark: 'toolsModule.Tools', why: 'await 挂上第二个骨架 Tools' },
        { site: 'src7/Tools.ts:122', mark: 'constructor(ctx: cordis.Context)', why: 'Tools 构造函数：把自身挂为 ctx.tools 服务' },
        { site: 'src7/Tools.ts:131', mark: 'register(spec: ToolSpec)', why: 'register：业务插件往这张表登记工具，拔掉插件自动撤回' },
      ],
    },
  },
  {
    kind: 'row',
    key: 'boot-sessions',
    arrowNote: '三大骨架就位',
    node: {
      id: 'boot-sessions-node',
      shape: 'action',
      tag: '',
      title: '③ 挂 Sessions',
      subtitle: '注入 resources + tools · 建 sessions 表 · 管会话主循环',
      detail: '第三个挂上的骨架服务（ctx.sessions）：依赖前两个骨架，确保 SQLite 里有 sessions(id, meta, messages) 表，'
        + '负责会话新建、打开缓存、四关口主循环与统一调模型 Sessions.chat。',
      anchors: [
        { site: 'src7/Main.ts:78', mark: 'sessionsModule.Sessions', why: 'await 挂上第三个骨架 Sessions' },
        {
          site: 'src7/Sessions.ts:325',
          mark: 'constructor(ctx: cordis.Context)',
          why: 'Sessions 构造函数：建 sessions 表并挂为 ctx.sessions',
        },
        {
          site: 'src7/Sessions.ts:344',
          mark: 'create(input: NewSession)',
          why: 'Sessions.create：新建会话并落库记入 openedSessions',
        },
      ],
    },
  },
  {
    kind: 'row',
    key: 'boot-plugins',
    arrowNote: '配置插件均已发起挂载',
    node: {
      id: 'boot-plugins-node',
      shape: 'action',
      tag: '',
      title: '④ 按序挂业务插件',
      subtitle: '照 config.yaml 的 plugins 顺序逐个 loadPlugin + app.plugin',
      detail: '遍历启用的插件清单，先从内置表或外部目录加载模块，记下它声明的 inject 依赖并调用 app.plugin 挂载；'
        + '单个插件超时不挡后续插件，缺失依赖记入 pluginStatus 供健康检查和教程页直读。',
      anchors: [
        { site: 'src7/Main.ts:136', mark: 'for (const entry of entries)', why: '按 config.yaml 顺序逐个发起插件挂载并限时等待' },
        {
          site: 'src7/Main.ts:150',
          mark: 'app.plugin(plugin, entry.config)',
          why: 'app.plugin(plugin, entry.config) 挂载并跟踪 fiber 状态',
        },
        {
          site: 'src7/plugins/Index.ts:134',
          mark: 'export async function loadPlugin(',
          why: 'loadPlugin：先查内置插件表，再按运行时目录加载外部插件',
        },
      ],
    },
    side: {
      id: 'boot-plugins-side',
      badge: '紫侧卡 · 业务插件零直接 import',
      title: '各插件按 inject 找骨架与服务',
      points: [
        '找 Resources：inject 写 resources → 读 ctx.resources.config / db',
        '找 Tools：inject 写 tools → 调 ctx.tools.register 登记工具',
        '找 Sessions：inject 写 sessions → 调 ctx.sessions 或听关口事件',
        '找 http：inject 写 http → 往 ctx.http.app 挂路由（先不 listen）',
      ],
      detail: '业务插件之间绝不直接 import 对方实现：要用底层能力就在 inject 数组声明服务名从 ctx 上拿，'
        + '要别的插件帮忙就只发事件、等回执事件，拔掉任意业务插件都不会拖垮骨架。',
      anchors: [
        {
          site: 'src7/plugins/http/index.ts:32',
          mark: 'export const inject',
          why: 'http 插件只注入 resources，对外提供 ctx.http 服务',
        },
        {
          site: 'src7/plugins/knowledge/Tools.ts:70',
          mark: "name: 'kb_search'",
          why: 'knowledge 插件通过 ctx.tools.register 登记 kb_search',
        },
        {
          site: 'src7/plugins/bots/index.ts:84',
          mark: 'export const inject',
          why: 'bots 插件声明 inject: resources / sessions / tools / workspaces',
        },
        {
          site: 'src7/plugins/web-api/index.ts:58',
          mark: 'export const inject',
          why: 'web-api 注入 http 往 ctx.http.app 登记全部 /api/* 路由',
        },
      ],
    },
  },
  {
    kind: 'row',
    key: 'boot-ready',
    arrowNote: '触发各渠道与 HTTP 开工',
    node: {
      id: 'boot-ready-node',
      shape: 'event',
      tag: '事件 emit',
      title: 'ready',
      subtitle: '广播全员开工，并续跑上次未完的 running 会话',
      detail: '所有配置的插件都发起挂载后，Main.ts 发出 ready 事件通知 http、feishu、wechat、cli 等正式接客；'
        + '紧接着查出数据库里上次停在 running 的会话自动调 run() 续跑。',
      anchors: [
        { site: 'src7/Main.ts:205', mark: "app.emit('ready'", why: "app.emit('ready', args.rest) 广播开工信号" },
        { site: 'src7/Main.ts:208', mark: "find({ state: 'running' })", why: '找出库里仍为 running 的会话自动 open(id).run() 续跑' },
      ],
    },
  },
  {
    kind: 'row',
    key: 'boot-listen',
    arrowNote: '',
    node: {
      id: 'boot-listen-node',
      shape: 'action',
      tag: '',
      title: 'Http.listen(30086)',
      subtitle: 'http 插件收到 ready → 挂 dist/web 静态页并监听端口',
      detail: 'Fastify 开始监听后就不能再加路由，所以 http 插件在 ready 回调里最后一步挂上静态网页托管，'
        + '再调用 app.listen 监听 0.0.0.0:30086（换版端口占用时自动重试等待）。',
      anchors: [
        { site: 'src7/plugins/http/index.ts:279', mark: "this.ctx.on('ready'", why: '监听 ready 事件：先挂静态页再启动端口监听' },
        { site: 'src7/plugins/http/index.ts:495', mark: 'private async listen(', why: 'Http.listen：解析端口并带端口占用重试保护' },
        {
          site: 'src7/plugins/http/index.ts:512',
          mark: 'this.app.listen({',
          why: 'this.app.listen({ host, port }) 正式对外提供服务',
        },
      ],
    },
  },
];


//==========================================================
//M 下段数据：Sessions 竖线主轴（最简消息「你好」从头到尾）
//==========================================================

/** 下段：最简消息「你好」从渠道进来到用户收到回复的完整竖线主轴。 */
export const SESSION_SPINE_STEPS: SpineTrackStep[] = [
  {
    kind: 'row',
    key: 'msg-entry',
    arrowNote: 'emitInbound 送进渠道协议',
    node: {
      id: 'msg-entry-node',
      shape: 'action',
      tag: '',
      title: '入口 · web-api / feishu',
      subtitle: '收到用户「你好」→ 校验入参、拼成标准 ChannelMessage',
      detail: '网页 POST /api/message（web-api）或飞书长连接（feishu）接住「你好」，先记入本渠道收件表或流水，'
        + '再组装统一的 ChannelMessage 交给 protocol.emitInbound。',
      anchors: [
        {
          site: 'src7/plugins/web-api/index.ts:480',
          mark: 'this.timeline.insert(newMessage)',
          why: 'web-api 先写入 web_messages 拿到消息号 id',
        },
        {
          site: 'src7/plugins/channels/Message.ts:280',
          mark: 'export async function emitInbound(',
          why: 'emitInbound：按私聊/@/旁听统一发出标准入站事件',
        },
        {
          site: 'src7/plugins/feishu/Inbound.ts:776',
          mark: 'protocol.emitInbound(this.ctx, channelMessage',
          why: '飞书长连接收消息同样汇聚到 protocol.emitInbound',
        },
      ],
    },
  },
  {
    kind: 'row',
    key: 'msg-direct',
    arrowNote: '排入前台队列并唤醒会话',
    node: {
      id: 'msg-direct-node',
      shape: 'event',
      tag: '渠道事件',
      title: 'channel/direct',
      subtitle: '私聊入站事件发出，交给机器人插件认领去向',
      detail: '一对一网页或私聊消息触发 channel/direct；骨架完全不知道渠道存在，由监听该事件的 bots 插件接手分派。',
      anchors: [
        {
          site: 'src7/plugins/channels/Message.ts:280',
          mark: 'export async function emitInbound(',
          why: '私聊消息在这里发出 channel/direct 事件',
        },
        {
          site: 'src7/plugins/bots/index.ts:588',
          mark: 'private async onChannelMessage(',
          why: 'Bots.onChannelMessage 统一接住入站渠道消息',
        },
      ],
    },
    side: {
      id: 'msg-direct-side',
      badge: '紫侧卡 · bots 认领路由',
      title: 'bots.route 认领并绑定回话地址',
      points: [
        '先发 bot/receive 问有无插件（relay / approval）抢单',
        '无人抢单 → FrontDesk 按客户域找到或新建前台 Session',
        '开跑前调 bots.route 把渠道与回话地址存进会话记录',
      ],
      detail: 'Bots 按目标机器人逐一问过 bot/receive 后，交给前台单队列持久化保存来源快照；'
        + 'startQueuedUser 调用 bots.route 更新 row.channel / address，再 queueUserMessage 并调 session.run()。',
      anchors: [
        {
          site: 'src7/plugins/bots/index.ts:646',
          mark: "serial('bot/receive'",
          why: "serial('bot/receive') 给外部认领插件留出优先接管口",
        },
        {
          site: 'src7/plugins/bots/DispatchClaim.ts:94',
          mark: 'async claimChannelMessage(',
          why: 'claimChannelMessage：定位前台会话并去重入队',
        },
        {
          site: 'src7/plugins/bots/index.ts:948',
          mark: 'route(session: Session, origin: Origin)',
          why: 'Bots.route：把回话渠道、地址与客户号写进会话并落库',
        },
        {
          site: 'src7/plugins/bots/DispatchResults.ts:935',
          mark: 'this.home.bots.route(session, said.origin)',
          why: 'startQueuedUser：切换回话地址、入队文本并唤醒 run()',
        },
      ],
    },
  },
  {
    kind: 'row',
    key: 'msg-run',
    arrowNote: '',
    node: {
      id: 'msg-run-node',
      shape: 'action',
      tag: '',
      title: '① Session.run()',
      subtitle: '建本轮 AbortController 防重入，启动 Session.loop 循环',
      detail: '进入骨架 src7/Sessions.ts 主线！若 this.aborter 已存在说明正在转，直接返回防重入；'
        + '否则建本轮取消开关、改状态为 running，进入不限步数的 Session.loop。',
      anchors: [
        {
          site: 'src7/Sessions.ts:581',
          mark: 'async run(): Promise<void>',
          why: 'Session.run：防重入守卫、建 aborter、异常兜底与尾消息续转',
        },
        { site: 'src7/Sessions.ts:613', mark: 'private async loop(', why: 'Session.loop：一步 = 调一次模型 + 执行它要求的工具' },
      ],
    },
  },
  {
    kind: 'row',
    key: 'msg-save-running',
    arrowNote: '',
    node: {
      id: 'msg-save-running-node',
      shape: 'save',
      tag: '',
      title: "change('running') → save()",
      subtitle: 'SQLite 落盘：状态改 running 写进 sessions 表，并发 session/change',
      detail: '开跑先把 row.state 改成 running、清空旧 reply，立即整行写入 SQLite sessions 表，再发 session/change；'
        + '即使进程中途断电，下次启动也能凭 running 状态自动续跑。',
      anchors: [
        { site: 'src7/Sessions.ts:588', mark: "this.change('running'", why: "run() 开头调用 this.change('running', '')" },
        {
          site: 'src7/Sessions.ts:790',
          mark: 'private change(state',
          why: 'Session.change：改状态、调 save() 落库、发 session/change',
        },
        { site: 'src7/Sessions.ts:760', mark: 'save(): void', why: 'Session.save：拆成 meta 与 messages 两列写入 SQLite' },
      ],
    },
  },
  {
    kind: 'row',
    key: 'msg-save-user',
    arrowNote: '',
    node: {
      id: 'msg-save-user-node',
      shape: 'save',
      tag: '',
      title: 'append(user) → save()',
      subtitle: 'SQLite 落盘：把排队的用户消息「你好」接进对话并存库',
      detail: '每步循环开头把 inbox 里暂存的用户消息全部取出，push 进 row.messages 后立即调 save() 落盘，'
        + '再发出 session/new-message 让 journal、memory、网页时间线同步记录。',
      anchors: [
        { site: 'src7/Sessions.ts:632', mark: 'this.inbox.splice(0)', why: '循环开头把 inbox 里的待接入消息逐条 append 进对话' },
        {
          site: 'src7/Sessions.ts:778',
          mark: 'private append(message',
          why: 'Session.append：先入内存并 save() 落库，再发 session/new-message',
        },
        {
          site: 'src7/Sessions.ts:769',
          mark: 'INSERT OR REPLACE INTO sessions',
          why: 'INSERT OR REPLACE INTO sessions 持久化最新对话数组',
        },
      ],
    },
  },
  {
    kind: 'row',
    key: 'msg-chat-req',
    arrowNote: '',
    node: {
      id: 'msg-chat-req-node',
      shape: 'action',
      tag: '',
      title: '② 备 ChatRequest',
      subtitle: '装配 model / thinking / 空 system[] / 可用 tools[] / messages 副本',
      detail: '骨架按会话当前 model、thinking、空 system 数组、ctx.tools 按会话种类筛出的工具定义，'
        + '以及 row.messages 的浅拷贝拼出本步 ChatRequest（插件裁剪副本不改动库里原记录）。',
      anchors: [
        {
          site: 'src7/Sessions.ts:637',
          mark: 'const request: ChatRequest = {',
          why: '构造本步 ChatRequest 请求对象交给 getStepAnswer',
        },
        {
          site: 'src7/Tools.ts:154',
          mark: 'listToolsForSessionKind(kind',
          why: 'listToolsForSessionKind：按 front/work 等会话种类筛选可用工具',
        },
      ],
    },
  },
  {
    kind: 'row',
    key: 'msg-before-model',
    arrowNote: '带着加工完的 request 调模型',
    node: {
      id: 'msg-before-model-node',
      shape: 'event',
      tag: '关口一 · serial',
      title: 'session/before-model',
      subtitle: '调模型前串行交给各插件加工提示词、上下文与工具',
      detail: '按插件挂载顺序逐个 await 监听函数：可往 request.system 加提示词、裁剪或注入 request.messages、'
        + '预填 request.answer 跳过真调模型，或写 request.stop 直接停下本轮。',
      anchors: [
        {
          site: 'src7/Sessions.ts:697',
          mark: "serial('session/before-model'",
          why: "await this.ctx.serial('session/before-model', request)",
        },
        {
          site: 'src7/Sessions.ts:59',
          mark: "'session/before-model'(request",
          why: 'session/before-model 事件契约与全部监听方清单',
        },
      ],
    },
    side: {
      id: 'msg-before-model-side',
      badge: '紫侧卡 · 业务插件齐聚关口一',
      title: 'bots / memory / knowledge / context-fit',
      points: [
        'bots：FrontDesk 拼近期往来，Prompt 注入底座 + 人设 + 记忆',
        'memory：按说话人权限召回相关记忆片段补进上下文',
        'knowledge：已向 Tools 登记 kb_search 随 request.tools 提供',
        'context-fit：窗口超限时自动压缩裁剪 messages 副本',
      ],
      detail: '骨架自身不拼一句提示词、不管记忆也不管上下文长度——全靠业务插件在关口一各自往 ChatRequest 里添砖加瓦。',
      anchors: [
        {
          site: 'src7/plugins/bots/FrontDesk.ts:61',
          mark: "this.ctx.on('session/before-model'",
          why: 'FrontDesk 注入最近 N 条前台往来与历史检索提示',
        },
        {
          site: 'src7/plugins/bots/Prompt.ts:71',
          mark: "this.ctx.on('session/before-model'",
          why: 'Prompt 按序拼入底座、功能声明、人设与记忆文件',
        },
        {
          site: 'src7/plugins/memory/index.ts:155',
          mark: "ctx.on('session/before-model'",
          why: 'memory 在关口一按权限召回记忆注入本步请求',
        },
        {
          site: 'src7/plugins/knowledge/Tools.ts:70',
          mark: "name: 'kb_search'",
          why: 'knowledge 登记 kb_search 供模型按需检索知识库',
        },
        {
          site: 'src7/plugins/context-fit/index.ts:322',
          mark: "ctx.on('session/before-model'",
          why: 'context-fit 检查窗口预算并裁剪/压缩历史副本',
        },
      ],
    },
  },
  {
    kind: 'row',
    key: 'msg-call-model',
    arrowNote: '拿到 AssistantMessage 回答',
    node: {
      id: 'msg-call-model-node',
      shape: 'action',
      tag: '',
      title: '③ getStepAnswer 调模型',
      subtitle: 'Sessions.chat(request) 经 pi-ai 请求供应商拿回「你好！…」',
      detail: '若关口一没有插件预填 answer，骨架调用 ctx.sessions.chat(request) 经 @earendil-works/pi-ai 发请求，'
        + '内置临时错误指数退避重试，单次失败还会广播 session/model-failed 供统计与换模感知。',
      anchors: [
        {
          site: 'src7/Sessions.ts:689',
          mark: 'private async getStepAnswer(',
          why: 'Session.getStepAnswer：串联关口一、模型请求与关口二',
        },
        {
          site: 'src7/Sessions.ts:713',
          mark: 'this.ctx.sessions.chat(request)',
          why: '调用 this.ctx.sessions.chat(request) 发起真实模型请求',
        },
        {
          site: 'src7/Sessions.ts:477',
          mark: 'async chat(request: ChatRequest)',
          why: 'Sessions.chat：拼 pi-ai Context、重试策略与失败通知',
        },
      ],
    },
    side: {
      id: 'msg-after-model-side',
      badge: '紫侧卡 · 关口二 + model-catalog',
      title: '◇ 关口二 session/after-model 验回答',
      points: [
        'model-catalog：排关口一末尾管并发名额与限流自动换备用模型',
        '回答入库前串行发 session/after-model（AnsweredRequest）',
        '插件可审查或替换 answer，写 stop 则丢弃回答并停下本轮',
      ],
      detail: '模型返回后、写进 row.messages 之前必过关口二 session/after-model；'
        + '若写 answered.stop，本次回答连同里面要求的工具调用全部作废，确保把关插件拥有最终否决权。',
      anchors: [
        {
          site: 'src7/Sessions.ts:719',
          mark: "serial('session/after-model'",
          why: "await this.ctx.serial('session/after-model', answered)",
        },
        {
          site: 'src7/Sessions.ts:67',
          mark: "'session/after-model'(request",
          why: 'session/after-model 事件契约与 AnsweredRequest 说明',
        },
        {
          site: 'src7/plugins/model-catalog/Fallback.ts:263',
          mark: 'request.answer = await this.attempt(request, model)',
          why: 'ModelFallback：限流或超长时自动切备用模型重发',
        },
      ],
    },
  },
  {
    kind: 'row',
    key: 'msg-save-assistant',
    arrowNote: '检查 answer 里的 toolCall',
    node: {
      id: 'msg-save-assistant-node',
      shape: 'save',
      tag: '',
      title: 'append(assistant) → save()',
      subtitle: 'SQLite 落盘：模型回答写入 sessions 表，并发 session/new-message',
      detail: '通过关口二的 AssistantMessage 先落库保存并通知用量与日志插件（Usage 统计 token），'
        + '接着从 answer.content 里筛出 type === "toolCall" 的调用块决定是否走工具支路。',
      anchors: [
        { site: 'src7/Sessions.ts:651', mark: 'this.append(answer)', why: 'this.append(answer) 把模型回答持久化进 sessions 表' },
        { site: 'src7/Sessions.ts:657', mark: 'getToolCalls(answer)', why: '筛选 answer.content 里的 toolCall 判断要不要跑工具' },
      ],
    },
  },
  {
    kind: 'tool-loop',
    key: 'msg-tool-branch',
    badge: '↺ 可选工具循环支路（calls.length > 0 时逐个执行）',
    skipText: '「你好」calls 为空 → 直接跳过支路往下收尾 ↓',
    loopBackText: '每个工具结果 append(toolResult) → save() 后，回到第 ② 步再调模型',
    arrowNote: 'calls.length === 0（无需调工具）',
    steps: [
      {
        id: 'loop-before-tool',
        shape: 'event',
        tag: '关口三 · serial',
        title: 'session/before-tool',
        subtitle: '执行单个工具前交 approval 等插件把关',
        detail: 'Tools.execute 开头串行发出关口三：插件写 gate.deny 只拦当前这一个工具（理由当结果喂回模型继续走），'
          + '写 gate.stop 则整场会话立刻停下。',
        anchors: [
          {
            site: 'src7/Tools.ts:187',
            mark: "serial('session/before-tool'",
            why: "await this.ctx.serial('session/before-tool', gate)",
          },
          {
            site: 'src7/plugins/approval/index.ts:481',
            mark: "ctx.on('session/before-tool'",
            why: 'approval 在关口三拦截高风险命令等待用户批准',
          },
        ],
      },
      {
        id: 'loop-tools-exec',
        shape: 'action',
        tag: '',
        title: 'Tools.execute → spec.run()',
        subtitle: 'Tools 骨架校验参数后调用插件登记的工具实现',
        detail: '用 piAi.validateToolArguments 按 TypeBox schema 校验外部模型入参，通过后调用对应插件注册的 spec.run；'
          + '抛错也不崩循环，统一包装成 isError: true 的 ToolOutcome 交回模型判断。',
        anchors: [
          { site: 'src7/Tools.ts:170', mark: 'async execute(', why: 'Tools.execute 完整把关、参数校验与异常捕获流程' },
          {
            site: 'src7/Tools.ts:220',
            mark: 'validateToolArguments',
            why: '校验参数并执行 spec.run(args, session, signal, call.id)',
          },
        ],
      },
      {
        id: 'loop-after-tool',
        shape: 'event',
        tag: '关口四 · serial',
        title: 'session/after-tool',
        subtitle: '工具结果入库前允许插件改写 outcome 或写 stop 停轮',
        detail: '工具跑完（含被 deny 拦下）后串行发出关口四，插件可改写 done.outcome；'
          + '随后包装成 role: "toolResult" 消息调 append(result) → save() 落盘，回到循环顶部继续下一步。',
        anchors: [
          {
            site: 'src7/Sessions.ts:672',
            mark: "serial('session/after-tool'",
            why: "await this.ctx.serial('session/after-tool', done)",
          },
          {
            site: 'src7/Sessions.ts:677',
            mark: 'this.append(result)',
            why: 'this.append(result) 把 toolResult 落库配对并进入下一轮模型步',
          },
        ],
      },
    ],
  },
  {
    kind: 'row',
    key: 'msg-save-done',
    arrowNote: 'session/change 唤醒渠道回发',
    node: {
      id: 'msg-save-done-node',
      shape: 'save',
      tag: '',
      title: "④ change('done') → save()",
      subtitle: 'SQLite 落盘：提取最终回复写进 row.reply，状态改 done 落库',
      detail: '「你好」无需调用工具（calls.length === 0），提取模型回答纯文本写入 row.reply，'
        + '将状态改为 done 落盘保存，并发出 session/change(session, "running") 宣告本轮完成。',
      anchors: [
        { site: 'src7/Sessions.ts:660', mark: 'calls.length === 0', why: 'calls.length === 0 分支：模型不再要工具，本轮完成' },
        {
          site: 'src7/Sessions.ts:662',
          mark: "this.change('done'",
          why: "this.change('done', reply) 写库并广播 session/change",
        },
        {
          site: 'src7/Sessions.ts:796',
          mark: "emit('session/change'",
          why: "emit('session/change', this, stateBefore) 通知外部收尾",
        },
      ],
    },
  },
  {
    kind: 'row',
    key: 'msg-channel-reply',
    arrowNote: '收到 channel/replied 回执',
    node: {
      id: 'msg-channel-reply-node',
      shape: 'event',
      tag: '回话事件',
      title: 'channel/reply',
      subtitle: 'bots 自动兜底把最终回复按来源快照发往原渠道',
      detail: '一对一渠道（autoFinal）本轮未调 channel_reply 工具时，DispatchResults.sendLastWords 自动把 row.reply '
        + '拼成标准回复请求发出 channel/reply，并按 requestId 等待渠道返回 channel/replied 回执。',
      anchors: [
        {
          site: 'src7/plugins/bots/DispatchResults.ts:704',
          mark: 'private async sendLastWords(',
          why: 'sendLastWords：一对一渠道零次回复自动发最终正文',
        },
        {
          site: 'src7/plugins/channels/Reply.ts:194',
          mark: "requestEvent(ctx, 'channel/reply'",
          why: 'requestChannelReply：发 channel/reply 并等 channel/replied',
        },
      ],
    },
    side: {
      id: 'msg-channel-reply-side',
      badge: '紫侧卡 · web-api / feishu 回传',
      title: '渠道插件接单送达并回执归档',
      points: [
        'web-api 追加进 web_messages.replies（飞书调开放平台发消息）',
        '发送完成回传 channel/replied 幂等回执（status: sent）',
        'FrontDesk.onReplied 凭成功回执记入机器人往来归档',
      ],
      detail: '回话完全走统一事件协议：不管是网页轮询还是飞书卡片，渠道只认 channel/reply 干活、回 channel/replied 报账。',
      anchors: [
        {
          site: 'src7/plugins/web-api/index.ts:160',
          mark: 'protocol.registerTextReply(this.ctx',
          why: 'web-api 注册 registerTextReply 接单写入网页消息回话列表',
        },
        {
          site: 'src7/plugins/bots/FrontDesk.ts:119',
          mark: 'private onReplied(',
          why: 'FrontDesk.onReplied：仅在渠道回执成功时归档机器人回复',
        },
      ],
    },
  },
  {
    kind: 'row',
    key: 'msg-end',
    arrowNote: '',
    node: {
      id: 'msg-end-node',
      shape: 'action',
      tag: '',
      title: '结束 · 用户收到回复',
      subtitle: '发出 bot/settled 标回完 · 网页或飞书看到「你好！…」',
      detail: '队列收尾发出 bot/settled 通知网页把本条消息标为已回复完成；'
        + '整场 Session 静默留在 openedSessions 内存缓存里，等用户说下一句话时零开销接着聊。',
      anchors: [
        { site: 'src7/plugins/bots/index.ts:130', mark: "'bot/settled'(event", why: 'bot/settled 事件：通知网页与命令行本轮回复彻底收尾' },
        {
          site: 'src7/plugins/bots/DispatchResults.ts:742',
          mark: 'this.finishChannelFront(front, item)',
          why: 'finishChannelFront 完成本轮队列清理并触发 settled',
        },
      ],
    },
  },
];


//==========================================================
//M 交互渲染组件（严格图形渲染 + 原地展开源码抽屉）
//==========================================================

/**
 * 竖向主轴连接箭头。
 * @param props.note 可选的连线旁注。
 */
function SpineArrow(props: { note: string }): JSX.Element {
  return (
    <div className="tu-sp-arrow" aria-hidden="true">
      <span className="tu-sp-arrow-line" />
      <span className="tu-sp-arrow-tip">▼</span>
      {props.note !== '' && <span className="tu-sp-arrow-note">{props.note}</span>}
    </div>
  );
}


/**
 * 点击任意节点或紫侧卡后原地展开的说明与源码抽屉（复用 SiteLink + SourceToggle）。
 */
function SpineDetailDrawer(props: {
  title: string;
  detail: string;
  anchors: readonly SpineAnchor[];
  onClose: () => void;
}): JSX.Element {
  return (
    <div className="tu-sp-detail" role="region" aria-label={`${props.title} 源码说明`}>
      <div className="tu-sp-detail-head">
        <span className="tu-sp-detail-title">{props.title}</span>
        <button type="button" className="tu-sp-pill-btn" onClick={props.onClose}>收起 ▲</button>
      </div>
      <p className="tu-sp-detail-note">{props.detail}</p>
      <ul className="tu-sp-detail-anchors">
        {props.anchors.map((anchor) => (
          <li key={anchor.site}>
            <div className="tu-sp-anchor-bar">
              <SiteLink site={anchor.site} />
              <CopySiteButton site={anchor.site} />
              <SourceToggle site={anchor.site} label="看源码" />
            </div>
            <span className="tu-sp-anchor-why">{anchor.why}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}


/**
 * 按节点的严格几何类型（蓝圆角框 / 黄菱形 / 绿胶囊）渲染可点击按钮。
 */
function SpineNodeButton(props: {
  node: SpineNode;
  open: boolean;
  onToggle: (id: string) => void;
}): JSX.Element {
  const { node, open, onToggle } = props;
  let chev = '▾ 源码';
  if (open) {
    chev = '▴ 收起';
  }

  //M 黄菱形：使用 SVG polygon 绘制清晰斜边描边，配合宽内边距保证文字居中绝不碰斜边。
  if (node.shape === 'event') {
    let diamondClass = 'tu-sp-node-btn tu-sp-diamond';
    if (open) {
      diamondClass += ' open';
    }
    return (
      <button
        type="button"
        className={diamondClass}
        data-spine-node={node.id}
        data-spine-shape="event"
        aria-expanded={open}
        onClick={() => onToggle(node.id)}
      >
        <svg className="tu-sp-diamond-svg" viewBox="0 0 200 100" preserveAspectRatio="none" aria-hidden="true">
          <polygon points="100,3 197,50 100,97 3,50" vectorEffect="non-scaling-stroke" />
        </svg>
        {node.tag !== '' && <span className="tu-sp-diamond-tag">{node.tag}</span>}
        <code className="tu-sp-diamond-code">◇ {node.title}</code>
      </button>
    );
  }

  //M 绿胶囊：写 SQLite 落盘（save()）。
  if (node.shape === 'save') {
    let saveClass = 'tu-sp-node-btn tu-sp-save';
    if (open) {
      saveClass += ' open';
    }
    return (
      <button
        type="button"
        className={saveClass}
        data-spine-node={node.id}
        data-spine-shape="save"
        aria-expanded={open}
        onClick={() => onToggle(node.id)}
      >
        <span className="tu-sp-save-title">💾 {node.title}</span>
        <span className="tu-sp-save-sub">{node.subtitle}</span>
      </button>
    );
  }

  //M 蓝圆角框：模块动作（Action）。
  let actionClass = 'tu-sp-node-btn tu-sp-action';
  if (open) {
    actionClass += ' open';
  }
  return (
    <button
      type="button"
      className={actionClass}
      data-spine-node={node.id}
      data-spine-shape="action"
      aria-expanded={open}
      onClick={() => onToggle(node.id)}
    >
      <div className="tu-sp-node-top">
        <span className="tu-sp-action-title">{node.title}</span>
        <span className="tu-sp-chev">{chev}</span>
      </div>
      <span className="tu-sp-sub">{node.subtitle}</span>
    </button>
  );
}


/**
 * 渲染挂在主轴节点侧边的紫色外部模块卡片（自身同样可点开看插件源码锚点）。
 */
function SpineSideButton(props: {
  side: SpineSideCard;
  open: boolean;
  onToggle: (id: string) => void;
}): JSX.Element {
  const { side, open, onToggle } = props;
  let cardClass = 'tu-sp-node-btn tu-sp-side-card';
  if (open) {
    cardClass += ' open';
  }
  let chev = '▾ 源码';
  if (open) {
    chev = '▴ 收起';
  }
  return (
    <div className="tu-sp-side-cell">
      <span className="tu-sp-side-link" aria-hidden="true">←</span>
      <button
        type="button"
        className={cardClass}
        data-spine-node={side.id}
        data-spine-shape="side"
        aria-expanded={open}
        onClick={() => onToggle(side.id)}
      >
        <div className="tu-sp-node-top">
          <span className="tu-sp-side-badge">{side.badge}</span>
          <span className="tu-sp-chev">{chev}</span>
        </div>
        <span className="tu-sp-side-title">{side.title}</span>
        <ul className="tu-sp-side-points">
          {side.points.map((pt) => <li key={pt}>{pt}</li>)}
        </ul>
      </button>
    </div>
  );
}


/**
 * 渲染一整段竖线轨迹（启动上段或会话下段）。
 */
function SpineTrackView(props: {
  steps: readonly SpineTrackStep[];
  openIds: ReadonlySet<string>;
  onToggle: (id: string) => void;
}): JSX.Element {
  const { steps, openIds, onToggle } = props;
  return (
    <div className="tu-sp-track">
      {steps.map((step, index) => {
        const isLast = index === steps.length - 1;
        if (step.kind === 'tool-loop') {
          return (
            <div key={step.key} className="tu-sp-step-wrap">
              <div className="tu-sp-loop-box" data-spine-loop>
                <div className="tu-sp-loop-head">
                  <span className="tu-sp-loop-badge">{step.badge}</span>
                  <span className="tu-sp-loop-skip">{step.skipText}</span>
                </div>
                <div className="tu-sp-loop-track">
                  {step.steps.map((inner, innerIdx) => {
                    const innerOpen = openIds.has(inner.id);
                    const hasNextInner = innerIdx < step.steps.length - 1;
                    return (
                      <div key={inner.id} className="tu-sp-loop-item">
                        <SpineNodeButton node={inner} open={innerOpen} onToggle={onToggle} />
                        {innerOpen && (
                          <SpineDetailDrawer
                            title={inner.title}
                            detail={inner.detail}
                            anchors={inner.anchors}
                            onClose={() => onToggle(inner.id)}
                          />
                        )}
                        {hasNextInner && <SpineArrow note="" />}
                      </div>
                    );
                  })}
                </div>
                <div className="tu-sp-loop-back">{step.loopBackText}</div>
              </div>
              {!isLast && <SpineArrow note={step.arrowNote} />}
            </div>
          );
        }

        const nodeOpen = openIds.has(step.node.id);
        const side = step.side;
        const sideOpen = side !== undefined && openIds.has(side.id);
        let rowClass = 'tu-sp-row solo';
        if (side !== undefined) {
          rowClass = 'tu-sp-row';
        }
        return (
          <div key={step.key} className="tu-sp-step-wrap">
            <div className={rowClass}>
              <div className="tu-sp-main-cell">
                <SpineNodeButton node={step.node} open={nodeOpen} onToggle={onToggle} />
              </div>
              {side !== undefined && (
                <SpineSideButton side={side} open={sideOpen} onToggle={onToggle} />
              )}
            </div>
            {nodeOpen && (
              <SpineDetailDrawer
                title={step.node.title}
                detail={step.node.detail}
                anchors={step.node.anchors}
                onClose={() => onToggle(step.node.id)}
              />
            )}
            {side !== undefined && sideOpen && (
              <SpineDetailDrawer
                title={side.title}
                detail={side.detail}
                anchors={side.anchors}
                onClose={() => onToggle(side.id)}
              />
            )}
            {!isLast && <SpineArrow note={step.arrowNote} />}
          </div>
        );
      })}
    </div>
  );
}


/**
 * 「竖线全景」整屏交互画布。
 * @param props.onClose 关闭竖线全景返回原教程视图；由 TutorialPage 的 toggleSpine 传入。
 */
export function SpineCanvas(props: { onClose: () => void }): JSX.Element {
  const [openIds, setOpenIds] = useState<Set<string>>(() => new Set());
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);

  const toggleNode = useCallback((id: string): void => {
    //M 点击节点原地切换展开/收起，支持同时展开多处对比阅读。
    setOpenIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      next.add(id);
      return next;
    });
  }, []);

  const collapseAll = useCallback((): void => {
    setOpenIds(new Set());
  }, []);

  const jumpTo = (elementId: string): void => {
    //M 顶栏快捷胶囊平滑滚到对应主轴段落。
    document.getElementById(elementId)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="tu-sp" role="dialog" aria-label="竖线全景">
      <header className="tu-sp-top">
        <span className="tu-sp-brand">竖线全景 · 骨架与消息主轴</span>
        <nav className="tu-sp-jump-nav" aria-label="段落跳转">
          <button type="button" className="tu-sp-pill-btn" onClick={() => jumpTo('spine-boot')}>
            ① 三大骨架启动
          </button>
          <button type="button" className="tu-sp-pill-btn" onClick={() => jumpTo('spine-session')}>
            ② 消息「你好」主轴
          </button>
          {openIds.size > 0 && (
            <button type="button" className="tu-sp-pill-btn" onClick={collapseAll}>
              收起已展开 ({String(openIds.size)})
            </button>
          )}
        </nav>
        <button type="button" className="tu-sp-close" onClick={props.onClose}>关闭 ×</button>
      </header>

      <div className="tu-sp-legend" aria-label="图形图例">
        <span className="tu-sp-lg-item">
          <span className="tu-sp-lg-action" aria-hidden="true" />
          <span>蓝圆角框 = 模块动作（Action）</span>
        </span>
        <span className="tu-sp-lg-item">
          <svg className="tu-sp-lg-diamond" viewBox="0 0 24 16" aria-hidden="true">
            <polygon points="12,1.5 22.5,8 12,14.5 1.5,8" />
          </svg>
          <span>黄菱形 = 事件（Event emit）</span>
        </span>
        <span className="tu-sp-lg-item">
          <span className="tu-sp-lg-save" aria-hidden="true" />
          <span>绿胶囊 = 写 SQLite 落盘（save()）</span>
        </span>
        <span className="tu-sp-lg-item">
          <span className="tu-sp-lg-side" aria-hidden="true" />
          <span>紫侧卡 = 外部模块插进来干活（web-api / bots / model-catalog / Tools / 业务插件）</span>
        </span>
        <span className="tu-sp-lg-hint">点任意图形原地展开说明 + 看真实源码 / 跳 VS Code</span>
      </div>

      <div className="tu-sp-body" ref={setScrollEl}>
        <TutorialScrollContext.Provider value={scrollEl}>
          <div className="tu-sp-columns">
            <section className="tu-sp-section" id="spine-boot">
              <div className="tu-sp-sec-head">
                <h2>
                  <span>上段 · 三大骨架怎么启动</span>
                  <span className="tu-sp-sec-tag">Main.ts:73-78</span>
                </h2>
                <p className="tu-sp-sec-sub">
                  骨架只有 Main / Resources / Tools / Sessions 四个核心文件：先挂齐三大基础服务，再按序挂业务插件，最后发 ready 监听 30086。
                </p>
              </div>
              <SpineTrackView steps={BOOT_SPINE_STEPS} openIds={openIds} onToggle={toggleNode} />
            </section>

            <section className="tu-sp-section" id="spine-session">
              <div className="tu-sp-sec-head">
                <h2>
                  <span>下段 · Sessions 竖线主轴：最简消息「你好」从头到尾</span>
                  <span className="tu-sp-sec-tag">Sessions.ts</span>
                </h2>
                <p className="tu-sp-sec-sub">
                  骨架只推会话循环往前走、每次状态与消息变动立即 save() 落 SQLite；渠道收发、提示词、记忆、知识库与换模全从侧边事件插进来。
                </p>
              </div>
              <SpineTrackView steps={SESSION_SPINE_STEPS} openIds={openIds} onToggle={toggleNode} />
            </section>
          </div>
        </TutorialScrollContext.Provider>
      </div>
    </div>
  );
}
