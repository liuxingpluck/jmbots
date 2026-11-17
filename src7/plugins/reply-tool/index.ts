/**
 * 工具 reply：干活的会话（work）做到一半先回用户一句。执行就是 bots.say(会话, 话)（发通知 bot/say，渠道收到自己发、自己认 @路径）。
 * 这场会话没有渠道（没人等它的话）时抛错，模型知道发不出去。前台不给（前台自己的回答就是回话）。
 * 照 0.4 src/capabilities/tools/Tools.ts:595-599、1475-1532。设计：docs/src7插件设计/reply-tool.md。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';


/** 插件名。 */
export const name = 'reply-tool';

/** 用到的服务：tools 登记工具；bots 发话。 */
export const inject = ['tools', 'bots'];


/**
 * 登记 reply。没有状态，不建 class。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后调一次。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  //M tools.register：只给 work 会话；骨架照 parameters 校验过参数才调 run。
  ctx.tools.register({
    definition: {
      name: 'reply',
      description: '做到一半，先给用户发一句话（发到这场会话回话的渠道）。先说结论，简短；写 @绝对路径 就把那个文件一起发过去（渠道支持时）。'
        + '做完时的最后回答会自动发给用户，不要再用 reply 重复一遍。',
      parameters: piAi.Type.Object({ text: piAi.Type.String({ description: '要发的话' }) }),
    },
    kinds: ['work'],
    run: (args, session) => {
      //G row.channel 是 bots 插件加的项：没有渠道就没人收。
      if (session.row.channel === undefined) throw new Error('这场会话没有渠道，发不出去');
      const text = String(args['text']);
      //T 跟踪：reply 工具先回用户一句。
      ctx.emit('trace', 'ReplyTool.run', '先回用户一句', 'bots.say(session, text)', { 会话: session.row.id, 渠道: session.row.channel, 字数: text.length });
      //M bots.say：发通知 bot/say，渠道和前台都听；不等渠道发完。
      ctx.bots.say(session, text);
      return '已发给用户';
    },
  });
}
