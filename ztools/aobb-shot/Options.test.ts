/** AOBB 多开舱截图参数解析与命令审核回归测试。 */
import * as path from 'node:path';
import * as test from 'bun:test';
import * as options from './Options.ts';

const root = path.resolve(import.meta.dir, '..', '..');
const base = 'bun ztools/aobb-shot/Aobb_Shot.ts --url http://localhost:30086 --out docs/开发进度/截图.png';

test.test('审核允许单个 data 属性选择器，运行时保留原选择器', () => {
  const selectors = [
    'button[data-look=mind]',
    '[data-dir=lr]',
    '[data-trace-reply=r292_0]',
    "[data-msg-id='292']",
    '[data-action]',
  ];
  for (const selector of selectors) {
    //M 同时核对审核和脚本解释，单引号和数值应原样交给 CSS。
    const command = `${base} --click ${selector}`;
    test.expect(options.isAobbShotCommand(command, root)).toBe(true);
    const args = ['--url', 'http://localhost:30086', '--out', 'docs/开发进度/截图.png', '--click', selector];
    const shot = options.getShotOptions(args, root);
    test.expect(shot.actions).toEqual([{ kind: 'click', selector }]);
  }
});

test.test('属性语法只用于 --click 的一个选择器，不接受空格、括号和额外属性', () => {
  const rejected = [
    `${base} --click button [data-look=mind]`,
    `${base} --click button[data-look=mind]:nth-child(1)`,
    `${base} --click [data-msg-id='292'][data-reply-index='0']`,
    `${base} --click [data-look='mind map']`,
    `${base} --click [data-look=mind],[data-dir=lr]`,
    `${base} --width [data-dir=lr]`,
  ];
  for (const command of rejected) {
    //G 限制只在任务允许的精确语法内生效。
    test.expect(options.isAobbShotCommand(command, root)).toBe(false);
  }
});

test.test('滚动、输入、选择和点击按命令顺序执行并可取双帧耗时', () => {
  const typed = '搜索：带空格 & 标点';
  const encoded = Buffer.from(typed).toString('base64url');
  const actions = [
    '--scroll', 'page', 'bottom',
    '--click', "[data-session-index='0']",
    '--type', '[data-testid=wechat-kefu-search]', `b64=${encoded}`,
    '--scroll', '[data-testid=wechat-kefu-sessions]', '-420',
    '--type-enter', '[data-testid=wechat-kefu-search]', 'b64=',
    '--select', '[data-testid=usage-range]', '一年',
    '--timing',
  ];
  const command = `${base} ${actions.join(' ')}`;
  test.expect(options.isAobbShotCommand(command, root)).toBe(true);

  const args = ['--url', 'http://localhost:30086', '--out', 'docs/开发进度/截图.png', ...actions];
  const shot = options.getShotOptions(args, root);
  test.expect(shot.timing).toBe(true);
  test.expect(shot.actions).toEqual([
    { kind: 'scroll', target: 'page', distance: 'bottom' },
    { kind: 'click', selector: "[data-session-index='0']" },
    { kind: 'type', selector: '[data-testid=wechat-kefu-search]', value: typed, enter: false },
    { kind: 'scroll', target: '[data-testid=wechat-kefu-sessions]', distance: -420 },
    { kind: 'type', selector: '[data-testid=wechat-kefu-search]', value: '', enter: true },
    { kind: 'select', selector: '[data-testid=usage-range]', label: '一年' },
  ]);
});

test.test('新的动作不接受组合定位、越界滚动、无效文字、额外命令或超量', () => {
  const selector = '[data-testid=search]';
  const rejected = [
    `--scroll ${selector} 100001`,
    '--scroll page 1.5',
    `--type ${selector}`,
    '--type page value',
    `--type ${selector}[data-key] value`,
    `--type ${selector} b64=A`,
    `--type ${selector} b64=DQ`,
    `--type ${selector} test & whoami`,
    `--select ${selector} b64=`,
    `--select ${selector} "one two"`,
    '--timing --timing',
    '--scroll page bottom '.repeat(11),
  ];
  for (const remainder of rejected) {
    const command = `${base} ${remainder}`;
    test.expect(options.isAobbShotCommand(command, root)).toBe(false);
  }
});

test.test('多开舱地址支持默认值、AOBB_DOCK_URL 环境变量与 --base-url 覆盖', () => {
  const minimal = ['--url', 'http://localhost:30086', '--out', 'docs/开发进度/截图.png'];
  const defaulted = options.getShotOptions(minimal, root, {});
  test.expect(defaulted.baseUrl).toBe('http://127.0.0.1:30098');
  test.expect(defaulted.profile).toBeUndefined();

  const fromEnv = options.getShotOptions(minimal, root, { AOBB_DOCK_URL: 'http://localhost:30198/' });
  test.expect(fromEnv.baseUrl).toBe('http://localhost:30198');

  const cliArgs = [...minimal, '--base-url', 'http://127.0.0.1:30298/'];
  const fromCli = options.getShotOptions(cliArgs, root, { AOBB_DOCK_URL: 'http://localhost:30198' });
  test.expect(fromCli.baseUrl).toBe('http://127.0.0.1:30298');

  const allowedCmd = `${base} --base-url http://127.0.0.1:30298 --profile 常用155`;
  test.expect(options.isAobbShotCommand(allowedCmd, root)).toBe(true);
});

test.test('支持 --profile 明文与 Base64url 编码，拒绝非法多开舱地址与空配置名', () => {
  const encodedProfile = Buffer.from('常用 155').toString('base64url');
  const args = [
    '--url', 'http://127.0.0.1:30086',
    '--out', 'docs/开发进度/截图.png',
    '--profile', `b64=${encodedProfile}`,
  ];
  const shot = options.getShotOptions(args, root, {});
  test.expect(shot.profile).toBe('常用 155');
  test.expect(options.isAobbShotCommand(`${base} --profile b64=${encodedProfile}`, root)).toBe(true);

  const badDockUrls = [
    'https://127.0.0.1:30098',
    'http://example.com:30098',
    'http://127.0.0.1:30098/api',
    'http://127.0.0.1:70000',
    'http://127.0.0.1',
  ];
  for (const bad of badDockUrls) {
    test.expect(() => options.getDockBaseUrl(bad)).toThrow();
    test.expect(options.isAobbShotCommand(`${base} --base-url ${bad}`, root)).toBe(false);
  }

  test.expect(() => options.getShotOptions(
    ['--url', 'http://127.0.0.1:30086', '--out', 'docs/开发进度/截图.png', '--profile', 'b64='],
    root,
    {},
  )).toThrow('配置编号或名称');
});
