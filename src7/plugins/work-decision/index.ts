/** 收集插件和网页的任务节点，把任务变化、选择与留言交给中控。 */
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as checksModule from '../../utils/Checks.ts';
import * as utils from '../../utils/index.ts';
import * as controlPlaneModule from './ControlPlane.ts';
import type * as notifications from './Notify.ts';
import * as routesModule from './Routes.ts';
import * as storeModule from './Store.ts';
import * as toolsModule from './Tools.ts';

export const name = 'work-decision';
//M 1.3.6：ask_owner 认本人改问 channels 的 isOwnerTurn（从 utils/Workspace.ts 挪过去的），判断不变。
//M 1.3.7：选择回送按请求号等原会话或 relay 的回执。
//M 1.3.8：问 relay 收件、归档不再掐表、不再编假回执，按 reply 或 why 判。
//M 1.3.9：旧 data/decision-map JSON 导入过渡代码标明 //退场：条件。
//M 1.3.10：新增 GET /api/work-decision/version 轻量版本探针，供工作台 30 秒无感自动刷新。
//M 1.3.11：节点可选支持 quadrant 四象限字段及 POST/PUT /api/work-decision/quadrant，前端新增四象限决策矩阵视图。
//M 1.3.12：新增只读工具 work_topics（前后台会话、只限本人）：概览、按状态和关键词筛、看单个节点，带 topicId 给知识库用。
//M 1.3.13：建表、加列改走 db 迁移账本（云端 36 第 1 条）：db 成了必需依赖；quadrant 列是迁移第 2 版，旧库已有的只登记。
//M 1.4.0：新增多 AI 协同控制面任务面板（ControlPlane.ts，control-plane-tasks.json + /api/work-decision/tasks* 占坑防撞锁与心跳时间线）。
//M 1.4.1：新增 owner_targets 多机器人提醒路由与 POST /api/work-decision/notify 可选 { bot }，向后兼容旧 owner_target 配置。
//M 1.4.2：新增控制面任务面板单向唤醒（notifyHelper / helper_bots）与作战室精炼播报（broadcast / broadcast_target）。
//M 1.4.3：控制面任务加 sourceRef 来源引用（SourceRef.ts）、GET /tasks 来源 6 维筛选、POST /tasks/upsert 幂等入池与 work-decision/task-upsert 事件。
//M 1.4.4：控制面新增自定义动态筛选视图（FilterViews.ts，TaskFilterRule / TaskFilterViewDef）与 /api/work-decision/views* 接口。
export const version = '1.4.4';
export const inject = ['resources', 'http', 'tools', 'db'];

/** 读取配置文本，未设置时保持缺省。 */
function getOptionalText(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  if (value === undefined) return;

  //G 字段已配置时必须是非空字符串。
  return storeModule.readText(value, key);
}

/** 校验手机可打开的工作决策页地址（仅接受不含账号密码的 HTTP/HTTPS）。 */
function readPublicUrl(config: Record<string, unknown>): URL {
  const address = storeModule.readText(config['public_url'], 'public_url');
  const url = URL.parse(address);
  const validProtocol = url !== null && ['http:', 'https:'].includes(url.protocol);
  if (!validProtocol || url.username !== '' || url.password !== '') {
    throw new Error('public_url 要是不含账号和密码的 HTTP 或 HTTPS 地址');
  }
  return url;
}

/** 校验单个通知目标对象（bot、channel、chat 均为非空文本）。 */
function readOwnerNotice(value: unknown, label: string, url: URL): notifications.OwnerNotice {
  //G 通知目标需要是含三个路由字段的对象。
  const owner = checksModule.checkRecord(value, label);
  //G 明确选择负责通知的机器人。
  const bot = storeModule.readText(owner['bot'], `${label}.bot`);
  //G 明确选择机器人的发件渠道。
  const channel = storeModule.readText(owner['channel'], `${label}.channel`);
  //G 收件只使用配置提供的私聊标识。
  const chat = storeModule.readText(owner['chat'], `${label}.chat`);
  const target = { channel, chat };
  return { bot, target, url };
}

