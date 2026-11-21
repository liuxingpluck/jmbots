/**
 * 外网隧道映射规则（[[proxies]]）新增与编辑弹层组件。
 * 内置 30086 端口防环回地址（127.0.0.1 / localhost）安全引导与协议自适应表单。
 */
import * as react from 'react';
import * as frpcApi from './FrpcApi.ts';


/** 弹层属性。 */
export interface ProxyModalProps {
  /** 是否打开弹层。 */
  open: boolean;
  /** 编辑原规则下标；新增为 -1。 */
  editIndex: number;
  /** 编辑态原规则名称（按名称排除自身重名判断）；新增为 null。 */
  editingName?: string | null;
  /** 编辑态初始规则；新增为 null。 */
  initialProxy: frpcApi.FrpcProxy | null;
  /** 当前已有的全部规则（用于重名校验）。 */
  existingProxies: readonly frpcApi.FrpcProxy[];
  /** 远端 frps 服务器地址（用于预览远端端口入口）。 */
  serverAddr: string;
  /** 是否正在提交保存。 */
  saving: boolean;
  /** 关闭弹层回调。 */
  onClose: () => void;
  /** 提交回调（restart=true 时保存并平滑重启隧道）。 */
  onSubmit: (proxy: frpcApi.FrpcProxy, restart: boolean) => Promise<void>;
}


/**
 * 隧道映射新增与编辑弹层。
 */
