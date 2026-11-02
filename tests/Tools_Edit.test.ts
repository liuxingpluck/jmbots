/**
 * 测 edit 的匹配替换（EditMatch.ts）和输出截断（Truncate.ts）：都是纯函数，不碰文件和模型。
 */
import * as bunTest from 'bun:test';
import * as editMatch from '../src/tools/EditMatch.ts';
import * as truncate from '../src/tools/Truncate.ts';


bunTest.describe('applyEdits', () => {
  bunTest.test('精确替换几处，保留 BOM 和 \\r\\n', () => {
    /** 原文：带 BOM、Windows 换行。 */
    const content = '﻿a = 1\r\nb = 2\r\nc = 3\r\n';
    /** 改完。 */
    const changed = editMatch.applyEdits(content, [
      { oldText: 'a = 1', newText: 'a = 10' },
      { oldText: 'c = 3', newText: 'c = 30' },
    ], 'x.txt');
    bunTest.expect(changed).toBe('﻿a = 10\r\nb = 2\r\nc = 30\r\n');
  });

  bunTest.test('宽松匹配：中文引号、行尾空格不影响查找，没改到的行原样保留', () => {
    /** 原文：第一行有行尾空格（没改到，要保留），第二行用中文引号。 */
    const content = 'keep me   \nsay “hi”\n';
    /** 改完。 */
    const changed = editMatch.applyEdits(content, [{ oldText: 'say "hi"', newText: 'say "bye"' }], 'x.txt');
    bunTest.expect(changed).toBe('keep me   \nsay "bye"\n');
  });

  bunTest.test('找不到、不唯一、重叠、没变化都报错', () => {
    bunTest.expect(() => editMatch.applyEdits('abc', [{ oldText: 'zzz', newText: '' }], 'x')).toThrow('找不到');
    bunTest.expect(() => editMatch.applyEdits('aa aa', [{ oldText: 'aa', newText: 'b' }], 'x')).toThrow('出现了 2 次');
    bunTest.expect(() =>
      editMatch.applyEdits('abcdef', [
        { oldText: 'abcd', newText: '1' },
        { oldText: 'cdef', newText: '2' },
      ], 'x'),
    ).toThrow('重叠');
    bunTest.expect(() => editMatch.applyEdits('abc', [{ oldText: 'b', newText: 'b' }], 'x')).toThrow('没有变化');
  });

  bunTest.test('readEdits 认几种写法', () => {
    /** 期望。 */
    const expected = [{ oldText: 'a', newText: 'b' }];
    bunTest.expect(editMatch.readEdits({ edits: expected })).toEqual(expected);
    bunTest.expect(editMatch.readEdits({ edits: JSON.stringify(expected) })).toEqual(expected);
    bunTest.expect(editMatch.readEdits({ edits: { oldText: 'a', newText: 'b' } })).toEqual(expected);
    bunTest.expect(editMatch.readEdits({ old_text: 'a', new_text: 'b' })).toEqual(expected);
    bunTest.expect(() => editMatch.readEdits({ edits: [] })).toThrow();
  });
});


bunTest.describe('truncate', () => {
  bunTest.test('留开头：按行数截，告诉留了几行', () => {
    /** 结果。 */
    const result = truncate.truncateHead('1\n2\n3\n4', { maxLines: 2 });
    bunTest.expect(result).toMatchObject({ content: '1\n2', truncated: true, truncatedBy: 'lines', totalLines: 4, outputLines: 2 });
  });

  bunTest.test('留开头：第一行就超字节上限', () => {
    bunTest.expect(truncate.truncateHead('x'.repeat(20), { maxBytes: 10 }).firstLineTooLong).toBe(true);
  });

  bunTest.test('留结尾：按字节截；最后一行太长只留后半截，不切坏中文', () => {
    bunTest.expect(truncate.truncateTail('a\nb\nc', { maxLines: 2 }).content).toBe('b\nc');
    /** 结果：每个汉字 3 字节，留 7 字节只能放下 2 个字。 */
    const result = truncate.truncateTail('一二三四', { maxBytes: 7 });
    bunTest.expect(result).toMatchObject({ content: '三四', lastLinePartial: true });
  });

  bunTest.test('没超限原样返回', () => {
    bunTest.expect(truncate.truncateTail('abc\n')).toMatchObject({ content: 'abc\n', truncated: false, totalLines: 1 });
  });
});
