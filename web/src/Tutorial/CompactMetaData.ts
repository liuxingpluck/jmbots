/**
 * 教程页「极限压缩认知架构（L0 → L1 → L2）」静态元模型数据。
 * 严格遵循人类 4~6 工作记忆组块红线：5 原子签子 + 3 条主连线 + 5 个 L0 大块 + 每块 ≤5 子角色 + 34/34 插件三行极简卡。
 * 由 CompactMetaView.tsx 渲染，并由 CompactMetaData.test.ts 强制核验全仓插件目录零遗漏与 ≤30 字防啰嗦红线。
 */

/** 骨架层的不可再分原子概念（= 糖葫芦的签子）。 */
export interface Atom {
  /** 原子唯一英文标识。 */
  id: string;
  /** 原子两字中文名。 */
  name: string;
  /** 一句 ≤30 字极简人话定义。 */
  line: string;
  /** 对应 src7 真实源码入口（相对仓库根的文件:行号）。 */
  site: string;
}


/** L0 大块之间的主干连接通道。 */
export interface Link {
  /** 通道短名（≤30 字）。 */
  name: string;
  /** 一句 ≤30 字说明谁和谁靠它连什么。 */
  line: string;
}


/** L1 单块展开后的正交子角色（每个子角色挂载 1~3 个真实插件目录名）。 */
export interface Role {
  /** 子角色中文短名（≤30 字）。 */
  name: string;
  /** 归属该子角色的 src7/plugins/ 真实插件目录名列表（1~3 个）。 */
  plugins: readonly string[];
}


/** L0 全局正交功能大块（全系统严格 ≤5 块）。 */
export interface Block {
  /** 大块唯一英文标识。 */
  id: string;
  /** 大块带序号短名（≤30 字）。 */
  name: string;
  /** 大块一句 ≤30 字核心定位。 */
  line: string;
  /** 单块展开后的 L1 子角色列表（严格 ≤6 个）。 */
  roles: readonly Role[];
}


/** L2 单插件三行极简卡片（每字段严格 ≤30 字，砍掉流水账噪音）。 */
export interface Card {
  /** 1 句人话职责（≤30 字）。 */
  duty: string;
  /** 挂在哪个关口、事件或服务（≤30 字）。 */
  hook: string;
  /** 与主链的进→出数据关系（≤30 字）。 */
  io: string;
}


/** 纵向渐进学习路线中的单个工作记忆小块（每块 3~5 个概念 + 最小闭环实验 + 10 秒自测）。 */
export interface StageChunk {
  /** 小块唯一编号（如 '1.1'）。 */
  id: string;
  /** 小块带编号短标题（如 '1.1 骨架'）。 */
  title: string;
  /** 本块包含的 3~5 个互不重叠核心概念。 */
  concepts: readonly string[];
  /** 复用的 src7/docs/组块阅读/ 下真实 .md 文件名列表。 */
  docs: readonly string[];
  /** 基于 fake-model 的一句话最小闭环离线实验（含失败分支）。 */
  lab: string;
  /** 点击展开的 10 秒掌握自测题。 */
  quiz: string;
}


/** 纵向渐进学习路线中的单个学习大段（全系统共 4 段，每段 ≤4 小块）。 */
export interface Stage {
  /** 大段唯一标识（如 'stage-1'）。 */
  id: string;
  /** 大段短标题（如 '第 1 段 · 看懂一条消息'）。 */
  title: string;
  /** 学完本段解锁的真实掌控力（金字塔结论先行）。 */
  unlock: string;
  /** 本段内按顺序编排的 ≤4 个工作记忆小块。 */
  chunks: readonly StageChunk[];
}


/** 洋葱圈架构的单层同心圆（圆心骨架核 + 3 层外扩插件环）。 */
export interface OnionRing {
  /** 圈层唯一英文标识（如 'core'、'ring-1'）。 */
  id: string;
  /** 圈层层级序号（0=圆心骨架核，1=底座与协议，2=调度与治理，3=外部触角）。 */
  level: 0 | 1 | 2 | 3;
  /** 圈层短名（≤30 字）。 */
  name: string;
  /** 圈层一句话数量与定位副标（≤30 字）。 */
  tagline: string;
  /** 圈层一句话职责说明（≤30 字）。 */
  summary: string;
  /** 本圈条目列表（圆心为骨架核心文件名，外圈为真实 src7/plugins/ 插件目录名）。 */
  items: readonly string[];
  /** 是否为圆心骨架核（0 插件，不计入 34 个插件并集）。 */
  isCore?: boolean;
}


