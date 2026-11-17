/**
 * 插件的分类和一句说明：/flow/ 总览图按分类分组、点上写说明。
 * 只放运行时取不到的：分类、说明、别名、HTTP 路径。挂了什么服务、工具（boot-trail 记的）、要用谁（挂载结果）、听什么事件（Cordis 上的监听）、
 * 谁发事件（flow 自己从 internal/dispatch 认的）都在运行时取，见 flow/index.ts 的 graphOf，这里不再手抄。
 */
export interface CatalogPlugin {
  /** 插件名（config.yaml / Index.ts 里的名字）。 */
  name: string;
  /** 旧名或别名，比如 wechat。 */
  aliases?: string[];
  /** 分类（插件地图里的类）。 */
  category: string;
  /** 干什么，画在节点说明里。 */
  summary: string;
  /** HTTP 路径，没有是空串。Fastify 的路由表里看不出是哪个插件登记的，只好写在这里。 */
  http: string;
}


/** 骨架的一个点：入口 main，或它最先挂上的三个服务。 */
export interface CatalogSkeleton {
  /** 服务名。 */
  name: string;
  /** 干什么。 */
  summary: string;
}


/** 骨架的点：入口 main 加三服务。trace / internal/dispatch 是骨架自己的，不单独占一个点。 */
export const SKELETON: CatalogSkeleton[] = [
  { name: 'main', summary: '入口 Main.ts：读参数，挂骨架三服务和插件，发 ready，接着跑没跑完的会话。' },
  { name: 'resources', summary: '读配置、开数据库、给出运行时目录，最底下一层。' },
  { name: 'tools', summary: '工具登记处，插件往这里注册给模型用的工具。' },
  { name: 'sessions', summary: '会话的开、跑、存。发 session/request、session/message、session/change、model/failed。' },
];


/** 默认图画边上要跳过的事件：次数太多，点开插件再看。 */
export const QUIET_EVENTS = ['trace', 'internal/dispatch', 'ready'] as const;


/**
 * 一条说明。
 * @param name 插件名。
 * @param category 分类。
 * @param summary 一句说明。
 * @param extra 别名、HTTP 路径，没有可以不给。
 */
const C = (
  name: string,
  category: string,
  summary: string,
  extra: { aliases?: string[]; http?: string } = {},
): CatalogPlugin => ({
  name,
  category,
  summary,
  aliases: extra.aliases,
  http: extra.http ?? '',
});


