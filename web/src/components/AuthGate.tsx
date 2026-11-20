/**
 * 外网访问登录门禁壳：挂载时查询一次 `GET /api/auth/status`。
 * 家里 127.0.0.1 与内网直连返回 `required: false`，首帧直接放行子页面，零感知、零闪烁；
 * 外网反向代理（`X-External-Proxy: 1`）未登录时呈现深色磨砂登录卡片，支持 PC 与手机竖屏触控提交及退出登录。
 */
import * as react from 'react';
import './AuthGate.css';


//==========================================================
//M 类型与本机直连快速判定
//==========================================================

/** `/api/auth/status` 返回结构。 */
interface AuthStatusPayload {
  /** 当前请求链路是否要求网页登录。 */
  required: boolean;
  /** 当前浏览器是否已持有有效会话 Cookie。 */
  authenticated: boolean;
  /** 已登录时的用户名。 */
  username?: string;
}

/** 门禁壳阶段：checking 仅用于外网域名首屏几毫秒探针，避免未登录先打业务接口。 */
type GatePhase = 'checking' | 'login' | 'ready';

/** 主动触发退出的全局自定义事件名。 */
const LOGOUT_EVENT = 'jmbots:auth-logout';


/**
 * 判断当前地址栏主机名是否为本机环回或内网私有地址。
 * 本机与内网首帧即进入 ready，做到零等待、零闪烁；后台仍核对一次 `/api/auth/status`。
 * @returns 本机或内网直连地址返回 true。
 */
function isDirectInternalHost(): boolean {
  if (typeof window === 'undefined') return true;

  const host = window.location.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
  if (host.startsWith('192.168.') || host.startsWith('10.')) return true;

  return /^172\.(?:1[6-9]|2\d|3[01])\./u.test(host);
}


/**
 * 检查并清理地址栏里的 `?logout=1` 参数，方便书签或地址栏一键登出。
 * @returns 地址栏原本带有 `logout=1` 时返回 true。
 */
function consumeLogoutQuery(): boolean {
  if (typeof window === 'undefined') return false;

  const url = new URL(window.location.href);
  if (url.searchParams.get('logout') !== '1') return false;

  url.searchParams.delete('logout');
  window.history.replaceState(window.history.state, '', url.toString());
  return true;
}


/**
 * 供任意子页面调用的退出登录入口：清除服务端会话 Cookie 并通知当前门禁切回登录页。
 */
export async function logoutWebAuth(): Promise<void> {
  try {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
  } catch {
    //G 网络抖动时仍通知前端切回登录视图，下次联网重新核验。
  }
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new Event(LOGOUT_EVENT));
  }
}


//==========================================================
//M 登录门禁组件
//==========================================================

/**
 * 顶层外网登录门禁壳组件。
 * @param props 子节点为原本要渲染的页面根组件。
 */
