/** 探针只用假nvidia子进程；CPU/内存只读，不操纵负载、窗口或真实进程。 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import type * as os from 'node:os';
import * as probeModule from './ResourceProbe.ts';

/** 只恢复本文件替换的spawn，不影响随后Host回归。 */
let restore: (() => void) | undefined;

afterEach(() => {
  restore?.();
  restore = undefined;
});

test('nvidia命令使用逐卡MiB、隐藏窗口与取消信号；从未调用真实spawn', async () => {
  const calls: unknown[][] = [];
  const fake = {
    exited: Promise.resolve(0),
    stdout: new Blob(['0, 7419, 16311']).stream(),
  } as unknown as ReturnType<typeof Bun.spawn>;
  const implementation = (...args: unknown[]) => {
    calls.push(args);
    return fake;
  };
  const spy = spyOn(Bun, 'spawn').mockImplementation(implementation as typeof Bun.spawn);
  restore = () => { spy.mockRestore(); };
  const probe = new probeModule.ResourceProbe('configured-nvidia-smi');
  const control = new AbortController();
  const sample = await probe.read(control.signal);
  expect(sample.cpu).toBeNull();
  expect(sample.gpus?.[0]?.used).toBe(7419 * 1024 ** 2);
  expect(calls[0]?.[0]).toEqual([
    'configured-nvidia-smi', '--query-gpu=index,memory.used,memory.total', '--format=csv,noheader,nounits',
  ]);
  expect(calls[0]?.[1]).toMatchObject({ windowsHide: true, stderr: 'ignore' });
});

test('无驱动、命令缺席或失败按GPU未知返回，不抛错且CPU内存读取独立', async () => {
  const implementation = () => { throw new Error('模拟无nvidia-smi，不启动进程'); };
  const spy = spyOn(Bun, 'spawn').mockImplementation(implementation as typeof Bun.spawn);
  restore = () => { spy.mockRestore(); };
  const probe = new probeModule.ResourceProbe('absent-but-mocked');
  const sample = await probe.read(new AbortController().signal);
  expect(sample.gpus).toBeNull();
  expect(sample.memory).not.toBeNull();
});

/** 造一个核的累计时钟，毫秒。 */
function getCore(user: number, sys: number, irq: number, idle: number): os.CpuInfo {
  return { model: 'test', speed: 0, times: { user, nice: 0, sys, irq, idle } };
}

test('Windows的irq已含在sys里不重复计；sys大于idle也照常算出真实占用', () => {
  //M 照11-21宿主机实测的2秒增量：user+sys+idle正好等于墙钟乘核数。
  const busy = [getCore(10420, 3909, 437, 25671)];
  const windows = probeModule.sumCpuTimes(busy, 'win32');
  expect(windows).toEqual({ total: 40000, idle: 25671 });
  expect(Math.round(100 * (windows.total - windows.idle) / windows.total)).toBe(36);

  //M 忙核的累计值sys可以大于idle，这是真负载，不是把idle算了两遍。
  const heavy = probeModule.sumCpuTimes([getCore(100, 600, 50, 300)], 'win32');
  expect(heavy).toEqual({ total: 1000, idle: 300 });

  //M 空闲机器读出接近0，不会出现假的50%。
  const quiet = probeModule.sumCpuTimes([getCore(10, 10, 5, 980)], 'win32');
  expect(100 * (quiet.total - quiet.idle) / quiet.total).toBe(2);
});

test('Linux的irq单独一栏要计入总时长', () => {
  const linux = probeModule.sumCpuTimes([getCore(100, 100, 50, 750)], 'linux');
  expect(linux).toEqual({ total: 1000, idle: 750 });
});
