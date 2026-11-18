/** 跨进程协议只用假fetch；不访问真实Host或网络。 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import * as protocolModule from './Protocol.ts';

/** 本文件替换的fetch，在每例之后恢复。 */
let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

/** 提供可逐次替换的JSON回执，所有URL和请求体只保存在测试内存。 */
function getReply(initial: unknown) {
  const data = { value: initial };
  const calls: { input: unknown; init: RequestInit | undefined }[] = [];
  const implementation = async (input: unknown, init?: RequestInit) => {
    calls.push({ input, init });
    return Response.json(data.value);
  };
  const spy = spyOn(globalThis, 'fetch').mockImplementation(implementation as typeof fetch);
  restore = () => { spy.mockRestore(); };
  return { data, calls };
}

test('info/health须核对协议和名字，RSS为有限非负MiB，pause只认显式能力', async () => {
  const h = getReply({ ok: true, protocol: 1, name: 'fake', capabilities: ['pause'], rssMb: 812 });
  const signal = new AbortController().signal;
  const report = await protocolModule.readReport('http://mock.invalid', 'fake', 'info', 50, signal);
  expect(report).toEqual({ pause: true, rssMb: 812, ui: null });
  h.data.value = { ok: true, protocol: 1, name: 'other', capabilities: ['pause'], rssMb: 9999 };
  expect(await protocolModule.readReport('http://mock.invalid', 'fake', 'health', 50, signal)).toBeUndefined();
  h.data.value = { ok: true, protocol: 1, name: 'fake', rssMb: '812' };
  expect(await protocolModule.readReport('http://mock.invalid', 'fake', 'health', 50, signal)).toEqual({
    pause: false, rssMb: undefined, ui: null,
  });
  expect(h.calls.every((call) => call.init?.redirect === 'error')).toBe(true);
});

test('暂停/恢复只有明确确认才成功，体带原因，错误paused或授权不会触发其它动作', async () => {
  const h = getReply({ ok: true, paused: false });
  const signal = new AbortController().signal;
  expect(await protocolModule.requestPause('http://mock.invalid', true, signal)).toBe(false);
  h.data.value = { ok: true, paused: true };
  expect(await protocolModule.requestPause('http://mock.invalid', true, signal)).toBe(true);
  expect(h.calls[1]?.input).toBe('http://mock.invalid/jmbots/v1/pause');
  expect(h.calls[1]?.init?.body).toBe(JSON.stringify({ reason: 'mem-limit' }));
  h.data.value = { ok: true, state: 'expired' };
  expect(await protocolModule.readLicense('http://mock.invalid', signal)).toBe('expired');
  h.data.value = { ok: true, state: 'unknown-value' };
  expect(await protocolModule.readLicense('http://mock.invalid', signal)).toBeUndefined();
  expect(h.calls).toHaveLength(4);
});


test('UI只接受内部根路径，拒绝主机端口、脚本、控制字符、编码回溯与坏转义', () => {
  const accepted = ['/', '/ui/', '/ui/index.html', '/界面/'];
  for (const value of accepted) {
    expect(protocolModule.getUiPath(value)).toBe(value);
  }
  const rejected: unknown[] = [
    null, undefined, false, 80, '', 'ui/', '//evil.invalid:80/',
    'http://evil.invalid/', 'javascript:alert(1)', '/a?token=x', '/a#b',
    '/a/../b', '/a/./b', '/a/%2e%2e/b', '/%2fother', '/%5cother',
    '/bad%', '/bad%00', '/bad%20space', '/line\nend', '/back\\slash',
  ];
  for (const value of rejected) {
    expect(protocolModule.getUiPath(value)).toBeNull();
  }
});

test('info保留核实后的UI；商业授权明确区分未授权与未知，不产生批准动作', async () => {
  const reply = { ok: true, protocol: 1, name: 'fake', ui: '/panel/' };
  const h = getReply(reply);
  const signal = new AbortController().signal;
  const report = await protocolModule.readReport('http://mock.invalid', 'fake', 'info', 50, signal);
  expect(report?.ui).toBe('/panel/');
  h.data.value = { ...reply, ui: '//evil.invalid/' };
  const bad = await protocolModule.readReport('http://mock.invalid', 'fake', 'info', 50, signal);
  expect(bad?.ui).toBeNull();
  expect(protocolModule.getLicenseLabel('licensed')).toBe('已授权');
  expect(protocolModule.getLicenseLabel('expired')).toBe('过期');
  expect(protocolModule.getLicenseLabel('free')).toBe('不需要');
  expect(protocolModule.getLicenseLabel('none')).toBe('不需要');
  expect(protocolModule.getLicenseLabel(undefined)).toBe('未知');
  expect(protocolModule.getLicenseLabel('arbitrary')).toBe('未知');
});
