/**
 * 会话上下文与总结、压缩（由 compress、context-fit、summary 合一；主名沿用被依赖/后置裁剪最靠后的 context-fit）：
 *   1. Summary（Summary.ts，听 session/change）：干活的会话做完一轮写一句总结进 row.summary；
 *   2. Compress（Compress.ts，先听 session/request）：上一步用量达到阈值时把旧对话压成摘要（写 compress_log）；
 *   3. ContextFit（本文件，后听 session/request）：压缩后仍超预算时，先省略旧工具结果、再按段丢掉最早对话。
 * 顺序保证：Compress 必须排在 ContextFit 之前注册到 session/request，才能先把超长历史压缩后再做窗口裁剪。
 * 设计见同目录 说明.md 的「设计要点」一节。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import type * as dbModule from '../db/index.ts';
import * as compressModule from './Compress.ts';
import compressionSql from './migrations/0000_compress_log.sql' with { type: 'text' };
import * as summaryModule from './Summary.ts';


export { readCompressSettings, type CompressConfig, type CompressSettings } from './Compress.ts';
export { readSummaryEnabled } from './Summary.ts';


/** 插件名。 */
export const name = 'context-fit';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
export const version = '1.1.2';

/** Resources 读模型上限，Sessions 开小会话，db 管压缩表。 */
export const inject = ['resources', 'sessions', 'db'];

/** 启用压缩时先确认已有或新建的压缩记录可用。 */
const compressionMigrations: dbModule.MigrationPlan = {
  plugin: name,
  migrations: [{ version: 1, sql: compressionSql }],
};


/** 插件配置。 */
export interface Config {
  /** 最近几条工具结果、几段对话一定原样留，默认 6。 */
  keep: number;
  /** 上限的几成拿来装，默认 0.9。 */
  ratio: number;
}

/** 裁完的结果。 */
export interface Fitted {
  messages: piAi.Message[];
  tokens: number;
  trimmed: number;
  dropped: number;
}

/** 模型清单回执中裁剪用到的字段。 */
interface CatalogWindow {
  /** 模型窗口上限，单位 token。 */
  contextWindow: number;
}

/** 模型目录查询最多等三秒。 */
const CATALOG_WAIT_MS = 3000;

/**
 * 估 token：JSON 以后的 UTF-8 字节数 ÷ 3（中文一个字约 1 token、3 字节；英文估偏多，宁可多留余量）。
 * @param value 任意可 JSON 化的东西。
 * @returns 估算占用的 token 数（向上取整）。
 */