/** 插件地图上的全部自带插件。 */
export const CATALOG: CatalogPlugin[] = [
  C('bots', '骨架配套', '机器人名单，收消息时问进哪场会话，会话中途先说一句。'),
  C('prompt', '骨架配套', '每一步给请求拼系统提示词。'),
  C('summary', '骨架配套', '每场干活的会话做完一轮写一句总结。'),
  C('compress', '骨架配套', '会话太长时把前面压成摘要。'),
  C('fake-model', '骨架配套', '假模型：模型名 fake/ 开头的会话直接给固定回答，离线能测交办。'),
  C('http', 'HTTP 底座和网页', '整个程序唯一的 Fastify，管令牌，ready 后才监听。', { http: '/api/health、/api/tokens*' }),
  C('web', 'HTTP 底座和网页', '托管网页 dist/web 和插件页面。', { http: '/* 兜底；/<名字>/ 插件页面' }),
  C('cli', '渠道', '命令行渠道：把命令行带的一句话发给机器人，会话都停了就退出。'),
  C('web-api', '渠道', 'HTTP 渠道（渠道名 http）加网页要的核心接口。', { http: '/api/message、/api/messages*、/api/sessions*、/api/ui/*、/api/bots、/api/search' }),
  C('feishu', '渠道', '飞书的全部：渠道收发、确认和进度卡片、云文档工具、发件箱。'),
  C('wechat-kefu', '渠道', '微信客服：读消息、交给机器人、回话发送、客服页面。', { aliases: ['wechat'], http: '/wechat-kefu/、/api/wechat-kefu/*' }),
  C('bot-front-desk', '前台和分派', '每个机器人一场前台对话，所有消息先到这儿，复杂的交给后台会话。'),
  C('relay', '前台和分派', '不调模型的转话机器人，把话转给外部助手，等回信再回给用户。', { http: '/api/relay/inbox、/api/relay/reply' }),
  C('base-tools', '给模型的工具', '自带工具：time、read、list_dir、write。'),
  C('file-tools', '给模型的工具', '改文件、找文件：edit、find。'),
  C('exec', '给模型的工具', '跑命令。'),
  C('web-search', '给模型的工具', '网页搜索。'),
  C('image-gen', '给模型的工具', '生成图片。'),
  C('reply-tool', '给模型的工具', '干活的会话中途先回用户一句。'),
  C('note-claude', '给模型的工具', '给 Claude 留言。'),
  C('agent-tasks', '给模型的工具', '外部 AI 来领活、交结果的通道。', { http: '/api/agents*' }),
  C('assist', '给模型的工具', '助手体验：点表情、带选项的问题卡片、待办清单。', { http: '/api/assist*' }),
  C('approval', '审核和流程', '审命令和待确认。', { http: '/api/approvals*' }),
  C('decision', '审核和流程', '决策模型：一道是非题交给模型打分，交回 allow/deny/unsure。'),
  C('progress', '审核和流程', '进度和限时：每轮一项进度，长跑发卡片问要不要停。', { http: '/api/progress*' }),
  C('review', '审核和流程', '复盘：空闲时挑一件做太久的事，写慢在哪。'),
  C('runs', '审核和流程', '命令窗口：外面不经过模型直接跑命令。', { http: '/api/run、/api/runs*' }),
  C('notify', '审核和流程', '把待确认、长任务结束转到基地右下角 toast。'),
  C('model-catalog', '模型', '模型清单：拉每家供应商的 /models，和手写的合成一张表。', { http: '/api/models、/api/models/reconnect、/api/ui/provider-models' }),
  C('model-fallback', '模型', '换模型：限流、超长时换备选。'),
  C('context-fit', '模型', '调模型前估 token，装不下先省略旧工具结果、再丢最早的段。'),
  C('memory', '记忆和知识', '记忆：工具、开场先搜、客服记忆库、托管记忆服务和 vgr。', { http: '/api/memory/*、/memory/*' }),
  C('memory-graph', '记忆和知识', '记忆关系图页面和数据接口（不是插件流程图）。', { http: '/graph/、/api/memory-graph/*' }),
  C('skills', '记忆和知识', '技能清单拼进提示词，工具 skill 读全文。'),
  C('settings', '管理接口', '设置页：看和改 config.yaml、新建机器人、重启。', { http: '/api/settings*、/api/bots、/api/service/restart' }),
  C('files-api', '管理接口', '上传、看文件、列目录。', { http: '/api/uploads/:name、/api/files、/files/*' }),
  C('base-bridge', '管理接口', '把更新、自启、记忆库、RAG 几条接口原样转给基地。', { http: '/api/update*、/api/autostart、/api/memory/health、/api/memory/search、/api/rag/*' }),
  C('update-watch', '管理接口', '盯基地的新版本，有就登记待确认，同意了叫基地换。'),
  C('desktop', '管理接口', '窗口操控：选窗口、看窗口、截图、滚动。', { http: '/api/desktop/status、/api/desktop/action' }),
  C('boot-trail', '记录和调试', '记下这次启动走过的路：骨架几步、每个插件挂了多久、多出哪些服务和工具，给 /flow/ 的“看启动”和总览图的边。写在 plugins 段第一个。'),
  C('trace', '记录和调试', '控制台打印执行路径：函数行和事件行。'),
  C('journal', '记录和调试', '流水：跟踪行存库，给网页追溯、/flow/ 的轨迹和外部查询。', { http: '/api/events' }),
  C('usage', '记录和调试', '用量：模型每调一次记一行，网页按时间段合计。', { http: '/api/usage' }),
  C('files-mirror', '记录和调试', '每场会话一个文件夹：对话.md 和 session.json。'),
  C('flow', '记录和调试', '插件和事件预览图：按插件聚合，边从运行时取；可看一条请求和这次启动走过的路、一条请求的变量和对话；右栏看运行时变量（点中轨迹一步看那一刻的快照，标出变了的）。别的插件用 ctx.flow.state 补充自己的变量。', { http: '/flow/、/api/flow/*、/api/plugins/status' }),
];


/**
 * 按名字找说明（认别名）。
 * @param name 插件名。
 */
export function catalogOf(name: string): CatalogPlugin | undefined {
  return CATALOG.find((item) => item.name === name || item.aliases?.includes(name));
}
