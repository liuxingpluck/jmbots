/**
 * 外网隧道（FRPC）原生深色控制台主页面（/frpc/）。
 * 提供顶栏状态灯、Hero 控制与开机自启、公网快捷入口、[[proxies]] 可视化增删改及 frpc.log 终端面板。
 */
import * as react from 'react';
import * as authGate from '../components/AuthGate.tsx';
import * as theme from '../ThemePalette.ts';
import { TOKEN, withToken } from '../Token.ts';
import * as frpcApi from './FrpcApi.ts';
import { ProxyModal } from './ProxyModal.tsx';


/** 可选的日志尾部行数档位（默认 120，兼顾 80 / 200 / 500 一键切换）。 */
const LOG_LINE_CHOICES = [80, 120, 200, 500] as const;

/** 自动轮询间隔（10 秒，纯普通 GET）。 */
const POLL_INTERVAL_MS = 10_000;


/** 顶部操作回执横幅结构。 */
interface ActionBanner {
  kind: 'ok' | 'err';
  text: string;
}


/**
 * 复制文本到剪贴板，兼容局域网非 HTTPS 环境（textarea 回退）。
 * @param text 待复制文本。
 */
async function copyTextSafe(text: string): Promise<boolean> {
  //M 优先调用标准异步剪贴板 API。
  if (typeof navigator !== 'undefined' && navigator.clipboard && window.isSecureContext) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      //G 权限拒绝时继续尝试回退方案。
    }
  }
  try {
    //M 在局域网 HTTP 环境下借隐藏 textarea 完成复制。
    const box = document.createElement('textarea');
    box.value = text;
    box.setAttribute('readonly', 'true');
    box.style.position = 'fixed';
    box.style.opacity = '0';
    document.body.appendChild(box);
    box.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(box);
    return ok;
  } catch {
    return false;
  }
}


/**
 * 根据 FrpcStatus 推导指示灯色相、顶栏短文案与英雄卡主标题。
 */
function resolveBeaconState(status: frpcApi.FrpcStatus | null): {
  tone: 'online' | 'pending' | 'offline';
  shortText: string;
  heroTitle: string;
} {
  if (status === null) {
    return { tone: 'offline', shortText: '连接中…', heroTitle: '正在读取隧道状态…' };
  }
  if (!status.configured) {
    return { tone: 'offline', shortText: '未配置', heroTitle: '未找到 frpc.toml 配置文件' };
  }
  if (status.running && status.connected) {
    return { tone: 'online', shortText: '已连接', heroTitle: '在线已连通' };
  }
  if (status.running) {
    return { tone: 'pending', shortText: '运行中待连', heroTitle: '进程运行中 · 正在连接远端' };
  }
  return { tone: 'offline', shortText: '已停止', heroTitle: '已停止' };
}


/**
 * 拼装单条隧道卡片右侧展示的外网访问目标列表。
 */
function getRemoteTargets(proxy: frpcApi.FrpcProxy, serverAddr: string): string[] {
  const isHttpLike = proxy.type === 'http' || proxy.type === 'https';
  if (isHttpLike) {
    const out: string[] = [];
    for (const domain of proxy.customDomains ?? []) {
      out.push(`${proxy.type}://${domain}`);
    }
    if (proxy.subdomain !== undefined && proxy.subdomain !== '') {
      out.push(`子域: ${proxy.subdomain}`);
    }
    if (out.length > 0) return out;

    return ['未填域名'];
  }
  let host = '远端服务器';
  if (serverAddr !== '') host = serverAddr;
  if (proxy.remotePort !== undefined) {
    return [`${host}:${String(proxy.remotePort)}`];
  }
  return [host];
}


/**
 * 顶部状态与控制英雄卡（Hero Card）。
 */
