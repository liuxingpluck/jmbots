/**
 * 事件页左栏：上面提交任务（可以选交给谁，或者接着当前会话），下面是最近的会话列表，点一个看它的全部记录。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as format from '../Format.ts';
import * as api from './EventsApi.ts';
import * as eventsStore from './EventsStore.ts';


/** 会话状态 → 标签颜色。 */
export const SESSION_STATUS_COLOR: Record<string, string> = {
  空闲: 'default',
  执行中: 'processing',
  等待确认: 'warning',
  出错: 'error',
};


/**
 * 会话的执行者写成一句话。
 * @param session 会话。
 */
export function describeActor(session: api.Session): string {
  if (session.bot) {
    return `机器人 ${session.bot}`;
  }
  if (session.agent) {
    return `智能体 ${session.agent}`;
  }
  if (session.model) {
    return `模型 ${session.model}`;
  }
  return '还没分派';
}


/** 左栏。 */
export default function SessionList() {
  /** 最近的会话。 */
  const sessions = eventsStore.useEventsStore((state) => state.sessions);
  /** 选中的会话。 */
  const sessionId = eventsStore.useEventsStore((state) => state.sessionId);
  /** 选中会话的动作。 */
  const select = eventsStore.useEventsStore((state) => state.select);
  /** 刷新出错时的提示。 */
  const error = eventsStore.useEventsStore((state) => state.error);
  return (
    <div className="events-list">
      <RunForm />
      {error ? <antd.Alert type="error" showIcon message={error} className="events-error" /> : null}
      <antd.List
        dataSource={sessions}
        locale={{ emptyText: '还没有会话' }}
        renderItem={(session) => (
          <antd.List.Item
            className={session.id === sessionId ? 'events-item is-selected' : 'events-item'}
            onClick={() => select(session.id)}
          >
            <div className="events-item-body">
              <div className="events-item-title">
                <antd.Tag color={SESSION_STATUS_COLOR[session.status] ?? 'default'}>{session.status}</antd.Tag>
                {session.kind === 'route' ? <antd.Tag color="purple">分派</antd.Tag> : null}
                {session.title}
              </div>
              <div className="events-item-meta">
                {describeActor(session)} · {session.source} · {format.formatTime(session.updatedAt)}
              </div>
            </div>
          </antd.List.Item>
        )}
      />
    </div>
  );
}


/** 提交任务：文字、交给谁（不选就由分派智能体决定）、要不要接着当前会话。 */
function RunForm() {
  /** 选中的会话；勾了“接着当前会话”时用它。 */
  const sessionId = eventsStore.useEventsStore((state) => state.sessionId);
  /** 选中会话、刷新的动作。 */
  const select = eventsStore.useEventsStore((state) => state.select);
  const refresh = eventsStore.useEventsStore((state) => state.refresh);
  /** 输入的任务。 */
  const [text, setText] = react.useState('');
  /** 交给谁：''（分派决定）、'bot:名字'、'agent:名字'。 */
  const [target, setTarget] = react.useState('');
  /** 接着当前会话。 */
  const [follow, setFollow] = react.useState(false);
  /** 正在提交。 */
  const [sending, setSending] = react.useState(false);
  /** 可选的机器人和智能体。 */
  const [roles, setRoles] = react.useState<{ bots: api.RoleSummary[]; agents: api.RoleSummary[] }>({ bots: [], agents: [] });

  // m: 打开时取一次机器人和智能体。
  react.useEffect(() => {
    void api.listRoles().then(setRoles, () => undefined);
  }, []);

  /** 提交：成功后清空输入、选中那个会话。 */
  async function submit(): Promise<void> {
    // g: 没写内容不提交。
    if (!text.trim()) {
      return;
    }
    setSending(true);
    try {
      /** 交给谁：拆成种类和名字。 */
      const [kind, name] = target.split(':');
      /** 提交结果。 */
      const created = await api.run({
        text,
        sessionId: follow && sessionId ? sessionId : undefined,
        bot: kind === 'bot' ? name : undefined,
        agent: kind === 'agent' ? name : undefined,
      });
      setText('');
      select(created.sessionId);
      void refresh();
    } catch (error) {
      void antd.message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setSending(false);
    }
  }

  /** 下拉选项。 */
  const options = [
    { value: '', label: '分派智能体决定' },
    ...roles.bots.map((role) => ({ value: `bot:${role.name}`, label: `机器人 ${role.name}` })),
    ...roles.agents.map((role) => ({ value: `agent:${role.name}`, label: `智能体 ${role.name}` })),
  ];
  return (
    <div className="events-run">
      <antd.Input.TextArea
        value={text}
        onChange={(event) => setText(event.target.value)}
        autoSize={{ minRows: 2, maxRows: 6 }}
        placeholder="要做的事（Ctrl+Enter 提交）"
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            void submit();
          }
        }}
      />
      <div className="events-run-bar">
        <antd.Select size="small" value={target} options={options} onChange={setTarget} disabled={follow} className="events-run-target" />
        <antd.Checkbox checked={follow} disabled={!sessionId} onChange={(event) => setFollow(event.target.checked)}>
          接着当前会话
        </antd.Checkbox>
        <antd.Button size="small" type="primary" loading={sending} onClick={() => void submit()}>
          提交
        </antd.Button>
      </div>
    </div>
  );
}