export function AuthGate(props: { children: react.ReactNode }): react.JSX.Element {
  //M 本机与内网首帧直接放行；公网域名先挡住子组件挂载，等一次 /api/auth/status 返回后再决定。
  let initialPhase: GatePhase = 'checking';
  if (isDirectInternalHost()) {
    initialPhase = 'ready';
  }

  const [phase, setPhase] = react.useState<GatePhase>(initialPhase);
  const [required, setRequired] = react.useState(false);
  const [currentUser, setCurrentUser] = react.useState('');
  const [username, setUsername] = react.useState('');
  const [password, setPassword] = react.useState('');
  const [showPassword, setShowPassword] = react.useState(false);
  const [submitting, setSubmitting] = react.useState(false);
  const [error, setError] = react.useState('');

  /** 拉取一次服务端登录状态，按结果切换门禁阶段。 */
  const refreshStatus = react.useCallback(async (): Promise<void> => {
    try {
      const response = await fetch('/api/auth/status', {
        cache: 'no-store',
        credentials: 'same-origin',
      });
      if (!response.ok) {
        setPhase('ready');
        return;
      }
      const status = (await response.json()) as AuthStatusPayload;
      setRequired(status.required);
      if (status.required && !status.authenticated) {
        setCurrentUser('');
        setPhase('login');
        return;
      }
      setCurrentUser(status.username ?? '');
      setPhase('ready');
    } catch {
      //G 断网或后端重启瞬间放行子页面，交由页面自有离线提示处理。
      setPhase('ready');
    }
  }, []);

  react.useEffect(() => {
    //M 若地址带 ?logout=1，先清 Cookie 再查状态；正常打开则直接请求一次 /api/auth/status。
    const shouldLogout = consumeLogoutQuery();
    if (shouldLogout) {
      void logoutWebAuth().then(() => refreshStatus());
    }
    if (!shouldLogout) {
      void refreshStatus();
    }

    const onLogout = (): void => {
      setCurrentUser('');
      setPassword('');
      setError('');
      setPhase('login');
    };
    const onUnauthorized = (): void => {
      void refreshStatus();
    };
    window.addEventListener(LOGOUT_EVENT, onLogout);
    window.addEventListener('jmbots:unauthorized', onUnauthorized);
    return () => {
      window.removeEventListener(LOGOUT_EVENT, onLogout);
      window.removeEventListener('jmbots:unauthorized', onUnauthorized);
    };
  }, [refreshStatus]);

  /** 提交账号密码，验证通过后无缝切入当前目标页面。 */
  const handleSubmit = async (event: react.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const trimmedUser = username.trim();
    if (trimmedUser === '' || password === '') {
      setError('请填写账号和密码');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ username: trimmedUser, password }),
      });
      const data = (await response.json().catch(() => ({}))) as {
        ok?: boolean;
        username?: string;
        error?: string;
      };
      if (!response.ok || data.ok !== true) {
        setError(data.error ?? '账号或密码不对');
        return;
      }

      //M Cookie 已由响应头写入浏览器，清空内存中的明文密码后直接放行原目标页面。
      setPassword('');
      setError('');
      setRequired(true);
      setCurrentUser(data.username ?? trimmedUser);
      setPhase('ready');
    } catch {
      setError('网络连接异常，请稍后再试');
    } finally {
      setSubmitting(false);
    }
  };

  //G 公网首屏等待 /api/auth/status 的十几毫秒内保持同色深底，不闪白、不误发未授权请求。
  if (phase === 'checking') {
    return <div className="jm-auth-backdrop" aria-busy="true" />;
  }

  if (phase === 'login') {
    let passwordType: 'password' | 'text' = 'password';
    let toggleLabel = '显示';
    if (showPassword) {
      passwordType = 'text';
      toggleLabel = '隐藏';
    }
    let submitLabel = '进入工作台';
    if (submitting) {
      submitLabel = '正在验证…';
    }

    return (
      <div className="jm-auth-backdrop">
        <div className="jm-auth-card" role="dialog" aria-labelledby="jm-auth-heading">
          <div className="jm-auth-brand">
            <div className="jm-auth-logo" aria-hidden="true">
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                <rect x="3" y="3" width="8" height="8" rx="2" />
                <rect x="13" y="3" width="8" height="8" rx="2" />
                <rect x="3" y="13" width="8" height="8" rx="2" />
                <path d="M14 17h6M17 14v6" />
              </svg>
            </div>
            <h1 id="jm-auth-heading" className="jm-auth-title">积木 AI 工作台</h1>
            <p className="jm-auth-subtitle">外网安全访问验证 · PC 与手机通用</p>
          </div>

          <form className="jm-auth-form" onSubmit={(event) => { void handleSubmit(event); }}>
            <div className="jm-auth-field">
              <label className="jm-auth-label" htmlFor="jm-auth-username">账号</label>
              <input
                id="jm-auth-username"
                className="jm-auth-input"
                type="text"
                name="username"
                autoComplete="username"
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
                placeholder="请输入登录账号"
                value={username}
                onChange={(event) => { setUsername(event.target.value); }}
              />
            </div>

            <div className="jm-auth-field">
              <label className="jm-auth-label" htmlFor="jm-auth-password">密码</label>
              <div className="jm-auth-input-wrap">
                <input
                  id="jm-auth-password"
                  className="jm-auth-input jm-auth-input--password"
                  type={passwordType}
                  name="password"
                  autoComplete="current-password"
                  enterKeyHint="go"
                  placeholder="请输入登录密码"
                  value={password}
                  onChange={(event) => { setPassword(event.target.value); }}
                />
                <button
                  type="button"
                  className="jm-auth-toggle"
                  onClick={() => { setShowPassword((prev) => !prev); }}
                >
                  {toggleLabel}
                </button>
              </div>
            </div>

            {error !== '' && <div className="jm-auth-error" role="alert">{error}</div>}

            <button type="submit" className="jm-auth-submit" disabled={submitting}>
              {submitLabel}
            </button>
          </form>

          <p className="jm-auth-footnote">验证通过后，本设备 30 天内免重复输入密码</p>
        </div>
      </div>
    );
  }

  //M 本地/内网访问（required 为 false）只原样返回子组件，不渲染任何额外节点。
  if (!required) {
    return <>{props.children}</>;
  }

  let logoutTitle = '退出外网登录';
  let logoutText = '退出';
  if (currentUser !== '') {
    logoutTitle = `已登录：${currentUser}（点击退出）`;
    logoutText = `${currentUser} · 退出`;
  }

  return (
    <>
      {props.children}
      <button
        type="button"
        className="jm-auth-logout-tab"
        title={logoutTitle}
        onClick={() => { void logoutWebAuth(); }}
      >
        {logoutText}
      </button>
    </>
  );
}
