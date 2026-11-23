/**
 * 设置中心轻量声明式注册表：定义 6 大一级分组与 17 个二级设置节点元数据、
 * `#settings=` 深链接别名映射、秒搜匹配（中英文/键名/@modified）与未保存改动判定。
 * 所有文案使用静态中文原文，渲染层经 `t()` 翻译，不引入重型 JSON Schema。
 */
import type * as i18n from '../I18n.ts';
import * as editsModule from './Edits.ts';


/** 一级设置分组标识。 */
export type SettingsGroupId =
  | 'console'
  | 'models'
  | 'bots'
  | 'knowledge'
  | 'security'
  | 'desktop';


/** 一级分组元数据。 */
export interface SettingsGroup {
  /** 分组唯一标识。 */
  id: SettingsGroupId;
  /** 分组展示标题（中文原文）。 */
  title: string;
  /** 分组简短说明。 */
  description: string;
}


/** 二级设置节点元数据。 */
export interface SettingsSectionMeta {
  /** 节点唯一标识（同步用于 `#settings=<id>` 深链接与 DOM 锚点）。 */
  id: string;
  /** 所属一级分组标识。 */
  groupId: SettingsGroupId;
  /** 节点标题（中文原文）。 */
  title: string;
  /** 节点一句话副标题（中文原文）。 */
  subtitle: string;
  /** 检索关键词清单（中英文、配置键名、别名）。 */
  keywords: readonly string[];
  /** 对应 `config.yaml` 路径集合；空数组代表不写入 config.yaml 的即时项或入口项。 */
  configPaths: readonly editsModule.Path[];
  /** 是否属于改后即时生效或只读入口（右上角展示「即时生效」徽章）。 */
  immediate?: boolean;
  /** 可选后端依赖插件名；未挂载时自动隐藏避免接口 404。 */
  requiresPlugin?: string;
}


/** 解析后的搜索查询条件。 */
export interface ParsedSearchQuery {
  /** 是否包含 `@modified` 特殊过滤词（仅看未保存改动）。 */
  onlyModified: boolean;
  /** 去除 `@modified` 后的普通小写检索词条。 */
  terms: string[];
}


/** 6 大一级分组清单（按主导航展示顺序排列）。 */
export const SETTINGS_GROUPS: readonly SettingsGroup[] = [
  {
    id: 'console',
    title: '控制台与运行态',
    description: '实时运行状态、工作台总览与模型重连体检',
  },
  {
    id: 'models',
    title: '模型与推理',
    description: '供应商密钥、默认/决策/备用模型、并发配额与引擎',
  },
  {
    id: 'bots',
    title: '机器人与渠道',
    description: '机器人名单、提示词语言、飞书与微信客服渠道',
  },
  {
    id: 'knowledge',
    title: '记忆与知识',
    description: '网页搜索后端、向量记忆、知识库与实体图谱',
  },
  {
    id: 'security',
    title: '安全与网络',
    description: '端口、外网反代登录鉴权、FRPC 隧道与目录授权',
  },
  {
    id: 'desktop',
    title: '桌面与外观',
    description: '本地壳子、开机自启、主题语言、演示打码与窗口操控',
  },
];


/**
 * 17 个二级设置节点清单（按分组与展示顺序排列）。
 * 入口节点（immediate）带了 configPaths 的，下面还有写进 config.yaml 的表单，红点和 @modified 照常算。
 */
