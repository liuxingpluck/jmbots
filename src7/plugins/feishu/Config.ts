/**
 * feishu 的配置：plugins 段写给本插件的（domain、people、groups、history_on_join）加上 config.yaml 的 channels.feishu（飞书应用清单），
 * 在 apply 里校验一次（checkConfig），交回 FeishuConfig；以后 Feishu、Inbound、Reply 直接信，不再查。错误里不带 app_secret。
 */
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as botUtils from '../../utils/Bots.ts';
import * as checks from '../../utils/Checks.ts';
import * as filesModule from '../../utils/Files.ts';

/** 拉群历史默认条数：机器人新进群自动拉、HTTP 接口不写 limit 时都用它（config.example.yaml 写同一个数）。 */
export const DEFAULT_HISTORY_LIMIT = 200;

/** 拉群历史一次最多条数（HTTP 的 limit、配置的 history_on_join 都不能超过）。 */
export const MAX_HISTORY_LIMIT = 5000;


/** 名单里的一个飞书应用，校验后。 */
export interface FeishuApp {
  /** 应用号 app_id。 */
  appId: string;
  /** 应用密钥 app_secret：只交给 SDK，不打印、不进跟踪。 */
  appSecret: string;
  /** 这个应用默认对应哪个机器人。 */
  bot: string;
  /** 可选：同一个飞书应用允许认领的多个机器人名（缺省只含 [bot]）。 */
  bots?: string[];
}


/** 一个人能让机器人做什么：owner 本人什么都能；builder 在自己的目录里写代码、跑程序；guest 只查、读、搜、答。 */
export type FeishuRole = 'owner' | 'builder' | 'guest';


/** 登记的一个人（feishu 插件配置的 people）。 */
export interface FeishuPerson {
  /** 飞书 open_id：每个飞书应用不同，同一个人在几个应用下各登记一项。 */
  openId: string;
  /** 叫什么：收件、群聊记录里用它。 */
  name: string;
  /** 哪一档；旧写法 owner: true 并成 owner，不写是 guest。 */
  role: FeishuRole;
  /** builder、guest 的目录，绝对路径（不写是运行时目录 guests/<名字>/，启动时建好；guest 的名字当不了目录名时是 guests/_guest/）；owner 是 ''。 */
  dir: string;
}


/** 登记的一个群（feishu 插件配置的 groups）。 */
export interface FeishuGroup {
  /** 飞书群号 chat_id。 */
  chatId: string;
  /** 群名；不写是 ''（用飞书查到的）。 */
  name: string;
  /** mention 只收 @ 机器人的（默认）；all 不 @ 的也收，只记不回；judge 不 @ 的也收，记完问决策模型要不要主动接话。 */
  listen: 'mention' | 'all' | 'judge';
  /** listen: judge 时决策模型的把握 ≥ 它才接话；不写用 decision 插件默认（allow_at）。 */
  judgeThreshold?: number;
  /** listen: judge 时判定要接话就转给这个外部助手（relay 的 helpers 里的名字）；不写由机器人自己接话。 */
  judgeHelper?: string;
  /** direct 只认外部助手前缀（默认，和没登记一样）；model 时 @ 机器人的话由模型判断要不要转。 */
  relay: 'direct' | 'model';
  /** 受不受信：true 时本人在这个群里说话照旧带私人记忆；不写是 false（群里的回复大家都看得到）。 */
  trusted: boolean;
  /** 每日群进度设置。省略时不挂定时。 */
  daily?: { hour: number; minute: number; bot: string; appId: string; prompt: string };
}


/** apply 校验好以后给 Feishu 的东西。 */
export interface FeishuConfig {
  /** 飞书开放平台的地址（SDK 的 domain）；默认 https://open.feishu.cn，离线测试指向假飞书。 */
  domain: string;
  /** 飞书应用，照配置的先后。 */
  apps: FeishuApp[];
  /** 认得的人：open_id → 人。 */
  people: Map<string, FeishuPerson>;
  /** 专门设过的群：chat_id → 群。 */
  groups: Map<string, FeishuGroup>;
  /** 机器人新进群时自动拉最近多少条历史；0 是不拉。默认 DEFAULT_HISTORY_LIMIT。 */
  historyOnJoin: number;
}


