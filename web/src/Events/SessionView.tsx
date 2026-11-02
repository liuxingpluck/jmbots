/**
 * 事件页右栏：一个会话的白盒子。每次执行一张卡片，卡片里按时间排：
 *   分派结论 → 第 1 步（发给模型什么、模型回了什么、调了哪些工具、结果）→ 判断结论 → 命令审核 → 第 2 步 ……
 * 原始请求（系统提示词、上下文消息、工具定义）和原始回复折叠着，点开能看到数据库里的原样 JSON。
 * 有命令在等确认时，顶上显示“同意”“拒绝”按钮。
 */
import * as antd from 'antd';
import type { ReactNode } from 'react';
import * as format from '../Format.ts';
import * as api from './EventsApi.ts';
import * as eventsStore from './EventsStore.ts';
import * as sessionList from './SessionList.tsx';


/** 事件、步骤、工具调用的状态 → 标签颜色。 */
const STATUS_COLOR: Record<string, string> = {
  pending: 'default',
  running: 'processing',
  in_progress: 'processing',
  paused: 'warning',
  completed: 'success',
  failed: 'error',
  approved: 'success',
  rejected: 'error',
};


/** 状态的中文。 */
const STATUS_TEXT: Record<string, string> = {
  pending: '排队',
  running: '执行中',
  in_progress: '进行中',
  paused: '等确认',
  completed: '完成',
  failed: '失败',
  approved: '已同意',
  rejected: '已拒绝',
};


/**
 * 状态标签。
 * @param props.status 状态。
 */
function StatusTag(props: { status: string }) {
  return <antd.Tag color={STATUS_COLOR[props.status] ?? 'default'}>{STATUS_TEXT[props.status] ?? props.status}</antd.Tag>;
}


/**
 * 任意值写成文字：字符串原样，别的转成缩进的 JSON。
 * @param value 值。
 */
function toText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2) ?? '';
}


/**
 * 一段等宽文字，太长时在框里滚动。
 * @param props.value 要显示的值。
 */
function Pre(props: { value: unknown }) {
  return <pre className="events-pre">{toText(props.value)}</pre>;
}


/** 右栏。 */
export default function SessionView() {
  /** 选中的会话 ID。 */
  const sessionId = eventsStore.useEventsStore((state) => state.sessionId);
  /** 选中会话的全部记录。 */
  const full = eventsStore.useEventsStore((state) => state.full);
  // g: 没选会话、或者还在取。
  if (!sessionId) {
    return <antd.Empty className="events-empty" description="左边选一个会话，或者提交一个任务" />;
  }
  if (!full) {
    return <antd.Spin className="events-empty" />;
  }

  // m: 头部信息、等确认的命令，然后每次执行一张卡片（新的在下面）。
  const { session } = full;
  return (
    <div className="events-view">
      <antd.Descriptions size="small" column={2} title={session.title} bordered>
        <antd.Descriptions.Item label="会话 ID">{session.id}</antd.Descriptions.Item>
        <antd.Descriptions.Item label="状态">
          <antd.Tag color={sessionList.SESSION_STATUS_COLOR[session.status] ?? 'default'}>{session.status}</antd.Tag>
        </antd.Descriptions.Item>
        <antd.Descriptions.Item label="执行者">{sessionList.describeActor(session)}</antd.Descriptions.Item>
        <antd.Descriptions.Item label="工作区">{session.workspace}</antd.Descriptions.Item>
        <antd.Descriptions.Item label="来源">{session.source}</antd.Descriptions.Item>
        <antd.Descriptions.Item label="日志目录">{full.sessionDir}</antd.Descriptions.Item>
      </antd.Descriptions>
      {full.approvals
        .filter((approval) => approval.status === 'pending')
        .map((approval) => (
          <PendingApproval key={approval.id} approval={approval} />
        ))}
      {full.events
        .filter((event) => event.type === 'execution')
        .map((execution) => (
          <ExecutionCard key={execution.id} full={full} execution={execution} />
        ))}
    </div>
  );
}


/**
 * 一条等确认的命令：同意或拒绝后，引擎从停下的那一步接着做。
 * @param props.approval 待确认命令。
 */
function PendingApproval(props: { approval: api.ApprovalRow }) {
  /** 刷新的动作。 */
  const refresh = eventsStore.useEventsStore((state) => state.refresh);
  /** 同意或拒绝，然后刷新。 */
  async function decide(decision: 'approved' | 'rejected'): Promise<void> {
    try {
      await api.decide(props.approval.id, decision);
      void refresh();
    } catch (error) {
      void antd.message.error(error instanceof Error ? error.message : String(error));
    }
  }
  return (
    <antd.Alert
      type="warning"
      showIcon
      className="events-approval"
      message={`命令等你确认（待确认 ID ${props.approval.id}，目录 ${props.approval.workDir}）`}
      description={<Pre value={props.approval.command} />}
      action={
        <antd.Flex vertical gap={8}>
          <antd.Button size="small" type="primary" onClick={() => void decide('approved')}>
            同意
          </antd.Button>
          <antd.Button size="small" danger onClick={() => void decide('rejected')}>
            拒绝
          </antd.Button>
        </antd.Flex>
      }
    />
  );
}


