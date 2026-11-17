/** 定时检查通过可选基地服务工作；不调用真实模型、基地或更新接口。 */
import { expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type { Base } from '../base-bridge/index.ts';
import { apply } from './index.ts';

test('没挂基地照常启动，后来挂上但断连时静默，恢复后才询问更新', async () => {
  //M 临时目录只用于隔离更新状态；本测试不会批准或安装更新。
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-update-watch-'));
  const handlers = new Map<string, () => void>();
  const cleanups: (() => void)[] = [];
  const pending: Record<string, unknown>[] = [];
  let service: Pick<Base, 'getJson' | 'postJson'> | undefined;
  let calls = 0;
  let online = false;
  const errors = spyOn(console, 'error').mockImplementation(() => {});
  const ctx = {
    resources: { dir: () => root },
    get: () => service,
    on: (event: string, handler: () => void) => handlers.set(event, handler),
    effect: (start: () => () => void) => cleanups.push(start()),
    emit: () => {},
    bots: { list: () => [{ name: '测试机器人' }] },
    approval: {
      list: () => pending,
      ask: (item: Record<string, unknown>) => {
        const result = { ...item, id: '待确认' };
        pending.push(result);
        return result;
      },
    },
  } as unknown as cordis.Context;

  try {
    //M 先挂 watch，再出现 base，证明没有把缺失的服务固定在启动时。
    apply(ctx, { first_ms: 0, every_ms: 5 });
    handlers.get('ready')?.();
    await Bun.sleep(20);
    expect(pending).toEqual([]);
    service = {
      getJson: async () => {
        calls += 1;
        if (!online) throw new Error('基地没响应');
        return { status: 200, body: { managed: true, current: { version: '1' }, available: { version: '2' } } };
      },
      postJson: async () => { throw new Error('本测试不能请求安装更新'); },
    };
    for (let count = 0; calls === 0 && count < 100; count += 1) await Bun.sleep(5);
    expect(calls).toBeGreaterThan(0);
    expect(pending).toEqual([]);
    expect(errors).not.toHaveBeenCalled();

    //M 网络恢复以后继续正常发现新版本，不把断连永久记成已处理。
    online = true;
    for (let count = 0; pending.length === 0 && count < 100; count += 1) await Bun.sleep(5);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.['kind']).toBe('update');
    expect(errors).not.toHaveBeenCalled();
  } finally {
    for (const cleanup of cleanups) cleanup();
    errors.mockRestore();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
