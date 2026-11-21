/**
 * 飞书发件箱：外面的程序往运行时目录 integrations/feishu/outbox/ 放 .md 文件，每 5 秒扫发一次。
 * 支持通过可选文件头（--- 块：app_id / bot / chat_id）或 plugins.feishu.outbox 配置路由到指定飞书应用、机器人或聊天；
 * 缺省保持原兼容（优先走第一个已私聊过的应用最近私聊人）。
 * 单份 .md 发送失败时捕获异常记日志并移入 integrations/feishu/failed/，绝不死循环重试或卡住同批后续文件。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as namesModule from '../../../utils/Names.ts';
import * as textModule from '../../../utils/Text.ts';
import type { Feishu, FeishuAddress } from '../index.ts';


/** 多久看一次，毫秒。 */
export const OUTBOX_INTERVAL_MS = 5000;

/** 发件箱可选路由元数据。 */
export interface OutboxHeader {
  /** 指定飞书应用号。 */
  appId?: string;
  /** 指定机器人名。 */
  bot?: string;
  /** 指定目标聊天号（群或私聊 chat_id）。 */
  chatId?: string;
  /** 去掉文件头后的正文。 */
  body: string;
}

/** 发件箱三个工作目录。 */
export interface OutboxDirs {
  /** 待发目录。 */
  outbox: string;
  /** 已发归档目录。 */
  sent: string;
  /** 投递失败隔离目录（防卡死后续文件）。 */
  failed: string;
}


/**
 * 剥离单行值首尾可选成对引号。
 */
function unquoteValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}


/**
 * 解析发件箱 .md 顶部可选的 --- 路由头（支持 app_id/appId、bot、chat_id/chatId/to）。
 * 未带合法闭合 --- 头时，全文原样作为 body。
 * @param raw .md 文件原文。
 * @returns 路由头与正文。
 */
export function parseOutboxMarkdown(raw: string): OutboxHeader {
  const clean = raw.replace(/^\uFEFF/u, '');
  if (!/^---\r?\n/u.test(clean)) {
    return { body: clean.trim() };
  }

  const lines = clean.split(/\r?\n/u);
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() === '---') {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex < 0) {
    return { body: clean.trim() };
  }

  const header: OutboxHeader = {
    body: lines.slice(closeIndex + 1).join('\n').trim(),
  };
  let recognized = false;
  for (let i = 1; i < closeIndex; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '' || line.startsWith('#')) continue;

    const colon = line.indexOf(':');
    if (colon <= 0) continue;

    const key = line.slice(0, colon).trim();
    const val = unquoteValue(line.slice(colon + 1));
    if (val === '') continue;

    if (key === 'app_id' || key === 'appId') {
      header.appId = val;
      recognized = true;
    }
    if (key === 'bot') {
      header.bot = val;
      recognized = true;
    }
    if (key === 'chat_id' || key === 'chatId' || key === 'to') {
      header.chatId = val;
      recognized = true;
    }
  }
  //G 头部块里一个已知路由键都没解析到时，按普通 Markdown 水平线正文回退，不静默吞掉正文。
  if (!recognized) {
    return { body: clean.trim() };
  }
  return header;
}


/**
 * 按机器人名挑选飞书应用：优先选已有最近私聊记录的那个应用，否则取第一个匹配应用。
 */
function pickAppIdByBot(feishu: Feishu, botName: string): string {
  const matched = feishu.config.apps.filter((app) => app.bot === botName || app.bots?.includes(botName));
  const [first] = matched;
  if (first === undefined) {
    throw new Error(`发件箱指定的机器人 ${botName} 没有绑定飞书应用`);
  }
  for (const app of matched) {
    if (feishu.lastPrivate(app.appId) !== undefined) return app.appId;
  }
  return first.appId;
}


/**
 * 综合文件头与插件默认配置，解析本次发件箱文件的飞书投递地址。
 * @param feishu 飞书渠道实例。
 * @param header 解析后的文件头。
 * @returns 目标飞书回话地址。
 */
