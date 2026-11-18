/** 探针只用假nvidia子进程；CPU/内存只读，不操纵负载、窗口或真实进程。 */
import { afterEach, expect, spyOn, test } from 'bun:test';
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