export const SETTINGS_SECTIONS: readonly SettingsSectionMeta[] = [
  {
    id: 'console-overview',
    groupId: 'console',
    title: '运行态总览',
    subtitle: '实时查看后端、基地壳子、托管子服务与外网隧道状态，一键直达重监控工作台',
    keywords: [
      'console', 'overview', 'status', 'info', 'version', 'programs',
      'frpc', 'work-decision', 'tick', 'wechat-kefu', 'knowledge',
      '总览', '运行态', '控制台', '工作台', '版本', '进程', '监控',
    ],
    configPaths: [],
    immediate: true,
  },
  {
    id: 'reconnect',
    groupId: 'console',
    title: '服务连接与重连体检',
    subtitle: '重新拉取各供应商模型清单、核对配置模型可用性，或安全重启后端服务',
    keywords: [
      'reconnect', 'test', 'restart', 'health', 'models', 'check',
      '重连', '体检', '重启服务', '模型清单', '测试连接',
    ],
    configPaths: [],
    immediate: true,
  },
  {
    id: 'providers',
    groupId: 'models',
    title: '模型供应商',
    subtitle: '左侧选择或新增供应商，右侧配密钥、接口地址、协议与自定义模型目录',
    keywords: [
      'providers', 'api_key', 'base_url', 'api', 'list_models',
      'compat', 'model_compat', 'models', 'openai', 'anthropic',
      '供应商', '密钥', '地址', '协议', '模型目录', '兼容',
    ],
    configPaths: [['providers']],
  },
  {
    id: 'model-routing',
    groupId: 'models',
    title: '默认模型与决策/备用链',
    subtitle: '配置默认对话模型、决策模型、限流备用链与看图转写模型',
    keywords: [
      'default_model', 'models', 'models.decision', 'decision',
      'fallback', 'fallback.chain', 'fallback.max_tries',
      'vision_model', 'routing', '默认模型', '决策模型', '备用链', '看图',
    ],
    configPaths: [
      ['default_model'],
      ['models', 'decision'],
      ['decision'],
      editsModule.PLUGIN_PATHS.fallbackChain,
      editsModule.PLUGIN_PATHS.fallbackMaxTries,
      editsModule.PLUGIN_PATHS.visionModel,
    ],
  },
  {
    id: 'concurrency',
    groupId: 'models',
    title: '并发配额',
    subtitle: '限制同一时刻模型与供应商的最大并发调用数，超额自动排队',
    keywords: [
      'concurrency', 'concurrency.default', 'concurrency.models',
      'concurrency.providers', 'limit', 'queue', '并发', '配额', '排队',
    ],
    configPaths: [['concurrency']],
  },
  {
    id: 'engine',
    groupId: 'models',
    title: '引擎与重试/生图/收尾',
    subtitle: '配置基地桥接地址、生图模型、收尾模型、请求重试间隔与同家兜底',
    keywords: [
      'engine', 'index_url', 'image_model', 'wrapup_model',
      'models.retry.wait_ms', 'retry', 'fallback_include_siblings',
      'base-bridge', 'image-gen', 'progress',
      '引擎', '生图', '收尾', '重试', '兜底', '基地地址',
    ],
    configPaths: [
      editsModule.PLUGIN_PATHS.wrapupModel,
      ['models', 'retry', 'wait_ms'],
      editsModule.PLUGIN_PATHS.indexUrl,
      editsModule.PLUGIN_PATHS.imageModel,
      editsModule.PLUGIN_PATHS.fallbackSiblings,
    ],
  },
  {
    id: 'bots-list',
    groupId: 'bots',
    title: '机器人与语言',
    subtitle: '管理启用的机器人名单、提示词语言以及各自绑定的飞书应用',
    keywords: [
      'bots', 'channels', 'channels.feishu', 'feishu',
      'app_id', 'app_secret', 'language', 'bot',
      '机器人', '语言', '飞书', '应用',
    ],
    configPaths: [['bots'], ['channels']],
  },
  {
    id: 'channels-entry',
    groupId: 'bots',
    title: '渠道与外部工作台',
    subtitle: '查看飞书与微信渠道实时连通概况，快捷进入微信客服独立工作台',
    keywords: [
      'channels', 'wechat', 'wechat-kefu', 'feishu', 'status',
      '渠道', '微信', '客服', '飞书', '工作台', '连通',
    ],
    configPaths: [],
    immediate: true,
  },
  {
    id: 'channel-policy',
    groupId: 'bots',
    title: '转话与飞书群策略',
    subtitle: '外部助手转话的催促与过期、免前缀直通规则，以及飞书各群的监听方式与受信开关',
    keywords: [
      'relay', 'remind_minutes', 'expire_minutes', 'owner_p2p_direct',
      'owner_group_direct', 'exclusive_bots', 'helper', 'feishu', 'groups',
      'listen', 'mention', 'judge', 'trusted', 'chat_id',
      '转话', '催促', '过期', '直通', '独占', '免前缀', '群策略', '监听', '受信', '飞书群',
    ],
    configPaths: [
      editsModule.PLUGIN_PATHS.relayRemind,
      editsModule.PLUGIN_PATHS.relayExpire,
      editsModule.PLUGIN_PATHS.relayOwnerP2p,
      editsModule.PLUGIN_PATHS.relayOwnerGroup,
      editsModule.PLUGIN_PATHS.relayExclusive,
      editsModule.PLUGIN_PATHS.feishuGroups,
    ],
  },
  {
    id: 'search',
    groupId: 'knowledge',
    title: '网页搜索配置',
    subtitle: '配置 web_search 工具按优先级尝试的搜索引擎后端（Magpie / 智谱 MCP）',
    keywords: [
      'search', 'web_search', 'magpie', 'zhipu_mcp', 'api_key', 'url',
      '搜索', '网页搜索', '联网', '智谱',
    ],
    configPaths: [['search']],
  },
  {
    id: 'knowledge-entry',
    groupId: 'knowledge',
    title: '记忆 / VGR / 知识库入口',
    subtitle: '查看记忆服务健康统计，直达知识库、统一记忆检索与实体关系图谱',
    keywords: [
      'knowledge', 'memory', 'vgr', 'graph', 'rag', 'jmbots-memory',
      'history', 'recall_history', 'recall_knowledge', 'service_url',
      'backend_timeout_ms', 'backfill', 'batch_size', 'interval_ms',
      '知识库', '记忆', '图谱', '关系图', '向量', '召回', '回填', '超时',
    ],
    configPaths: [
      editsModule.PLUGIN_PATHS.memoryHistory,
      editsModule.PLUGIN_PATHS.memoryRecallHistory,
      editsModule.PLUGIN_PATHS.memoryRecallKnowledge,
      editsModule.PLUGIN_PATHS.memoryServiceUrl,
      editsModule.PLUGIN_PATHS.memoryTimeout,
      editsModule.PLUGIN_PATHS.memoryBackfillEnabled,
      editsModule.PLUGIN_PATHS.memoryBackfillBatch,
      editsModule.PLUGIN_PATHS.memoryBackfillInterval,
    ],
    immediate: true,
  },
  {
    id: 'server-http',
    groupId: 'security',
    title: '服务端口与外网反代鉴权',
    subtitle: '配置服务端口、主访问令牌、外网登录门禁（server.web_auth）与动态令牌',
    keywords: [
      'server', 'http', 'port', 'server.port', 'token', 'server.token',
      'web_auth', 'server.web_auth', 'username', 'password',
      'password_scrypt', 'password_sha256', 'auth', 'trusted_ips',
      '服务', '端口', '令牌', '鉴权', '外网登录', '反代', '密码',
    ],
    configPaths: [['server'], ['http']],
  },
  {
    id: 'frpc-entry',
    groupId: 'security',
    title: '外网隧道 FRPC 概览',
    subtitle: '实时查看 FRPC 隧道在线状态、开机自启与公网域名，一键打开控制面板',
    keywords: [
      'frpc', 'tunnel', 'proxy', 'domain', 'autostart', 'publicUrls', 'dir', 'frpc.dir',
      '隧道', '外网', '反代', '公网', '域名', '内网穿透', '客户端目录',
    ],
    configPaths: [editsModule.PLUGIN_PATHS.frpcDir],
    immediate: true,
  },
  {
    id: 'grants',
    groupId: 'security',
    title: '目录授权',
    subtitle: '将人员或群聊绑定到本机目录，授权目录及子目录内操作免反复确认',
    keywords: [
      'grants', 'dir', 'approval', 'trusted', 'trusted_dirs', 'permission',
      '目录授权', '授权', '目录', '免确认', '群', '可信目录',
    ],
    configPaths: [editsModule.PLUGIN_PATHS.trustedDirs],
    immediate: true,
  },
  {
    id: 'shell-local',
    groupId: 'desktop',
    title: '本地壳子与开机自启',
    subtitle: '配置开机自启、壳子端口、连接后端与记忆库/RAG 目录（兼容 shell.* 与 local.*）',
    keywords: [
      'shell', 'local', 'shell.port', 'local.port', 'shell.host',
      'shell.trial_port', 'shell.server', 'shell.libs', 'shell.rag',
      'autostart', '壳子', '基地', '开机自启', '端口', '本地',
    ],
    configPaths: [['shell'], ['local']],
  },
  {
    id: 'ui-theme',
    groupId: 'desktop',
    title: '界面主题、语言与演示打码',
    subtitle: '即时切换界面语言、深浅色主题与演示隐私打码开关',
    keywords: [
      'ui', 'theme', 'dark', 'light', 'tech', 'eyecare',
      'language', 'ui.language', 'mask', 'privacy', 'demo',
      '界面', '主题', '深色', '浅色', '科技', '护眼', '语言', '演示打码', '打码',
    ],
    configPaths: [],
    immediate: true,
  },
  {
    id: 'desktop-window',
    groupId: 'desktop',
    title: '窗口操控',
    subtitle: '拖动定位点选中桌面窗口，实时预览区域并发送定向滚动指令',
    keywords: [
      'desktop', 'window', 'aobw', 'scroll', 'preview', 'pick',
      '窗口', '操控', '拾取', '滚动', '预览',
    ],
    configPaths: [],
    immediate: true,
    requiresPlugin: 'desktop',
  },
];


