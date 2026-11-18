/**
 * 每句回复的生成标识、来源范围和显式补取规则。
 * 展示器只用后端证据；补取只走只读消息接口，不修改分派或执行。
 */
import * as api from '../Api.ts';
import * as i18n from '../I18n.ts';
import * as channelTabs from './ChannelTabs.tsx';
import type * as types from '../Types.ts';
import type * as storeModule from '../Store.ts';
import type * as zustand from 'zustand';


/** 当前视图对明确来源号的补取结论，跨渠道与确实缺失分别说明。 */
export interface ResolvedSources {
  /** 归属于当前 origin、可并入当前时间线的消息。 */
  visible: types.MessageView[];
  /** 属于另一视图的消息号，并非不存在。 */
  foreignIds: number[];
  /** 真实缺失或机器人归属不符的消息号。 */
  missingIds: number[];
}


/** 不依赖当前配置的回复元信息；空值保留明确未知。 */
export class ReplyLink {
  /** @param t 当前界面的翻译函数，省略时使用中文。 */
  constructor(private readonly t: i18n.Translate = i18n.source) {}

  /**
   * 完整模型 ID（带前缀）和思考档，中间用 · 隔开，例如 magpie/workbuddy/deepseek-v4.1-flash · max。
   * @param generation 后端记录的回复生成依据。
   * @returns 供气泡旁展示的生成模型与思考档文本。
   */
  generation(generation: types.ReplyGeneration): string {
    const t = this.t;
    if (generation.kind === 'program') {
      return t('程序生成');
    }
    if (generation.kind === 'unknown' || !generation.model) {
      return t('生成模型未确认');
    }
    const parts = [generation.model];
    const requested = generation.thinkingRequested;
    const sent = generation.thinkingSent;
    //M 有请求档位时优先显示请求档位，实发不同才补充“实发 …”；都没有则写明未记录。
    if (requested) {
      parts.push(requested);
      if (sent && sent !== requested) {
        parts.push(t('实发 {level}', { level: sent }));
      }
    }
    if (!requested && sent) {
      parts.push(sent);
    }
    if (!requested && !sent) {
      parts.push(t('档位未记录'));
    }
    if (generation.kind === 'model-wrapped') {
      parts.push(t('程序包装'));
    }
    return parts.join(' · ');
  }


  /**
   * 完整路径和证据来源仅用于核对；没有供应商回报时明确未知。
   * @param generation 后端记录的回复生成依据。
   * @returns 用于悬停提示的多行核对文本。
   */
  generationTitle(generation: types.ReplyGeneration): string {
    const t = this.t;
    const lines = [generation.model || t('生成模型未确认')];
    lines.push(t('生成依据：{source}', { source: generation.source }));
    lines.push(t('供应商实际执行档位：{level}', {
      level: generation.thinkingReported || t('未回报'),
    }));
    return lines.join('\n');
  }


  /**
   * 关联条数始终来自保存集合；历史范围不能标成本轮快照。
   * @param association 后端记录的回复关联来源集合与范围。
   * @returns 关联条数及历史范围说明文案。
   */
  association(association: types.ReplyAssociation): string {
    const t = this.t;
    const count = new Set(association.messageIds).size;
    const label = t('关联 {count} 条用户消息', { count });
    if (association.scope === 'turn') {
      return label;
    }
    const scopes = {
      run: t('运行范围（未确认本轮）'),
      batch: t('分派批次范围'),
      target: t('仅确定目标消息'),
    };
    return `${label} · ${scopes[association.scope]}`;
  }


  /**
   * 回答与关联来源共享一个标识，不借用事件发送序号。
   * @param target 回复定位目标。
   * @returns 形如「↔ 消息号/回复序号」的标签文本。
   */
  tag(target: storeModule.TraceTarget): string {
    return `↔ ${String(target.messageId)}/${String(target.replyIndex + 1)}`;
  }


  /**
   * 只按机器人、消息号与回复下标核对，不按文本或时间邻近猜测。
   * @param left 左侧目标。
   * @param right 右侧目标。
   * @returns 两者均非空且三项标识完全一致时返回 true。
   */
  static sameTarget(left: storeModule.TraceTarget | null, right: storeModule.TraceTarget | null): boolean {
    return left !== null && right !== null
      && left.bot === right.bot
      && left.messageId === right.messageId
      && left.replyIndex === right.replyIndex;
  }


