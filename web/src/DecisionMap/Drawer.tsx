/** 查看节点结论、提交选项、写话给中控的侧栏，放射、思维导图、表格、清单共用这一个。 */
import * as react from 'react';
import type * as types from '../../../src7/plugins/decision-map/Types.ts';
import * as words from './Words.ts';

/** 新加的界面字过语言包；写成 t('原文')，提取脚本 scripts/I18n_Extract.ts 才认得出。 */
const t = words.t;

/** 侧栏由页面管理选中的节点和请求状态。 */
interface DrawerProps {
  /** 正在查看的节点。 */
  node: types.DecisionNode;
  /** 正在保存的选项号。 */
  saving?: string;
  /** 本次点选失败的原因。 */
  error?: string;
  /** 收起选项。 */
  close: () => void;
  /** 提交选项，实现在 DecisionMapPage 的 chooseOption。 */
  choose: (id: string) => void;
  /** 写的话是否正在发送。 */
  sending: boolean;
  /** 本次写话失败的原因。 */
  noteError?: string;
  /** 把话发给中控，可带选项；实现在 DecisionMapPage 的 sendNote，成功返回 true。 */
  send: (text: string, option?: string) => Promise<boolean>;
}

/** 毫秒时间戳写成本地的月日时分。 */
export function getTime(at: number): string {
  const date = new Date(at);

  //M 面板、表格都用同一种短时间格式。
  return date.toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short', hour12: false });
}

