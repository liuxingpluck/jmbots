/** 命令行守卫的离线测试：默认值、两种参数写法和端口出错时的提示。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import * as embedded from '../src/resources/Embedded.ts';
import * as checks from '../src/utils/Checks.ts';


/** 测试用的默认监听参数。 */
const DEFAULTS: checks.ListenOptions = {
  port: 30086,
  host: '127.0.0.1',
};


test.test('没给参数时用默认值', () => {
  assert.deepEqual(checks.readListenOptions(DEFAULTS, []), DEFAULTS);
});


test.test('两种写法都认', () => {
  assert.deepEqual(checks.readListenOptions(DEFAULTS, ['--port', '30087', '--host=0.0.0.0']), {
    port: 30087,
    host: '0.0.0.0',
  });
  const equalsOptions = checks.readListenOptions(DEFAULTS, ['--port=30088']);
  assert.deepEqual(equalsOptions, {
    port: 30088,
    host: '127.0.0.1',
  });
});


test.test('端口不合格时抛错，并带上原文', () => {
  for (const portText of ['0', '65536', 'abc', '1.5']) {
    assert.throws(() => checks.readListenOptions(DEFAULTS, ['--port', portText]), {
      message: `--port 需要 1–65535 的整数，收到：${portText}`,
    });
  }
});


test.test('运行目录在入口补齐：源码默认、空白、相对路径和环境变量优先级', () => {
  const expected = path.resolve(import.meta.dir, '..', 'jmbotsData');
  assert.equal(checks.resolveRuntimeDirectory(undefined), expected);
  assert.equal(checks.resolveRuntimeDirectory('  '), expected);
  assert.equal(checks.resolveRuntimeDirectory('relative-data'), path.resolve('relative-data'));
  assert.deepEqual(checks.readStartupOptions([], 'env-data'), {
    runtime: path.resolve('env-data'),
    candidate: false,
  });
  assert.deepEqual(checks.readStartupOptions(['--runtime=cli-data', '--mode', 'candidate'], 'env-data'), {
    runtime: path.resolve('cli-data'),
    candidate: true,
  });
  assert.equal(checks.readStartupOptions(['--runtime='], 'env-data').runtime, expected);
});


test.test('编译版的默认运行目录是 EXE 所在目录', () => {
  const compiled = test.spyOn(embedded, 'isCompiled').mockReturnValue(true);
  try {
    assert.equal(checks.resolveRuntimeDirectory(undefined), path.dirname(process.execPath));
    assert.equal(checks.resolveRuntimeDirectory(''), path.dirname(process.execPath));
  } finally {
    compiled.mockRestore();
  }
});


test.test('入口拒绝缺参数值和错误模式，不让错误落到内部', () => {
  for (const args of [['--runtime'], ['--runtime', '--mode', 'candidate'], ['--mode']]) {
    assert.throws(() => checks.readStartupOptions(args, undefined), /后面需要参数值/);
  }
  assert.throws(() => checks.readStartupOptions(['--mode=typo'], undefined), /--mode 需要/);
  assert.throws(() => checks.readListenOptions(DEFAULTS, ['--port']), /后面需要参数值/);
  assert.throws(() => checks.readListenOptions(DEFAULTS, ['--port=']), /--port 需要/);
  const invalidDefaults = {
    port: NaN,
    host: '0.0.0.0',
  };
  assert.throws(() => checks.readListenOptions(invalidDefaults, []), /--port 需要/);
});
