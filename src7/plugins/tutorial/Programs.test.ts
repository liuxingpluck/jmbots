/**
 * 进程插件说明的离线测试（Programs.ts）。
 * 跑法：bun test ./src7/plugins/tutorial
 * 查的是：只认 config 里登记的程序；目录从 file 推出来，占位符和相对路径照 programs 的规则；说明没写回空串。
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as programsModule from './Programs.ts';

/** 一份只登记了 wechat 的配置。 */
function getRaw(file: unknown): Record<string, unknown> {
  const program = { name: 'wechat', file };
  const config = { programs: [program] };
  return { plugins: ['tutorial', { name: 'programs', config }] };
}

describe('进程插件目录', () => {
  test('相对路径以运行时目录为根', () => {
    const root = path.resolve('runtime-root');
    const raw = getRaw('program/wechat-0.3.0/wechat');
    const dir = programsModule.getProgramDir(raw, root, 'wechat');
    expect(dir).toBe(path.join(root, 'program', 'wechat-0.3.0'));
  });

  test('换掉 {runtime} 和 {data}', () => {
    const root = path.resolve('runtime-root');
    const raw = getRaw('{data}/wechat/wechat');
    const dir = programsModule.getProgramDir(raw, root, 'wechat');
    expect(dir).toBe(path.join(root, 'data', 'wechat'));
  });

  test('没登记的程序、没写 file、没有 programs 插件都找不到', () => {
    const root = path.resolve('runtime-root');
    const raw = getRaw('program/wechat');
    expect(programsModule.getProgramDir(raw, root, 'other')).toBeUndefined();
    expect(programsModule.getProgramDir(getRaw(42), root, 'wechat')).toBeUndefined();
    expect(programsModule.getProgramDir({ plugins: ['tutorial'] }, root, 'wechat')).toBeUndefined();
    expect(programsModule.getProgramDir({}, root, 'wechat')).toBeUndefined();
  });
});

describe('进程插件说明', () => {
  test('有说明读全文，没有回空串', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tutorial-programs-'));
    try {
      const empty = await programsModule.readProgramReadme(dir);
      expect(empty.text).toBe('');

      fs.writeFileSync(path.join(dir, '说明.md'), '# 外置微信');
      const written = await programsModule.readProgramReadme(dir);
      expect(written.text).toBe('# 外置微信');
      expect(written.file).toBe(path.join(dir, '说明.md'));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
