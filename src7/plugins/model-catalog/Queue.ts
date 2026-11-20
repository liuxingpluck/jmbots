/**
 * 模型并发名额（原 model-fallback/Queue.ts，已并入 model-catalog）：
 * 每个模型、每家供应商同时最多几个请求，多的先来先排。
 * 先占模型的，再占供应商的（写了上限才占）；做完反着还，不管成败都还。没有等待超时。
 */


/** 并发上限：读 model-catalog.fallback.concurrency 或顶层 concurrency 段。 */
export interface Limits {
  /** 每个模型默认最多几个。 */
  perModel: number;
  /** 个别模型的上限，键是“供应商/模型”。 */
  models: Record<string, number>;
  /** 每家供应商合计上限；没写的不限。 */
  providers: Record<string, number>;
}


/** 并发名额队列。 */
export class Queue {
  /** 每个名额现在占了几个。 */
  private readonly running = new Map<string, number>();

  /** 每个名额在等的唤醒回调（FIFO）。 */
  private readonly waiting = new Map<string, (() => void)[]>();

  /** @param limits 并发上限。 */
  constructor(private readonly limits: Limits) {}

  /**
   * 占名额做一件事。
   * @param model 供应商/模型。
   * @param task 要做的（调模型）。
   * @param signal 停止信号：排队时被喊停就不等了，直接抛。
   * @returns task 执行完成后的返回值。
   * @throws 排队期间 signal 中止或 task 本身失败时抛出异常。
   * 副作用：在执行期间占用并在结束时释放模型及供应商的并发名额。
   */
  async run<T>(model: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const provider = model.split('/')[0] ?? '';
    const providerLimit = this.limits.providers[provider];
    //M 先抢占该模型的并发名额，防止单个模型并发过高触发限流。
    await this.acquire(`模型:${model}`, this.limits.models[model] ?? this.limits.perModel, signal);
    if (providerLimit !== undefined) {
      try {
        //M 若该供应商配置了总并发上限，再抢占一个供应商名额。
        await this.acquire(`供应商:${provider}`, providerLimit, signal);
      } catch (error) {
        //G 供应商名额未拿到或等待被取消时，归还刚才已占的模型名额避免泄漏。
        this.release(`模型:${model}`);
        throw error;
      }
    }
    try {
      return await task();
    } finally {
      if (providerLimit !== undefined) {
        //M 请求结束时按相反顺序先归还供应商名额，唤醒等待中的下一个请求。
        this.release(`供应商:${provider}`);
      }
      //M 归还该模型的并发名额，让队列中后续等待请求继续执行。
      this.release(`模型:${model}`);
    }
  }

  /** 满了就排进等待队列，被叫醒再看；排队时喊停就退出队列、抛错。 */
  private async acquire(key: string, limit: number, signal?: AbortSignal): Promise<void> {
    //G 只要当前占用名额已达上限就持续排队，等待释放通知或取消信号。
    while ((this.running.get(key) ?? 0) >= limit) {
      if (signal?.aborted === true) {
        throw new Error('排队时被喊停了');
      }
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal?.removeEventListener('abort', wake);
          //M 被唤醒或触发中止后把自己移出等待列表，避免重复调用或泄漏。
          this.waiting.set(key, (this.waiting.get(key) ?? []).filter((item) => item !== wake));
          resolve();
        };
        //M 注册取消监听并把当前唤醒回调排进队尾，等待释放时按顺序叫醒。
        signal?.addEventListener('abort', wake, { once: true });
        this.waiting.set(key, [...(this.waiting.get(key) ?? []), wake]);
      });
    }
    //M 等到空位后将占用计数加 1，正式占住名额再继续往下跑。
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
  }

  /** 还一个，叫醒最早在等的一个。 */
  private release(key: string): void {
    //M 占用计数减 1 并从队头唤醒最早排队的请求，维持先来先得。
    this.running.set(key, Math.max(0, (this.running.get(key) ?? 1) - 1));
    this.waiting.get(key)?.shift()?.();
  }
}