/** 顶部常驻的一句话第一性原理元点（非单卡字段，完整凝练全系统运行本质）。 */
export const ORIGIN_MOTTO =
  '一句话进会话，模型⇄工具来回转到模型不再要工具，最后那句就是回话；每转一步都发事件，插件在事件上加料或拦截。';


/** 5 个不可再分原子概念（= 骨架签子）。 */
export const ATOMS: readonly Atom[] = [
  {
    id: 'resources',
    name: '资源',
    line: '配置+主库+模型供应商',
    site: 'src7/Resources.ts:159',
  },
  {
    id: 'sessions',
    name: '会话',
    line: '对话记录+模型⇄工具循环，4态',
    site: 'src7/Sessions.ts:525',
  },
  {
    id: 'tools',
    name: '工具',
    line: '按会话种类登记、校验并执行',
    site: 'src7/Tools.ts:114',
  },
  {
    id: 'events',
    name: '事件',
    line: '通知(emit)或排队可改(serial)',
    site: 'src7/utils/RequestEvent.ts:80',
  },
  {
    id: 'plugins',
    name: '插件',
    line: '独立目录，apply(ctx)里听事件登工具',
    site: 'src7/plugins/Index.ts:48',
  },
];


/** L0 大块之间仅有的 3 条主连接线（底座靠 inject 托底，不拉杂线）。 */
export const LINKS: readonly Link[] = [
  {
    name: '信封 channel/*',
    line: '①渠道 ⇄ ②前台收发标准消息',
  },
  {
    name: '四道关口 session/*',
    line: '会话×串行事件，②③④在此加料拦截',
  },
  {
    name: '问答 request→result',
    line: '跨插件按 requestId 一问一答',
  },
];


/** L0 全局 5 大正交插件块与各自的 L1 子角色归组。 */
export const BLOCKS: readonly Block[] = [
  {
    id: 'channels',
    name: '① 渠道',
    line: '收进各端原话，按信封原路回发',
    roles: [
      { name: '协议', plugins: ['channels'] },
      { name: 'IM 接入', plugins: ['feishu', 'wechat'] },
      { name: '本机对话', plugins: ['web-api', 'cli'] },
      { name: '语音双工', plugins: ['voice'] },
    ],
  },
  {
    id: 'front',
    name: '② 前台',
    line: '认人把关、排队分派与外派拍板',
    roles: [
      { name: '认领排队', plugins: ['bots'] },
      { name: '地盘与认人', plugins: ['workspaces', 'people'] },
      { name: '安全门卫', plugins: ['approval'] },
      { name: '外派与拍板', plugins: ['relay', 'work-decision'] },
      { name: '快判督办', plugins: ['decision', 'progress'] },
    ],
  },
  {
    id: 'thinking',
    name: '③ 思考',
    line: '关口一上换模、压缩与离线替身',
    roles: [
      { name: '目录换模', plugins: ['model-catalog'] },
      { name: '上下文瘦身', plugins: ['context-fit'] },
      { name: '离线替身', plugins: ['fake-model'] },
    ],
  },
  {
    id: 'hands',
    name: '④ 手脚',
    line: '挂工具干活，读写长期记忆与知识',
    roles: [
      { name: '本地手', plugins: ['file-tools', 'exec'] },
      { name: '外网手', plugins: ['web-search', 'image-gen'] },
      { name: '日常助手', plugins: ['assist'] },
      { name: '记忆与知识', plugins: ['memory', 'knowledge'] },
    ],
  },
  {
    id: 'base',
    name: '⑤ 底座',
    line: 'HTTP网关、宿主桥、外置守护与观测',
    roles: [
      { name: '网关与主库', plugins: ['http', 'db'] },
      { name: '系统设置', plugins: ['settings'] },
      { name: '基地与桌面桥', plugins: ['base-bridge', 'desktop', 'screen'] },
      { name: '外网与外置', plugins: ['frpc', 'programs'] },
      { name: '流水与观测', plugins: ['journal', 'tutorial'] },
    ],
  },
];


