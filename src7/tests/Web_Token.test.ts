/**
 * web/src/Token.ts 的离线测试（2026-11-14 22:50 EST，令牌合并）：子页直接打开 ?token= 能认、地址栏去掉、请求带上。
 * 不开浏览器：用假的地址、存储、replace。
 */
import { describe, expect, test } from 'bun:test';
import { TOKEN, TOKEN_KEY, takeToken, withToken } from '../../web/src/Token.ts';

/** 假的浏览器：一个 Map 当 localStorage，记下 replace 过的地址。 */
function fakeEnv(href: string, stored?: string) {
  const map = new Map<string, string>();
  if (stored !== undefined) map.set(TOKEN_KEY, stored);
  const replaced: string[] = [];
  return {
    map,
    replaced,
    env: {
      href,
      storage: { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value) },
      replace: (url: string) => void replaced.push(url),
    },
  };
}

describe('takeToken', () => {
  test('子页 /wechat-kefu/?token= 认令牌、记下、地址栏去掉', () => {
    const f = fakeEnv('http://127.0.0.1:30086/wechat-kefu/?token=FAKE-123');
    expect(takeToken(f.env)).toBe('FAKE-123');
    expect(f.map.get(TOKEN_KEY)).toBe('FAKE-123');
    expect(f.replaced).toEqual(['http://127.0.0.1:30086/wechat-kefu/']);
  });
  test('别的参数和井号留着', () => {
    const f = fakeEnv('http://h/memory/?customer=c1&token=T&q=%E5%90%88%E5%90%8C#x', 'OLD');
    expect(takeToken(f.env)).toBe('T');
    expect(f.replaced).toEqual(['http://h/memory/?customer=c1&q=%E5%90%88%E5%90%8C#x']);
  });
  test('没带就用记着的，不动地址栏', () => {
    const f = fakeEnv('http://h/graph/?customer=c1', 'SAVED');
    expect(takeToken(f.env)).toBe('SAVED');
    expect(f.replaced).toEqual([]);
  });
  test('空的 ?token= 去掉但不覆盖记着的', () => {
    const f = fakeEnv('http://h/?token=', 'SAVED');
    expect(takeToken(f.env)).toBe('SAVED');
    expect(f.replaced).toEqual(['http://h/']);
  });
  test('什么都没有是空字符串', () => {
    expect(takeToken(fakeEnv('http://h/').env)).toBe('');
  });
});

describe('withToken', () => {
  test('没 ? 加 ?，有 ? 加 &', () => {
    expect(withToken('/api/wechat-kefu/status', 'a b')).toBe('/api/wechat-kefu/status?token=a%20b');
    expect(withToken('/api/wechat-kefu/chats?account=x', 'T')).toBe('/api/wechat-kefu/chats?account=x&token=T');
  });
  test('空令牌原样', () => {
    expect(withToken('/api/x?y=1', '')).toBe('/api/x?y=1');
  });
  test('井号留在最后', () => {
    expect(withToken('/a?b=1#c', 'T')).toBe('/a?b=1&token=T#c');
  });
});

test('不是浏览器时 TOKEN 是空字符串，不抛', () => {
  expect(TOKEN).toBe('');
});
