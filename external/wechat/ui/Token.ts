/**
 * 外置微信客服页自包含的访问令牌读取与 URL 拼接工具。
 * 地址栏若带 `?token=` 则自动存入 localStorage 并从地址栏擦除，后续页面接口统一附带令牌。
 */


/** 浏览器本地存储里保存访问令牌的键名。 */
export const TOKEN_KEY = 'jmbots.token';


/** 令牌读取所需的最小浏览器环境接口。 */
export interface TokenEnv {
  /** 当前完整页面 URL。 */
  href: string;
  /** 本地存储读写对象。 */
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  /** 无刷新替换地址栏回调。 */
  replace: (url: string) => void;
}


/**
 * 从当前 URL 或本地存储读取访问令牌，并在存在查询参数时清理地址栏。
 * @param env 浏览器地址与存储接口。
 */
export function takeToken(env: TokenEnv): string {
  const url = new URL(env.href);
  //M 读取查询串中的 ?token= 参数并在非空时写入本地存储。
  const fromUrl = url.searchParams.get('token');
  if (fromUrl !== null) {
    if (fromUrl !== '') {
      env.storage.setItem(TOKEN_KEY, fromUrl);
    }
    url.searchParams.delete('token');
    //M 擦除地址栏里的明文令牌防止截图外泄。
    env.replace(url.toString());
  }
  return env.storage.getItem(TOKEN_KEY) ?? '';
}


/**
 * 为相对请求地址附加 `token=` 查询参数（令牌为空时原样返回）。
 * @param path 相对路径。
 * @param token 访问令牌。
 */
export function withToken(path: string, token: string): string {
  if (token === '') return path;

  const hash = path.indexOf('#');
  let head = path;
  let tail = '';
  if (hash >= 0) {
    head = path.slice(0, hash);
    tail = path.slice(hash);
  }
  let separator = '?';
  if (head.includes('?')) {
    separator = '&';
  }
  return `${head}${separator}token=${encodeURIComponent(token)}${tail}`;
}


/**
 * 在浏览器加载阶段读取一次当前访问令牌；非浏览器环境安全退回空串。
 */
function getBrowserToken(): string {
  try {
    //M 注入真实 window 环境完成令牌提取。
    return takeToken({
      href: window.location.href,
      storage: window.localStorage,
      replace: (url) => window.history.replaceState(window.history.state, '', url),
    });
  } catch {
    return '';
  }
}


/** 当前页面会话锁定的访问令牌。 */
export const TOKEN = getBrowserToken();