/** L2 全量 34 个真实插件目录的三行极简卡（键名严格对应 src7/plugins/<目录名>）。 */
export const CARDS: Readonly<Record<string, Card>> = {
  // ① 渠道（6）
  channels: {
    duty: '收发事件与标准消息结构（协议不挂）',
    hook: '定义 channel/* 协议',
    io: '被各渠道与 bots 直接 import',
  },
  feishu: {
    duty: '飞书长连接收发、卡片与撤回',
    hook: '发 channel/*，接 channel/reply',
    io: '飞书事件 ⇄ 标准消息与回执',
  },
  wechat: {
    duty: '微信客服收发（注册名 wechat-kefu）',
    hook: '发 direct/mention，接 reply',
    io: '本机微信 ⇄ 发件表草稿/发送',
  },
  'web-api': {
    duty: '网页聊天消息与会话历史接口',
    hook: '发 channel/direct，接 reply',
    io: 'POST /api/message ⇄ 时间线',
  },
  cli: {
    duty: '命令行单句发话，跑完即退',
    hook: '听 ready 发 direct，接 reply',
    io: '命令行参数一句话 ⇄ 终端打印',
  },
  voice: {
    duty: '开麦实时转写与语音合成回话',
    hook: '发 direct，接 channel/reply',
    io: '麦克风音频 ⇄ 转写文字与播报',
  },

  // ② 前台（8）
  bots: {
    duty: '机器人认领、前台排队与派后台',
    hook: '听 channel/*，守关口一/三/四',
    io: '标准消息 → 会话循环 → 回话',
  },
  workspaces: {
    duty: '机器人工作区目录与读写权限隔离',
    hook: '供 ctx.workspaces，登 workspace',
    io: '说话人身份 → 本轮合法工作目录',
  },
  people: {
    duty: '跨渠道核验认人与访客名片（未挂）',
    hook: '响应 people/request → result',
    io: '平台绑定元组 → 人员角色范围',
  },
  approval: {
    duty: '审批复口令、按人筛工具与审命令',
    hook: '抢听 channel/*，守关口一/三',
    io: '高危调用 → 本人点头或 deny',
  },
  relay: {
    duty: '前缀改道外部 AI 与外派任务回信',
    hook: '截 bot/receive，登 agent_task',
    io: '用户话 → 外部助手收件 → 回信',
  },
  'work-decision': {
    duty: '工作决策台：汇总待定供主人拍板',
    hook: '工具 ask_owner，连 relay 收发',
    io: '待定事项 → 主人点选回传中控',
  },
  decision: {
    duty: '开小会话做是/否/打分快速判定',
    hook: '响应 decision/judge → result',
    io: '判断问题 → 结构化短结论',
  },
  progress: {
    duty: '盯长跑耗时、发进度卡与复盘收尾',
    hook: '守关口一/三，听 session/change',
    io: '会话步进 → 进度提醒卡与复盘',
  },

  // ③ 思考（3）
  'model-catalog': {
    duty: '模型目录、并发队列、限流换模与计费',
    hook: '守关口一末尾，听 model-failed',
    io: '请求模型名 → 可用模型回答与账单',
  },
  'context-fit': {
    duty: '总结、压缩与裁剪三段瘦身防爆窗',
    hook: '守关口一，听 session/change',
    io: '超长对话历史 → 塞得下的请求副本',
  },
  'fake-model': {
    duty: '离线假模型，零费用演练会话全链',
    hook: '守关口一直接填 request.answer',
    io: 'fake/ 请求 → 预设假回答或调工具',
  },

  // ④ 手脚（7）
  'file-tools': {
    duty: '工作区文件读写查找与技能书加载',
    hook: '守关口一，登 read/write/edit/skill',
    io: '工具参数 → 文件结果或技能正文',
  },
  exec: {
    duty: '跑本机命令与运行日志，先过审批',
    hook: '登工具 exec，发 approval/request',
    io: '命令与目录 → 退出码与截断输出',
  },
  'web-search': {
    duty: '按配置顺序调网关做联网网页搜索',
    hook: '登工具 web_search',
    io: '查询关键词 → 网页摘要与链接',
  },
  'image-gen': {
    duty: '调生图模型出图并存进当前工作区',
    hook: '登工具 image_generate',
    io: '绘图提示词 → 工作区图片文件',
  },
  assist: {
    duty: '追问用户、表情回应、待办与定时提醒',
    hook: '守关口一，登 ask/todo/remind_*',
    io: '辅助调用或到点 → 追问/提醒卡片',
  },
  memory: {
    duty: '按身份归档对话、开场召回与混合检索',
    hook: '守关口一，听 channel/* 与新消息',
    io: '往来对话 ⇄ 召回记忆与关系图谱',
  },
  knowledge: {
    duty: '结构化双链知识库、消歧与磁盘镜像',
    hook: '登 kb_search/kb_save，挂知识路由',
    io: '知识文档 ⇄ 双链检索与本地镜像',
  },

  // ⑤ 底座（10）
  http: {
    duty: '唯一 Fastify 网关、双门禁与静态托管',
    hook: '供 ctx.http 服务，听 ready 监听',
    io: '外部 HTTP 请求 → 鉴权分发路由',
  },
  db: {
    duty: '主库 Drizzle、版本迁移账本与事务',
    hook: '供 ctx.db 服务（migrate/事务）',
    io: '插件版本 SQL → 主库幂等建表',
  },
  settings: {
    duty: '设置页：配置校验回写、建机器人与重启',
    hook: '挂 /api/settings 与重启接口',
    io: '本人改设置 → 写盘并热通知插件',
  },
  'base-bridge': {
    duty: '桥接托盘基地：转发通知与试跑换版',
    hook: '响应 base/request，登 notify_user',
    io: '审批/换版信号 → 桌面托盘与换版',
  },
  desktop: {
    duty: 'Windows 窗口定位、截图与滚动接口',
    hook: '挂 /api/desktop/* 窗口接口',
    io: '核验后窗口指令 → 坐标与截图',
  },
  screen: {
    duty: '收基地过检点击截图，生成一句讲解',
    hook: '挂 /api/screen/*，发 judge 与语音',
    io: '屏幕点击截图 → 一两句中文讲解',
  },
  frpc: {
    duty: '外网隧道启停、自启与代理无损编辑',
    hook: '挂 /api/frpc/* 隧道管理接口',
    io: '隧道配置与启停 → 公网穿透状态',
  },
  programs: {
    duty: '守护独立子进程并按三线做资源守卫',
    hook: '听 ready，响应 programs/* 守卫',
    io: '外置二进制 → 保活转发与限流',
  },
  journal: {
    duty: '记录全链事件流水与会话文件镜像',
    hook: '听 new-message/change/trace',
    io: '运行事件与跟踪 → 流水表与镜像',
  },
  tutorial: {
    duty: '录制启动与消息轨迹，驱动 /tutorial/ 页',
    hook: '首顺位听 trace/internal/*，挂教程路由',
    io: '快照与流水 → 可视化透视（零侵入）',
  },
};


