/**
 * 假模型：不发请求，直接给出固定的回答。开发机连不到模型 API 时，用它把整条链路跑通。
 * 它只管模型名以 fake/ 开头的会话；别的会话照常发给真模型，挂着它也不受影响。
 * 第一步回“要调用 time 工具”；拿到工具结果以后回一句“现在是……”，这一轮就做完了。
 * 用户的话写成“调用 工具名 {JSON 参数}”时，它就去调那个工具，离线也能测交办（hand_session）、喊停。
 * 用法：config.yaml 的 plugins 段挂上 fake-model；providers 里加一家叫 fake 的（base_url 随便写，不会去连）；
 *       default_model 写成 fake/fake。想换回真模型，只要把 default_model 改回去。
 */
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';


/** 插件名。 */
export const name = 'fake-model';
//M 插件版本号，写成 x.y.z；启动时 plugins/Index.ts 用 Checks.ts 的 checkVersion 查。
export const version = '1.0.1';


/**
 * 挂上假模型：听 session/request，把回答直接填进 request.answer，会话就不发请求了。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里写的服务都就绪，
 * 再调一次 apply(ctx, 配置)。插件在 apply 里通过 ctx 听事件、登记工具；插件被拔掉时，这些登记自动撤掉。
 * 详见 plugins/Index.ts 的 PluginModule。
 * @param ctx Cordis 给这个插件的 ctx。
 * 副作用：监听 session/request 事件；模型名以 fake/ 开头时直接填写 request.answer，不向远端发请求。
 */
export function apply(ctx: cordis.Context): void {
  ctx.on('session/request', (request) => {
    //G 只管模型名以 fake/ 开头的；别的照常发给真模型。
    if (!request.model.startsWith('fake/')) return;

    //M 2026-11-14 18:25：前台会在最后补 system 提醒（比如“这一轮有图片”），看最后一条时跳过 system，不然拿到工具结果也不收尾、一直调 time 到 30 步。
    const last = request.messages.findLast((item) => (item.role as string) !== 'system');

    //M 对话最后是工具的结果 → 照结果回一句话，这一轮就做完了。
    if (last?.role === 'toolResult') {
      const result = piAi.contentText(last.content);
      let answerText = result;
      if (last.toolName === 'time') {
        answerText = `现在是 ${result}`;
      }
      request.answer = piAi.fauxAssistantMessage(answerText);
      return;
    }

    //M 最后是后台、外部 AI 交回的结果（bots/Dispatch.ts 存进对话的那句）→ 原样转述，离线也能看到结果回到了前台。
    let said = '';
    if (last?.role === 'user') {
      said = piAi.contentText(last.content);
    }
    if (said.startsWith('【') && said.includes('交回的结果')) {
      request.answer = piAi.fauxAssistantMessage(said);
      return;
    }

    //M 要调哪个工具：用户的话写成“调用 工具名 {JSON 参数}”就调那个（离线测交办、喊停用）；别的话调 time。
    const asked = /^调用\s+(\S+)\s*(\{.*\})?$/su.exec(said.trim());
    const tool = asked?.[1] ?? 'time';
    const args = JSON.parse(asked?.[2] ?? '{}') as Parameters<typeof piAi.fauxToolCall>[1];

    //G 这场会话没有这个工具（比如写总结的小会话）→ 直接回一句话。
    if (!request.tools.some((item) => item.name === tool)) {
      request.answer = piAi.fauxAssistantMessage(`（假模型）${said.slice(0, 40)}`);
      return;
    }

    //M 说一句话，同时要调用这个工具。
    const blocks = [piAi.fauxText(`我来调用 ${tool}。`), piAi.fauxToolCall(tool, args)];
    request.answer = piAi.fauxAssistantMessage(blocks, { stopReason: 'toolUse' });
  });
}
