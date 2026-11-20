import * as test from 'bun:test';
import * as cordis from 'cordis';
import zh from '../../web/src/locales/trace.zh.json' with { type: 'json' };
import zhTW from '../../web/src/locales/trace.zh-TW.json' with { type: 'json' };
import en from '../../web/src/locales/trace.en.json' with { type: 'json' };
import fr from '../../web/src/locales/trace.fr.json' with { type: 'json' };
import * as traceText from '../../web/src/locales/Trace.ts';
import * as printModule from '../plugins/tutorial/Print.ts';

test.test('四份跟踪语言包包含相同文案和占位符', () => {
  const source: Record<string, string> = zh;
  const ids = Object.keys(source).sort();
  const slots = (text: string) => [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort();
  const packs: Record<string, string>[] = [zhTW, en, fr];
  for (const pack of packs) {
    test.expect(Object.keys(pack).sort()).toEqual(ids);
    for (const id of ids) {
      test.expect(pack[id]).toBeTruthy();
      test.expect(slots(pack[id]!)).toEqual(slots(source[id]!));
    }
  }
});

test.test('网页翻译新文案，只插入声明的变量，旧文字原样显示', () => {
  const key = 'trace.relay.accept';
  const vars = { helper: 'reviewer', session: 'internal-session' };
  const params = traceText.getTraceParams(key, vars);
  test.expect(params).toEqual({ helper: 'reviewer' });
  test.expect(traceText.getTraceText('fr', key, params)).toBe('Réponse reçue de reviewer');
  test.expect(traceText.getTraceText('fr', '执行工具')).toBe('执行工具');
});

test.test('控制台按配置语言打印新跟踪点，保留代码提示和旧文字', async () => {
  const ctx = new cordis.Context();
  ctx.provide('resources', { raw: { ui: { language: 'en' } } });
  const config = { console: true, file: false, varLimit: 80 };
  new printModule.Printer(ctx, config);
  const consoleLog = test.spyOn(console, 'log').mockImplementation(() => {});
  try {
    const vars = { tool: 'time', session: 'example' };
    const code = 'spec.run(...)';
    ctx.emit('trace', 'Tools.execute', 'trace.tools.execute', code, vars);
    ctx.emit('trace', 'Old.execute', '旧跟踪点', code, { 工具: 'time' });
    const output = consoleLog.mock.calls.map(([line]) => String(line));
    test.expect(output).toHaveLength(2);
    test.expect(output[0]).toContain('Run the tool');
    test.expect(output[0]).toContain(code);
    test.expect(output[0]).toContain('Tool=time');
    test.expect(output[1]).toContain('旧跟踪点');
    test.expect(output[1]).toContain('工具=time');
  } finally {
    consoleLog.mockRestore();
    await ctx.fiber.dispose();
  }
});
