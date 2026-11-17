/**
 * Rules.ts 的 isProjectCheck：项目自己的检查、编译直接放行；接了别的命令、不认识的脚本、带引号空格的参数不放行。
 */
import { describe, expect, test } from 'bun:test';
import { isProjectCheck } from './Rules.ts';

describe('isProjectCheck', () => {
  test('src7 的检查、测试、编译放行', () => {
    const passed = [
      'bun run typecheck:src7',
      'bun.cmd run test:src7',
      'bun run typecheck',
      'bun test src7/plugins/relay',
      String.raw`cd /d jmbots && bun scripts/Build_Src7.ts --out cache\打包测试\20261116-1500EST`,
      'bun scripts/Build_Src7.ts --out cache/build --skip_checks yes 2>&1',
      String.raw`bun scripts/Build_Src7.ts --out ..\..\AIJMBots\jmbotsData\updates`,
    ];
    for (const command of passed) {
      expect(isProjectCheck(command)).toBe(true);
    }
  });

  test('接了别的命令、不认识的脚本、怪参数不放行', () => {
    const rejected = [
      'bun run typecheck:src7 & del x',
      'bun run build',
      'bun scripts/Other.ts',
      'bun scripts/Build_Src7.ts --out "a b"',
      'bun scripts/Build_Src7.ts --out x | more',
    ];
    for (const command of rejected) {
      expect(isProjectCheck(command)).toBe(false);
    }
  });
});