/** 旧版 `#settings=<分类>` 深链接兼容映射表。 */
const LEGACY_CATEGORY_MAP: Readonly<Record<string, string>> = {
  console: 'console-overview',
  reconnect: 'reconnect',
  providers: 'providers',
  models: 'model-routing',
  concurrency: 'concurrency',
  engine: 'engine',
  bots: 'bots-list',
  channels: 'channels-entry',
  relay: 'channel-policy',
  search: 'search',
  knowledge: 'knowledge-entry',
  http: 'server-http',
  server: 'server-http',
  frpc: 'frpc-entry',
  grants: 'grants',
  local: 'shell-local',
  shell: 'shell-local',
  ui: 'ui-theme',
  desktop: 'desktop-window',
};


/**
 * 将商店或 URL `#settings=` 传入的分类名解析为当前可见的二级节点 ID。
 * @param rawCategory 原始分类名（支持新 ID 与旧版分类名）。
 * @param visibleSections 当前可见二级节点列表。
 * @returns 命中节点 ID；未命中时返回首个可见节点 ID。
 */
export function resolveSectionId(
  rawCategory: string,
  visibleSections: readonly SettingsSectionMeta[],
): string {
  const fallback = visibleSections[0]?.id ?? 'console-overview';
  const trimmed = rawCategory.trim();
  if (trimmed === '') return fallback;

  //M 先直接匹配新版二级节点 ID，再检查旧版分类别名映射，确保历史深链接零失效。
  if (visibleSections.some((item) => item.id === trimmed)) return trimmed;

  const mapped = LEGACY_CATEGORY_MAP[trimmed];
  if (mapped !== undefined && visibleSections.some((item) => item.id === mapped)) {
    return mapped;
  }
  return fallback;
}