/** 时间线上的一项：一步模型调用，或者一个挂在执行下面的事件（分派、判断、审核）。 */
type TimelineEntry = { kind: 'step'; at: number; step: api.StepRow } | { kind: 'event'; at: number; event: api.EventRow };


/**
 * 一次执行的卡片。
 * @param props.full 会话的全部记录。
 * @param props.execution execution 事件。
 */
function ExecutionCard(props: { full: api.SessionFull; execution: api.EventRow }) {
  const { full, execution } = props;
  /** 这次执行的模型调用和工具调用。 */
  const records = full.executions.find((item) => item.eventId === execution.id) ?? { steps: [], tools: [] };
  /** 输入。 */
  const input = (execution.payload as { input?: string }).input ?? '';

  // m: 步骤和挂在下面的事件合在一起按时间排；同一时刻步骤在前。
  /** 时间线。 */
  const entries: TimelineEntry[] = [
    ...records.steps.map((step): TimelineEntry => ({ kind: 'step', at: step.createdAt, step })),
    ...full.events.filter((event) => event.parentId === execution.id).map((event): TimelineEntry => ({ kind: 'event', at: event.createdAt, event })),
  ].sort((a, b) => a.at - b.at || (a.kind === 'step' ? -1 : 1));

  return (
    <antd.Card
      size="small"
      className="events-card"
      title={
        <span>
          执行 {execution.id} <StatusTag status={execution.status} />
          <span className="events-muted">{format.formatTime(execution.createdAt)}</span>
        </span>
      }
    >
      <div className="events-input">
        <span className="events-label">输入</span>
        {input}
      </div>
      {execution.error ? <antd.Alert type="error" showIcon message={execution.error} className="events-error" /> : null}
      <antd.Timeline
        items={entries.map((entry) => {
          if (entry.kind === 'step') {
            return { key: `step-${entry.step.id}`, color: 'blue', children: <StepBlock step={entry.step} tools={records.tools.filter((tool) => tool.step === entry.step.step)} /> };
          }
          return { key: `event-${entry.event.id}`, color: 'gray', children: <ChildEvent event={entry.event} /> };
        })}
      />
    </antd.Card>
  );
}


/**
 * 一步：模型、用时、思考、回复、工具调用，以及折叠起来的原始请求和回复。
 * @param props.step 模型调用记录。
 * @param props.tools 这一步的工具调用。
 */
function StepBlock(props: { step: api.StepRow; tools: api.ToolRow[] }) {
  const { step } = props;
  /** 请求里常用的几项。 */
  const request = step.request as { model?: string; thinking?: string; note?: string; system?: string; messages?: unknown[]; tools?: unknown[] };
  /** 回复里常用的几项。 */
  const response = (step.response ?? {}) as { text?: string; thinking?: string; ms?: number; message?: { usage?: { input?: number; output?: number } } };
  /** 用量。 */
  const usage = response.message?.usage;

  /** 折叠面板：思考、原始请求、原始回复。 */
  const panels: { key: string; label: string; children: ReactNode }[] = [];
  if (response.thinking) {
    panels.push({ key: 'thinking', label: '思考', children: <Pre value={response.thinking} /> });
  }
  panels.push({ key: 'system', label: '系统提示词', children: <Pre value={request.system ?? '（还没回来，或只用模型时为空）'} /> });
  panels.push({ key: 'messages', label: `上下文消息（${request.messages?.length ?? '?'} 条）`, children: <Pre value={request.messages ?? '（还没回来）'} /> });
  panels.push({ key: 'raw', label: '原始请求和回复（JSON）', children: <Pre value={{ request: step.request, response: step.response }} /> });

  return (
    <div className="events-step">
      <div className="events-step-head">
        <b>第 {step.step} 步</b> · {step.actor} · {request.model ?? '?'}（思考 {request.thinking ?? '默认'}）
        <StatusTag status={step.status} />
        <span className="events-muted">
          {format.formatTime(step.createdAt)}
          {response.ms === undefined ? '' : ` · ${(response.ms / 1000).toFixed(1)} 秒`}
          {usage ? ` · 输入 ${usage.input ?? '?'} / 输出 ${usage.output ?? '?'} token` : ''}
        </span>
      </div>
      {request.note ? <div className="events-muted">这一步之前留的话：{request.note}</div> : null}
      {step.error ? <antd.Alert type="error" showIcon message={step.error} className="events-error" /> : null}
      {step.status === 'in_progress' ? <div className="events-reply"><antd.Spin size="small" /> <span className="events-muted">等模型回复……</span></div> : <div className="events-reply">{response.text || '（没有文字）'}</div>}
      {props.tools.map((tool) => (
        <ToolBlock key={tool.id} tool={tool} />
      ))}
      <antd.Collapse size="small" ghost items={panels} />
    </div>
  );
}