/**
 * 校验配置。channels.feishu 是外面进来的（config.yaml），在这里校验一次，里面直接信。
 * @param ctx 插件的 ctx（读 config.yaml、查机器人名单）。
 * @param written plugins 段里写给本插件的配置：domain、people、groups 都可选。
 * @returns 校验后的配置。
 * @throws 哪一项不对时抛错；错误里不带 app_secret。
 */
export function checkConfig(ctx: cordis.Context, written: unknown): FeishuConfig {
  let ownObject: unknown = {};
  if (typeof written === 'object' && written !== null) {
    ownObject = written;
  }
  const own = ownObject as Record<string, unknown>;
  const domain = own['domain'] ?? 'https://open.feishu.cn';
  if (typeof domain !== 'string' || !/^https?:\/\/\S+$/u.test(domain)) {
    throw new Error('feishu 插件的 domain 要写成 http:// 或 https:// 开头的地址');
  }

  const channels = ctx.resources.raw['channels'] as { feishu?: unknown } | undefined;
  const list = channels?.feishu;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error('config.yaml 的 channels.feishu 要写成一张清单，至少一个飞书应用');
  }
  const apps: FeishuApp[] = [];
  for (const [index, value] of list.entries()) {
    let itemObject: unknown = {};
    if (typeof value === 'object' && value !== null) {
      itemObject = value;
    }
    const item = itemObject as Record<string, unknown>;
    const where = `channels.feishu 第 ${String(index + 1)} 项`;
    const appId = checks.checkNonEmptyText(item['app_id'], `${where} 的 app_id`);
    const appSecret = checks.checkNonEmptyText(item['app_secret'], `${where} 的 app_secret`);
    const bot = item['bot'];
    //M 校验主机器人名字存在于已配置的机器人名单中。
    if (typeof bot !== 'string' || botUtils.getBotConfig(ctx.resources.raw, bot) === undefined) {
      throw new Error(`${where} 的 bot 要写机器人名单里有的名字`);
    }
    if (apps.some((app) => app.appId === appId)) throw new Error(`${where} 的 app_id 和前面的重了`);
    const extraBotsRaw = item['bots'];
    let botsList: string[] | undefined;
    if (extraBotsRaw !== undefined) {
      //M 校验多机器人共享账号配置的每一个追加机器人名均合法存在。
      const raw = ctx.resources.raw;
      const botsInvalid = !Array.isArray(extraBotsRaw)
        || extraBotsRaw.some((one) => typeof one !== 'string' || botUtils.getBotConfig(raw, one) === undefined);
      if (botsInvalid) {
        throw new Error(`${where} 的 bots 要写成机器人名单里已有名字的清单`);
      }
      botsList = [...new Set([bot, ...(extraBotsRaw as string[])])];
    }
    const appEntry: FeishuApp = { appId, appSecret, bot };
    if (botsList !== undefined) {
      appEntry.bots = botsList;
    }
    //M 把校验完的一项加入已配置应用清单，启动时按这个清单连飞书。
    apps.push(appEntry);
  }
  //M 校验并解析人员权限清单与群配置清单后拼出完整飞书配置对象。
  //M 机器人新进群自动拉的历史条数：不写用默认，写 0 不拉。
  const historyWritten = own['history_on_join'] ?? DEFAULT_HISTORY_LIMIT;
  const historyRule = { integer: true, min: 0, max: MAX_HISTORY_LIMIT };
  const historyOnJoin = checks.checkNumber(historyWritten, 'feishu 插件的 history_on_join（0 是进群不拉历史）', historyRule);
  const people = getPeople(ctx, own);
  const groups = getGroups(own, apps);
  return { domain: domain.replace(/\/+$/u, ''), apps, people, groups, historyOnJoin };
}


/**
 * 一张登记清单（people、groups）：不写是空的，写了要是对象的清单。
 * @param value 配置里写的。
 * @param key 哪一项，报错用。
 * @returns 每项当对象读。
 */
function getEntries(value: unknown, key: string): Record<string, unknown>[] {
  if (value === undefined) return [];
  const valid = Array.isArray(value)
    && value.every((item) => typeof item === 'object' && item !== null && !Array.isArray(item));
  if (!valid) throw new Error(`feishu 插件的 ${key} 要写成清单，每项一个对象`);
  return value as Record<string, unknown>[];
}


