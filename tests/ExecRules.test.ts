/**
 * exec 审核前程序规则的离线测试：碰密钥文件、jmai 自己的检查、读出要跑的脚本。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as execRules from '../src/executors/ExecRules.ts';


bunTest.test('碰密钥文件的认得出，config.example.yaml 和 .env.example 不算', () => {
  bunTest.expect(execRules.touchesSecret('cd F:\\aidata\\AIJMBots && findstr /n /c:"app_secret" config.yaml')).toBe('config.yaml');
  bunTest.expect(execRules.touchesSecret('type F:\\aidata\\AIJMBots\\config.yaml')).toBe('config.yaml');
  bunTest.expect(execRules.touchesSecret('Get-Content .env')).toBe('.env');
  bunTest.expect(execRules.touchesSecret('type config.example.yaml')).toBeUndefined();
  bunTest.expect(execRules.touchesSecret('copy .env.example x.txt')).toBeUndefined();
  bunTest.expect(execRules.touchesSecret('bun run lint')).toBeUndefined();
});


bunTest.test('jmai 的检查和换版本直接放行，接了别的命令就不算', () => {
  bunTest.expect(execRules.isProjectCheck('cd F:\\aidata\\source\\jmai && bun scripts/Swap_Serve.ts 2>&1')).toBe(true);
  bunTest.expect(execRules.isProjectCheck('chcp 65001 >nul & cd /d F:\\aidata\\source\\jmai && bun scripts/Swap_Serve.ts')).toBe(true);
  bunTest.expect(execRules.isProjectCheck('bun run typecheck')).toBe(true);
  bunTest.expect(execRules.isProjectCheck('bun.cmd test ./tests/Inbox.test.ts')).toBe(true);
  bunTest.expect(execRules.isProjectCheck('bun run lint && del /q x')).toBe(false);
  bunTest.expect(execRules.isProjectCheck('bun scripts/Other.ts')).toBe(false);
});


bunTest.test('读出要跑的本地脚本（按 cd 的目录找）', () => {
  /** 临时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'execrules-'));
  fs.writeFileSync(path.join(dir, '发布.ts'), 'console.log("hi")');
  /** 读出来的。 */
  const script = execRules.readScript(`cd ${dir} && bun 发布.ts 2>&1`, os.tmpdir());
  bunTest.expect(script?.content).toBe('console.log("hi")');
  bunTest.expect(execRules.readScript('dir', dir)).toBeUndefined();
  fs.rmSync(dir, { recursive: true, force: true });
});
