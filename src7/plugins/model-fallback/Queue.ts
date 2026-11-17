/**
 * 模型并发名额：每个模型、每家供应商同时最多几个请求，多的先来先排。照 0.4 ModelQueue（src/capabilities/Model.ts:754-822）。
 * 先占模型的，再占供应商的（写了上限才占）；做完反着还，不管成败都还。没有等待超时。
 */


/** 并发上限：读顶层 concurrency 段。 */
export interface Limits {
  /** 每个模型默认最多几个。 */
  perModel: number;
  /** 个别模型的上限，键是“供应商/模型”。 */
  models: Record<string, number>;
  /** 每家供应商合计上限；没写的不限。 */
  providers: Record<string, number>;
}


/** 并发名额。 */
export class Queue {
  /** 每个名额现在占了几个。 */
  private readonly running = new Map<string, number>();

  /** 每个名额在等的。 */
  private readonly waiting = new Map<string, (() => void)[]>();

  /** @param limits 并发上限。 */
  constructor(private readonly limits: Limits) {}

  /**
   * 占名额做一件事。
   * @param model 供应商/模型。
   * @param task 要做的（调模型）。
   * @param signal 停止信号：排队时被喊停就不等了，直接抛。
   */
  async run<T>(model: string, task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const provider = model.split('/')[0] ?? '';
    const providerLimit = this.limits.providers[provider];
    await this.acquire(`模型:${model}`, this.limits.models[model] ?? this.limits.perModel, signal);
    if (providerLimit !== undefined) {
      try {
        await this.acquire(`供应商:${provider}`, providerLimit, signal);
      } catch (error) {
        this.release(`模型:${model}`);
        throw error;
      }
    }
    try {
      return await task();
    } finally {
      if (providerLimit !== undefined) this.release(`供应商:${provider}`);
      this.release(`模型:${model}`);
    }
  }

  /** 满了就排进等待队列，被叫醒再看；排队时喊停就退出队列、抛错。 */
  private async acquire(key: string, limit: number, signal?: AbortSignal): Promise<void> {
    while ((this.running.get(key) ?? 0) >= limit) {
      if (signal?.aborted === true) throw new Error('排队时被喊停了');
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          signal?.removeEventListener('abort', wake);
          this.waiting.set(key, (this.waiting.get(key) ?? []).filter((item) => item !== wake));
          resolve();
        };
        signal?.addEventListener('abort', wake, { once: true });
        this.waiting.set(key, [...(this.waiting.get(key) ?? []), wake]);
      });
    }
    this.running.set(key, (this.running.get(key) ?? 0) + 1);
  }

  /** 还一个，叫醒最早在等的一个。 */
  private release(key: string): void {
    this.running.set(key, Math.max(0, (this.running.get(key) ?? 1) - 1));
    this.waiting.get(key)?.shift()?.();
  }
}
