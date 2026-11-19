/** 收集插件和网页的任务节点，把任务变化、选择与留言交给中控。 */
import type * as cordis from 'cordis';
import * as routesModule from './Routes.ts';
import * as storeModule from './Store.ts';

export const name = 'decision-map';
export const version = '1.3.1';
export const inject = ['resources', 'http'];

/**
 * 校验配置并把当前数据目录的图挂到主 HTTP 服务上。
 * @param ctx Cordis 插件上下文。
 * @param config 可选 relay_helper。缺省时中控通过变化接口读取结果。
 * 副作用：打开图和历史，挂载 HTTP 入口和插件事件。
 */
export function apply(ctx: cordis.Context, config?: unknown): void {
  let helper: string | undefined;
  if (config !== undefined) {
    //M 只在入口读取中控助手名，配置为空时允许直接轮询。
    const written = storeModule.readObject(config);
    const value = written['relay_helper'];
    if (value !== undefined) helper = storeModule.readText(value, 'decision-map.relay_helper');
  }

  //M 统一把图与历史存在当前运行时目录的 data/decision-map 下。
  const dir = ctx.resources.dir('data', 'decision-map');
  const store = new storeModule.Store(dir);
  routesModule.mount(ctx, store, helper);
}
