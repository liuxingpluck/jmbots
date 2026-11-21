/** 外部程序配置的默认值、占位符解析与跨项校验。 */
import * as path from 'node:path';
import { expect, test } from 'bun:test';
import * as specModule from './Spec.ts';

test('配置填好默认值，路径和参数的占位符按当前数据目录替换', () => {
  const root = path.resolve(import.meta.dir, 'test-runtime');
  const data = path.join(root, 'data');
  const config = { programs: [{
    name: 'test-tool', file: 'program/test-tool',
    cwd: '{data}', args: ['{runtime}', '{data}', '{host}', '{port}'], env: { TEST_TOOL_RUNTIME: '{runtime}' },
  }] };
  const [spec] = specModule.readPrograms(config);
  expect(spec).toMatchObject({
    name: 'test-tool', title: 'test-tool', port: 0, host: '127.0.0.1', autostart: true,
    mount: '/api/ext/test-tool', exitWaitMs: 5000, startupMs: 120_000,
  });
  expect(specModule.getLaunch(root, spec!)).toMatchObject({
    args: [root, data, '127.0.0.1', '0'], cwd: data, env: { TEST_TOOL_RUNTIME: root },
  });
  expect(process.env['TEST_TOOL_RUNTIME']).toBeUndefined();
});

test('拒绝重复名字和等同的挂载路径，以及端口和参数类型不对的配置', () => {
  const program = { name: 'first', file: 'first', mount: '/example' };
  expect(() => specModule.readPrograms({ programs: [program, program] })).toThrow('name first 重复');
  const duplicateMount = { name: 'second', file: 'second', mount: '/example/' };
  expect(() => specModule.readPrograms({ programs: [program, duplicateMount] })).toThrow('mount /example 重复');
  expect(() => specModule.readPrograms({ programs: [{ ...program, mount: 'example' }] })).toThrow('mount');
  expect(() => specModule.readPrograms({ programs: [{ ...program, port: 65536 }] })).toThrow('port');
  expect(() => specModule.readPrograms({ programs: [{ ...program, args: [1] }] })).toThrow('args');
  //G /programs/ 留给界面入口，mount 写在下面会占掉别的程序的界面。
  expect(() => specModule.readPrograms({ programs: [{ ...program, mount: '/programs/first' }] })).toThrow('/programs');
  expect(() => specModule.readPrograms({ programs: [{ ...program, mount: '/programs' }] })).toThrow('/programs');
});


test('同组别名共享渠道占用，格式错误和重复分组在入口拒绝', () => {
  const invalid = [null, { a: 'b' }, [['one']], [['a', 'B']], [['a', 'b'], ['b', 'c']]];
  for (const written of invalid) {
    expect(() => specModule.readChannelAliases(written)).toThrow('channel_aliases');
  }
  const first = { name: 'first', file: 'first', channels: [{ name: 'primary', bot: '助手' }] };
  const second = { name: 'second', file: 'second', channels: [{ name: 'alias', bot: '助手' }] };
  const config = { programs: [first, second] };
  const aliases = specModule.readChannelAliases([['alias', 'primary']]);
  expect(() => specModule.readPrograms(config, aliases)).toThrow('渠道 alias 已经登记');
});


test('守卫默认阈值按GiB转换、closable默认false，并在入口拒绝非法配置', () => {
  const settings = specModule.readGuard(undefined);
  expect(settings).toMatchObject({
    memoryBytes: 60 * 1024 ** 3, resumeBytes: 55 * 1024 ** 3,
    vramBytes: 15.5 * 1024 ** 3, vramResumeBytes: 14.5 * 1024 ** 3, intervalMs: 5000,
  });
  //M CPU限制已停用（用户 #442）：老配置写了cpu字段照收不报错，也不再进守卫设置。
  const old = specModule.readGuard({ guard: { cpu_percent: 80, cpu_resume_percent: 70 } });
  expect(old).not.toHaveProperty('cpuPercent');
  expect(old).not.toHaveProperty('cpuResumePercent');
  const [spec] = specModule.readPrograms({ programs: [{ name: 'a', file: 'unused' }] });
  expect(spec?.closable).toBe(false);
  const cases = [
    { guard: null }, { guard: [] }, { guard: { memory_gb: null } },
    { guard: { interval_ms: 0 } },
    { guard: { resume_gb: 60 } },
    { guard: { vram_resume_gb: 15.5 } }, { guard: { typo: 1 } },
  ];
  for (const config of cases) {
    expect(() => specModule.readGuard(config)).toThrow();
  }
  const invalid = { programs: [{ name: 'a', file: 'unused', closable: 'yes' }] };
  expect(() => specModule.readPrograms(invalid)).toThrow('closable');
});
