/** 命令行守卫的离线测试：默认值、两种参数写法和端口出错时的提示。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as checks from '../src/utils/Checks.ts';


/** 测试用的默认监听参数。 */
const DEFAULTS: checks.ListenOptions = { port: 30086, host: '127.0.0.1' };


test.test('没给参数时用默认值', () => {
  assert.deepEqual(checks.readListenOptions(DEFAULTS, []), DEFAULTS);
});


test.test('两种写法都认', () => {
  assert.deepEqual(checks.readListenOptions(DEFAULTS, ['--port', '30087', '--host=0.0.0.0']), {
    port: 30087,
    host: '0.0.0.0',
  });
  assert.deepEqual(checks.readListenOptions(DEFAULTS, ['--port=30088']), { port: 30088, host: '127.0.0.1' });
});


test.test('端口不合格时抛错，并带上原文', () => {
  for (const portText of ['0', '65536', 'abc', '1.5']) {
    assert.throws(() => checks.readListenOptions(DEFAULTS, ['--port', portText]), {
      message: `--port 需要 1–65535 的整数，收到：${portText}`,
    });
  }
});