export function ProxyModal(props: ProxyModalProps): react.JSX.Element | null {
  const { open, editIndex, editingName, initialProxy, existingProxies, serverAddr, saving, onClose } = props;
  const [name, setName] = react.useState('');
  const [proto, setProto] = react.useState<frpcApi.FrpcProtocol>('http');
  const [localIP, setLocalIP] = react.useState('192.168.200.1');
  const [localPort, setLocalPort] = react.useState('30086');
  const [domainsText, setDomainsText] = react.useState('');
  const [subdomain, setSubdomain] = react.useState('');
  const [remotePort, setRemotePort] = react.useState('');
  const [formError, setFormError] = react.useState('');

  //M 每次打开弹层时用传入规则或安全默认值初始化表单字段。
  react.useEffect(() => {
    if (!open) return;

    setFormError('');
    if (initialProxy === null) {
      setName('');
      setProto('http');
      setLocalIP('192.168.200.1');
      setLocalPort('30086');
      setDomainsText('');
      setSubdomain('');
      setRemotePort('');
      return;
    }
    setName(initialProxy.name);
    setProto(initialProxy.type);
    setLocalIP(initialProxy.localIP);
    setLocalPort(String(initialProxy.localPort));
    setDomainsText((initialProxy.customDomains ?? []).join(', '));
    setSubdomain(initialProxy.subdomain ?? '');
    let nextRemote = '';
    if (initialProxy.remotePort !== undefined) {
      nextRemote = String(initialProxy.remotePort);
    }
    setRemotePort(nextRemote);
  }, [initialProxy, open]);

  //M 按 Escape 快捷关闭弹层（提交中锁定防误触）。
  react.useEffect(() => {
    if (!open) return undefined;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !saving) {
        //M 未在提交时响应 Escape 键关闭弹层。
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, saving, onClose]);

  if (!open) return null;

  const portNum = Number(localPort.trim());
  const isMainPort = portNum === 30086;
  //M 实时检测 30086 端口是否满足非 127./0. 点分 IPv4 白名单，并解析输入域名列表。
  const loopbackDanger = isMainPort && !frpcApi.isAllowedMainPortIp(localIP);
  const isHttpLike = proto === 'http' || proto === 'https';
  const parsedDomains = frpcApi.parseDomainList(domainsText);

  //M 切换本地端口为 30086 时若当前源 IP 不在主站安全白名单内，自动切到局域网地址 192.168.200.1。
  const handlePortChange = (nextVal: string): void => {
    setLocalPort(nextVal);
    setFormError('');
    if (Number(nextVal.trim()) === 30086 && !frpcApi.isAllowedMainPortIp(localIP)) {
      setLocalIP('192.168.200.1');
    }
  };

  /** 构造当前表单对应的 FrpcProxy 对象并执行前端校验后提交。 */
  const submitForm = async (restart: boolean): Promise<void> => {
    //G 保存过程中忽略重复点击。
    if (saving) return;

    const candidate: frpcApi.FrpcProxy = {
      name: name.trim(),
      type: proto,
      localIP: localIP.trim(),
      localPort: Number(localPort.trim()),
    };
    if (isHttpLike && parsedDomains.length > 0) {
      candidate.customDomains = parsedDomains;
    }
    if (isHttpLike && subdomain.trim() !== '') {
      candidate.subdomain = subdomain.trim();
    }
    if (!isHttpLike && remotePort.trim() !== '') {
      candidate.remotePort = Number(remotePort.trim());
    }

    //M 提交前先走共享规则校验，拦截空名、重名、非法端口与 30086 白名单外地址。
    const invalidReason = frpcApi.validateProxyCandidate(candidate, existingProxies, editIndex, editingName);
    if (invalidReason !== '') {
      setFormError(invalidReason);
      return;
    }
    setFormError('');
    try {
      await props.onSubmit(candidate, restart);
    } catch (err) {
      setFormError((err as Error).message || '保存隧道规则失败');
    }
  };

  let modalTitle = '新增外网隧道映射';
  if (editIndex >= 0) modalTitle = `编辑隧道映射 · ${initialProxy?.name ?? ''}`;

  let serverPreview = '远端服务器';
  if (serverAddr !== '') serverPreview = serverAddr;

  return (
    <div
      className="fr-modal-backdrop"
      role="presentation"
      onClick={(event) => {
        //M 点击半透明遮罩层空白处关闭弹层。
        if (event.target === event.currentTarget && !saving) props.onClose();
      }}
    >
      <div className="fr-modal" role="dialog" aria-modal="true" aria-label={modalTitle}>
        <div className="fr-modal-head">
          <h3>{modalTitle}</h3>
          <button
            type="button"
            className="fr-icon-close"
            disabled={saving}
            aria-label="关闭"
            onClick={props.onClose}
          >
            ✕
          </button>
        </div>

        <div className="fr-modal-body">
          <div className="fr-presets">
            <span className="fr-presets-label">快捷预设：</span>
            <button
              type="button"
              className="fr-preset-chip"
              onClick={() => {
                //M 一键填入 jmbots 30086 主站推荐安全源地址。
                setLocalIP('192.168.200.1');
                setLocalPort('30086');
                setProto('http');
                setFormError('');
              }}
            >
              jmbots 主站 (192.168.200.1:30086)
            </button>
            <button
              type="button"
              className="fr-preset-chip"
              onClick={() => {
                //M 一键填入其他普通本机端口预设。
                setLocalIP('127.0.0.1');
                setLocalPort('8080');
                setFormError('');
              }}
            >
              其他本机服务 (127.0.0.1:8080)
            </button>
          </div>

          <div className="fr-field-row two-col">
            <label className="fr-field">
              <span className="fr-field-label">隧道名称 (name)</span>
              <input
                type="text"
                className="fr-input"
                data-proxy-name
                placeholder="例如 jmbots-web"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setFormError('');
                }}
              />
            </label>

            <div className="fr-field">
              <span className="fr-field-label">协议类型 (type)</span>
              <div className="fr-proto-seg" role="radiogroup" aria-label="协议类型">
                {frpcApi.FRPC_PROTOCOLS.map((item) => (
                  <button
                    key={item}
                    type="button"
                    className="fr-proto-btn"
                    data-proto={item}
                    aria-pressed={proto === item}
                    onClick={() => {
                      setProto(item);
                      setFormError('');
                    }}
                  >
                    {item.toUpperCase()}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="fr-field-row two-col">
            <label className="fr-field">
              <span className="fr-field-label">本地源 IP (localIP)</span>
              <input
                type="text"
                className="fr-input mono"
                data-proxy-ip
                placeholder="192.168.200.1"
                value={localIP}
                onChange={(event) => {
                  setLocalIP(event.target.value);
                  setFormError('');
                }}
              />
            </label>

            <label className="fr-field">
              <span className="fr-field-label">本地源端口 (localPort)</span>
              <input
                type="number"
                min={1}
                max={65535}
                className="fr-input mono"
                data-proxy-port
                placeholder="30086"
                value={localPort}
                onChange={
                  //M 修改端口时联动检查 30086 局域网安全默认 IP。
                  (event) => handlePortChange(event.target.value)
                }
              />
            </label>
          </div>

          {isMainPort && !loopbackDanger && (
            <div className="fr-guard-tip safe">
              <span>
                🔒 映射 <code>30086</code> 主站端口已采用非环回地址 <code>{localIP}</code>，外网访问将正常受 AuthGate 登录门禁保护。
              </span>
            </div>
          )}
          {loopbackDanger && (
            <div className="fr-guard-tip danger">
              <span>
                ⚠️ 禁止将 <code>30086</code> 映射到 <code>{localIP}</code>（会导致外网请求被误判为本机直连而绕过登录门禁）！
              </span>
              <button
                type="button"
                className="fr-fix-ip-btn"
                onClick={() => {
                  setLocalIP('192.168.200.1');
                  setFormError('');
                }}
              >
                一键改为 192.168.200.1
              </button>
            </div>
          )}

          {isHttpLike && (
            <>
              <label className="fr-field">
                <span className="fr-field-label">绑定公网域名 (customDomains，多个用逗号分隔)</span>
                <input
                  type="text"
                  className="fr-input mono"
                  data-proxy-domains
                  placeholder="例如 app.xuanguiyl.top"
                  value={domainsText}
                  onChange={(event) => {
                    setDomainsText(event.target.value);
                    setFormError('');
                  }}
                />
                {parsedDomains.length > 0 && (
                  <div className="fr-domain-chips">
                    {parsedDomains.map((domain) => (
                      <span key={domain} className="fr-domain-chip">https://{domain}</span>
                    ))}
                  </div>
                )}
              </label>

              <label className="fr-field">
                <span className="fr-field-label">子域名前缀 (subdomain，可选)</span>
                <input
                  type="text"
                  className="fr-input mono"
                  placeholder="留空即可（仅服务端配置 subdomainHost 时使用）"
                  value={subdomain}
                  onChange={(event) => {
                    setSubdomain(event.target.value);
                    setFormError('');
                  }}
                />
              </label>
            </>
          )}

          {!isHttpLike && (
            <label className="fr-field">
              <span className="fr-field-label">远端暴露端口 (remotePort，1 ~ 65535)</span>
              <input
                type="number"
                min={1}
                max={65535}
                className="fr-input mono"
                data-proxy-remote-port
                placeholder="例如 16000"
                value={remotePort}
                onChange={(event) => {
                  setRemotePort(event.target.value);
                  setFormError('');
                }}
              />
              {remotePort.trim() !== '' && (
                <span className="fr-field-hint">
                  外网访问入口：<code>{serverPreview}:{remotePort.trim()}</code>
                </span>
              )}
            </label>
          )}

          {formError !== '' && (
            <div className="fr-form-error" role="alert">{formError}</div>
          )}
        </div>

        <div className="fr-modal-foot">
          <button
            type="button"
            className="fr-btn ghost"
            disabled={saving}
            onClick={props.onClose}
          >
            取消
          </button>
          <button
            type="button"
            className="fr-btn secondary"
            disabled={saving || loopbackDanger}
            onClick={
              //M 仅回写 frpc.toml 不重启隧道进程。
              () => void submitForm(false)
            }
          >
            仅保存配置
          </button>
          <button
            type="button"
            className="fr-btn primary"
            data-proxy-submit-restart
            disabled={saving || loopbackDanger}
            onClick={
              //M 回写 frpc.toml 后立即平滑重启隧道进程使新规则生效。
              () => void submitForm(true)
            }
          >
            {saving && '正在保存…'}
            {!saving && '保存并平滑重启'}
          </button>
        </div>
      </div>
    </div>
  );
}
