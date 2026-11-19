/** 统一记忆工具经事件向各归档来源读历史。 */
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import type { ToolResult, ToolSpec } from '../../Tools.ts';

/** 归档查询的用途。每个来源仍由拥有记录和权限规则的插件读取。 */
export type HistoryRoute = 'front-search' | 'front-get'
  | 'channel-current' | 'channel-visible' | 'channel-mentions' | 'wechat-archive';

/** 工具给归档来源的读取请求。 */
export interface HistoryToolRequest {
  /** 调用方已选好的来源和动作。 */
  route: HistoryRoute;
  /** 已经按入口转换为相应来源的参数。 */
  args: Record<string, unknown>;
  /** 当前会话，供来源确定权限。 */
  session: Session;
  /** 本轮停止信号。 */
  signal: AbortSignal;
  /** 本轮工具调用编号。 */
  callId: string;
  /** 原来源自己的回执格式。 */
  result?: ToolResult;
}

declare module 'cordis' {
  interface Events {
    /**
     * 记忆工具读取前台、渠道或微信的归档记录。
     * 谁发：src7/plugins/memory/Search.ts 的 Search.readHistory
     * 谁接：src7/plugins/memory/HistoryTools.ts 的 registerHistoryReader
     */
    'memory/history-tool'(request: HistoryToolRequest): void | Promise<void>;
  }
}

/**
 * 登记归档来源的读取函数，并把结果交回原查询。
 * @param ctx 归档提供方的上下文。
 * @param route 此函数负责的归档路由。
 * @param run 读取该归档的处理函数。
 */
export function registerHistoryReader(ctx: cordis.Context, route: HistoryRoute, run: ToolSpec['run']): void {
  //M 每个归档仍由提供方核对权限和游标。
  ctx.on('memory/history-tool', async (request) => {
    if (request.route !== route) return;

    //M 归档由其原来的工具实现读取，避免切换后丢掉未收进索引的记录。
    const { args, session, signal, callId } = request;
    const result = await run(args, session, signal, callId);
    request.result = result;
  });
}