export function estimate(value: unknown): number {
  return Math.ceil(Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8') / 3);
}

/**
 * 一条工具结果换成“已省略”。
 * @param message 工具结果。
 * @param order 第几条（从 1 数）。
 */
function trimmed(message: piAi.ToolResultMessage, order: number): piAi.ToolResultMessage {
  let length = 0;
  for (const block of message.content) {
    if (block.type === 'text') {
      length += block.text.length;
    }
  }
  const text = `（第 ${String(order)} 条工具结果已省略，以装进模型上下文：原来 ${String(length)} 字。要用就重新调工具。）`;
  return { ...message, content: [{ type: 'text', text }] };
}

/**
 * 切段：一条用户消息自成一段；一条模型回答连同紧跟它的工具结果算一段。
 * @returns 每段是一组下标。
 */
function blocks(messages: piAi.Message[]): number[][] {
  const result: number[][] = [];
  for (const [index, message] of messages.entries()) {
    const last = result.at(-1);
    if (message.role === 'toolResult' && last !== undefined) {
      last.push(index);
      continue;
    }
    result.push([index]);
  }
  return result;
}

/**
 * 按预算裁。不改传进来的数组。
 * @param messages 要发的对话。
 * @param budget 最多给对话多少 token。
 * @param keep 最近几条工具结果、几段一定原样留。
 * @returns 裁剪后的消息数组、估算 token 数及替换与丢弃条数统计。
 */
export function fit(messages: piAi.Message[], budget: number, keep: number): Fitted {
  //G 先估算原对话总 token，没超预算就直接原样返回，不做裁剪。
  let current = [...messages];
  let tokens = estimate(current);
  if (tokens <= budget) return { messages: current, tokens, trimmed: 0, dropped: 0 };

  //M 1. 早的工具结果换成“已省略”：从最早的开始，最近 keep 条不动，够了就停。
  const tools: number[] = [];
  for (const [index, message] of current.entries()) {
    if (message.role === 'toolResult') {
      tools.push(index);
    }
  }
  let count = 0;
  for (const [order, index] of tools.slice(0, Math.max(0, tools.length - keep)).entries()) {
    if (tokens <= budget) {
      break;
    }
    //M 把这条旧工具结果换为省略占位文本，并按差值即时扣减总 token 估算。
    const message = current[index] as piAi.ToolResultMessage;
    const replaced = trimmed(message, order + 1);
    tokens += estimate(replaced) - estimate(message);
    current[index] = replaced;
    count += 1;
  }
  if (tokens <= budget) return { messages: current, tokens, trimmed: count, dropped: 0 };

  //M 2. 还装不下：从最早成段丢；最后一条用户消息所在的段和最近 keep 段不丢。
  const parts = blocks(current);
  const lastUser = parts.findLastIndex((part) => current[part[0] ?? 0]?.role === 'user');
  let userBound = parts.length;
  if (lastUser >= 0) {
    userBound = lastUser;
  }
  const limit = Math.min(parts.length - keep, userBound);
  let cutAt = 0;
  let dropped = 0;
  while (tokens > budget && cutAt < limit) {
    const part = parts[cutAt] ?? [];
    tokens -= estimate(part.map((index) => current[index]));
    dropped += part.length;
    cutAt += 1;
  }
  if (cutAt > 0) {
    const from = parts[cutAt]?.[0] ?? current.length;
    const notice: piAi.Message = {
      role: 'user',
      content: `（更早的 ${String(dropped)} 条对话已省略，以装进模型上下文；需要的话问用户或重新查。）`,
      timestamp: Date.now(),
    };
    current = [notice, ...current.slice(from)];
    tokens = estimate(current);
  }
  return { messages: current, tokens, trimmed: count, dropped };
}


/**
 * 校验插件配置。
 * @throws keep 不是非负整数、ratio 不在 (0, 1] 时抛错。
 */
function readConfig(config: Record<string, unknown> | undefined): Config {
  const keep = config?.['keep'] ?? 6;
  const ratio = config?.['ratio'] ?? 0.9;
  if (typeof keep !== 'number' || !Number.isInteger(keep) || keep < 0) {
    throw new Error('context-fit 的 keep 要是不小于 0 的整数');
  }
  if (typeof ratio !== 'number' || ratio <= 0 || ratio > 1) throw new Error('context-fit 的 ratio 要大于 0、不大于 1');
  return { keep, ratio };
}


/**
 * 挂上总结、压缩与上下文裁剪。
 * 按固定先后挂载：先挂总结（session/change）→ 再挂压缩（先听 session/request）→ 最后挂上下文裁剪（后听 session/request）。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param raw 插件配置（可带 keep、ratio，以及子配置 compress、summary）。
 * @throws `keep`、`ratio`、`compress` 或 `summary` 配置不合法时抛错。
 * 副作用：按顺序挂载 Summary、Compress（若启用）以及 `session/request` 窗口裁剪监听。
 */
export function apply(ctx: cordis.Context, raw: Record<string, unknown> | undefined): void {
  //M 入口统一校验裁剪、总结与压缩三部分配置，不合法直接阻止加载。
  const config = readConfig(raw);
  const summaryEnabled = summaryModule.readSummaryEnabled(raw?.['summary']);
  const compressSettings = compressModule.readCompressSettings(raw?.['compress']);

  //M 若启用总结，最先挂载 Summary 监听会话完成事件。
  if (summaryEnabled) {
    new summaryModule.Summary(ctx);
  }
  //M 顺序关键：Compress 必须在 ContextFit 之前监听 session/request，使压缩后的 [摘要, ...尾部] 继续接受窗口预算裁剪。
  if (compressSettings.enabled) {
    //M 启动时先迁移自有表，再让 Compress 开始查询和保存摘要。
    ctx.db.migrate(compressionMigrations);
    const compressConfig = { at: compressSettings.at, keep: compressSettings.keep };
    const orm = ctx.db.orm;
    new compressModule.Compress(ctx, compressConfig, orm);
  }

  //M 听 session/request：所有种类的会话都裁。
  ctx.on('session/request', async (request) => {
    const lookup = { action: 'find', model: request.model } as const;
    const options = {
      timeoutMs: CATALOG_WAIT_MS,
      signal: request.signal,
      onFallback: () => ({ requestId: '' }),
    };

    //M 先问清单的窗口上限，会话喊停时结束这次等待。
    const result = await requestEventModule.requestEvent(
      ctx,
      'model-catalog/request',
      'model-catalog/result',
      lookup,
      options,
    );
    const info: CatalogWindow | undefined = result.info;
    let window = info?.contextWindow ?? 0;
    if (window === 0) {
      //M 没有目录上限就用 providers 手写的上限。
      const model = ctx.resources.getModel(request.model);
      window = model.contextWindow;
    }

    //G 上限不为正数时跳过裁剪。
    if (window <= 0) return;

    //G 扣除系统提示与工具定义占用后算出对话预算，未超预算时直接放行。
    const budget = Math.floor(window * config.ratio) - estimate(request.system) - estimate(request.tools);
    const before = estimate(request.messages);
    if (before <= budget) return;

    //M 超预算时按既定策略裁剪旧工具结果或早期对话，并将结果写回请求。
    const fitted = fit(request.messages, budget, config.keep);
    request.messages = fitted.messages;

    //T 跟踪：裁了。
    const vars = {
      会话: request.session.id, 模型: request.model, 上限: window, 预算: budget,
      裁前: before, 裁后: fitted.tokens, 换掉: fitted.trimmed, 丢了: fitted.dropped,
    };
    ctx.emit('trace', 'ContextFit.fit', '装不下，裁了旧的工具结果', 'fit(request.messages, budget, keep)', vars);
  });
}
