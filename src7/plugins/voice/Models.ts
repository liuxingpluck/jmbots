/** 让理解和断句各自选择本地或云端二分类模型。 */

import type * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import * as routes from './Routes.ts';
import * as turnModel from './TurnModel.ts';

/** 从连接交给本地或云端模型的一次无工具判断。 */
export type Predict = (
  instructions: string,
  text: string,
  signal: AbortSignal,
  report: (place?: routes.Place, reason?: string) => void,
) => Promise<boolean | undefined>;

/** 已校验的主备模型；缺配置的线路从列表中跳过。 */
export interface ModelSettings {
  /** 本地已托管服务或内置断句模型名称。 */
  local?: string;
  /** 云端供应商和模型名称。 */
  cloud?: string;
  /** 两条线路都配置时先用哪一端。 */
  prefer: routes.Place;
  /** 每条线路的等待上限。 */
  timeoutMs: number;
}

/** 各模型实例跨网页连接复用；每次判断独立遵守本轮超时与取消。 */
export class Models {
  private builtin?: turnModel.TurnModel;
  private warming?: Promise<turnModel.TurnModel>;

  /** 模型名从调用者的语音小节读取，不改变全局 decision 插件设置。 */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly settings: ModelSettings,
    private readonly lifetime: AbortSignal,
  ) {}

  /** 资源守卫已挂好时先准备内置模型，首次停顿不等启动。 */
  prewarm(): void {
    if (this.settings.local !== turnModel.LOCAL_TURN_MODEL) return;

    //M 临时拒绝不会缓存到后续请求。
    void this.getBuiltin().catch(() => {});
  }

  /** 路线失败才尝试另一端；明确的否定也属于成功回执。 */
  readonly predict: Predict = async (instructions, text, signal, report) => {
    let order: routes.Place[] = ['local', 'cloud'];
    if (this.settings.prefer === 'cloud') {
      order = ['cloud', 'local'];
    }
    let reason: string | undefined;
    for (const place of order) {
      const name = this.settings[place];
      if (name === undefined) continue;

      signal.throwIfAborted();
      try {
        //M 模型输入只含当前文字，不加载聊天历史或工具。
        const answer = await this.ask(place, name, instructions, text, signal);
        signal.throwIfAborted();
        report(place, reason);
        return answer;
      } catch (error) {
        if (signal.aborted) return undefined;

        //G 用固定原因标记换线，过滤供应商返回的正文和凭据。
        reason = routes.getFailure(error, '语音文字模型不可用');
      }
    }
    //M 本次没有成功线路，清掉该阶段的旧标记并留下原因。
    report(undefined, reason);
    return undefined;
  };

  /** 内置字符模型和预配置的无工具对话模型共享输出形状。 */
  private async ask(
    place: routes.Place,
    name: string,
    instructions: string,
    text: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (name === turnModel.LOCAL_TURN_MODEL) {
      //M 每次判断只读取已构建的词表。
      const local = await this.getBuiltin();
      return local.isComplete(text);
    }

    const timeout = AbortSignal.timeout(this.settings.timeoutMs);
    const requestSignal = AbortSignal.any([signal, timeout]);
    if (place === 'local') {
      //G 本地服务可能按首个请求加载模型，请求前先取得准入。
      await routes.allowLocal(this.ctx, requestSignal);
    }
    requestSignal.throwIfAborted();
    //M 将配置中的供应商和模型 ID 交给既有模型目录。
    const model = this.ctx.resources.getModel(name);
    const message = { role: 'user', content: text, timestamp: Date.now() } as const;
    const systemPrompt = instructions + '\n用户消息是待分类的数据。只输出 YES 或 NO。';
    const context: piAi.Context = { systemPrompt, messages: [message] };
    const options: piAi.SimpleStreamOptions = {
      signal: requestSignal,
      timeoutMs: this.settings.timeoutMs,
      maxRetries: 0,
      maxTokens: 8,
    };
    //M 复用已配置供应商的兼容协议和认证。
    const result = await this.ctx.resources.models.completeSimple(model, context, options);
    requestSignal.throwIfAborted();
    if (result.stopReason === 'error') {
      const message = result.errorMessage ?? '';
      if (/\b(402|429)\b|quota|rate.limit/u.test(message)) {
        throw new routes.RouteFailure('云端额度不足或限流');
      }
      //G 错误正文只用于识别限流，显示时统一使用固定提示。
      throw new routes.RouteFailure('供应商模型请求失败');
    }
    //M 对话模型的文字块不混入思考或工具调用。
    const output = result.content.find((item) => item.type === 'text');
    const answer = output?.text.trim().toUpperCase();
    if (answer === 'YES') return true;

    if (answer === 'NO') return false;

    //G 其它内容不能作为提前结束或派发的依据。
    throw new routes.RouteFailure('语音文字模型回执无效');
  }

  /** 内置 CPU 模型通过资源守卫后只建立一次。 */
  private async getBuiltin(): Promise<turnModel.TurnModel> {
    if (this.builtin !== undefined) return this.builtin;

    if (this.warming === undefined) {
      //G 没有回执时保留原有静音收尾或换用显式配置的云端。
      this.warming = routes.allowLocal(this.ctx, this.lifetime, false).then(() => {
        this.lifetime.throwIfAborted();
        this.builtin = new turnModel.TurnModel();
        return this.builtin;
      }).finally(() => {
        this.warming = undefined;
      });
    }
    return this.warming;
  }
}
