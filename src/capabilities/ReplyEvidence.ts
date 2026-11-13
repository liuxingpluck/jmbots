/**
 * 回复的生成与输入依据：运行时只复制成功调用的安全元信息，HTTP 只读恢复历史。
 * 不读当前模型配置、不请求模型、不写库；相同文本或调用归属有歧义就保持未知。
 */
import type * as modelModule from './Model.ts';
import type * as storeModule from './Store.ts';


/** 生成快照的调用身份；未记录的列保持 null。 */
export interface GenerationIdentity {
  /** 该段文字的用途，不能把审核用途当会话生成。 */
  purpose?: string | null;
  /** 生成所在运行。 */
  run?: number | null;
  /** 生成所在步骤。 */
  step?: number | null;
  /** reply 工具调用号；最终文本没有。 */
  callId?: string | null;
  /** 程序包装模型段落时明确区分；默认直接模型文字。 */
  kind?: 'model' | 'model-wrapped';
}


/** 一句回复的两份独立证据；模型未知不影响明确来源消息的定位。 */
export interface ReplyEvidence {
  /** 这句文本由谁生成、用了什么思考设置。 */
  generation: storeModule.ReplyGeneration;
  /** 可以证明的输入范围。 */
  association: storeModule.ReplyAssociation;
}


/** 从成功 ChatOutput 取实际路由和本地设置，不读取当前会话模型或思考正文。 */
export function modelGeneration(
  output: Pick<modelModule.ChatOutput, 'request' | 'message'>,
  identity: GenerationIdentity,
): storeModule.ReplyGeneration {
  return {
    kind: identity.kind ?? 'model',
    model: output.request.model || null,
    thinkingRequested: output.request.thinkingAsked ?? null,
    thinkingSent: output.request.thinking ?? null,
    thinkingReported: null,
    source: 'snapshot',
    purpose: identity.purpose ?? null,
    run: identity.run ?? null,
    step: identity.step ?? null,
    assistantAt: Number.isFinite(output.message.timestamp) ? output.message.timestamp : null,
    callId: identity.callId ?? null,
  };
}


/** 程序拼接的错误、通知、限时提示，不把同阶段调用过的审核模型归给它。 */
export function programGeneration(
  purpose: string,
  identity: Pick<GenerationIdentity, 'run' | 'step' | 'callId'> = {},
): storeModule.ReplyGeneration {
  return {
    ...unknownGeneration(),
    kind: 'program',
    source: 'snapshot',
    purpose,
    run: identity.run ?? null,
    step: identity.step ?? null,
    callId: identity.callId ?? null,
  };
}


/** 无可靠生成记录时所有模型/设置列留空，不用当前配置或零值补造。 */
export function unknownGeneration(): storeModule.ReplyGeneration {
  return {
    kind: 'unknown',
    model: null,
    thinkingRequested: null,
    thinkingSent: null,
    thinkingReported: null,
    source: 'unknown',
    purpose: null,
    run: null,
    step: null,
    assistantAt: null,
    callId: null,
  };
}


/** 创建独立的来源快照，只接受明确收件号，不保留外部可变数组。 */
export function association(
  messageIds: number[],
  scope: storeModule.ReplyAssociation['scope'],
  source: string,
): storeModule.ReplyAssociation {
  const validIds = messageIds.filter((id) => Number.isSafeInteger(id) && id > 0);
  return { messageIds: [...new Set(validIds)], scope, source };
}


/** 只读助手匹配候选，不包含系统提示或思考正文。 */
interface AssistantCandidate {
  /** 保存的助手记录。 */
  stored: storeModule.StoredMessage;
  /** 工具 reply 的调用号；普通最终文本为空。 */
  callId: string | null;
}


/** 请求范围内的只读恢复器；同批 HTTP 消息复用实例以免反复读取整段会话。 */
export class ReplyEvidenceReader {
  /** 请求内已读会话；不作为长期缓存，不保存配置或模型客户端。 */
  private readonly sessions = new Map<string, storeModule.SessionRow | undefined>();

  /** @param store 已打开的数据库，本类仅调用读取方法。 */
  constructor(private readonly store: storeModule.Store) {}

  /**
   * 读取生成与关联证据；新快照优先，历史只有唯一可靠助手/成功工具匹配才恢复。
   * @param message 被回复的原收件。
   * @param reply replies 中的确定一项，不按相似内容挑目标。
   * @returns 安全元信息和明确的历史范围；不改库、不调模型。
   */
  read(message: storeModule.MessageRow, reply: storeModule.Reply): ReplyEvidence {
    const linked = this.associationOf(message, reply);
    if (reply.generation) {
      return { generation: this.copyGeneration(reply.generation), association: linked };
    }
    const session = this.session(reply.session.id);
    if (!session || session.bot !== message.bot) {
      return { generation: unknownGeneration(), association: linked };
    }

    /** 重复同文回复无法一一对应旧助手调用，不能凭时间相近指定其中一句。 */
    const sameReplies = message.replies.filter((saved) => saved.text.trim() === reply.text.trim());
    const candidates = this.candidates(message, reply, session);
    if (sameReplies.length > 1 || candidates.length !== 1) {
      return { generation: unknownGeneration(), association: linked };
    }
    const candidate = candidates[0]!;
    const generation = this.fromAssistant(candidate, reply);
    return { generation, association: linked };
  }

