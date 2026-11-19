/**
 * 基地通知（由原 notify 并入 base-bridge）：把待确认、长任务结束转到基地的右下角 toast（POST <url>，默认 ctx.base /notify）。
 * 也登记 notify_user 工具，给模型在需要时主动提醒用户。
 * 默认关闭：需在 plugins[base-bridge].config.notify 显式传 true 或对象（如 { url }）才开启。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import * as textModule from '../../utils/Text.ts';
import type { BaseReply } from './index.ts';


/** approval/asked 通知携带的最小字段（不从 approval/index.ts 引类型）。 */
interface AskedNotice {
  title: string;
}

/** progress/update 通知携带的最小字段（不从 progress/index.ts 引类型）。 */
interface ProgressNotice {
  id: number;
  sessionId: string;
  text: string;
  stage: string;
  action?: string;
  result?: string;
}


/** `plugins[base-bridge].config.notify` 校验后配置。 */
export interface NotifySettings {
  /** 是否启用通知监听与 notify_user 工具（未传或传 false 时默认关闭）。 */
  enabled: boolean;
  /** 显式覆盖的通知完整地址（空串则走 ctx.base '/notify'）。 */
  url: string;
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


/**
 * 校验并读取 `plugins[base-bridge].config.notify`（默认关闭）。
 * @param raw `config.notify`；`undefined` 或 `false` 返回 `{ enabled: false, url: '' }`，`true` 或 `{ ... }` 开启并校验字段。
 * @returns 校验并归一化后的通知配置（`enabled` 与去掉首尾空白的 `url`）。
 * @throws 类型不合法时抛错。
 */
export function readNotifySettings(raw: unknown): NotifySettings {
  if (raw === undefined || raw === false) return { enabled: false, url: '' };

  if (raw === true) return { enabled: true, url: '' };

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('base-bridge.notify 要是 true、false 或对象');
  }
  const own = raw as { url?: unknown; enabled?: unknown };
  if (own.url !== undefined && typeof own.url !== 'string') {
    throw new Error('base-bridge.notify.url 要是字符串');
  }
  if (own.enabled !== undefined && typeof own.enabled !== 'boolean') {
    throw new Error('base-bridge.notify.enabled 要是 true 或 false');
  }
  let url = '';
  if (typeof own.url === 'string') {
    url = own.url.trim();
  }
  return { enabled: own.enabled !== false, url };
}


/** 网页入口，给通知带一个可点的链接；没有端口就不带。 */
function pageUrl(ctx: cordis.Context): string | undefined {
  const server = (ctx.resources.raw['server'] ?? {}) as { port?: unknown };
  if (typeof server.port === 'number') return `http://127.0.0.1:${String(server.port)}/`;

  return undefined;
}


/** 请基地弹一条通知。没配地址或关掉了就跳过。 */
async function sendNotice(ctx: cordis.Context, settings: NotifySettings, notice: Notice): Promise<string> {
  if (!settings.enabled) return '通知已关掉';

  //M 显式 notify.url 优先；默认只给相对路径，由基地服务补全。
  const base = ctx.get('base');
  if (base === undefined && settings.url === '') return '没挂 base-bridge，无法发送基地通知';

  try {
    const postNotice = async (): Promise<BaseReply> => {
      //M 若已挂载基地服务就优先通过它发通知，拿状态码判断基地是否收下。
      if (base !== undefined) return base.postJson(settings.url || '/notify', notice, TIMEOUT_MS);

      //M 显式通知地址可以独立使用；独立于基地服务，直接发到该地址。
      const sent = await fetch(settings.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(notice),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      //M 读出原始响应文本连同状态码返回，供外层判断通知是否成功。
      return { status: sent.status, body: await sent.text() };
    };
    //M 执行发送并拿到统一结构的回应，用于下面检查 2xx 状态码。
    const response = await postNotice();
    if (response.status < 200 || response.status >= 300) {
      const text = JSON.stringify(response.body) ?? '';
      return `基地通知接口回了 ${String(response.status)}：${text.slice(0, 200)}`;
    }
    return '已发出通知';
  } catch (error) {
    if (base === undefined) return '基地没响应';

    //M 已挂 base-bridge 时抽取可读错误信息回传给工具调用方。
    return textModule.getMessage(error);
  }
}


/**
 * 挂上通知模块：登记 `notify_user` 工具，监听 `approval/asked` 与 `progress/update` 并发送 trace。
 * @param ctx 含 `tools` 与 `resources` 的 Cordis 上下文。
 * @param settings `readNotifySettings` 返回的已校验配置。
 * 副作用：在 `ctx.tools` 登记 `notify_user` 工具，监听 `approval/asked` 与 `progress/update` 事件，并发送 trace。
 */
export function mountNotify(ctx: cordis.Context, settings: NotifySettings): void {
  if (!settings.enabled) return;

  const toasted = new Set<string>();
  const withUrl = (notice: Notice): Notice => {
    //M 若本地网页端口可用，就把首页链接带在通知里方便用户点开查看。
    const link = pageUrl(ctx);
    if (link !== undefined) {
      notice.url = link;
    }
    return notice;
  };

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
    sessionKinds: ['front', 'work'],
    run: (args) => {
      const level = args['level'];
      const notice: Notice = {
        title: String(args['title'] ?? ''),
        body: String(args['body'] ?? ''),
      };
      if (level === 'info' || level === 'warn' || level === 'error') {
        notice.level = level;
      }
      //M 补上网页跳转链接后把通知发往基地，并返回送达结果说明给模型。
      return sendNotice(ctx, settings, withUrl(notice));
    },
  });

  //M 听待确认：弹一条“有待确认”。
  ctx.on('approval/asked', (pending: AskedNotice) => {
    void sendNotice(ctx, settings, withUrl({
      title: '有待确认',
      body: pending.title,
      level: 'warn',
    }));
  });

  //M 听长任务结束：同一结局只弹一次。
  const done: string[] = ['done', 'error', 'stopped', 'timeout', 'flagged', 'handed'];
  ctx.on('progress/update', (item: ProgressNotice) => {
    if (!done.includes(item.stage)) return;

    const key = `${item.sessionId}:${item.id}:${item.stage}`;
    if (toasted.has(key)) return;

    toasted.add(key);
    let title = '任务结束';
    if (item.stage === 'done') {
      title = '任务完成';
    }
    if (item.stage === 'error') {
      title = '任务出错';
    }
    const body = (item.result ?? item.action ?? item.text).slice(0, 200);
    let level: 'info' | 'error' = 'info';
    if (item.stage === 'error') {
      level = 'error';
    }
    //M 补上网页跳转链接后异步推给基地弹右下角通知，不阻塞进度事件处理。
    void sendNotice(ctx, settings, withUrl({
      title,
      body,
      level,
    }));
  });

  let shownUrl = settings.url;
  if (shownUrl === '') {
    shownUrl = 'ctx.base /notify';
  }
  const vars = { 地址: shownUrl, 开着: settings.enabled };
  ctx.emit('trace', 'notify.apply', '通知转到基地右下角', 'POST <url> {title, body}', vars);
}
