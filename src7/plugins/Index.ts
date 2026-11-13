/**
 * 插件：约定，和自带插件的名单。
 * 一个插件就是一个文件夹，入口是它里面的 index.ts，导出 name、inject（可以没有）、apply。自带的和别人写的都一样。
 * 自带的放在本目录，名字就是文件夹名。发版是编译成单文件，磁盘上没有这些文件夹，所以自带的要在下面静态 import 一次。
 * 别人写的不用改这里：在 config.yaml 的 plugins 段写它的文件夹路径，Main.ts 照路径现加载它的入口。
 */
import type * as cordis from 'cordis';
import * as baseTools from './base-tools/index.ts';
import * as cli from './cli/index.ts';
import * as compress from './compress/index.ts';
import * as defaultDialog from './default-dialog/index.ts';
import * as trace from './trace/index.ts';


/** 一个插件的 index.ts 要导出的东西。 */
export interface PluginModule {
  /** 插件名：日志和跟踪里按它显示。 */
  name: string;
  /** 要用到哪些服务。这些服务都起来了，apply 才会被调；不用别的服务就不写。 */
  inject?: string[];
  /**
   * 挂上时调一次：在这里听事件、登记工具、起渠道。
   * 拔掉时不用自己收拾：通过 ctx 登记的监听和工具会自动撤掉。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config config.yaml 的 plugins 段里写给它的那一段；插件自己校验一次。
   */
  apply(ctx: cordis.Context, config: unknown): void | Promise<void>;
}


/** 自带插件：名字 → 模块。名字就是 config.yaml 里写的那个，也是文件夹名。 */
export const BUILT_IN: Record<string, PluginModule> = {
  'cli': cli,
  'base-tools': baseTools,
  'default-dialog': defaultDialog,
  'compress': compress,
  'trace': trace,
};

// 以后从 src6、src（0.4）搬过来的功能，一个功能一个文件夹，在上面加一行。比如：
//   http      HTTP 渠道（Fastify）
//   feishu    飞书渠道
//   approval  审核：听 session/before-calls，命令要用户点头时把会话改成 wait_user
//   search    联网搜索工具
