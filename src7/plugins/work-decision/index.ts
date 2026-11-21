/** 收集插件和网页的任务节点，把任务变化、选择与留言交给中控。 */
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as checksModule from '../../utils/Checks.ts';
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
export const version = '1.3.12';
export const inject = ['resources', 'http', 'tools'];

/** 读取配置文本，未设置时保持缺省。 */
function getOptionalText(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  if (value === undefined) return;

  //G 字段已配置时必须是非空字符串。
  return storeModule.readText(value, key);
}

/** 校验主人的通知目的地，工具不能从参数里指定收件人。 */
function getNotice(config: Record<string, unknown>): notifications.OwnerNotice | undefined {
  const value = config['owner_target'];
  if (value === undefined) return;

  //G 配置了通知目标时，手机能打开的地址必填。
  const address = storeModule.readText(config['public_url'], 'public_url');
  const url = URL.parse(address);
  if (url === null || !['http:', 'https:'].includes(url.protocol) || url.username !== '' || url.password !== '') {
    throw new Error('public_url 要是不含账号和密码的 HTTP 或 HTTPS 地址');
  }
  //G 通知目标需要是含三个路由字段的对象。
  const owner = checksModule.checkRecord(value, 'owner_target');
  //G 明确选择负责通知的机器人。
  const bot = storeModule.readText(owner['bot'], 'owner_target.bot');
  //G 明确选择机器人的发件渠道。
  const channel = storeModule.readText(owner['channel'], 'owner_target.channel');
  //G 收件只使用配置提供的私聊标识。
  const chat = storeModule.readText(owner['chat'], 'owner_target.chat');
  const target = { channel, chat };
  return { bot, target, url };
}

/**
 * 校验配置并把当前数据目录的图挂到主 HTTP 服务上。
 * @param ctx Cordis 插件上下文。
 * @param config 可选中控助手、旧图所属工作区和提醒目的地。
 * 副作用：初始化工作决策表，导入旧快照，挂载 HTTP 入口和插件事件。
 */
export function apply(ctx: cordis.Context, config?: unknown): void {
  //M 配置在挂载时读一次，之后入口使用已经解析过的字段。
  const settings = checksModule.checkRecord(config ?? {}, 'work-decision.config');
  const helper = getOptionalText(settings, 'relay_helper');
  //退场：所有运行时的旧 data/decision-map/graph.json 都导入 SQLite 以后，连同 legacy_workspace_id 与 importLegacy 一起删
  const legacyWorkspaceId = getOptionalText(settings, 'legacy_workspace_id');
  const notice = getNotice(settings);

  //M 工作决策使用资源数据库，旧目录仅用于一次性读取。
  const resources = ctx.resources;
  const dir = path.join(resources.root, 'data', 'decision-map');
  const store = new storeModule.Store(resources.db, dir, legacyWorkspaceId);
  routesModule.mount(ctx, store, helper, notice);
  toolsModule.registerAskOwner(ctx, store, notice);
  toolsModule.registerWorkTopics(ctx, store);
}
