/**
 * 访问令牌，所有网页共用这一份（主网页、/graph/、/memory/、/wechat-kefu/、/flow/ 都从这里拿）。
 * 2026-11-14 22:50 EST（Claude 22:35 第 6 节）：原来 Api.ts、GraphApi.ts、MemoryPage.tsx、WechatPage.tsx 各读一份，
 * 子页直接打开 /wechat-kefu/?token=… 时认不到、地址栏也不去掉；合成这一份。
 * 规则（docs/界面/05_外部AI任务通道.md 第 3 节）：地址里带 ?token= 就记进浏览器、从地址栏去掉（免得截图、复制带出去），没带就用记着的。
 */


/** 访问令牌在浏览器里存的键。 */
export const TOKEN_KEY = 'jmbots.token';


/** 读令牌要用到的浏览器那几样（测试里换成假的）。 */
export interface TokenEnv {
  /** 现在的完整地址。 */
  href: string;
  /** 存令牌的地方（浏览器里是 localStorage）。 */
  storage: Pick<Storage, 'getItem' | 'setItem'>;
  /** 换掉地址栏、不刷新（浏览器里是 history.replaceState）。 */
  replace: (url: string) => void;
}


/**
 * 取令牌：地址里带了就记下并从地址栏去掉，没带就用记着的。
 * @param env 浏览器那几样。
 * @returns 令牌；没有是空字符串。
 */
export function takeToken(env: TokenEnv): string {
  /** 现在的地址。 */
  const url = new URL(env.href);
  /** 地址里的。 */
  const fromUrl = url.searchParams.get('token');
  //M 带了 ?token=（哪怕是空的）都从地址栏去掉；空的不记。
  if (fromUrl !== null) {
    if (fromUrl !== '') env.storage.setItem(TOKEN_KEY, fromUrl);
    url.searchParams.delete('token');
    env.replace(url.toString());
  }
  return env.storage.getItem(TOKEN_KEY) ?? '';
}


/**
 * 给地址加上 token 参数（img、video、fetch 都能用）。
 * @param path 相对地址，可以已经带 ?。
 * @param token 令牌；空的原样返回。
 * @returns 带令牌的地址。
 */
export function withToken(path: string, token: string): string {
  if (token === '') return path;
  /** 井号后面的留在最后。 */
  const hash = path.indexOf('#');
  /** 井号前面。 */
  const head = hash < 0 ? path : path.slice(0, hash);
  /** 井号和后面。 */
  const tail = hash < 0 ? '' : path.slice(hash);
  return `${head}${head.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}${tail}`;
}


/**
 * 在浏览器里取令牌。
 * @returns 令牌；不是浏览器（测试里）或存不了时是空字符串。
 */
function browserToken(): string {
  try {
    return takeToken({
      href: window.location.href,
      storage: window.localStorage,
      replace: (url) => window.history.replaceState(window.history.state, '', url),
    });
  } catch {
    //G 不是浏览器（测试里）或者存不了：当没有。
    return '';
  }
}


/** 现在用的令牌：模块加载时取一次（哪个页面先 import 都一样）。换令牌要刷新页面。 */
export const TOKEN = browserToken();