/** 纵向「先分段、再分块」渐进学习路线（4 大段 × 4 小块 × 3~5 概念，对齐 00_学习路线.md）。 */
export const STAGES: readonly Stage[] = [
  {
    id: 'stage-1',
    title: '第 1 段 · 看懂一条消息',
    unlock: '对着 /tutorial/ 讲清任一消息走过哪几步、卡在哪',
    chunks: [
      {
        id: '1.1',
        title: '1.1 骨架',
        concepts: ['骨架 vs 插件', '会话=记录+循环', 'serial vs emit', '工具登记/执行'],
        docs: ['01_第一块.md'],
        lab: '发 1 句进 Session.run 看 4 态与 trace；失败分支：删模型名看循环未启',
        quiz: 'ctx.serial 与 ctx.emit 谁能改流程、谁只通知？',
      },
      {
        id: '1.2',
        title: '1.2 进与出',
        concepts: ['direct/mention/listen', 'bot/receive 认领', '前台排队 run', 'reply ↔ replied'],
        docs: ['02_第二块.md'],
        lab: '网页发 1 句 → channel/direct → bots 认领 → 收 replied；失败分支：重放同 claimKey 被去重',
        quiz: '插件想在 bot/receive 截走或改道，改哪两个字段？',
      },
      {
        id: '1.3',
        title: '1.3 四关口',
        concepts: ['before-model', 'after-model', 'before-tool', 'after-tool', 'deny vs stop'],
        docs: ['01_第一块.md', '05_第五块.md'],
        lab: '发调工具的话看 4 关口 trace；失败分支：approval deny 后工具返回“未执行：…”',
        quiz: '4 道关口中哪一道暂无人听？deny 与 stop 有何区别？',
      },
      {
        id: '1.4',
        title: '1.4 走一遍',
        concepts: ['web-api 收话', 'model-catalog 代调', 'autoFinal 回话', 'trace 看路'],
        docs: ['11_一条最简单的网页消息从头到尾.md'],
        lab: '网页发 8+9 对照 /tutorial/ 走完收话 → 关口一 → autoFinal → 回话；失败分支：停服务看轮询退避',
        quiz: '模型未调 reply 工具时，靠什么把末句发回渠道？',
      },
    ],
  },
  {
    id: 'stage-2',
    title: '第 2 段 · 会改行为',
    unlock: '判断新功能做插件还是改骨架、挂哪个关口/事件，看懂任一插件 index.ts',
    chunks: [
      {
        id: '2.1',
        title: '2.1 会话种类',
        concepts: ['会话种类 kind', 'hand_session 派后台', 'sessions.ask 小会话', 'stop 喊停'],
        docs: ['03_第三块.md'],
        lab: '前台派 work 后台看结果回流；失败分支：中途 stop_session 看状态立即收敛',
        quiz: 'sessions.ask 小会话为何不挂渠道也不带工具？',
      },
      {
        id: '2.2',
        title: '2.2 一问一答',
        concepts: ['request/result', 'requestId 配对', 'handled 接单', '退回机制', 'requestEvent'],
        docs: ['04_第四块.md'],
        lab: '发 */request 由办事方标 handled 回 */result；失败分支：无人接单或中止走退回',
        quiz: 'requestEvent 拿不到回执时，哪几种原因会触发退回？',
      },
      {
        id: '2.3',
        title: '2.3 插件约定',
        concepts: ['name/version/inject/apply', 'ctx 拔掉自动撤销', 'BUILT_IN vs 外部路径', 'plugins 挂载顺序'],
        docs: ['01_第一块.md'],
        lab: '对照任一插件 index.ts 核对导出字段与挂载顺序；失败分支：缺 inject 服务看 waiting 提示',
        quiz: '为何插件卸载后监听与工具会自动撤销，不用手写解绑？',
      },
      {
        id: '2.4',
        title: '2.4 资源存库',
        concepts: ['config 只校验一次', 'raw 插件自校验', 'sessions 表结构', 'db 版本迁移'],
        docs: ['06_第六块.md'],
        lab: '查 db_migrations 与 sessions 行记录；失败分支：改旧迁移 SQL 看 SHA-256 哈希拦截',
        quiz: '主配置在哪里只校验一次？插件私有配置由谁校验？',
      },
    ],
  },
  {
    id: 'stage-3',
    title: '第 3 段 · 管得住安全和成本',
    unlock: '说清谁能做什么、花多少钱、出事怎么停',
    chunks: [
      {
        id: '3.1',
        title: '3.1 把关',
        concepts: ['外人两道防线', '命令审批四档', 'approval 请求/结果', 'grants 临时授权'],
        docs: ['05_第五块.md', '14_安全审批与进程插件全链.md'],
        lab: '触发受审命令 → 弹审批卡 → 点头放行并查 grants；失败分支：拒绝或超时拦截不执行',
        quiz: '外人触发危险工具时，先后会撞上哪两道防线？',
      },
      {
        id: '3.2',
        title: '3.2 认人与地盘',
        concepts: ['本人 vs 外人', 'workspaces 权限', 'people guest 名片', '记忆按人按群隔离'],
        docs: ['10_机器人插件_bots.md', '13_记忆人员与上下文压缩全家桶.md'],
        lab: '对比本人/非本人读写工作区与查记忆；失败分支：越界路径被 workspaces 拒绝',
        quiz: 'people 自动建的 guest 名片为何改库也提不了权？',
      },
      {
        id: '3.3',
        title: '3.3 模型与上下文',
        concepts: ['目录与思考档', '429 冷却换模', '并发队列', 'context-fit 三段', '用量统计'],
        docs: ['16_模型调度熔断与用量全链.md', '13_记忆人员与上下文压缩全家桶.md'],
        lab: '造长对话进关口一看压缩日志与 /api/usage；失败分支：模拟 429 触发冷却换模',
        quiz: 'context-fit 塞不下长对话时，哪三步按什么顺序执行？',
      },
      {
        id: '3.4',
        title: '3.4 外置进程',
        concepts: ['programs 拉起守护', '双向密钥防伪', '资源三线降载', '只发二进制'],
        docs: ['07_第七块.md', '14_安全审批与进程插件全链.md'],
        lab: '查 /api/programs 与回调鉴权；失败分支：缺 x-jmbots-key 被拒 / 超线触发降载',
        quiz: '外置进程回调主程序靠什么请求头防伪？三线盯哪三项？',
      },
    ],
  },
  {
    id: 'stage-4',
    title: '第 4 段 · 专题查阅（查表不背）',
    unlock: '把任一插件、路由或数据表快速定位到文件行，做二次开发',
    chunks: [
      {
        id: '4.1',
        title: '4.1 渠道专题',
        concepts: ['feishu 三档/发件箱', 'wechat 客服草稿', 'voice 真双工', 'relay 前缀转话'],
        docs: ['09_渠道插件全家桶.md', '15_语音录屏与定时提醒.md'],
        lab: '定位目标渠道入口核对收发事件；失败分支：缺配置项跳过挂载，不拖垮主进程',
        quiz: 'feishu 群三档中哪一档先走快判再决定是否接话？',
      },
      {
        id: '4.2',
        title: '4.2 人机协作',
        concepts: ['work-decision 拍板', 'assist 定时提醒', 'progress 长跑督办', 'screen 点击讲解'],
        docs: ['08_工作决策工作台.md', '15_语音录屏与定时提醒.md'],
        lab: '用 fake/ 调 ask_owner 或 remind_add 看卡片落库；失败分支：非本人确认被拒',
        quiz: 'work-decision 拍板后靠哪条事件把选择送回中控或会话？',
      },
      {
        id: '4.3',
        title: '4.3 记忆知识',
        concepts: ['memory 四路召回', 'knowledge 双链消歧', 'journal 流水镜像'],
        docs: ['12_外网门禁与知识库底座.md', '13_记忆人员与上下文压缩全家桶.md'],
        lab: '调 kb_search 并查 journal_lines 留痕；失败分支：远端记忆离线退回纯本地检索',
        quiz: '标了硬性系统规则的知识文档，kb_save 工具能否修改？',
      },
      {
        id: '4.4',
        title: '4.4 底座调试',
        concepts: ['http 双层门禁', 'frpc 外网隧道', 'tutorial 泳道快照', '数据断点地图'],
        docs: ['12_外网门禁与知识库底座.md', '17_教程与流水账可观测全链.md', '18_HTTP启动骨架与数据读写调试断点地图.md'],
        lab: '对照 /tutorial/ 泳道与断点表定位写盘行；失败分支：frpc 把 30086 绑回环触发告警',
        quiz: 'sessions 表的唯一写盘入口是哪个方法？',
      },
    ],
  },
];