export function resolveOutboxTarget(feishu: Feishu, header: OutboxHeader): FeishuAddress {
  const cfgOutbox = feishu.config.outbox;
  let appId = '';

  //M 优先级：文件头 app_id → 文件头 bot → 配置 outbox.app_id → 配置 outbox.bot → 首个已有私聊记录的应用。
  if (header.appId !== undefined) {
    if (!feishu.apps.has(header.appId)) {
      throw new Error(`发件箱指定的飞书应用不存在：${header.appId}`);
    }
    appId = header.appId;
  }
  if (appId === '' && header.bot !== undefined) {
    appId = pickAppIdByBot(feishu, header.bot);
  }
  if (appId === '' && cfgOutbox?.appId !== undefined) {
    appId = cfgOutbox.appId;
  }
  if (appId === '' && cfgOutbox?.bot !== undefined) {
    appId = pickAppIdByBot(feishu, cfgOutbox.bot);
  }
  if (appId === '') {
    for (const app of feishu.config.apps) {
      if (feishu.lastPrivate(app.appId) !== undefined) {
        appId = app.appId;
        break;
      }
    }
  }
  if (appId === '') {
    appId = feishu.config.apps[0]?.appId ?? '';
  }
  if (appId === '' || !feishu.apps.has(appId)) {
    throw new Error('没有可用的飞书应用');
  }

  //M 指定了 chatId 时直投该会话；否则投给所选应用最近私聊的人。
  const chatId = header.chatId ?? cfgOutbox?.chatId;
  if (chatId !== undefined && chatId !== '') {
    let chatType = '';
    if (feishu.config.groups.has(chatId) || feishu.chats.has(chatId)) {
      chatType = 'group';
    }
    return { appId, chatId, messageId: '', openId: '', chatType };
  }

  const lastP2p = feishu.lastPrivate(appId);
  if (lastP2p === undefined) {
    throw new Error(`飞书应用 ${appId} 还没有人私聊过，不知道发给谁`);
  }
  return lastP2p;
}


/**
 * 生成不覆盖旧文件的归档路径：目标已存在时自动追加时间戳与序号后缀。
 * @param dest 原目标绝对路径。
 * @returns 不与现有文件冲突的最终目标路径。
 */