  /**
   * 当前来源视图归属，与后端 /api/messages 的 web/other 语义一致。
   * @param message 仅需携带 source 字段的消息视图。
   * @returns 网页端来源返回 'web'，其余渠道返回 'other'。
   */
  static origin(message: Pick<types.MessageView, 'source'>): types.MessageOrigin {
    if (message.source === 'web') return 'web';

    return 'other';
  }


  /**
   * 明确补取最多 100 条一批，区分跨视图与缺失，不改变正常分页游标。
   * @param bot 当前机器人名。
   * @param ids 需要补取的消息号列表。
   * @param origin 当前视图来源过滤；不传表示统一时间线不按来源过滤。
   * @param channel 可选渠道过滤。
   * @param chat 可选具体聊天过滤。
   * @returns 分好类的可见消息、跨视图消息号与缺失消息号；仅调用只读补取接口，无本地状态副作用。
   */
  static async resolve(
    bot: string,
    ids: number[],
    origin: types.MessageOrigin | undefined,
    channel?: string,
    chat?: string,
  ): Promise<ResolvedSources> {
    const unique = [...new Set(ids)];
    const messages: types.MessageView[] = [];
    const missingIds: number[] = [];
    for (let offset = 0; offset < unique.length; offset += 100) {
      //M 后端单批最多查 100 个 ID，分批调用只读补取接口汇总已返回消息与确实缺失的消息号。
      const batch = unique.slice(offset, offset + 100);
      const resolved = await api.resolveMessages(bot, batch);
      messages.push(...resolved.messages);
      missingIds.push(...resolved.missingIds);
    }
    const matches = (message: types.MessageView): boolean => {
      //G 先按来源归属确认是否属于当前视图（web 或 other），不一致则归入跨视图。
      if (origin !== undefined && ReplyLink.origin(message) !== origin) return false;

      //G 来源符合后再按当前选中的渠道与聊天条件判断是否可直接显示在时间线中。
      return channelTabs.matchesChannelView(message, channel, chat);
    };
    //M 按视图匹配结果把补回来的消息拆成可直接并入的 visible 与属于其它视图的 foreignIds。
    return {
      visible: messages.filter(matches),
      foreignIds: messages.filter((message) => !matches(message)).map((message) => message.id),
      missingIds,
    };
  }
}


/** 历史恢复后只读加载关联元信息；组件销毁或快速切换后丢弃旧响应。 */
export class ReplyEvidenceLoader {
  /** 每次选择或取消递增，连 A→B→A 的旧请求也不能回写。 */
  private serial = 0;

  /** @param store 当前网页仓库，只经既有动作保存轻量证据。 */
  constructor(private readonly store: Pick<zustand.StoreApi<storeModule.UiState>, 'getState'>) {}

  /**
   * 优先保留聊天已带的快照；历史恢复缺证据时才读取追踪接口。
   * @param target 当前选中的回复目标；为 null 时不发起请求。
   * @returns 异步加载完成后结束，无返回值。
   * 副作用：递增请求序号、只读请求 /api/messages/:id/trace，并调用 store.setReplyEvidence 回写结果或错误。
   */
  async load(target: storeModule.TraceTarget | null): Promise<void> {
    const mine = ++this.serial;
    if (!target) {
      return;
    }
    const selection = this.store.getState().replySelection;
    //G 仓库里已缓存同一回复目标的快照证据时直接复用，不再重复查追踪接口。
    if (selection && ReplyLink.sameTarget(selection.target, target)) {
      return;
    }
    try {
      //M 只读拉取指定回复的追踪记录以补全生成依据和关联来源，过时响应在回写前丢弃。
      const trace = await api.messageTrace(target.messageId, target.replyIndex);
      if (mine !== this.serial) {
        return;
      }
      this.store.getState().setReplyEvidence(target, trace.target);
    } catch (error) {
      if (mine === this.serial) {
        let reason = String(error);
        if (error instanceof Error) {
          reason = error.message;
        }
        this.store.getState().setReplyEvidence(target, null, reason);
      }
    }
  }

  /**
   * 取消观察，不取消已存在的后端任务，也不发执行请求。
   * @returns 无返回值。
   * 副作用：递增 serial 使尚未返回的只读追踪请求失效。
   */
  cancel(): void {
    this.serial += 1;
  }
}
