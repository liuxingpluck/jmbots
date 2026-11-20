/** 记忆页的渠道回填进度、开始/暂停按钮，和拉飞书群历史。 */
import * as react from 'react';
import * as api from '../Api.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';

/** 最近说过话的飞书群的身份前缀，后面就是群号。 */
const FEISHU_GROUP_PREFIX = 'feishu:group:';

/** 独立轮询渠道进度。用户操作期间冻结自动刷新，避免旧状态盖掉新回执。 */
export function ChannelBackfillCard() {
  //M 独立记忆页从地址或浏览器保存的偏好取语言，无需主聊天页的状态仓库。
  const [language] = react.useState(() => {
    const params = new URLSearchParams(window.location.search);
    const requested = params.get('lang');
    const explicit = i18n.matchLanguage(requested);
    if (explicit !== undefined) return explicit;

    //M 未指定地址语言时沿用用户保存的语言。
    return i18n.loadLanguage(window.localStorage);
  });
  const t = react.useCallback<i18n.Translate>((label, values) => {
    //M 用现有语言包处理计数占位和回填状态。
    return i18n.translate(language, label, values);
  }, [language]);

  //M 资源守卫原因沿用页面的全局演示打码。
  const mask = privacy.useMask();
  const [status, setStatus] = react.useState<api.MemoryBackfill>();
  const [busy, setBusy] = react.useState(false);
  const [error, setError] = react.useState('');
  //M 拉飞书群历史：群从“最近说过话的群”里选，条数默认 50；结果和失败原因照实显示。
  const [groups, setGroups] = react.useState<api.GrantSeen[]>([]);
  const [chatId, setChatId] = react.useState('');
  const [limit, setLimit] = react.useState('50');
  const [pulling, setPulling] = react.useState(false);
  const [pullResult, setPullResult] = react.useState('');
  const poll = react.useRef<AbortController | undefined>(undefined);

  react.useEffect(() => {
    if (busy) return;

    //M 首屏读一次，之后轮询已入库条数。每次仅保留最新的一次状态请求。
    const load = () => {
      poll.current?.abort();
      const request = new AbortController();
      poll.current = request;
      void api.memoryBackfill(request.signal).then((result) => {
        if (request.signal.aborted) return;

        setStatus(result);
        setError('');
      }).catch((failure: unknown) => {
        if (request.signal.aborted) return;

        //G 回填接口返回 404 时隐藏卡片。
        if (failure instanceof api.ApiError && failure.status === 404) {
          setStatus(undefined);
          return;
        }
        setError(t('读取回填状态失败'));
      });
    };
    //M 首次进入和操作结束后立即刷新，不等下一次轮询。
    load();
    const timer = window.setInterval(load, 3000);
    return () => {
      poll.current?.abort();
      window.clearInterval(timer);
    };
  }, [busy, t]);

  const change = async (running: boolean) => {
    //M 先中止正在轮询的旧请求，再交给后端保存新的手动状态。
    poll.current?.abort();
    setBusy(true);
    try {
      const result = await api.setMemoryBackfill(running);
      setStatus(result);
      setError('');
    } catch {
      setError(t('操作回填失败'));
    } finally {
      setBusy(false);
    }
  };

  //M 进页面读一次最近说过话的群，下拉里只留飞书群（身份写作 feishu:group:<群号>）。
  react.useEffect(() => {
    void api.grants().then((result) => {
      setGroups(result.seen.filter((item) => item.subject.startsWith(FEISHU_GROUP_PREFIX)));
    }).catch(() => {
      setGroups([]);
    });
  }, []);

  const pull = async () => {
    //M 取群号和条数交给后端，后端在入口校验；权限不够等原因原样显示。
    setPulling(true);
    try {
      const result = await api.pullFeishuHistory(chatId, Number(limit));
      setPullResult(t('已拉取 {pulled} 条，跳过 {skipped} 条，失败 {failed} 条', { pulled: result.pulled, skipped: result.skipped, failed: result.failed }));
    } catch (failure) {
      setPullResult(t('拉取失败：{reason}', { reason: failure instanceof Error ? failure.message : String(failure) }));
    } finally {
      setPulling(false);
    }
  };

  if (status === undefined && error === '') return null;

  //M 总数随归档发现推进。状态提示优先显示按钮回执或资源守卫原因。
  let label = t('开始回填');
  let detail = error;
  if (status?.running) {
    label = t('暂停回填');
  }
  if (status !== undefined && detail === '') {
    detail = t('正在回填');
    if (status.scanning) {
      detail = t('扫描历史归档中，总数会增加');
    }
    if (status.reason !== '') {
      detail = privacy.text(t(status.reason), mask);
    }
  }
  const done = status?.done ?? 0;
  const total = status?.total ?? 0;
  const title = t('渠道消息回填');
  const progress = t('已入库 {done} / {total}', { done, total });

  //M 沿用已有状态卡和按钮样式，提供可读进度及明确的下一步操作。
  return (
    <section className="mm-card" aria-label={title}>
      <div className="mm-card-label">{title}</div>
      {status !== undefined && <div className="mm-card-value">{progress}</div>}
      <div className="mm-card-sub" role="status">{detail}</div>
      {status !== undefined && <div className="mm-row mm-backfill-action">
        <button type="button" disabled={busy} onClick={() => void change(!status.running)}>{label}</button>
      </div>}
      <div className="mm-card-label mm-history-title">{t('拉飞书群历史')}</div>
      <div className="mm-row mm-backfill-action">
        <select value={chatId} aria-label={t('选择群')} onChange={(event) => setChatId(event.target.value)}>
          <option value="">{t('选择群')}</option>
          {groups.map((item) => (
            <option key={item.subject} value={item.subject.slice(FEISHU_GROUP_PREFIX.length)}>{privacy.text(item.label, mask)}</option>
          ))}
        </select>
        <input type="number" min={1} value={limit} aria-label={t('条数')} onChange={(event) => setLimit(event.target.value)} />
        <button type="button" disabled={pulling || chatId === ''} onClick={() => void pull()}>{t('拉取')}</button>
      </div>
      {pullResult !== '' && <div className="mm-card-sub" role="status">{pullResult}</div>}
    </section>
  );
}
