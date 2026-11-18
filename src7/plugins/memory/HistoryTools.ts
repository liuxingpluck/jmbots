/** 旧工具继续在 Tools 验参，新旧调用共用记忆工具的来源分发。 */
import type * as cordis from 'cordis';
import type { Session } from '../../Sessions.ts';
import type { ToolResult, ToolSpec } from '../../Tools.ts';
import type { MemoryService } from './index.ts';

/** 归档查询的用途。每个来源仍由拥有记录和权限规则的插件读取。 */
export type HistoryRoute = 'front-recent' | 'front-search' | 'front-get'
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
    /** 记忆工具读取前台、渠道或微信的归档记录。 */
    'memory/history-tool'(request: HistoryToolRequest): void | Promise<void>;
  }
}

/** 挂来源处理器及旧名兼容入口。旧调用继续保留原工具参数、权限和回执。 */
export function registerHistoryAlias(ctx: cordis.Context, route: HistoryRoute, spec: ToolSpec): void {
  //M 处理新工具或旧别名转来的读取，继续使用原渠道的签名游标和权限判断。
  ctx.on('memory/history-tool', async (request) => {
    if (request.route !== route) return;

    //M 归档由其原来的工具实现读取，避免切换后丢掉未收进索引的记录。
    const { args, session, signal, callId } = request;
    request.result = await spec.run(args, session, signal, callId);
  });

  //M Tools.execute 先按旧名经过关口和校验，随后把操作转换成统一来源请求。
  ctx.tools.register({
    ...spec,
    run: async (args, session, signal, callId) => {
      //M 无 memory 插件的部署沿用原工具，挂了才使用统一分发。
      const memory = ctx.get('memory') as MemoryService | undefined;
      if (memory === undefined) return spec.run(args, session, signal, callId);

      //M 已挂统一工具时，把旧操作交给它转发给归档来源。
      const request = { route, args, session, signal, callId };
      const result = await memory.unified.readHistory(request, true);
      if (result === undefined) throw new Error('历史来源未挂载');

      return result;
    },
  });
}
