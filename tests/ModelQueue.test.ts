/**
 * 并发配额的离线测试：每个模型、每个供应商同时最多几个调用，超了排队，不丢、不卡死。
 */
import * as bunTest from 'bun:test';
import * as model from '../src/capabilities/Model.ts';


/**
 * 跑一批假调用，记下同一时间最多有几个在跑。
 * @param queue 排队。
 * @param models 每个调用用的模型。
 */
async function peak(queue: model.ModelQueue, models: string[]): Promise<{ all: number; byModel: Record<string, number> }> {
  /** 正在跑的。 */
  let running = 0;
  /** 每个模型正在跑的。 */
  const runningByModel: Record<string, number> = {};
  /** 结果。 */
  const result = { all: 0, byModel: {} as Record<string, number> };
  await Promise.all(
    models.map((id) =>
      queue.run(id, async () => {
        running += 1;
        /** 这个模型现在在跑几个。 */
        const now = (runningByModel[id] ?? 0) + 1;
        runningByModel[id] = now;
        result.all = Math.max(result.all, running);
        result.byModel[id] = Math.max(result.byModel[id] ?? 0, now);
        await Bun.sleep(20);
        running -= 1;
        runningByModel[id] = (runningByModel[id] ?? 1) - 1;
      }),
    ),
  );
  return result;
}


bunTest.test('每个模型默认上限、单设的模型上限', async () => {
  /** 排队。 */
  const queue = new model.ModelQueue({ perModel: 2, models: { 'a/fast': 4 }, providers: {} });
  /** 结果。 */
  const result = await peak(queue, [...Array<string>(6).fill('a/slow'), ...Array<string>(6).fill('a/fast')]);
  bunTest.expect(result.byModel['a/slow']).toBe(2);
  bunTest.expect(result.byModel['a/fast']).toBe(4);
});


bunTest.test('供应商合计上限', async () => {
  /** 排队。 */
  const queue = new model.ModelQueue({ perModel: 3, models: {}, providers: { p: 4 } });
  /** 结果。 */
  const result = await peak(queue, [...Array<string>(5).fill('p/x'), ...Array<string>(5).fill('p/y')]);
  bunTest.expect(result.all).toBe(4);
  bunTest.expect(result.byModel['p/x']).toBeLessThanOrEqual(3);
});