/** 校验主人的通知目的地配置（兼容默认 owner_target 与多机器人 owner_targets）。 */
function getNoticeConfig(config: Record<string, unknown>): notifications.OwnerNoticeConfig | undefined {
  const rawDefault = config['owner_target'];
  const rawList = config['owner_targets'];

  //G 配了 owner_targets 时先校验为数组。
  let targetItems: unknown[] = [];
  if (rawList !== undefined) {
    targetItems = checksModule.checkArray(rawList, 'owner_targets');
  }

  //M 既无默认目标也无非空多机器人列表时，关闭主动提醒。
  if (rawDefault === undefined && targetItems.length === 0) return;

  //G 只要配置了默认目标或非空多机器人列表，手机能打开的地址必填。
  const url = readPublicUrl(config);
  let fallback: notifications.OwnerNotice | undefined;
  if (rawDefault !== undefined) {
    fallback = readOwnerNotice(rawDefault, 'owner_target', url);
  }

  const byBot = new Map<string, notifications.OwnerNotice>();
  for (let index = 0; index < targetItems.length; index += 1) {
    const label = `owner_targets[${String(index)}]`;
    const item = readOwnerNotice(targetItems[index], label, url);
    //G 同一个机器人只允许登记一条通知目标，避免路由歧义。
    if (byBot.has(item.bot)) {
      throw new Error(`owner_targets 中机器人「${item.bot}」重复`);
    }
    byBot.set(item.bot, item);
  }
  return { default: fallback, byBot };
}

/** 校验作战室群战报配置（未配置时返回 undefined，播报能力温和降级）。 */
function getBroadcastTarget(config: Record<string, unknown>): notifications.BroadcastTarget | undefined {
  const raw = config['broadcast_target'];
  if (raw === undefined) return undefined;

  //G broadcast_target 须为包含 bot、chat_id 与可选 channel（默认 feishu）的对象。
  const written = checksModule.checkRecord(raw, 'broadcast_target');
  let channel = 'feishu';
  if (written['channel'] !== undefined) {
    //M 显式指定发送渠道时校验为非空文本。
    channel = storeModule.readText(written['channel'], 'broadcast_target.channel');
  }
  //M 校验负责向作战室发战报的机器人名。
  const bot = storeModule.readText(written['bot'], 'broadcast_target.bot');
  //M 校验作战室群或聊天 ID（绝不硬编码）。
  const chatId = storeModule.readText(written['chat_id'], 'broadcast_target.chat_id');
  return { channel, bot, chatId };
}

/** 校验可选外部助手到机器人名的映射表（helper_bots）。 */
function getHelperBots(config: Record<string, unknown>): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const raw = config['helper_bots'];
  if (raw === undefined) return map;

  //G helper_bots 须为非数组对象，且所有键名与机器人名均须为非空文本。
  const written = checksModule.checkRecord(raw, 'helper_bots');
  //M 逐条校验 helper -> bot 映射并收进只读映射表。
  utils.eachEntry(written, (helperName, botValue) => {
    if (helperName.trim() === '' || helperName !== helperName.trim()) {
      throw new Error('helper_bots 的键名要写成无首尾空白的非空助手名');
    }
    //M 校验目标机器人名为非空文本。
    const bot = storeModule.readText(botValue, `helper_bots.${helperName}`);
    map.set(helperName, bot);
  });
  return map;
}

/**
 * 校验配置并把当前数据目录的图挂到主 HTTP 服务上。
 * @param ctx Cordis 插件上下文。
 * @param config 可选中控助手、旧图所属工作区、提醒目的地及控制面播报与助手机器人映射。
 * 副作用：初始化工作决策表，导入旧快照，挂载 HTTP 入口和插件事件。
 */
export function apply(ctx: cordis.Context, config?: unknown): void {
  //M 配置在挂载时读一次，之后入口使用已经解析过的字段。
  const settings = checksModule.checkRecord(config ?? {}, 'work-decision.config');
  //M 读取可选默认中控 relay 助手名。
  const helper = getOptionalText(settings, 'relay_helper');
  //退场：所有运行时的旧 data/decision-map/graph.json 都导入 SQLite 以后，连同 legacy_workspace_id 与 importLegacy 一起删
  const legacyWorkspaceId = getOptionalText(settings, 'legacy_workspace_id');
  //M 解析主人私聊提醒路由配置。
  const noticeConfig = getNoticeConfig(settings);
  //M 解析可选作战室群战报目的地（broadcast_target）。
  const broadcastTarget = getBroadcastTarget(settings);
  //M 解析可选外部助手到机器人名的映射表（helper_bots）。
  const helperBots = getHelperBots(settings);
  const dispatchConfig: notifications.ControlDispatchConfig = {
    broadcastTarget,
    helperBots,
    noticeConfig,
  };

  //M 工作决策使用资源数据库，建表走 db 的迁移账本；旧目录仅用于一次性读取。
  const resources = ctx.resources;
  const dir = path.join(resources.root, 'data', 'decision-map');
  const store = new storeModule.Store(resources.db, ctx.db, dir, legacyWorkspaceId);
  const controlStore = new controlPlaneModule.ControlPlaneStore(resources.root);
  //M 挂载决策图与控制面接口，并注入单向唤醒与作战室播报配置。
  routesModule.mount(ctx, store, helper, noticeConfig, controlStore, dispatchConfig);
  //M 注册后台提问与只读专题查询工具。
  toolsModule.registerAskOwner(ctx, store, noticeConfig);
  toolsModule.registerWorkTopics(ctx, store);
}
