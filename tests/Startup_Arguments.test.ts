/** 启动参数合同回归：后端与独立看门狗语法一致，验证子进程收到目录；不启动服务。 */
import * as test from 'bun:test';
import * as assert from 'node:assert/strict';
import * as child from 'node:child_process';
import * as checks from '../src/utils/Checks.ts';
import * as serveProcess from '../scripts/Serve_Process.ts';


test.test('独立看门狗和后端入口使用相同的参数语法', () => {
  const examples = [
    ['--runtime', 'some-data'],
    ['--runtime=some-data'],
    ['--runtime='],
    [],
  ];
  for (const args of examples) {
    const serverValue = checks.readArgument('runtime', args) ?? 'default';
    const watchdogValue = serveProcess.option('runtime', 'default', args);
    assert.equal(watchdogValue, serverValue);
  }
  for (const args of [['--runtime'], ['--runtime', '--port=30188']]) {
    assert.throws(() => checks.readArgument('runtime', args), /需要参数值/);
    assert.throws(() => serveProcess.option('runtime', 'default', args), /需要参数值/);
  }
});


test.test.skipIf(process.platform !== 'win32')('启动子进程显式传入已确定的运行目录', () => {
  /** 拦住唯一进程创建点，只检查生成的参数，不运行 PowerShell。 */
  const spawn = test.spyOn(child, 'spawnSync').mockReturnValue({
    pid: 123,
    output: [],
    stdout: '123',
    stderr: '',
    status: 0,
    signal: null,
  });
  try {
    const options = {
      runtimeDir: 'F:/isolated-runtime',
      port: 30188,
      candidate: true,
    };
    const pid = serveProcess.startServe(options, 'fixture');
    assert.equal(pid, 123);
    const argumentsText = JSON.stringify(spawn.mock.calls[0]);
    assert.ok(argumentsText.includes('--runtime'));
    assert.ok(argumentsText.includes('F:/isolated-runtime'));
    assert.ok(argumentsText.includes('--mode'));
    assert.ok(argumentsText.includes('candidate'));
  } finally {
    spawn.mockRestore();
  }
});


test.test('HTTP命令入口补齐必填字段并拒绝坏超时', () => {
  const result = checks.readRunInput({ command: 'echo hello' }, 'F:/runtime');
  assert.deepEqual(result, {
    command: 'echo hello',
    cwd: 'F:/runtime',
    why: '',
    from: 'api',
    timeoutSec: checks.RUN_TIMEOUT_SEC,
    askUser: false,
  });
  const supplied = {
    command: 'echo hello',
    cwd: '  F:/work  ',
    timeout: '9000',
    from: '  fixture  ',
    ask_user: true,
  };
  const normalized = checks.readRunInput(supplied, 'F:/runtime');
  assert.equal(normalized.cwd, 'F:/work');
  assert.equal(normalized.from, 'fixture');
  assert.equal(normalized.timeoutSec, checks.RUN_TIMEOUT_MAX_SEC);
  assert.equal(normalized.askUser, true);
  for (const timeout of [0, -1, Infinity, 'bad', false]) {
    const invalid = {
      command: 'echo hello',
      timeout,
    };
    assert.throws(() => checks.readRunInput(invalid, 'F:/runtime'));
  }
});


test.test('exec入口拒绝无效命令，超时只在入口确定', () => {
  assert.throws(() => checks.readExecInput({ command: 42 }), /command/);
  assert.throws(() => checks.readExecInput({ command: ' ' }), /command/);
  const input = {
    command: 'echo hello',
    timeout: '3',
  };
  const result = checks.readExecInput(input);
  assert.deepEqual(result, {
    command: 'echo hello',
    timeoutMs: 3000,
  });
  for (const timeout of [0, -1, 1.5, Infinity, false]) {
    const invalid = {
      command: 'echo hello',
      timeout,
    };
    assert.throws(() => checks.readExecInput(invalid));
  }
});


test.test('配置数字边界不把空白、布尔值和无穷当成合法值', () => {
  assert.equal(checks.requireFiniteNumber('2.5', 'value'), 2.5);
  assert.deepEqual(checks.requireFiniteNumberList([1, '2'], 'delays'), [1, 2]);
  for (const value of [null, false, '', ' ', Infinity, NaN]) {
    assert.throws(() => checks.requireFiniteNumber(value, 'value'));
  }
  assert.throws(() => checks.requireFiniteNumberList([1, 'bad'], 'delays'), /delays\[1\]/);
});
