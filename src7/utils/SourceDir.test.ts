/**
 * 源码根目录名 SourceDir.ts 单元测试：getSourceStart 认得开头、分隔符后面的源码前缀，不认别的目录名的尾巴、不认 web/ 下面那个。
 * 正反例里的源码前缀都由 SOURCE_PREFIX 拼，目录改名后测试照样成立。
 * 跑法：bun test ./src7/utils/SourceDir.test.ts
 */
import { describe, expect, test } from 'bun:test';
import { SOURCE_DIR, SOURCE_PREFIX, getSourceStart } from './SourceDir.ts';


describe('SOURCE_PREFIX', () => {
  test('是目录名加正斜杠', () => {
    expect(SOURCE_PREFIX).toBe(`${SOURCE_DIR}/`);
  });
});


describe('getSourceStart 正例', () => {
  test('开头就是', () => {
    expect(getSourceStart(`${SOURCE_PREFIX}Main.ts`)).toBe(0);
  });

  test('绝对路径里，前面是正斜杠或反斜杠', () => {
    const slash = `F:/aidata/source/jmbots/${SOURCE_PREFIX}Main.ts`;
    expect(getSourceStart(slash)).toBe('F:/aidata/source/jmbots/'.length);
    const back = `F:\\jmbots\\${SOURCE_PREFIX}Main.ts`;
    expect(getSourceStart(back)).toBe('F:\\jmbots\\'.length);
  });

  test('前面是空白或引号', () => {
    expect(getSourceStart(`见 ${SOURCE_PREFIX}Main.ts:3`)).toBe(2);
    expect(getSourceStart(`"${SOURCE_PREFIX}Main.ts"`)).toBe(1);
  });

  test('出现两次取最后一处', () => {
    const text = `/a/${SOURCE_PREFIX}x/${SOURCE_PREFIX}Main.ts`;
    expect(getSourceStart(text)).toBe(`/a/${SOURCE_PREFIX}x/`.length);
  });

  test('web/ 后面那个不算，但更前面的真源码前缀算', () => {
    const text = `/repo/${SOURCE_PREFIX}web/${SOURCE_PREFIX}x.ts`;
    expect(getSourceStart(text)).toBe('/repo/'.length);
  });
});


describe('getSourceStart 反例', () => {
  test('没有源码前缀', () => {
    expect(getSourceStart('web/index.html')).toBe(-1);
    expect(getSourceStart('')).toBe(-1);
  });

  test('别的目录名的尾巴', () => {
    expect(getSourceStart(`my${SOURCE_PREFIX}Main.ts`)).toBe(-1);
  });

  test('web/ 后面那个（开头的、绝对路径里的、反斜杠的）', () => {
    expect(getSourceStart(`web/${SOURCE_PREFIX}App.tsx`)).toBe(-1);
    expect(getSourceStart(`F:/jmbots/web/${SOURCE_PREFIX}App.tsx`)).toBe(-1);
    expect(getSourceStart(`F:\\jmbots\\web\\${SOURCE_PREFIX}App.tsx`)).toBe(-1);
  });
});