/** 按时间列出这个节点上用户和中控写过的话。 */
function NoteList({ node }: { node: types.DecisionNode }) {
  const notes = node.notes ?? [];
  if (notes.length === 0) return null;

  //M 选项号换成选项文字，读的人不用对编号。
  const getOptionText = (id: string): string => {
    const found = node.options?.find((option) => option.id === id);
    if (found === undefined) return id;

    return found.text;
  };

  //M 每条写清谁、何时、内容；用户的话标出中控回没回。
  return (
    <section className="decision-notes" aria-label={t('写过的话')}>
      <h3>{t('写过的话')}</h3>
      <ol>
        {notes.map((note) => {
          let who = t('你');
          if (note.author === 'central') who = t('中控');
          let state = '';
          if (note.author === 'user' && note.repliedAt === undefined) state = t('等中控回');
          if (note.author === 'user' && note.repliedAt !== undefined) state = t('中控已回');

          //M 一条话一块：谁、何时、选了什么、内容。
          return (
            <li key={note.id} className="decision-note" data-author={note.author}>
              <p className="decision-note__meta">
                <strong>{who}</strong> · {getTime(note.at)}
                {state !== '' && <span className="decision-note__state">{state}</span>}
              </p>
              {note.option !== undefined && (
                <p className="decision-note__option">{t('选了')}「{getOptionText(note.option)}」</p>
              )}
              <p className="decision-note__text">{note.text}</p>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** 打开经过校验的 HTTP 证据链接，其他文本只作参考。 */
function getLinks(values: string[]): string[] {
  return values.filter((value) => /^https?:\/\//iu.test(value));
}

/** 当前节点记下的决定来源和当时的选项。 */
function DecisionHistory({ node }: { node: types.DecisionNode }) {
  //M 先写清谁定的、什么时候定的。
  let actor = '决定人未记录';
  if (node.decidedBy === 'central') actor = '中控定的';
  if (node.decidedBy === 'user') actor = '用户定的';
  if (node.decidedBy === 'user' && node.chosen !== undefined) actor = '用户点的';
  let time = '时间未记录';
  if (node.decidedAt !== undefined) time = getTime(node.decidedAt);

  //M 旧选项只供回看，突出当时选中的一项。
  return (
    <section aria-label="决定记录" className="decision-history">
      <p>{actor} · {time}</p>
      {(node.options?.length ?? 0) > 0 && (
        <ul className="decision-options">
          {node.options?.map((option) => (
            <li
              className="decision-option"
              key={option.id}
              data-chosen={option.id === node.chosen}
              data-option-id={option.id}
            >
              <span className="decision-option__title">
                {option.text}
                {option.id === node.chosen && <span className="decision-option__recommended">已选 ✓</span>}
              </span>
              {option.cost && <span className="decision-option__cost">{option.cost}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** 待定时显示点击即可提交的选项，已定时显示中控接收状态。 */
export function Drawer({ node, saving, error, close, choose, sending, noteError, send }: DrawerProps) {
  const [draft, setDraft] = react.useState('');
  const isPending = node.kind === 'pending' && node.status === 'open';
  const isConfirmed = node.acknowledgedAt !== undefined;
  const isDecided = node.kind === 'decided' || node.status === 'decided';
  const awaitingCentral = node.decidedBy === 'user' && node.chosen !== undefined;

  //G 证据列表只把 HTTP 链接渲染成可操作地址。
  const links = getLinks(node.links ?? []);
  const sources = new Set(node.sources ?? []);
  if (node.detailPath) {
    sources.add(node.detailPath);
  }
  let stateText = '节点详情';
  if (isPending) stateText = '★ 要你定';
  if (isDecided) stateText = '已定 ✓';
  const written = draft.trim();
  const busy = saving !== undefined || sending;

  /** 点选项：框里写了话就连同选项一起发，没写就照原样点选。 */
  const pick = (option: string): void => {
    if (written === '') {
      //M 没写话就和原来一样直接点选。
      choose(option);
      return;
    }

    //M 选项和补的话一次发出，成功后清空输入框。
    void send(written, option).then((ok) => {
      if (ok) setDraft('');
    });
  };

  /** 只发写的话，不选选项。 */
  const submit = (event: react.FormEvent): void => {
    event.preventDefault();
    if (written === '' || busy) return;

    //M 发送成功才清空，失败时保留原话方便重发。
    void send(written).then((ok) => {
      if (ok) setDraft('');
    });
  };
  //M 输入框的提示按节点是否待定换一句。
  let hint = t('追问、改主意、补要求都可以写，发给中控');
  if (isPending) hint = t('不选也行，直接写你的答案；写了再点选项，会连同选项一起发');

  //M 点节点时先看结论和选择，已到手的决定单独标明中控确认。
  return (
    <aside className="decision-drawer" aria-labelledby="decision-drawer-title">
      <div className="decision-drawer__head">
        <span className="decision-drawer__state">{stateText}</span>
        <button type="button" onClick={close} className="decision-close" aria-label="关闭详情">×</button>
      </div>
      <h2 id="decision-drawer-title">{node.title}</h2>
      {node.summary !== '' && <p className="decision-drawer__summary">{node.summary}</p>}
      {isPending && (
        <div className="decision-options" aria-label="可选决定">
          {node.options?.map((option) => (
            <button
              className="decision-option"
              key={option.id}
              type="button"
              data-option-id={option.id}
              disabled={busy}
              onClick={() => pick(option.id)}
            >
              <span className="decision-option__title">
                {option.text}
                {option.recommended && <span className="decision-option__recommended">推荐</span>}
              </span>
              {option.cost && <span className="decision-option__cost">{option.cost}</span>}
              {saving === option.id && <span className="decision-option__cost">正在保存</span>}
            </button>
          ))}
        </div>
      )}
      {isDecided && <DecisionHistory node={node} />}
      {awaitingCentral && (
        <div className="decision-receipt" data-confirmed={isConfirmed}>
          {isConfirmed && <span>中控已收到{node.note && ` · ${node.note}`}</span>}
          {!isConfirmed && <span>等待中控确认</span>}
        </div>
      )}
      {error && <p className="decision-error" role="alert">{error}</p>}
      <NoteList node={node} />
      <form className="decision-write" onSubmit={submit}>
        <label htmlFor="decision-write-text">{t('写一句给中控')}</label>
        <textarea
          id="decision-write-text"
          value={draft}
          maxLength={2000}
          rows={3}
          placeholder={hint}
          onChange={(event) => setDraft(event.target.value)}
        />
        <button type="submit" disabled={written === '' || busy}>
          {sending && t('正在发送')}
          {!sending && t('发给中控')}
        </button>
        {noteError && <p className="decision-error" role="alert">{noteError}</p>}
      </form>
      {sources.size > 0 && (
        <section className="decision-sources" aria-label="出处">
          <h3>出处</h3>
          <ul className="decision-links">
            {[...sources].map((source) => <li key={source}>{source}</li>)}
          </ul>
        </section>
      )}
      {links.length > 0 && (
        <ul className="decision-links">
          {links.map((link) => <li key={link}><a href={link} target="_blank" rel="noreferrer">{link}</a></li>)}
        </ul>
      )}
    </aside>
  );
}
