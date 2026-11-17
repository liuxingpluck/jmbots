/**
 * 插件：约定，和自带插件的名单。
 * 一个插件就是一个文件夹，入口是它里面的 index.ts，导出 name、inject（可以没有）、apply。自带的和别人写的都一样。
 * 自带的放在本目录，名字就是文件夹名。发版是编译成单文件，磁盘上没有这些文件夹，所以自带的要在下面静态 import 一次。
 * 别人写的不用改这里：在 config.yaml 的 plugins 段写它的文件夹路径，Main.ts 照路径现加载它的入口。
 */
import type * as cordis from 'cordis';
import * as agentTasks from './agent-tasks/index.ts';
import * as approval from './approval/index.ts';
import * as baseBridge from './base-bridge/index.ts';
import * as baseTools from './base-tools/index.ts';
import * as bootTrail from './boot-trail/index.ts';
import * as botFrontDesk from './bot-front-desk/index.ts';
import * as bots from './bots/index.ts';
import * as cli from './cli/index.ts';
import * as compress from './compress/index.ts';
import * as contextFit from './context-fit/index.ts';
import * as decision from './decision/index.ts';
import * as desktop from './desktop/index.ts';
import * as exec from './exec/index.ts';
import * as fakeModel from './fake-model/index.ts';
import * as feishu from './feishu/index.ts';
import * as fileTools from './file-tools/index.ts';
import * as filesApi from './files-api/index.ts';
import * as filesMirror from './files-mirror/index.ts';
import * as flow from './flow/index.ts';
import * as http from './http/index.ts';
import * as imageGen from './image-gen/index.ts';
import * as journal from './journal/index.ts';
import * as memory from './memory/index.ts';
import * as memoryGraph from './memory-graph/index.ts';
import * as modelCatalog from './model-catalog/index.ts';
import * as modelFallback from './model-fallback/index.ts';
import * as noteClaude from './note-claude/index.ts';
import * as notify from './notify/index.ts';
import * as progress from './progress/index.ts';
import * as prompt from './prompt/index.ts';
import * as relay from './relay/index.ts';
import * as replyTool from './reply-tool/index.ts';
import * as assist from './assist/index.ts';
import * as review from './review/index.ts';
import * as runs from './runs/index.ts';
import * as settings from './settings/index.ts';
import * as skills from './skills/index.ts';
import * as summary from './summary/index.ts';
import * as trace from './trace/index.ts';
import * as updateWatch from './update-watch/index.ts';
import * as usage from './usage/index.ts';
import * as webApi from './web-api/index.ts';
import * as webSearch from './web-search/index.ts';
import * as wechat from './wechat/index.ts';
import * as web from './web/index.ts';


/** 一个插件的 index.ts 要导出的东西。 */
export interface PluginModule {
  /** 插件名：日志和跟踪里按它显示。 */
  name: string;
  /** 要用到哪些服务。这些服务都起来了，apply 才会被调；不用别的服务就不写。 */
  inject?: string[];
  /**
   * 插件的入口函数。Cordis 的约定：谁调 ctx.plugin(模块, 配置)（这里是 Main.ts 的 app.plugin），
   * Cordis 就给这个插件单独建一个子 ctx，等 inject 里的服务都就绪后，调一次 apply(子ctx, 配置)。
   * 子 ctx 记着这个插件做过的所有登记（ctx.on 听事件、ctx.tools.register 登记工具等），插件被拔掉（dispose）时一起撤掉，
   * 所以插件可以热插拔，不用自己写卸载代码。类比：apply 就是插件的 main()，ctx 是它拿到的“遥控器”。
   * 挂上时调一次：在这里听事件、登记工具、起渠道。
   * 拔掉时不用自己收拾：通过 ctx 登记的监听和工具会自动撤掉。
   * @param ctx Cordis 给这个插件的 ctx。
   * @param config config.yaml 的 plugins 段里写给它的那一段；插件自己校验一次。
   */
  apply(ctx: cordis.Context, config: unknown): void | Promise<void>;
}


// 自带插件分类（每个插件提供什么、用了谁，见 src7/docs/插件地图.md）。下面名单的先后不动，挂载先后照 config.yaml 的 plugins 段。
//   骨架配套：bots、prompt、summary、compress、fake-model
//   HTTP 底座和网页：http、web
//   渠道：cli、web-api、feishu、wechat（wechat-kefu）
//   前台和分派：bot-front-desk、relay
//   给模型的工具：base-tools、file-tools、exec、web-search、image-gen、reply-tool、note-claude、agent-tasks、assist
//   审核和流程：approval、decision、progress、review、runs、notify
//   模型：model-catalog、model-fallback、context-fit
//   记忆和知识：memory、memory-graph、skills
//   管理接口：settings、files-api、base-bridge、update-watch、desktop
//   记录和调试：boot-trail（写在 plugins 段第一个）、trace、journal、usage、files-mirror、flow（原来的 debug 11-17 并进 flow）
/** 自带插件：名字 → 模块。名字就是 config.yaml 里写的那个，也是文件夹名。 */
export const BUILT_IN: Record<string, PluginModule> = {
  'bots': bots,
  'cli': cli,
  'prompt': prompt,
  'base-tools': baseTools,
  'bot-front-desk': botFrontDesk,
  'summary': summary,
  'compress': compress,
  'trace': trace,
  'fake-model': fakeModel,
  'http': http,
  'web': web,
  'web-api': webApi,
  'files-api': filesApi,
  'model-catalog': modelCatalog,
  'relay': relay,
  'feishu': feishu,
  'journal': journal,
  'approval': approval,
  'exec': exec,
  'file-tools': fileTools,
  'web-search': webSearch,
  'usage': usage,
  'settings': settings,
  'memory': memory,
  'memory-graph': memoryGraph,
  'skills': skills,
  'context-fit': contextFit,
  'model-fallback': modelFallback,
  'progress': progress,
  'review': review,
  'files-mirror': filesMirror,
  'flow': flow,
  'boot-trail': bootTrail,
  'decision': decision,
  'runs': runs,
  'agent-tasks': agentTasks,
  'image-gen': imageGen,
  'reply-tool': replyTool,
  'assist': assist,
  'note-claude': noteClaude,
  'notify': notify,
  'base-bridge': baseBridge,
  'update-watch': updateWatch,
  'desktop': desktop,
  'wechat': wechat,
  // 2026-11-14：监听客服插件对外名字是 wechat-kefu（页面 /wechat-kefu/）；仍保留 wechat 别名，旧测试配置还能挂上。
  'wechat-kefu': wechat,
};

// 以后从 src6、src（0.4）搬过来的功能，一个功能一个文件夹，在上面加一行（设计在 docs/src7插件设计/，名单见 00_总览.md 第 4 节）。