  /** 显式快照、旧运行、旧分派批次和目标消息逐级降级，不能加入同会话其余消息。 */
  private associationOf(
    message: storeModule.MessageRow,
    reply: storeModule.Reply,
  ): storeModule.ReplyAssociation {
    if (reply.association) {
      const saved = reply.association;
      return association(saved.messageIds, saved.scope, saved.source);
    }
    if (reply.trace?.messageIds.length) {
      return association(reply.trace.messageIds, 'run', '旧回复保存的运行消息关联，不能确认新观察轮');
    }
    const dispatch = message.dispatch;
    if (dispatch && typeof dispatch === 'object' && 'messageIds' in dispatch && Array.isArray(dispatch.messageIds)) {
      const ids = dispatch.messageIds.filter((id): id is number => Number.isSafeInteger(id) && Number(id) > 0);
      if (ids.length > 0) {
        return association(ids, 'batch', '旧分派批次关联，不能确认一句回复具体读取了哪些输入');
      }
    }
    return association([message.id], 'target', '仅能确认这条回复所保存的目标消息');
  }

  /** 只在本次查询中复用会话 JSON，空会话号不尝试恢复模型。 */
  private session(id: string): storeModule.SessionRow | undefined {
    if (!id) {
      return undefined;
    }
    if (!this.sessions.has(id)) {
      this.sessions.set(id, this.store.getSession(id));
    }
    return this.sessions.get(id);
  }

  /** 匹配必须有同一原消息的显式输入、可靠运行，以及保存的最终文本或成功 reply 结果。 */
  private candidates(
    origin: storeModule.MessageRow,
    reply: storeModule.Reply,
    session: storeModule.SessionRow,
  ): AssistantCandidate[] {
    const found: AssistantCandidate[] = [];
    let inputIds: number[] = [];
    for (const [index, stored] of session.messages.entries()) {
      const message = stored.message;
      if (message.role === 'user' && stored.messageIds?.length) {
        inputIds = stored.messageIds;
      }
      if (message.role !== 'assistant' || !inputIds.includes(origin.id)) {
        continue;
      }
      if (reply.trace && stored.run !== reply.trace.run) {
        continue;
      }
      if (!Number.isInteger(stored.run) || stored.run < 1
        || message.stopReason === 'error' || message.stopReason === 'aborted') {
        continue;
      }
      const calls = message.content.filter((block) => block.type === 'toolCall');
      if (calls.length === 0) {
        const text = message.content.map((block) => block.type === 'text' ? block.text : '').join('');
        if (text.trim() && text.trim() === reply.text.trim()) {
          found.push({ stored, callId: null });
        }
      }
      for (const call of calls) {
        if (call.name !== 'reply' || call.arguments.text !== reply.text) {
          continue;
        }
        const succeeded = session.messages.slice(index + 1).some((result) => {
          return result.run === stored.run && result.message.role === 'toolResult'
            && result.message.toolCallId === call.id && result.message.isError !== true;
        });
        if (succeeded) {
          found.push({ stored, callId: call.id });
        }
      }
    }
    return found;
  }

  /** 仅投影助手自身模型和当时保存的发送档位；不取会话当前的 model/thinking。 */
  private fromAssistant(candidate: AssistantCandidate, reply: storeModule.Reply): storeModule.ReplyGeneration {
    const stored = candidate.stored;
    if (stored.generation) {
      return { ...this.copyGeneration(stored.generation), source: 'stored-assistant', callId: candidate.callId };
    }
    const message = stored.message;
    if (message.role !== 'assistant' || !message.provider || !message.model) {
      return unknownGeneration();
    }
    const model = message.model.startsWith(`${message.provider}/`)
      ? message.model
      : `${message.provider}/${message.model}`;
    return {
      ...unknownGeneration(),
      kind: 'model',
      model,
      thinkingSent: stored.effort ?? null,
      source: 'stored-assistant',
      purpose: 'session',
      run: stored.run,
      step: reply.trace?.step ?? null,
      assistantAt: Number.isFinite(message.timestamp) ? message.timestamp : null,
      callId: candidate.callId,
    };
  }

  /** 显式白名单防止历史 JSON 的额外字段（如 thinking/system/state）进入接口。 */
  private copyGeneration(saved: storeModule.ReplyGeneration): storeModule.ReplyGeneration {
    return {
      kind: saved.kind,
      model: saved.model ?? null,
      thinkingRequested: saved.thinkingRequested ?? null,
      thinkingSent: saved.thinkingSent ?? null,
      thinkingReported: saved.thinkingReported ?? null,
      source: saved.source,
      purpose: saved.purpose ?? null,
      run: saved.run ?? null,
      step: saved.step ?? null,
      assistantAt: saved.assistantAt ?? null,
      callId: saved.callId ?? null,
    };
  }
}