/** 没登记的 guest 共用的目录名：运行时目录 guests/_guest/（Inbound.ts 收消息、点卡片时也用）。 */
export const GUEST_DIR = '_guest';


/** people 里 role 能写的值。 */
const ROLES = ['owner', 'builder', 'guest'] as const;

/** groups 里 listen 能写的值。 */
const LISTENS = ['mention', 'all', 'judge'] as const;

/** groups 里 relay 能写的值。 */
const RELAYS = ['direct', 'model'] as const;

/** judge_threshold 的范围：0 到 1。 */
const THRESHOLD_RULE: checks.NumberRule = { min: 0, max: 1 };


/**
 * 认得的人：people 每项 open_id、name（必写）、role（owner / builder / guest，默认 guest）、dir（builder 的目录）。
 * builder、guest 的 dir 相对运行时目录算（写绝对路径也行），不写是 guests/<名字>/；没有就建。
 * @param ctx 用于定位运行时目录。
 * @param own feishu 插件的配置。
 * @returns open_id → 人。
 * @throws 身份字段有误、用了旧 owner 配置、编号重复或工作区路径不合法时抛错。
 */
function getPeople(ctx: cordis.Context, own: Record<string, unknown>): Map<string, FeishuPerson> {
  const people = new Map<string, FeishuPerson>();
  //M 逐条解析并校验配置里登记的人员身份档案（owner / builder / guest）。
  for (const item of getEntries(own['people'], 'people')) {
    //G 旧身份配置需要明确迁移，避免本人身份被误降为访客。
    if (Object.hasOwn(item, 'owner')) {
      throw new Error('feishu 的 people[].owner 已不用，本人改写 role: owner，其他人按角色填写或省略');
    }

    const openId = item['open_id'];
    const name = item['name'];
    if (typeof openId !== 'string' || openId === '' || typeof name !== 'string' || name === '') {
      throw new Error('feishu 插件的 people 每项要写 open_id 和 name');
    }
    if (people.has(openId)) throw new Error(`feishu 插件的 people 里 ${openId} 写了两次`);

    //M 未指定角色的登记人沿用访客权限。
    const role = checks.checkAllowedValue(item['role'] ?? 'guest', ROLES, `feishu 插件 people 里 ${name} 的 role`);

    //M builder 的目录：写了相对运行时目录算，没写是 guests/<名字>/；没有就建。owner 用不到。
    let dir = '';
    if (role === 'builder') {
      const written = item['dir'] ?? path.join('guests', name);
      if (typeof written !== 'string' || written === '') throw new Error(`feishu 插件 people 里 ${name} 的 dir 要写目录`);
      if (item['dir'] === undefined && (path.basename(name) !== name || name === '..')) {
        throw new Error(`feishu 插件 people 里 ${name} 的名字当不了目录名，给他写 dir`);
      }
      dir = path.resolve(ctx.resources.root, written);
      //M 确保已按配置解析的工作区目录存在。
      filesModule.ensureDir(dir);
    }
    //M guest 的目录：写了照写，没写是 guests/<名字>/，名字当不了目录名就用 guests/_guest/；只建这一个目录。
    if (role === 'guest') {
      let defaultGuestDir = path.join('guests', GUEST_DIR);
      if (path.basename(name) === name && name !== '..') {
        defaultGuestDir = path.join('guests', name);
      }
      const written = item['dir'] ?? defaultGuestDir;
      if (typeof written !== 'string' || written === '') throw new Error(`feishu 插件 people 里 ${name} 的 dir 要写目录`);
      dir = path.resolve(ctx.resources.root, written);
      //M 确保已按配置解析的工作区目录存在。
      filesModule.ensureDir(dir);
    }
    people.set(openId, { openId, name, role, dir });
  }

  return people;
}