/**
 * 一次工具调用：参数和结果。
 * @param props.tool 工具调用记录。
 */
function ToolBlock(props: { tool: api.ToolRow }) {
  const { tool } = props;
  return (
    <div className="events-tool">
      <div>
        <antd.Tag color="purple">{tool.toolName}</antd.Tag>
        <StatusTag status={tool.status} />
        <span className="events-muted">{tool.updatedAt - tool.createdAt} 毫秒</span>
      </div>
      <div className="events-label">参数</div>
      <Pre value={tool.input} />
      <div className="events-label">{tool.status === 'failed' ? '出错' : '结果'}</div>
      <Pre value={tool.status === 'failed' ? tool.error : (tool.output ?? '（还没有结果）')} />
    </div>
  );
}


/**
 * 挂在执行下面的事件：分派、判断、命令审核。常见的几项写成一句话，原样 JSON 折叠着。
 * @param props.event 事件。
 */
function ChildEvent(props: { event: api.EventRow }) {
  const { event } = props;
  return (
    <div className="events-child">
      <b>{describeEvent(event)}</b>
      <span className="events-muted">{format.formatTime(event.createdAt)}</span>
      <antd.Collapse size="small" ghost items={[{ key: 'raw', label: '原始内容', children: <Pre value={event.payload} /> }]} />
    </div>
  );
}


/**
 * 事件写成一句话。
 * @param event 事件。
 */
function describeEvent(event: api.EventRow): string {
  /** 内容。 */
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  if (event.type === 'dispatch') {
    /** 分派结论。 */
    const result = (payload.result ?? {}) as { kind?: string; name?: string; workspace?: string; reason?: string };
    return `分派：交给 ${result.kind ?? '?'} ${result.name ?? '?'}，工作区 ${result.workspace ?? '?'}（${result.reason ?? ''}）`;
  }
  if (event.type === 'judge') {
    /** 判断结论。 */
    const judgment = (payload.judgment ?? {}) as { action?: string; reason?: string; message?: string; target?: string; by?: string };
    /** 转交对象和留言。 */
    const extra = [judgment.target ? `→ ${judgment.target}` : '', judgment.message ?? ''].filter(Boolean).join(' ');
    return `判断（第 ${toText(payload.step)} 步之后，${judgment.by ?? '?'}）：${judgment.action ?? '?'} ${extra}——${judgment.reason ?? ''}`;
  }
  if (event.type === 'route_result') {
    // m: 分派对话的结论：这句话派给了谁。
    /** 动作。 */
    const actions = Array.isArray(payload.actions)
      ? (payload.actions as { type?: string; sessionId?: string; approvalId?: number; title?: string; model?: string; thinking?: string; text?: string }[])
      : [];
    /** 动作写成一句话。 */
    const described = actions.map((action) => {
      if (action.type === 'continue') {
        return `接着会话 ${action.sessionId ?? '?'}`;
      }
      if (action.type === 'new') {
        return `开新会话「${action.title ?? ''}」${action.model ? `（${action.model} ${action.thinking ?? ''}）` : ''}`;
      }
      if (action.type === 'ask_user') {
        return `问用户：${action.text ?? ''}`;
      }
      return `${action.type === 'approve' ? '放行' : '拒绝'}待确认 ${toText(action.approvalId)}`;
    });
    return `分派结论${payload.fallback === true ? '（按老办法）' : ''}：${described.join('；')}——${toText(payload.reason)}`;
  }
  if (event.type === 'route') {
    if (!payload.routeSessionId) {
      return `程序直接派来（没开分派对话）——${toText(payload.reason)}`;
    }
    return `由分派对话 ${toText(payload.routeSessionId)} 派来——${toText(payload.reason)}`;
  }
  if (event.type === 'sent') {
    return `回复已发到${toText(payload.channel ?? '渠道')}（消息 ${toText(payload.messageId)}）`;
  }
  if (event.type === 'watchdog') {
    return `看门狗：已经 ${toText(payload.minutes)} 分钟没有新步骤`;
  }
  if (event.type === 'approval_decided') {
    return `待确认 ${toText(payload.approvalId)} ${payload.decision === 'approved' ? '已放行' : '已拒绝'}（${toText(payload.by)}）${payload.note ? `：${toText(payload.note)}` : ''}`;
  }
  if (event.type === 'exec_review') {
    // m: 审核结论：直接执行，或者谁审的、决策模型给的安全概率、等用户确认的 ID。
    /** 结论的各段。 */
    const parts: string[] = [];
    if (typeof payload.verdict === 'string') {
      parts.push(payload.verdict);
    }
    if (payload.by !== undefined) {
      parts.push(`由 ${toText(payload.by)} 审`);
    }
    if (payload.probability !== undefined) {
      parts.push(`安全概率 ${toText(payload.probability)}`);
    }
    if (payload.approvalId !== undefined) {
      parts.push(`待确认 ID ${toText(payload.approvalId)}`);
    }
    return `命令审核：${toText(payload.command)}（${parts.join('，')}）`;
  }
  return `${event.type}（${event.status}）`;
}
