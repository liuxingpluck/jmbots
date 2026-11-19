/** 用内存控制台验证报错前缀、原格式占位符和多行栈。 */
import * as nodeConsole from 'node:console';
import * as stream from 'node:stream';
import { expect, spyOn, test } from 'bun:test';
import * as backendLog from './BackendLog.ts';
import * as text from './Text.ts';
import * as trace from './Trace.ts';

const DATE = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})/u;

/** 让 Console 照常格式化，只把输出收在内存里。 */
function getLog() {
  let content = '';
  const sink = new stream.Writable({
    write(chunk, _encoding, done) {
      content += String(chunk);
      done();
    },
  });
  const options = { stdout: sink, stderr: sink, colorMode: false } as const;
  //M Bun 合并后的 Console 构造类型漏了实例 error，测试取实际使用的这个方法。
  const output = new nodeConsole.Console(options) as unknown as Pick<Console, 'error'>;
  backendLog.installBackendErrorLogger(output);
  return { output, getContent: () => content };
}

test('按本机时间和调用方模块给多行错误加一个报错头', () => {
  const { output, getContent } = getLog();
  const before = text.formatLocalTime(Date.now(), 'date');

  output.error('样例失败 %s\n    at 模拟栈帧', '***');

  const after = text.formatLocalTime(Date.now(), 'date');
  const [first, second, empty] = getContent().split('\n');
  expect([before, after]).toContain(DATE.exec(first ?? '')?.[1] ?? '');
  expect(first).toEndWith('[BackendLog.test] 样例失败 ***');
  expect(second).toBe('    at 模拟栈帧');
  expect(empty).toBe('');
});

test('插件报错已有时间时保留它并补插件来源', () => {
  const { output, getContent } = getLog();
  const frame = spyOn(trace, 'getCallSite').mockReturnValue('src7/plugins/example/read/Reader.ts:7');
  try {
    output.error('2026-11-19 05:40:10 样例失败\n    at 模拟插件栈');
    output.error('2026-11-19 05:40:11\n    at 后续错误正文');
    expect(getContent()).toBe(
      '2026-11-19 05:40:10 [example] 样例失败\n    at 模拟插件栈\n'
      + '2026-11-19 05:40:11 [example] \n    at 后续错误正文\n',
    );
  } finally {
    frame.mockRestore();
  }
});

test('原生 Error 保留消息和栈并在无法取得模块时使用后端来源', () => {
  const { output, getContent } = getLog();
  const frame = spyOn(trace, 'getCallSite').mockReturnValue('位置不明');
  try {
    output.error(new Error('样例错误'));
    const [head, ...details] = getContent().split('\n');
    expect(head).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} \[backend\] Error: 样例错误$/u);
    expect(details.some((line) => /^\s+at /u.test(line))).toBe(true);
  } finally {
    frame.mockRestore();
  }
});
