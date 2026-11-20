/** 给后台工作会话提供异步提问工具。 */
import * as crypto from 'node:crypto';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import * as workspace from '../../utils/Workspace.ts';
import * as notifications from './Notify.ts';
import type * as storeModule from './Store.ts';
import type * as types from './Types.ts';

/** 登记 ask_owner，收件身份和工作区来自当前会话。 */
export function registerAskOwner(
  ctx: cordis.Context,
  store: storeModule.Store,
  notice: notifications.OwnerNotice | undefined,
): void {
  const parameters = piAi.Type.Object({
    title: piAi.Type.String(),
    summary: piAi.Type.String(),
    options: piAi.Type.Array(piAi.Type.Object({
      id: piAi.Type.String(),
      text: piAi.Type.String(),
      recommended: piAi.Type.Optional(piAi.Type.Boolean()),
      cost: piAi.Type.Optional(piAi.Type.String()),
    }), { minItems: 2, maxItems: 8 }),
    body: piAi.Type.Optional(piAi.Type.String()),
  });
  //M 只给后台会话登记异步提问工具。
  ctx.tools.register({
    definition: {
      name: 'ask_owner',
      description: '把需要主人决定的事登记到工作决策。给出标题、一句话背景和选项，可附 Markdown 正文。主人选完会把结果送回本会话。',
      parameters,
    },
    sessionKinds: ['work'],
    run(args, session, _signal, callId) {
      const row = session.row;
      const channel = row.channel ?? '';
      //G 工作决策可通知主人并写入本人项目，工具须确认会话属于本人。
      const isOwner = workspace.isOwnerTurn(channel, row.address);
      if (!isOwner) throw new Error('只有本人会话可以登记工作决策');

      //M 工具从已绑定会话取项目和回执去向，并用工具调用号识别重试。
      const hash = crypto.createHash('sha256');
      const source = JSON.stringify([row.id, callId]);
      const digest = hash.update(source).digest('hex');
      const id = `ask-${digest.slice(0, 24)}`;
      const input = {
        ...args,
        id,
        bot: row.bot,
        workspaceId: row.workspaceId,
        asker: { kind: 'session', sessionId: row.id },
      } as types.DecisionAsk;
      //M 幂等提问与正常接口共用工作区和选项校验。
      const saved = store.ask(input);
      //M 写入待定项后请求通知，工具立即交回节点。
      notifications.notifyNew(ctx, notice, saved.graph, saved.tasks);

      //M 决策编号既是重试键，也是页面的直达链接。
      const query = new URLSearchParams({ focus: id });
      const url = `${notifications.PAGE}?${query.toString()}`;
      return JSON.stringify({ id, url });
    },
  });
}
