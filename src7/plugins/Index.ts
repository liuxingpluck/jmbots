/**
 * 插件：约定，和自带插件的名单。
 * 一个插件就是一个文件夹，入口是它里面的 index.ts，导出 name、inject（可以没有）、apply。自带的和别人写的都一样。
 * 自带的放在本目录，名字就是文件夹名。发版是编译成单文件，磁盘上没有这些文件夹，所以自带的要在下面静态 import 一次。
 * 别人写的不用改这里：在 config.yaml 的 plugins 段写它的文件夹路径，Main.ts 照路径现加载它的入口。
 */
import type * as cordis from 'cordis';
import * as checksModule from '../utils/Checks.ts';
import * as textModule from '../utils/Text.ts';
import * as approval from './approval/index.ts';
import * as baseBridge from './base-bridge/index.ts';
import * as bots from './bots/index.ts';
import * as cli from './cli/index.ts';
import * as contextFit from './context-fit/index.ts';
import * as decision from './decision/index.ts';
import * as desktop from './desktop/index.ts';
import * as exec from './exec/index.ts';
import * as fakeModel from './fake-model/index.ts';
import * as feishu from './feishu/index.ts';
import * as fileTools from './file-tools/index.ts';
import * as filesApi from './files-api/index.ts';
import * as http from './http/index.ts';
import * as imageGen from './image-gen/index.ts';
import * as journal from './journal/index.ts';
import * as memory from './memory/index.ts';
import * as modelCatalog from './model-catalog/index.ts';
import * as modelNotes from './model-notes/index.ts';
import * as progress from './progress/index.ts';
import * as relay from './relay/index.ts';
import * as assist from './assist/index.ts';
import * as settings from './settings/index.ts';
import * as skills from './skills/index.ts';
import * as tutorial from './tutorial/index.ts';
import * as usage from './usage/index.ts';
import * as webApi from './web-api/index.ts';
import * as webSearch from './web-search/index.ts';
import * as wechat from './wechat/index.ts';
import * as web from './web/index.ts';
import * as workspaces from './workspaces/index.ts';


/** 一个插件的 index.ts 要导出的东西。 */
export interface PluginModule {
  /** 插件名：日志和跟踪里按它显示。 */
  name: string;
  /** 插件版本号，写成 x.y.z（比如 '1.0.0'）。每个插件都要写，下面登记完自带插件时用 Checks.ts 的 checkVersion 查。 */
  version?: string;
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
//   骨架配套：workspaces（机器人的工作区，bots 依赖它）、bots（含前台和派后台，11-17 并进原 bot-front-desk、prompt、reply-tool）、fake-model
//   HTTP 底座和网页：http、web
//   渠道：cli、web-api、feishu、wechat（wechat-kefu）
//   分派：relay（转外部助手、外部 AI 任务通道、给 Claude 留言；11-17 并进原 agent-tasks、note-claude；前台在 bots 里）
//   给模型的工具：file-tools（已并入原 base-tools）、exec（已并入原 runs）、web-search、image-gen、assist（reply 工具在 bots 里）
//   审核和流程：approval、decision、progress（已并入原 review）
//   模型与上下文：model-catalog（已并入原 model-fallback）、context-fit（已并入原 compress、summary）、model-notes（模型介绍和评价，/model-notes/）
//   记忆和知识：memory（已并入原 memory-graph）、skills
//   管理接口：settings、files-api、base-bridge（已并入原 notify、update-watch）、desktop
//   记录和调试：tutorial（写在 plugins 段第一个；11-17 由 flow、boot-trail、trace 合成）、journal（已并入原 files-mirror）、usage
/** 自带插件：名字 → 模块。名字就是 config.yaml 里写的那个，也是文件夹名。 */
export const BUILT_IN: Record<string, PluginModule> = {
  //M tutorial 排第一个：它要录启动，config.yaml 里也写在第一个。
  'tutorial': tutorial,
  'workspaces': workspaces,
  'bots': bots,
  'cli': cli,
  'file-tools': fileTools,
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
  'web-search': webSearch,
  'usage': usage,
  'settings': settings,
  'memory': memory,
  'skills': skills,
  'context-fit': contextFit,
  'model-notes': modelNotes,
  'progress': progress,
  'decision': decision,
  'image-gen': imageGen,
  'assist': assist,
  'base-bridge': baseBridge,
  'desktop': desktop,
  'wechat': wechat,
  // 2026-11-14：监听客服插件对外名字是 wechat-kefu（页面 /wechat-kefu/）；仍保留 wechat 别名，旧测试配置还能挂上。
  'wechat-kefu': wechat,
};

//M 自带插件逐个查版本号：没写或不是 x.y.z 的，启动时就报错，写明是哪个插件。
textModule.eachEntry(BUILT_IN, (pluginName, plugin) => {
  checksModule.checkVersion(pluginName, plugin.version);
});

// 以后从 src6、src（0.4）搬过来的功能，一个功能一个文件夹，在上面加一行（设计在 docs/src7插件设计/，名单见 00_总览.md 第 4 节）。
