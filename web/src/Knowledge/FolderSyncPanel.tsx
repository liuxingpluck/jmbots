/**
 * 知识库顶栏「同步本地目录」的轻面板（knowledge v1.2.0）：
 * 打开时读 GET /api/knowledge/sync-status，显示后端配置的 localWatchDirs 和最近一次结果；
 * 可以临时填本机目录（一行一个）、分类名，点「同步」发 POST /api/knowledge/sync-folders，显示新建、更新、跳过几篇。
 * 后端只读源目录，不改、不删用户的文件。
 */
import * as react from 'react';
import * as api from './KnowledgeApi.ts';

/** 面板的参数。 */
export interface FolderSyncPanelProps {
  /** 同步成功后让页面刷新目录树和列表（KnowledgePage 的 loadTree、loadList）。 */
  onSynced: () => void;
  /** 接口出错交给页面统一处理（KnowledgePage 的 handleError：403 切只读、其余提示）。 */
  onError: (error: unknown) => void;
  /** 关面板。 */
  onClose: () => void;
}


/**
 * 一次同步结果写成一句话。
 * @param result 同步结果。
 */
function getResultText(result: api.KnowledgeSyncResult): string {
  const at = new Date(result.lastSyncedAt).toLocaleString();
  const counts = `扫到 ${String(result.scanned)} 个，新建 ${String(result.created)}，`
    + `更新 ${String(result.updated)}，跳过 ${String(result.skipped)}，问题 ${String(result.errors.length)}`;
  return `${at}：${counts}`;
}


/** 同步本地目录的轻面板。 */
export function FolderSyncPanel(props: FolderSyncPanelProps): react.JSX.Element {
  const { onSynced, onError, onClose } = props;
  const [status, setStatus] = react.useState<api.KnowledgeSyncStatusResponse>();
  const [dirsText, setDirsText] = react.useState('');
  const [category, setCategory] = react.useState('');
  const [running, setRunning] = react.useState(false);
  const [result, setResult] = react.useState<api.KnowledgeSyncResult>();

  //M 打开时读一次配置的目录和最近一次结果。
  react.useEffect(() => {
    const controller = new AbortController();
    api.getSyncStatus(controller.signal).then(setStatus).catch((error: unknown) => {
      if (controller.signal.aborted) return;

      onError(error);
    });
    return () => controller.abort();
  }, [onError]);

  //==========================================================
  //M 同步：填了目录就用填的（一行一个），没填用后端配置的；分类不填放进「外部学习」
  //==========================================================
  const run = async (): Promise<void> => {
    const dirs = dirsText.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line !== '');
    let sendDirs: string[] | undefined;
    if (dirs.length > 0) {
      sendDirs = dirs;
    }
    let sendCategory: string | undefined;
    if (category.trim() !== '') {
      sendCategory = category.trim();
    }
    setRunning(true);
    try {
      const done = await api.syncFolders(sendDirs, sendCategory);
      setResult(done);
      onSynced();
    } catch (error) {
      onError(error);
    } finally {
      setRunning(false);
    }
  };

  const configured = status?.localWatchDirs ?? [];
  const last = result ?? status?.lastSync ?? undefined;
  let runText = '同步';
  if (running) {
    runText = '正在同步…';
  }

  return (
    <div className="kb-sync-panel" role="dialog" aria-label="同步本地目录">
      <div className="kb-sync-head">
        <strong>同步本地目录</strong>
        <span className="kb-muted">只读导入 .md、.txt，不改源文件</span>
        <span className="kb-grow" />
        <button type="button" className="kb-icon-btn" onClick={onClose} aria-label="关闭">×</button>
      </div>
      <div className="kb-sync-section">
        <span className="kb-muted">配置的目录（localWatchDirs）</span>
        {configured.length === 0 && <span className="kb-muted">没有配置，可以在下面临时填</span>}
        {configured.map((dir) => <code key={dir}>{dir}</code>)}
      </div>
      <textarea
        className="kb-sync-dirs"
        rows={3}
        value={dirsText}
        placeholder="临时同步的本机目录，绝对路径，一行一个；不填用上面配置的"
        onChange={(event) => setDirsText(event.target.value)}
      />
      <div className="kb-sync-row">
        <input
          value={category}
          placeholder="分类（默认 外部学习）"
          onChange={(event) => setCategory(event.target.value)}
        />
        <button type="button" className="kb-primary-btn" disabled={running} onClick={() => void run()}>
          {runText}
        </button>
      </div>
      {last !== undefined && (
        <div className="kb-sync-section">
          <span>{getResultText(last)}</span>
          {last.errors.slice(0, 10).map((item) => (
            <span key={`${item.path}:${item.reason}`} className="kb-sync-error">{item.path}：{item.reason}</span>
          ))}
        </div>
      )}
    </div>
  );
}
