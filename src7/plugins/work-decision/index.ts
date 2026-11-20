/** 收集插件和网页的任务节点，把任务变化、选择与留言交给中控。 */
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type * as notifications from './Notify.ts';
import * as routesModule from './Routes.ts';
import * as storeModule from './Store.ts';
import * as toolsModule from './Tools.ts';

export const name = 'work-decision';
export const version = '1.3.5';
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
  const owner = storeModule.readObject(value);
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
  const settings = storeModule.readObject(config ?? {});
  const helper = getOptionalText(settings, 'relay_helper');
  const legacyWorkspaceId = getOptionalText(settings, 'legacy_workspace_id');
  const notice = getNotice(settings);

  //M 工作决策使用资源数据库，旧目录仅用于一次性读取。
  const resources = ctx.resources;
  const dir = path.join(resources.root, 'data', 'decision-map');
  const store = new storeModule.Store(resources.db, dir, legacyWorkspaceId);
  routesModule.mount(ctx, store, helper, notice);
  toolsModule.registerAskOwner(ctx, store, notice);
}