/**
 * 解析搜索栏输入文本，拆出 `@modified` 标记与普通关键词列表。
 * @param rawQuery 搜索框原文。
 * @returns 结构化过滤条件。
 */
export function parseSearchQuery(rawQuery: string): ParsedSearchQuery {
  const tokens = rawQuery
    .trim()
    .toLowerCase()
    .split(/\s+/u)
    .filter((token) => token !== '');

  let onlyModified = false;
  const terms: string[] = [];
  for (const token of tokens) {
    if (token === '@modified') {
      onlyModified = true;
      continue;
    }
    terms.push(token);
  }
  return { onlyModified, terms };
}


/**
 * 判定指定二级节点是否存在尚未保存的 `config.yaml` 改动。
 * @param config 后端读取的原始配置快照。
 * @param draft 叠加草稿后的配置快照。
 * @param section 二级节点元数据。
 * @returns 存在实质改动时返回 true。
 */
export function isSectionModified(
  config: Record<string, unknown> | null,
  draft: unknown,
  section: SettingsSectionMeta,
): boolean {
  if (config === null || draft === null) return false;

  if (section.configPaths.length === 0) return false;

  //M 只要节点名下任意 config.yaml 路径相对原始配置发生实质变更，即亮起红点并参与 @modified 过滤。
  return section.configPaths.some((path) => editsModule.changedAt(config, draft, path));
}


/**
 * 判定指定二级节点是否命中全部普通关键词（匹配中英文标题、副标题、组名、键名与关键词）。
 * @param section 二级节点元数据。
 * @param group 所属一级分组。
 * @param terms 规范化后的小写关键词数组。
 * @param t 当前语言翻译函数。
 * @returns 全部词条均命中时返回 true。
 */
export function matchesSearchTerms(
  section: SettingsSectionMeta,
  group: SettingsGroup | undefined,
  terms: readonly string[],
  t: i18n.Translate,
): boolean {
  if (terms.length === 0) return true;

  //M 汇总中文原文、译文、分组标题、配置路径与预设关键词，支持跨语言与键名秒搜。
  const haystackParts: string[] = [
    section.id,
    section.title,
    t(section.title),
    section.subtitle,
    t(section.subtitle),
    ...section.keywords,
    ...section.configPaths.map((path) => path.join('.')),
  ];
  if (group !== undefined) {
    haystackParts.push(group.title, t(group.title), group.id);
  }
  const haystack = haystackParts.join('\n').toLowerCase();
  return terms.every((term) => haystack.includes(term));
}


/**
 * 按 ID 查找一级分组。
 * @param groupId 分组标识。
 * @returns 分组元数据或 undefined。
 */
export function findGroup(groupId: SettingsGroupId): SettingsGroup | undefined {
  return SETTINGS_GROUPS.find((item) => item.id === groupId);
}
