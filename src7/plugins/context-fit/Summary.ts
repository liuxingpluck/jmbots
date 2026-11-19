/**
 * 会话总结（由原 summary 并入 context-fit）：每场干活的会话做完一轮，给它写一句总结，存在会话的 summary 里。
 * 前台的 list_sessions 工具靠这句总结认出每场会话是干什么的。
 * 做法和压缩一样，是会话里嵌一场小会话：新开一场 kind 是 summary 的会话，让它跑同一个循环写出这句话。
 * 小会话没有渠道，不会被当成回话；原会话的对话一个字不动。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import type { AskInput, Session } from '../../Sessions.ts';


declare module '../../Sessions.ts' {
  interface SessionRow {
    /** 这场对话的一句总结；context-fit 内的 Summary 模块写。 */
    summary?: string;
  }
}


/**
 * 校验并读取 `plugins[context-fit].config.summary`。
 * @param raw 原始配置；`undefined` 或 `true` 或对象为开启，`false` 为关闭。
 * @returns 是否开启会话结束自动总结。
 * @throws 类型不合法时抛错。
 */
export function readSummaryEnabled(raw: unknown): boolean {
  if (raw === undefined || raw === true) return true;

  if (raw === false) return false;

  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) return true;

  throw new Error('context-fit.summary 要是 true、false 或对象');
}


/**
 * 总结：监听 session/change，在 work 会话进入 done 时总结一两句写入 row.summary。
 */
export class Summary {
  /**
   * 挂上监听。
   * @param ctx Cordis 给的 ctx。
   * 副作用：在 `ctx` 上挂载 `session/change` 事件监听。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M 监听会话状态流转，干活会话完成时异步触发一次摘要总结。
    this.ctx.on('session/change', (session) => {
      void this.onChange(session);
    });
  }

  /**
   * 响应 session/change：干活的会话做完了，就写总结。
   * @param session 状态刚变的那场会话。
   * 副作用：新开一场小会话并跑完它；写原会话的 summary。
   */
  private async onChange(session: Session): Promise<void> {
    const row = session.row;

    //G 只管干活的会话做完的那一下。
    if (row.kind !== 'work' || row.state !== 'done') return;

    //M 材料：以前的总结、用户最近说的三句、最后的回答。不把整场对话再发一遍。
    const said = row.messages.filter((item) => item.role === 'user');
    const recent = said.slice(-3).map((item) => piAi.contentText(item.content));
    const ask = [
      '用一两句话写下这场对话做了什么、结果在哪。只输出这一两句话。',
      `以前的总结：${row.summary ?? '（没有）'}`,
      `用户最近说的：\n${recent.join('\n')}`,
      `最后的回答：\n${row.reply}`,
    ];

    //T 跟踪：写总结。
    const vars = { session: row.id };
    this.ctx.emit('trace', 'summary.onChange', 'trace.contextFit.summarize', 'sessions.ask(askInput)', vars);

    //M 开一场小会话来写，不思考。等它跑完。
    const askInput: AskInput = {
      bot: row.bot,
      kind: 'summary',
      parent: row.id,
      thinking: 'off',
      text: ask.join('\n\n'),
    };
    //M 执行内部 summary 小会话并等待总结结果，失败则保持原总结不动。
    const { ok, reply } = await this.ctx.sessions.ask(askInput);

    //G 小会话没做成 → 这次不写。
    if (!ok) return;

    //M 小会话成功给出总结后，写回会话行并持久化以供前台会话列表展示。
    row.summary = reply;
    session.save();
  }
}
