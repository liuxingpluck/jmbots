/**
 * 每句回复的生成标识、来源范围和显式补取规则。
 * 展示器只用后端证据；补取只走只读消息接口，不修改分派或执行。
 */
import * as api from '../Api.ts';
import * as i18n from '../I18n.ts';
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

  /** 完整模型 ID（带前缀）和思考档，中间用 · 隔开，例如 magpie/workbuddy/deepseek-v4.1-flash · max。 */
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
    if (requested) {
      parts.push(requested);
      if (sent && sent !== requested) parts.push(t('实发 {level}', { level: sent }));
    } else if (sent) {
      parts.push(sent);
    } else {
      parts.push(t('档位未记录'));
    }
    if (generation.kind === 'model-wrapped') {
      parts.push(t('程序包装'));
    }
    return parts.join(' · ');
  }


  /** 完整路径和证据来源仅用于核对；没有供应商回报时明确未知。 */
  generationTitle(generation: types.ReplyGeneration): string {
    const t = this.t;
    const lines = [generation.model || t('生成模型未确认')];
    lines.push(t('生成依据：{source}', { source: generation.source }));
    lines.push(t('供应商实际执行档位：{level}', {
      level: generation.thinkingReported || t('未回报'),
    }));
    return lines.join('\n');
  }


  /** 关联条数始终来自保存集合；历史范围不能标成本轮快照。 */
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


  /** 回答与关联来源共享一个标识，不借用事件发送序号。 */
  tag(target: storeModule.TraceTarget): string {
    return `↔ ${String(target.messageId)}/${String(target.replyIndex + 1)}`;
  }


  /** 只按机器人、消息号与回复下标核对，不按文本或时间邻近猜测。 */
  static sameTarget(left: storeModule.TraceTarget | null, right: storeModule.TraceTarget | null): boolean {
    return left !== null && right !== null
      && left.bot === right.bot
      && left.messageId === right.messageId
      && left.replyIndex === right.replyIndex;
  }


  /** 当前来源视图归属，与后端 /api/messages 的 web/other 语义一致。 */
  static origin(message: Pick<types.MessageView, 'source'>): types.MessageOrigin {
    return message.source === 'web' ? 'web' : 'other';
  }


  /** 明确补取最多 100 条一批，区分跨视图与缺失，不改变正常分页游标。 */
  static async resolve(
    bot: string,
    ids: number[],
    origin: types.MessageOrigin | undefined,
    channel?: string,
  ): Promise<ResolvedSources> {
    const unique = [...new Set(ids)];
    const messages: types.MessageView[] = [];
    const missingIds: number[] = [];
    for (let offset = 0; offset < unique.length; offset += 100) {
      const batch = unique.slice(offset, offset + 100);
      const resolved = await api.resolveMessages(bot, batch);
      messages.push(...resolved.messages);
      missingIds.push(...resolved.missingIds);
    }
    const matches = (message: types.MessageView): boolean =>
      (origin === undefined || ReplyLink.origin(message) === origin)
      && (channel === undefined || message.channel.split(':')[0] === channel);
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

  /** 优先保留聊天已带的快照；历史恢复缺证据时才读取追踪接口。 */
  async load(target: storeModule.TraceTarget | null): Promise<void> {
    const mine = ++this.serial;
    if (!target) {
      return;
    }
    const selection = this.store.getState().replySelection;
    if (selection && ReplyLink.sameTarget(selection.target, target)) {
      return;
    }
    try {
      const trace = await api.messageTrace(target.messageId, target.replyIndex);
      if (mine !== this.serial) {
        return;
      }
      this.store.getState().setReplyEvidence(target, trace.target);
    } catch (error) {
      if (mine === this.serial) {
        const reason = error instanceof Error ? error.message : String(error);
        this.store.getState().setReplyEvidence(target, null, reason);
      }
    }
  }

  /** 取消观察，不取消已存在的后端任务，也不发执行请求。 */
  cancel(): void {
    this.serial += 1;
  }
}
