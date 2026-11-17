/**
 * 通知：把待确认、长任务结束转到基地的右下角 toast（POST <url>，默认 engine.index_url + /notify）。
 * 也登记一个 notify_user 工具，给模型在需要时主动提醒用户。地址从配置读，不写死。
 * 基地没开或没配地址时静默跳过（工具会说明原因），不挡会话。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { Pending } from '../approval/index.ts';
import type { BaseReply } from '../base-bridge/index.ts';
import type { ProgressItem } from '../progress/index.ts';


/** 插件名。 */
export const name = 'notify';

/** 用到的服务：配置、登记工具。 */
export const inject = ['resources', 'tools'];


/** apply 校验好以后给 send 的东西。 */
interface NotifyConfig {
  /** 完整的通知地址，如 http://127.0.0.1:15762/notify。不写就用 engine.index_url + /notify。 */
  url: string;
  /** 关掉以后事件和工具都不发。 */
  enabled: boolean;
}


/** 发给基地的一条通知。 */
interface Notice {
  title: string;
  body: string;
  level?: 'info' | 'warn' | 'error';
  url?: string;
}


/** 调基地最多等多久。 */
const TIMEOUT_MS = 3000;

/** 已经为哪一场进度的哪个结局弹过，避免同一结局弹两次。 */
const toasted = new Set<string>();


/**
 * 请基地弹一条通知。没配地址或关掉了就跳过。
 * 2026-11-17 jm开发：原来是 ctx.notify 服务（class Notify），没有别的插件调，去掉服务只留这个函数给本插件的工具和事件用。
 * @param ctx 用时获取可选的基地服务。
 * @param config 独立通知地址和开关。
 * @param notice 标题、正文、级别、可选链接。
 * @returns 发出去了，或跳过/失败的原因。
 */
async function send(ctx: cordis.Context, config: NotifyConfig, notice: Notice): Promise<string> {
  if (!config.enabled) return '通知已关掉';
  //M 显式 notify.url 优先；默认只给相对路径，不再读取和拼接 engine.index_url。
  const base = ctx.get('base');
  if (base === undefined && config.url === '') return '没挂 base-bridge，无法发送基地通知';
  try {
    let response: BaseReply;
    if (base !== undefined) {
      response = await base.postJson(config.url || '/notify', notice, TIMEOUT_MS);
    } else {
      //M 显式通知地址可以独立使用；没装基地插件时直接发，不读取或推测 engine.index_url。
      const sent = await fetch(config.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(notice),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      response = { status: sent.status, body: await sent.text() };
    }
    if (response.status < 200 || response.status >= 300) {
      const text = JSON.stringify(response.body) ?? '';
      return `基地通知接口回了 ${String(response.status)}：${text.slice(0, 200)}`;
    }
    return '已发出通知';
  } catch (error) {
    if (base === undefined) return '基地没响应';
    return error instanceof Error ? error.message : String(error);
  }
}


/**
 * 挂上通知：登记工具，听待确认、长任务结束。
 * @param ctx Cordis 给这个插件的 ctx。
 * @param config 插件自己的那段配置。
 */
export function apply(ctx: cordis.Context, config: unknown): void {
  const raw = (config ?? {}) as { url?: unknown; enabled?: unknown };
  //M 插件只处理自己的覆盖地址；默认地址由 ctx.base 统一持有。
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  const enabled = raw.enabled !== false;
  const notifyConfig: NotifyConfig = { url, enabled };

  //M 登记 notify_user 工具：模型在需要时主动提醒用户。
  ctx.tools.register({
    definition: {
      name: 'notify_user',
      description: '在用户电脑右下角弹一条系统通知（短标题和正文）。用户可能没看着聊天窗口时用。',
      parameters: piAi.Type.Object({
        title: piAi.Type.String({ description: '标题，一两句话以内' }),
        body: piAi.Type.String({ description: '正文' }),
        level: piAi.Type.Optional(piAi.Type.Union([
          piAi.Type.Literal('info'),
          piAi.Type.Literal('warn'),
          piAi.Type.Literal('error'),
        ], { description: '级别，不写是 info' })),
      }),
    },
    kinds: ['front', 'work'],
    run: (args) => {
      const level = args['level'];
      const notice: Notice = {
        title: String(args['title'] ?? ''),
        body: String(args['body'] ?? ''),
        ...(level === 'info' || level === 'warn' || level === 'error' ? { level } : {}),
        ...(pageUrl(ctx) === undefined ? {} : { url: pageUrl(ctx) }),
      };
      return send(ctx, notifyConfig, notice);
    },
  });

  //M 听待确认：弹一条“有待确认”。
  ctx.on('approval/asked', (pending: Pending) => {
    void send(ctx, notifyConfig, {
      title: '有待确认',
      body: pending.title,
      level: 'warn',
      ...(pageUrl(ctx) === undefined ? {} : { url: pageUrl(ctx) }),
    });
  });

  //M 听长任务结束：同一结局只弹一次。
  const done: ProgressItem['stage'][] = ['done', 'error', 'stopped', 'timeout', 'flagged', 'handed'];
  ctx.on('progress/update', (item: ProgressItem) => {
    if (!done.includes(item.stage)) return;
    const key = `${item.sessionId}:${item.id}:${item.stage}`;
    if (toasted.has(key)) return;
    toasted.add(key);
    const title = item.stage === 'done' ? '任务完成' : item.stage === 'error' ? '任务出错' : '任务结束';
    const body = (item.result ?? item.action ?? item.text).slice(0, 200);
    void send(ctx, notifyConfig, {
      title,
      body,
      level: item.stage === 'error' ? 'error' : 'info',
      ...(pageUrl(ctx) === undefined ? {} : { url: pageUrl(ctx) }),
    });
  });

  const vars = { 地址: url === '' ? 'ctx.base /notify' : url, 开着: enabled };
  ctx.emit('trace', 'notify.apply', '通知转到基地右下角', 'POST <url> {title, body}', vars);
}


/**
 * 网页入口，给通知带一个可点的链接。
 * @param ctx 用来读 server.port。
 * @returns 本机网页地址；没有端口就不带。
 */
function pageUrl(ctx: cordis.Context): string | undefined {
  const server = (ctx.resources.raw['server'] ?? {}) as { port?: unknown };
  return typeof server.port === 'number' ? `http://127.0.0.1:${String(server.port)}/` : undefined;
}