function getUniqueArchivePath(dest: string): string {
  if (!fs.existsSync(dest)) return dest;

  const dir = path.dirname(dest);
  const ext = path.extname(dest);
  const stem = path.basename(dest, ext);
  const stamp = namesModule.createTimestampId();
  let candidate = path.join(dir, `${stem}_${stamp}${ext}`);
  let seq = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${stem}_${stamp}_${String(seq)}${ext}`);
    seq += 1;
  }
  return candidate;
}


/**
 * 安全移动发件箱文件：目标已存在时自动加时间戳/序号防覆盖，跨设备改名失败时退回复制后删除。
 * @param from 源文件路径。
 * @param to 期望目标路径。
 * @returns 实际落盘的目标路径。
 */
function moveOutboxFile(from: string, to: string): string {
  const target = getUniqueArchivePath(to);
  try {
    fs.renameSync(from, target);
  } catch {
    fs.copyFileSync(from, target);
    fs.rmSync(from, { force: true });
  }
  return target;
}


/**
 * 单轮扫描并投递发件箱中的全部 .md 文件；发送与归档分开 try，单份异常记入 failed/，绝不阻断后续文件。
 * 发送成功但归档失败的文件记入 sentUnarchived，本进程内不再重复发送。
 * @param feishu 飞书渠道实例。
 * @param ctx 插件上下文。
 * @param dirs 待发、已发与失败隔离目录。
 * @param sentUnarchived 本进程内已发但归档失败的文件名集合（防下轮重复发送）。
 * @returns 本轮成功与失败文件名列表（便于单测断言）。
 */
export async function scanOutboxOnce(
  feishu: Feishu,
  ctx: cordis.Context,
  dirs: OutboxDirs,
  sentUnarchived: Set<string> = new Set(),
): Promise<{ sent: string[]; failed: string[] }> {
  const sentFiles: string[] = [];
  const failedFiles: string[] = [];
  const names = fs.readdirSync(dirs.outbox).filter((name) => name.endsWith('.md')).sort();

  //M 已被移出 outbox/ 的旧卡滞记录从内存集合清掉，不挡后续同名新文件。
  const present = new Set(names);
  for (const stuck of sentUnarchived) {
    if (!present.has(stuck)) {
      sentUnarchived.delete(stuck);
    }
  }

  for (const name of names) {
    //G 已发送成功但归档失败的残留文件，本进程内不再重复发送。
    if (sentUnarchived.has(name)) continue;

    const from = path.join(dirs.outbox, name);
    const stat = fs.statSync(from, { throwIfNoEntry: false });
    if (stat === undefined || !stat.isFile()) continue;

    let routedAppId = '';
    let bodyLength = 0;
    try {
      const raw = fs.readFileSync(from, 'utf8');
      const parsed = parseOutboxMarkdown(raw);
      bodyLength = parsed.body.length;
      if (parsed.body !== '') {
        const target = resolveOutboxTarget(feishu, parsed);
        routedAppId = target.appId;
        await feishu.sendText(target, parsed.body);
      }
    } catch (error) {
      const failedAt = new Date().toLocaleString('zh-CN', { hour12: false });
      const reason = textModule.getErrorMessage(error);
      console.error(`${failedAt} 飞书发件箱：${name} 发送失败，已移入 failed/：${reason}`);
      try {
        moveOutboxFile(from, path.join(dirs.failed, name));
      } catch (moveErr) {
        const moveReason = textModule.getErrorMessage(moveErr);
        console.error(`${failedAt} 飞书发件箱：移入 failed/ 失败（${name}）：${moveReason}`);
      }
      failedFiles.push(name);
      continue;
    }

    //M 发送成功后独立归档：归档抛错绝不当发送失败重发，登记进内存 Set 避免 5 秒轮询重复发送。
    try {
      moveOutboxFile(from, path.join(dirs.sent, name));
    } catch (archiveErr) {
      const failedAt = new Date().toLocaleString('zh-CN', { hour12: false });
      const archiveReason = textModule.getErrorMessage(archiveErr);
      console.error(`${failedAt} 飞书发件箱：${name} 已发但归档失败，本进程内不再重发：${archiveReason}`);
      sentUnarchived.add(name);
    }
    sentFiles.push(name);

    //T 跟踪：发件箱发出一份。
    const vars = { file: name, appId: routedAppId, length: bodyLength };
    ctx.emit('trace', 'Outbox.tick', 'trace.feishu.sendOutbox', 'feishu.sendText(target, body)', vars);
  }
  return { sent: sentFiles, failed: failedFiles };
}


/**
 * 开发件箱：ready 时开定时器，插件被拔掉时停。
 * @param feishu 飞书渠道。
 * @param ctx 本插件的 ctx。
 */
export function setup(feishu: Feishu, ctx: cordis.Context): void {
  const dirs: OutboxDirs = {
    outbox: ctx.resources.ensureRuntimeDir('integrations', 'feishu', 'outbox'),
    sent: ctx.resources.ensureRuntimeDir('integrations', 'feishu', 'sent'),
    failed: ctx.resources.ensureRuntimeDir('integrations', 'feishu', 'failed'),
  };
  const sentUnarchived = new Set<string>();
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  /** 看一遍发件箱。 */
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await scanOutboxOnce(feishu, ctx, dirs, sentUnarchived);
    } finally {
      busy = false;
    }
  };

  ctx.on('ready', () => {
    timer = setInterval(() => {
      //M 周期性触发发件箱扫描投递，防重入由内部 busy 标志位兜底。
      void tick();
    }, OUTBOX_INTERVAL_MS);
  });

  //M 插件被拔掉时停定时器。
  ctx.effect(() => {
    return () => {
      if (timer !== undefined) clearInterval(timer);
    };
  });
}