function HeroSection(props: {
  status: frpcApi.FrpcStatus;
  beacon: ReturnType<typeof resolveBeaconState>;
  busy: boolean;
  pendingControl: frpcApi.FrpcControlAction | null;
  pendingAutoStart: boolean;
  copiedUrl: string;
  onControl: (action: frpcApi.FrpcControlAction) => void;
  onToggleAutoStart: (next: boolean) => void;
  onCopyUrl: (url: string) => void;
}): react.JSX.Element {
  const { status, beacon, busy, pendingControl, copiedUrl } = props;

  let serverText = '未配置服务器';
  if (status.serverAddr !== '' && status.serverPort > 0) {
    serverText = `${status.serverAddr}:${String(status.serverPort)}`;
  }
  if (status.serverAddr !== '' && status.serverPort <= 0) {
    serverText = status.serverAddr;
  }

  let frpcPidText = '未运行';
  if (status.running && status.pid > 0) frpcPidText = `PID ${String(status.pid)}`;

  let trayPidText = '未运行';
  if (status.trayRunning && status.trayPid > 0) trayPidText = `PID ${String(status.trayPid)}`;
  if (status.trayRunning && status.trayPid <= 0) trayPidText = '运行中';

  let switchClass = 'fr-switch';
  if (status.autoStart) switchClass += ' on';

  return (
    <section className={`fr-hero tone-${beacon.tone}`} aria-label="外网隧道运行状态与主控">
      <div className="fr-hero-top">
        <div className="fr-hero-status">
          <div className={`fr-orb ${beacon.tone}`} aria-hidden="true">
            <span className="fr-orb-core" />
          </div>
          <div className="fr-hero-titles">
            <div className="fr-hero-title-row">
              <h1>{beacon.heroTitle}</h1>
              {status.updatedAt !== '' && (
                <span className="fr-updated-at">更新于 {status.updatedAt}</span>
              )}
            </div>
            {status.detail !== '' && <p className="fr-hero-detail">{status.detail}</p>}
            {status.dir !== '' && <div className="fr-hero-dir" title={status.dir}>{status.dir}</div>}
          </div>
        </div>

        <div className="fr-ctrl-group" role="group" aria-label="隧道进程控制">
          <button
            type="button"
            className="fr-ctrl-btn start"
            data-frpc-action="start"
            disabled={!status.configured || busy || (status.running && status.connected)}
            onClick={() => props.onControl('start')}
          >
            {pendingControl === 'start' && '正在启动…'}
            {pendingControl !== 'start' && '▶ 启动隧道'}
          </button>
          <button
            type="button"
            className="fr-ctrl-btn restart"
            data-frpc-action="restart"
            disabled={!status.configured || busy}
            onClick={() => props.onControl('restart')}
          >
            {pendingControl === 'restart' && '正在重启…'}
            {pendingControl !== 'restart' && '↻ 重启隧道'}
          </button>
          <button
            type="button"
            className="fr-ctrl-btn stop"
            data-frpc-action="stop"
            disabled={!status.configured || busy || !status.running}
            onClick={() => props.onControl('stop')}
          >
            {pendingControl === 'stop' && '正在停止…'}
            {pendingControl !== 'stop' && '■ 停止隧道'}
          </button>
        </div>
      </div>

      <div className="fr-meta-chips">
        <span className="fr-chip">
          <b>远端服务</b>
          <code>{serverText}</code>
        </span>
        {status.user !== '' && (
          <span className="fr-chip">
            <b>客户端标识</b>
            <code>{status.user}</code>
          </span>
        )}
        {status.tlsEnabled && <span className="fr-chip ok">🔒 TLS 已启用</span>}
        {!status.tlsEnabled && <span className="fr-chip muted">TLS 未开启</span>}
        {status.hasAuthToken && <span className="fr-chip gold">🛡️ Token 已保护</span>}
        {!status.hasAuthToken && <span className="fr-chip muted">未设 Token</span>}
        <span className="fr-chip">
          <b>隧道进程</b>
          <code>{frpcPidText}</code>
        </span>
        <span className="fr-chip">
          <b>托盘守护</b>
          <code>{trayPidText}</code>
        </span>
      </div>

      <div className="fr-autostart-bar">
        <div className="fr-autostart-info">
          <span className="fr-autostart-title">Windows 开机自启</span>
          <span className="fr-autostart-desc">开启后电脑重启自动拉起托盘与外网隧道（无黑框静默守护）</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={status.autoStart}
          aria-label="Windows 开机自启"
          data-frpc-autostart
          className={switchClass}
          disabled={busy || !status.configured}
          onClick={() => props.onToggleAutoStart(!status.autoStart)}
        >
          <span className="fr-switch-knob" />
          <span className="fr-switch-text">
            {status.autoStart && '已开启'}
            {!status.autoStart && '已关闭'}
          </span>
        </button>
      </div>

      {status.publicUrls.length > 0 && (
        <div className="fr-pub-bar" aria-label="公网快捷入口">
          <div className="fr-pub-head">🌍 公网快捷入口</div>
          <div className="fr-pub-list">
            {status.publicUrls.map((url) => {
              const isCopied = copiedUrl === url;
              return (
                <div key={url} className="fr-pub-item">
                  <code className="fr-pub-url">{url}</code>
                  <div className="fr-pub-actions">
                    <a
                      className="fr-mini-btn accent"
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      新窗打开 ↗
                    </a>
                    <button
                      type="button"
                      className="fr-mini-btn"
                      onClick={() => props.onCopyUrl(url)}
                    >
                      {isCopied && '已复制 ✓'}
                      {!isCopied && '一键复制'}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}


/**
 * 可视化隧道映射列表区块。
 */
function ProxiesSection(props: {
  status: frpcApi.FrpcStatus;
  deletingName: string | null;
  busy: boolean;
  savingProxy: boolean;
  onAdd: () => void;
  onEdit: (name: string) => void;
  onAskDelete: (name: string) => void;
  onCancelDelete: () => void;
  onConfirmDelete: (name: string) => void;
}): react.JSX.Element {
  const { status, deletingName, busy, savingProxy } = props;
  const proxies = status.proxies;

  return (
    <section className="fr-section" aria-label="隧道映射规则">
      <div className="fr-sec-head">
        <div className="fr-sec-title-wrap">
          <h2>隧道映射规则</h2>
          <span className="fr-count-badge">{String(proxies.length)} 条</span>
        </div>
        <button
          type="button"
          className="fr-btn primary sm"
          data-frpc-add-proxy
          disabled={!status.configured || busy}
          onClick={props.onAdd}
        >
          + 新增隧道
        </button>
      </div>

      {proxies.length === 0 && (
        <div className="fr-empty-box">
          <p>当前 `frpc.toml` 暂无 `[[proxies]]` 端口映射规则。</p>
          <button
            type="button"
            className="fr-btn secondary sm"
            disabled={!status.configured || busy}
            onClick={props.onAdd}
          >
            立即新增第一条隧道
          </button>
        </div>
      )}

      {proxies.length > 0 && (
        <div className="fr-proxy-grid">
          {proxies.map((proxy, index) => {
            const targets = getRemoteTargets(proxy, status.serverAddr);
            const isGuardedMain = proxy.localPort === 30086 && frpcApi.isAllowedMainPortIp(proxy.localIP);
            const isDeleting = deletingName === proxy.name;

            return (
              <article key={`${proxy.name}-${String(index)}`} className="fr-proxy-card" data-proxy-card={proxy.name}>
                <div className="fr-proxy-top">
                  <div className="fr-proxy-title">
                    <span className={`fr-proto-badge ${proxy.type}`}>{proxy.type.toUpperCase()}</span>
                    <code className="fr-proxy-name">{proxy.name}</code>
                  </div>
                  <div className="fr-proxy-ops">
                    <button
                      type="button"
                      className="fr-mini-btn"
                      disabled={busy}
                      onClick={() => props.onEdit(proxy.name)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      className="fr-mini-btn danger"
                      disabled={busy}
                      onClick={() => props.onAskDelete(proxy.name)}
                    >
                      删除
                    </button>
                  </div>
                </div>

                <div className="fr-proxy-route">
                  <div className="fr-endpoint-box">
                    <span className="fr-ep-label">本地源</span>
                    <code className="fr-ep-val">{proxy.localIP}:{String(proxy.localPort)}</code>
                    {isGuardedMain && <span className="fr-ep-safe">门禁已保护</span>}
                  </div>
                  <span className="fr-route-arrow" aria-hidden="true">→</span>
                  <div className="fr-endpoint-box remote">
                    <span className="fr-ep-label">外网入口</span>
                    <div className="fr-ep-targets">
                      {targets.map((target) => (
                        <code key={target} className="fr-ep-target">{target}</code>
                      ))}
                    </div>
                  </div>
                </div>

                {isDeleting && (
                  <div className="fr-delete-confirm" role="alert">
                    <span>确认删除隧道「{proxy.name}」并平滑重启？</span>
                    <div className="fr-delete-actions">
                      <button
                        type="button"
                        className="fr-mini-btn"
                        disabled={busy}
                        onClick={props.onCancelDelete}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="fr-mini-btn danger-solid"
                        disabled={busy}
                        onClick={() => props.onConfirmDelete(proxy.name)}
                      >
                        {savingProxy && '删除中…'}
                        {!savingProxy && '确认删除并重启'}
                      </button>
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}


/**
 * 实时运行日志面板组件。
 */
function LogsSection(props: {
  logs: frpcApi.FrpcLogsResponse | null;
  loadingLogs: boolean;
  logError: string;
  lineLimit: number;
  autoPoll: boolean;
  termRef: react.RefObject<HTMLDivElement | null>;
  onChangeLineLimit: (limit: number) => void;
  onToggleAutoPoll: () => void;
  onRefreshLogs: () => void;
  onScrollBottom: () => void;
}): react.JSX.Element {
  const { logs, loadingLogs, logError, lineLimit, autoPoll, termRef } = props;
  const lines = logs?.lines ?? [];
  let pollClass = 'fr-mini-btn';
  if (autoPoll) pollClass += ' active-poll';

  return (
    <section className="fr-section fr-logs-card" aria-label="FRPC 运行日志">
      <div className="fr-sec-head logs-head">
        <div className="fr-sec-title-wrap">
          <h2>实时运行日志 (frpc.log)</h2>
          {logs !== null && (
            <span className="fr-log-meta">
              {frpcApi.formatBytes(logs.totalBytes)}
              {logs.updatedAt !== '' && ` · ${logs.updatedAt}`}
            </span>
          )}
        </div>

        <div className="fr-log-tools">
          <div className="fr-line-seg" role="group" aria-label="日志行数切换">
            {LOG_LINE_CHOICES.map((choice) => (
              <button
                key={choice}
                type="button"
                className="fr-line-btn"
                data-log-lines={choice}
                aria-pressed={lineLimit === choice}
                onClick={() => props.onChangeLineLimit(choice)}
              >
                {String(choice)} 行
              </button>
            ))}
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={autoPoll}
            className={pollClass}
            data-log-autopoll
            onClick={props.onToggleAutoPoll}
          >
            {autoPoll && '● 自动 10s 轮询中'}
            {!autoPoll && '○ 自动每 10 秒轮询'}
          </button>

          <button type="button" className="fr-mini-btn" onClick={props.onScrollBottom}>
            滚到底部 ↓
          </button>

          <button
            type="button"
            className="fr-mini-btn accent"
            disabled={loadingLogs}
            onClick={props.onRefreshLogs}
          >
            {loadingLogs && '刷新中…'}
            {!loadingLogs && '↻ 刷新日志'}
          </button>
        </div>
      </div>

      {logError !== '' && <div className="fr-form-error">{logError}</div>}

      <div className="fr-log-term" ref={termRef} tabIndex={0} aria-label="日志输出终端">
        {lines.length === 0 && !loadingLogs && logError === '' && (
          <div className="fr-log-empty">暂无日志输出（启动隧道后将在此实时显示连接记录）</div>
        )}
        {lines.map((line, idx) => {
          const level = frpcApi.classifyLogLine(line);
          return (
            <div key={idx} className={`fr-log-line ${level}`}>
              <span className="fr-log-no">{String(idx + 1)}</span>
              <span className="fr-log-txt">{line}</span>
            </div>
          );
        })}
      </div>
    </section>
  );
}


/**
 * 外网隧道（/frpc/）完整控制台页面。
 */
export function FrpcPage(): react.JSX.Element {
  const [themeName, setThemeName] = react.useState<theme.ThemeName>(
    () => theme.loadThemeName(window.localStorage),
  );
  const webAuth = authGate.useWebAuth();

  const [status, setStatus] = react.useState<frpcApi.FrpcStatus | null>(null);
  const [loading, setLoading] = react.useState(true);
  const [refreshing, setRefreshing] = react.useState(false);
  const [loadError, setLoadError] = react.useState('');
  const [banner, setBanner] = react.useState<ActionBanner | null>(null);

  const [pendingControl, setPendingControl] = react.useState<frpcApi.FrpcControlAction | null>(null);
  const [pendingAutoStart, setPendingAutoStart] = react.useState(false);
  const [copiedUrl, setCopiedUrl] = react.useState('');

  const [modalOpen, setModalOpen] = react.useState(false);
  const [editingName, setEditingName] = react.useState<string | null>(null);
  const [savingProxy, setSavingProxy] = react.useState(false);
  const [deletingName, setDeletingName] = react.useState<string | null>(null);

  const [lineLimit, setLineLimit] = react.useState<number>(120);
  const [logs, setLogs] = react.useState<frpcApi.FrpcLogsResponse | null>(null);
  const [loadingLogs, setLoadingLogs] = react.useState(false);
  const [logError, setLogError] = react.useState('');
  const [autoPoll, setAutoPoll] = react.useState(true);
  const termRef = react.useRef<HTMLDivElement | null>(null);

  //M 全局写操作互斥与请求序号守卫，彻底杜绝旧轮询回包覆盖刚提交的控制或配置状态。
  const busy = pendingControl !== null || savingProxy || pendingAutoStart;
  const busyRef = react.useRef(busy);
  busyRef.current = busy;
  const writeLockRef = react.useRef(false);
  const statusSeqRef = react.useRef(0);
  const logsSeqRef = react.useRef(0);
  const lineLimitRef = react.useRef(lineLimit);
  lineLimitRef.current = lineLimit;

  //M 同步全局主题变量并监听跨标签页主题切换。
  react.useEffect(() => {
    theme.applyTheme(document.documentElement, theme.THEMES[themeName]);
  }, [themeName]);

  react.useEffect(() => {
    const onStorage = (): void => {
      setThemeName(theme.loadThemeName(window.localStorage));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  //M 成功提示横幅 4 秒后自动淡出，错误提示保留至用户手动关闭或下次操作。
  react.useEffect(() => {
    if (banner === null || banner.kind !== 'ok') return undefined;

    const timer = window.setTimeout(() => setBanner(null), 4000);
    return () => window.clearTimeout(timer);
  }, [banner]);

  const scrollLogsToBottom = react.useCallback((): void => {
    const el = termRef.current;
    if (el !== null) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  /** 拉取指定行数的末尾日志（按单调序号仅采信最新一次响应）。 */
  const loadLogs = react.useCallback(async (limit: number, stickBottom = false): Promise<void> => {
    logsSeqRef.current += 1;
    const seq = logsSeqRef.current;
    setLoadingLogs(true);
    try {
      const nextLogs = await frpcApi.fetchFrpcLogs(limit);
      if (seq !== logsSeqRef.current) return;

      setLogs(nextLogs);
      setLogError('');
      if (stickBottom) {
        window.requestAnimationFrame(() => scrollLogsToBottom());
      }
    } catch (err) {
      if (seq !== logsSeqRef.current) return;

      setLogError((err as Error).message || '读取 frpc.log 失败');
    } finally {
      if (seq === logsSeqRef.current) {
        setLoadingLogs(false);
      }
    }
  }, [scrollLogsToBottom]);

  /** 刷新状态与日志（支持首屏加载、手动刷新与后台静默轮询共用同一套防竞态逻辑）。 */
  const refreshAll = react.useCallback(async (mode: 'initial' | 'manual' | 'poll' = 'manual'): Promise<void> => {
    if (mode !== 'initial' && (busyRef.current || writeLockRef.current)) return;

    statusSeqRef.current += 1;
    const seq = statusSeqRef.current;
    if (mode === 'initial') setLoading(true);
    if (mode === 'manual') setRefreshing(true);
    try {
      const nextStatus = await frpcApi.fetchFrpcStatus();
      if (seq === statusSeqRef.current && !busyRef.current && !writeLockRef.current) {
        setStatus(nextStatus);
        setLoadError('');
      }
    } catch (err) {
      if (mode !== 'poll' && seq === statusSeqRef.current) {
        setLoadError((err as Error).message || '无法连接外网隧道状态接口');
      }
    } finally {
      if (mode === 'initial') setLoading(false);
      if (mode === 'manual') setRefreshing(false);
    }
    if (busyRef.current || writeLockRef.current) return;

    await loadLogs(lineLimitRef.current, mode === 'initial');
  }, [loadLogs]);

  //M 页面首次挂载时拉取完整状态与默认 120 行日志。
  react.useEffect(() => {
    void refreshAll('initial');
  }, [refreshAll]);

  //M 开启每 10 秒自动轮询时：写操作进行中或页面不可见时直接跳过，切换日志行数不重建定时器。
  react.useEffect(() => {
    if (!autoPoll) return undefined;

    const timer = window.setInterval(() => {
      if (document.visibilityState !== 'visible' || busyRef.current || writeLockRef.current) return;

      void refreshAll('poll');
    }, POLL_INTERVAL_MS);
    return () => window.clearInterval(timer);
  }, [autoPoll, refreshAll]);

  /** 执行启动 / 停止 / 重启隧道动作。 */
  const handleControl = async (action: frpcApi.FrpcControlAction): Promise<void> => {
    if (busy || writeLockRef.current) return;

    writeLockRef.current = true;
    statusSeqRef.current += 1;
    setPendingControl(action);
    setBanner(null);
    let label = '启动';
    if (action === 'stop') label = '停止';
    if (action === 'restart') label = '重启';
    try {
      const res = await frpcApi.controlFrpc(action);
      statusSeqRef.current += 1;
      setStatus(res.status);
      setLoadError('');
      setBanner({ kind: 'ok', text: `隧道${label}指令已执行` });
      await loadLogs(lineLimitRef.current, true);
    } catch (err) {
      setBanner({ kind: 'err', text: `${label}失败：${(err as Error).message}` });
    } finally {
      writeLockRef.current = false;
      setPendingControl(null);
    }
  };

  /** 切换开机自启。 */
  const handleToggleAutoStart = async (enabled: boolean): Promise<void> => {
    if (busy || writeLockRef.current) return;

    writeLockRef.current = true;
    statusSeqRef.current += 1;
    setPendingAutoStart(true);
    setBanner(null);
    try {
      const res = await frpcApi.setFrpcAutoStart(enabled);
      statusSeqRef.current += 1;
      setStatus((prev) => {
        if (prev === null) return null;

        return { ...prev, autoStart: res.autoStart };
      });
      let msg = '已关闭 Windows 开机自启';
      if (res.autoStart) msg = '已开启 Windows 开机自启（下次开机自动拉起托盘与隧道）';
      setBanner({ kind: 'ok', text: msg });
    } catch (err) {
      setBanner({ kind: 'err', text: `设置开机自启失败：${(err as Error).message}` });
    } finally {
      writeLockRef.current = false;
      setPendingAutoStart(false);
    }
  };

  /** 复制公网快捷入口链接。 */
  const handleCopyUrl = async (url: string): Promise<void> => {
    const ok = await copyTextSafe(url);
    if (!ok) {
      setBanner({ kind: 'err', text: '浏览器未允许自动复制，请长按或手动复制链接' });
      return;
    }
    setCopiedUrl(url);
    window.setTimeout(() => {
      setCopiedUrl((cur) => {
        if (cur === url) return '';

        return cur;
      });
    }, 1800);
  };

  /** 提交新增或修改后的单条映射规则（按原规则 name 定位替换，杜绝轮询重排错改）。 */
  const handleSubmitProxy = async (proxy: frpcApi.FrpcProxy, restart: boolean): Promise<void> => {
    if (status === null || busy || writeLockRef.current) return;

    writeLockRef.current = true;
    statusSeqRef.current += 1;
    setSavingProxy(true);
    try {
      const nextList = [...status.proxies];
      if (editingName !== null) {
        const targetIdx = nextList.findIndex((item) => item.name === editingName);
        if (targetIdx < 0) {
          throw new Error(`原隧道「${editingName}」已被移除，请关闭弹层刷新后重试`);
        }
        nextList[targetIdx] = proxy;
      }
      if (editingName === null) {
        nextList.push(proxy);
      }
      const res = await frpcApi.saveFrpcProxies(nextList, restart);
      statusSeqRef.current += 1;
      setStatus(res.status);
      setLoadError('');
      setModalOpen(false);
      setEditingName(null);
      let note = `已保存隧道「${proxy.name}」配置`;
      if (restart) note = `已保存隧道「${proxy.name}」并平滑重启生效`;
      setBanner({ kind: 'ok', text: note });
      await loadLogs(lineLimitRef.current, true);
    } finally {
      writeLockRef.current = false;
      setSavingProxy(false);
    }
  };

  /** 确认删除指定名称的隧道映射并重启生效。 */
  const handleConfirmDelete = async (targetName: string): Promise<void> => {
    if (status === null || busy || writeLockRef.current) return;

    const target = status.proxies.find((item) => item.name === targetName);
    if (target === undefined) {
      setDeletingName(null);
      return;
    }

    writeLockRef.current = true;
    statusSeqRef.current += 1;
    setSavingProxy(true);
    try {
      const nextList = status.proxies.filter((item) => item.name !== targetName);
      const res = await frpcApi.saveFrpcProxies(nextList, true);
      statusSeqRef.current += 1;
      setStatus(res.status);
      setLoadError('');
      setDeletingName(null);
      setBanner({ kind: 'ok', text: `已删除隧道「${target.name}」并平滑重启` });
      await loadLogs(lineLimitRef.current, true);
    } catch (err) {
      setBanner({ kind: 'err', text: `删除隧道失败：${(err as Error).message}` });
    } finally {
      writeLockRef.current = false;
      setSavingProxy(false);
    }
  };

  /** 切换日志尾部行数档位并立即重拉。 */
  const handleChangeLineLimit = (nextLimit: number): void => {
    lineLimitRef.current = nextLimit;
    setLineLimit(nextLimit);
    void loadLogs(nextLimit, true);
  };

  const handleCloseModal = react.useCallback((): void => {
    if (busyRef.current || writeLockRef.current) return;

    setModalOpen(false);
    setEditingName(null);
  }, []);

  const beacon = resolveBeaconState(status);
  let editingProxy: frpcApi.FrpcProxy | null = null;
  let editIndex = -1;
  if (status !== null && editingName !== null) {
    editIndex = status.proxies.findIndex((item) => item.name === editingName);
    if (editIndex >= 0) {
      editingProxy = status.proxies[editIndex] ?? null;
    }
  }

  return (
    <div className="fr-page">
      <header className="fr-top">
        <div className="fr-top-left">
          <a className="fr-back-link" href={withToken('/', TOKEN)}>
            ← 返回聊天
          </a>
        </div>

        <div className="fr-top-center">
          <span className="fr-top-brand">外网隧道 (FRPC)</span>
          <span className={`fr-status-pill ${beacon.tone}`} data-frpc-state={beacon.tone}>
            <span className="fr-dot" aria-hidden="true" />
            {beacon.shortText}
          </span>
        </div>

        <div className="fr-top-right">
          <a className="fr-nav-link" href={withToken('/work-decision/', TOKEN)}>
            工作决策
          </a>
          <a className="fr-nav-link" href={withToken('/knowledge/', TOKEN)}>
            知识库
          </a>
          <a className="fr-nav-link" href={withToken('/tutorial/', TOKEN)}>
            教程
          </a>
          <a className="fr-nav-link" href={withToken('/wechat-kefu/', TOKEN)}>
            智能客服
          </a>
          <a className="fr-nav-link" href={withToken('/graph/', TOKEN)}>
            知识图谱
          </a>
          <a className="fr-nav-link" href={withToken('/memory/', TOKEN)}>
            记忆搜索
          </a>
          <button
            type="button"
            className="fr-nav-btn"
            disabled={refreshing || loading || busy}
            title="立即刷新状态与日志"
            onClick={() => void refreshAll('manual')}
          >
            {refreshing && '刷新中…'}
            {!refreshing && '↻ 刷新'}
          </button>
          {webAuth.required && (
            <button
              type="button"
              className="fr-nav-btn danger"
              onClick={() => void webAuth.logout()}
            >
              退出
            </button>
          )}
        </div>
      </header>

      <main className="fr-main">
        {banner !== null && (
          <div className={`fr-banner ${banner.kind}`} role="status">
            <span>{banner.text}</span>
            <button
              type="button"
              className="fr-banner-close"
              aria-label="关闭提示"
              onClick={() => setBanner(null)}
            >
              ✕
            </button>
          </div>
        )}

        {loadError !== '' && (
          <div className="fr-error-card" role="alert">
            <div className="fr-error-text">
              <strong>读取外网隧道状态未成功</strong>
              <span>{loadError}</span>
            </div>
            <button
              type="button"
              className="fr-btn secondary sm"
              disabled={busy}
              onClick={() => void refreshAll('manual')}
            >
              重试连接
            </button>
          </div>
        )}

        {loading && status === null && loadError === '' && (
          <div className="fr-loading-box">正在连接 FRPC 外网隧道服务…</div>
        )}

        {status !== null && (
          <>
            <HeroSection
              status={status}
              beacon={beacon}
              busy={busy}
              pendingControl={pendingControl}
              pendingAutoStart={pendingAutoStart}
              copiedUrl={copiedUrl}
              onControl={(act) => void handleControl(act)}
              onToggleAutoStart={(next) => void handleToggleAutoStart(next)}
              onCopyUrl={(url) => void handleCopyUrl(url)}
            />

            <ProxiesSection
              status={status}
              deletingName={deletingName}
              busy={busy}
              savingProxy={savingProxy}
              onAdd={() => {
                setEditingName(null);
                setModalOpen(true);
              }}
              onEdit={(targetName) => {
                setEditingName(targetName);
                setModalOpen(true);
              }}
              onAskDelete={(targetName) => setDeletingName(targetName)}
              onCancelDelete={() => setDeletingName(null)}
              onConfirmDelete={(targetName) => void handleConfirmDelete(targetName)}
            />
          </>
        )}

        <LogsSection
          logs={logs}
          loadingLogs={loadingLogs}
          logError={logError}
          lineLimit={lineLimit}
          autoPoll={autoPoll}
          termRef={termRef}
          onChangeLineLimit={handleChangeLineLimit}
          onToggleAutoPoll={() => setAutoPoll((prev) => !prev)}
          onRefreshLogs={() => void loadLogs(lineLimit, true)}
          onScrollBottom={scrollLogsToBottom}
        />
      </main>

      <ProxyModal
        open={modalOpen}
        editIndex={editIndex}
        editingName={editingName}
        initialProxy={editingProxy}
        existingProxies={status?.proxies ?? []}
        serverAddr={status?.serverAddr ?? ''}
        saving={savingProxy}
        onClose={handleCloseModal}
        onSubmit={handleSubmitProxy}
      />
    </div>
  );
}