/** 洋葱圈 4 层同心圆架构（外圈依赖内圈，内圈零依赖外圈；1 骨架核 + 3 插件环覆盖 34/34 插件）。 */
export const ONION_RINGS: readonly OnionRing[] = [
  {
    id: 'core',
    level: 0,
    name: '圆心 · 骨架核',
    tagline: '0 插件 · 4 个核心骨架文件',
    summary: '0 依赖插件，只管会话循环与 4 道关口',
    items: ['Main.ts', 'Resources.ts', 'Tools.ts', 'Sessions.ts'],
    isCore: true,
  },
  {
    id: 'ring-1',
    level: 1,
    name: '第 1 圈 · 底座与协议',
    tagline: '5 插件 · 供基础服务与协议',
    summary: '提供主库、网关、工作区、渠道协议与认人底座',
    items: ['db', 'http', 'workspaces', 'channels', 'people'],
  },
  {
    id: 'ring-2',
    level: 2,
    name: '第 2 圈 · 调度与治理',
    tagline: '11 插件 · 管分派守关口',
    summary: '负责认领把关、外派督办、模型调度与记忆知识',
    items: [
      'bots',
      'approval',
      'relay',
      'work-decision',
      'decision',
      'progress',
      'model-catalog',
      'context-fit',
      'fake-model',
      'memory',
      'knowledge',
    ],
  },
  {
    id: 'ring-3',
    level: 3,
    name: '第 3 圈 · 外部触角',
    tagline: '18 插件 · 接渠道伸手脚',
    summary: '对接各端渠道、执行工具、系统桥接与运行观测',
    items: [
      'feishu',
      'wechat',
      'web-api',
      'cli',
      'voice',
      'file-tools',
      'exec',
      'web-search',
      'image-gen',
      'assist',
      'settings',
      'base-bridge',
      'desktop',
      'screen',
      'frpc',
      'programs',
      'journal',
      'tutorial',
    ],
  },
];