/**
 * 专门设过的群：groups 每项 chat_id（必写）、name、listen（mention / all / judge，默认 mention）、
 * judge_threshold（0 到 1，可不写）、judge_helper（非空文字，可不写：判定要接话时转给这个外部助手）、relay（direct / model，默认 direct）、
 * trusted（true / false，默认 false：本人在 trusted 群里说话才带私人记忆）。
 * @param own feishu 插件的配置。
 * @returns chat_id → 群。
 * @throws 哪项没写 chat_id、chat_id 重了、listen 或 relay 写了别的值、judge_threshold 不是 0 到 1 的数、trusted 不是布尔时抛错。
 */
function getGroups(own: Record<string, unknown>, apps: FeishuApp[]): Map<string, FeishuGroup> {
  const groups = new Map<string, FeishuGroup>();
  //M 逐条解析并校验专项群规则（监听策略、决策阈值、中转方式及隐私信任标记）。
  for (const item of getEntries(own['groups'], 'groups')) {
    const chatId = item['chat_id'];
    const name = item['name'] ?? '';
    let listenWritten = item['listen'] ?? 'mention';
    const threshold = item['judge_threshold'];
    if (typeof chatId !== 'string' || chatId === '') throw new Error('feishu 插件的 groups 每项要写 chat_id');
    if (groups.has(chatId)) throw new Error(`feishu 插件的 groups 里 ${chatId} 写了两次`);
    if (typeof name !== 'string') throw new Error(`feishu 插件 groups 里 ${chatId} 的 name 要写成字符串`);

    //M 校验每日任务并从指定机器人的应用中确定唯一的发信账号。
    const daily = getGroupDaily(item['daily'], chatId, apps);
    if (daily !== undefined && item['listen'] === undefined) {
      //M 已启用日报的群默认也收没有 @ 的成员汇报。
      listenWritten = 'all';
    }

    //M 监听方式、转话方式、受不受信照公共校验查；没写的用默认。
    const where = `feishu 插件 groups 里 ${chatId} 的`;
    const listen = checks.checkAllowedValue(listenWritten, LISTENS, `${where} listen`);
    const relay = checks.checkAllowedValue(item['relay'] ?? 'direct', RELAYS, `${where} relay`);
    const trusted = checks.checkFlag(item['trusted'] ?? false, `${where} trusted`);
    const groupEntry: FeishuGroup = { chatId, name, listen, relay, trusted };
    if (threshold !== undefined) {
      groupEntry.judgeThreshold = checks.checkNumber(threshold, `${where} judge_threshold`, THRESHOLD_RULE);
    }
    //M judge_helper：可选；写了要是非空文字。
    if (item['judge_helper'] !== undefined) {
      groupEntry.judgeHelper = checks.checkNonEmptyText(item['judge_helper'], `${where} judge_helper`);
    }
    if (daily !== undefined) {
      groupEntry.daily = daily;
    }
    groups.set(chatId, groupEntry);
  }
  return groups;
}


/** 群日报入站配置的校验，匹配一个飞书发信账号并拆好本地时间。 */
function getGroupDaily(raw: unknown, chatId: string, apps: FeishuApp[]): FeishuGroup['daily'] {
  if (raw === undefined) return undefined;

  const where = 'feishu 群 ' + chatId + ' 的 daily';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(where + ' 要写 at、bot 和 prompt');
  }
  const daily = raw as Record<string, unknown>;
  const { at, bot, prompt } = daily;
  const requestedApp = daily['app_id'];
  if (typeof at !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/u.test(at)) {
    throw new Error(where + ' 的 at 要写成本地时刻 HH:mm');
  }
  if (typeof bot !== 'string' || bot.trim() === '') throw new Error(where + ' 的 bot 要写机器人名');
  if (typeof prompt !== 'string' || prompt.trim() === '') throw new Error(where + ' 的 prompt 要写非空文字');

  //M 共享应用同样接单，多个可用发信账号时由配置显式消除歧义。
  const candidates = apps.filter((app) => app.bot === bot || app.bots?.includes(bot));
  const selected = candidates.filter((app) => requestedApp === undefined || app.appId === requestedApp);
  if (selected.length !== 1) throw new Error(where + ' 要能确定一个属于该机器人的 app_id');

  //M 时间在配置入口拆开，定时器直接使用数值。
  const hour = Number(at.slice(0, 2));
  const minute = Number(at.slice(3));
  return { hour, minute, bot, appId: selected[0]!.appId, prompt: prompt.trim() };
}
