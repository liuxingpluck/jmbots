/**
 * 会话上下文与总结、压缩（由 compress、context-fit、summary 合一；主名沿用被依赖/后置裁剪最靠后的 context-fit）：
 *   1. Summary（Summary.ts，听 session/change）：干活的会话做完一轮写一句总结进 row.summary；
 *   2. Compress（Compress.ts）：上一步用量达到模型窗口比例时把旧对话压成摘要（写 compress_log）；
 *   3. ContextFit（本文件）：压缩后仍超预算时，先省略旧工具结果、再按段丢掉最早对话。
 * 在同一个 session/before-model 监听里先按窗口压缩，再裁剪请求。
 * 设计见同目录 说明.md 的「设计要点」一节。
 */
import type * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import * as requestEventModule from '../../utils/RequestEvent.ts';
import * as utils from '../../utils/index.ts';
import type * as dbModule from '../db/index.ts';
import * as compressModule from './Compress.ts';
import compressionSql from './migrations/0000_compress_log.sql' with { type: 'text' };
import * as summaryModule from './Summary.ts';


export { readCompressSettings, type CompressConfig, type CompressSettings } from './Compress.ts';
export { readSummaryEnabled } from './Summary.ts';


/** 插件名。 */
export const name = 'context-fit';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
export const version = '1.1.3';

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
  /** 裁剪后保留的对话消息 Message。role 区分消息种类，content 放内容，timestamp 记时间。 */
  messages: piAi.Message[];
  tokens: number;
  trimmed: number;
  dropped: number;
}

/** 求得的两个窗口，0 表示无可用窗口。 */
interface ModelWindow {
  /** 真实登记的窗口，用于决定是否压缩。 */
  registered: number;
  /** 裁剪允许使用既有的估算窗口。 */
  fit: number;
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
 * @param message 工具结果 ToolResultMessage。toolCallId 对应调用，content 存正文和图片，isError 标记失败。
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
 * 先查模型目录，再查经过 Resources 校验的手写配置。
 * @param ctx 插件上下文，用来查模型目录和配置。
 * @param modelName 要发请求的供应商名/模型 ID。
 * @param signal 会话的取消信号，启动检查时省略。
 * @returns 压缩使用已登记的窗口，裁剪也可使用既有的估算值。
 */
async function readModelWindow(ctx: cordis.Context, modelName: string, signal?: AbortSignal): Promise<ModelWindow> {
  const lookup = { action: 'find', model: modelName } as const;
  const options = {
    timeoutMs: CATALOG_WAIT_MS,
    signal,
    onFallback: () => ({ requestId: '' }),
  };
  //M 两个处理阶段共用这次目录查询。会话取消时结束等待。
  const result = await requestEventModule.requestEvent(
    ctx,
    'model-catalog/request',
    'model-catalog/result',
    lookup,
    options,
  );
  const info = result.info;
  const listed = info?.contextWindow ?? 0;
  if (listed > 0 && info?.contextWindowEstimated !== true) return { registered: listed, fit: listed };

  //M 从原始配置识别明确登记的窗口，Resources 的校验结果会为省略项补估算值。
  const slash = modelName.indexOf('/');
  const providerName = modelName.slice(0, slash);
  const modelId = modelName.slice(slash + 1);
  const rawProvider = utils.getField(ctx.resources.raw['providers'], providerName);
  const rawModels = utils.getField(rawProvider, 'models');
  const rawModel = utils.getField(rawModels, modelId);
  const written = utils.getField(rawModel, 'context_window');
  if (typeof written === 'number' && written > 0) return { registered: written, fit: written };

  //G 压缩只认登记值。裁剪继续用模型目录或 Resources 的保守估算。
  if (listed > 0) return { registered: 0, fit: listed };
  if (ctx.resources.config.providers[providerName] === undefined) return { registered: 0, fit: 0 };

  const model = ctx.resources.getModel(modelName);
  return { registered: 0, fit: model.contextWindow };
}

/** 启动时汇总默认模型、手写模型和兼容配置中的未登记窗口。 */
async function warnMissingWindows(ctx: cordis.Context): Promise<void> {
  const config = ctx.resources.config;
  const names = new Set([config.defaultModel]);
  //M 纳入所有在 providers 里列出或自定义兼容方式的模型。
  utils.eachEntry(config.providers, (providerName, provider) => {
    const ids = [...Object.keys(provider.models), ...Object.keys(provider.modelCompat)];
    for (const id of ids) {
      names.add(`${providerName}/${id}`);
    }
  });

  const missing: string[] = [];
  for (const name of names) {
    //M 使用与请求相同的登记规则，查不到就加入本次启动的汇总。
    const window = await readModelWindow(ctx, name);
    if (window.registered === 0) {
      missing.push(name);
    }
  }
  if (missing.length === 0) return;

  const models = missing.join('、');
  console.warn(`context-fit 有模型尚未登记上下文窗口，自动压缩会跳过 ${models}`);
}


/**
 * 挂上总结、压缩与上下文裁剪。
 * 模型请求先压缩历史，再按窗口预算裁剪。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param raw 插件配置（可带 keep、ratio，以及子配置 compress、summary）。
 * @throws `keep`、`ratio`、`compress` 或 `summary` 配置不合法时抛错。
 * 副作用：挂载总结与模型请求监听，启动时汇总缺少窗口的模型。
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
  let compress: compressModule.Compress | undefined;
  if (compressSettings.enabled) {
    //M 启动时先迁移自有表，再准备查询和保存摘要。
    ctx.db.migrate(compressionMigrations);
    const compressConfig = { ratio: compressSettings.ratio, keep: compressSettings.keep };
    const orm = ctx.db.orm;
    compress = new compressModule.Compress(ctx, compressConfig, orm);
  }

  //M 启动时等模型目录监听挂好，再汇总一次窗口登记。
  ctx.once('ready', () => warnMissingWindows(ctx));

  //M 查一次模型窗口，先按登记值压缩，再按裁剪预算处理请求。
  ctx.on('session/before-model', async (request) => {
    const windows = await readModelWindow(ctx, request.model, request.signal);
    if (request.signal.aborted) return;

    if (compress !== undefined) {
      //M 先写入摘要，再让裁剪计算这一轮真正要发的消息。
      await compress.onRequest(request, windows.registered);
    }

    //G 上限不为正数时跳过裁剪。
    const window = windows.fit;
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
      session: request.session.id, model: request.model, contextLimit: window, budget: budget,
      tokensBefore: before, tokensAfter: fitted.tokens, trimmedCount: fitted.trimmed, droppedCount: fitted.dropped,
    };
    ctx.emit('trace', 'ContextFit.fit', 'trace.contextFit.trim', 'fit(request.messages, budget, keep)', vars);
  });
}
