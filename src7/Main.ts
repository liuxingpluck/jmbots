/**
 * 入口：挂骨架，照 config.yaml 的 plugins 段挂插件，告诉大家开工，接着跑上次没跑完的会话。
 * 运行：bun src7/Main.ts [--data|--runtime 运行时目录] [给命令行渠道的其余参数]
 *   编译版还认：version（打印 JSON 后退出）、serve [--runtime 目录] [--port 端口] [--mode candidate]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import * as timers from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import * as cordis from 'cordis';
import * as pluginIndex from './plugins/Index.ts';
import * as resourcesModule from './Resources.ts';
import * as sessionsModule from './Sessions.ts';
import * as toolsModule from './Tools.ts';
import * as backendLog from './utils/BackendLog.ts';
import * as checks from './utils/Checks.ts';
import * as textModule from './utils/Text.ts';
import * as versions from './utils/Versions.ts';


declare module 'cordis' {
  interface Events {
    /**
     * 骨架挂好、配置的插件都发起挂载后通知开工。超时的插件继续在后台启动。
     * 命令行渠道等到它才把命令行里带的那句话发出去。
     * 谁发：src7/Main.ts 的 main
     * 谁接：
     *   src7/plugins/approval/Outbound.ts 的 Outbound.constructor
     *   src7/plugins/assist/index.ts 的 apply
     *   src7/plugins/base-bridge/UpdateWatch.ts 的 mountUpdateWatch
     *   src7/plugins/bots/DispatchResults.ts 的 DispatchResults.listen
     *   src7/plugins/bots/index.ts 的 Bots.constructor
     *   src7/plugins/cli/index.ts 的 Cli.constructor
     *   src7/plugins/context-fit/index.ts 的 apply
     *   src7/plugins/feishu/index.ts 的 Feishu.constructor
     *   src7/plugins/feishu/outbox/Outbox.ts 的 setup
     *   src7/plugins/http/index.ts 的 Http.constructor
     *   src7/plugins/memory/ChannelBackfill.ts 的 ChannelBackfill.constructor
     *   src7/plugins/memory/index.ts 的 apply
     *   src7/plugins/programs/ResourceGuard.ts 的 ResourceGuard.constructor
     *   src7/plugins/programs/index.ts 的 apply
     *   src7/plugins/relay/index.ts 的 Relay.constructor
     *   src7/plugins/tutorial/Boot.ts 的 BootTrail.constructor
     *   src7/plugins/voice/index.ts 的 apply
     *   src7/plugins/wechat/index.ts 的 Wechat.constructor
     * @param argv 命令行里剩下的参数，谁要谁用。
     */
    'ready'(argv: string[]): void;
  }
}


/**
 * 启动。
 * @param argv 命令行参数，去掉了 bun 和脚本路径。
 * 副作用：挂骨架和插件、开数据库、发 ready、接着跑上次没跑完的会话（可能发模型请求）；
 *   挂载结果写进 app.resources.pluginStatus，没挂上、没开工的打到标准错误。
 * @throws 命令行、config.yaml 不对，或试运行却没配 http 插件时抛错；文件最底下接住。
 */
async function main(argv: string[]): Promise<void> {
  //==========================================================
  //M 处理启动参数并挂上基础服务
  //==========================================================
  //M version 子命令：只打印版本表就退出，不起服务。
  if (argv[0] === 'version') {
    versions.printVersionInfo();
    return;
  }

  //M 在挂骨架和插件之前统一标记报错，也覆盖配置与挂载失败。
  backendLog.installBackendErrorLogger();

  //M serve 子命令（基地这样起编译版）和不写子命令是同一回事：去掉 serve 这个词，剩下的参数一样认。
  let flags = argv;
  if (argv[0] === 'serve') {
    flags = argv.slice(1);
  }

  //M 校验命令行参数并整理出运行时目录与透传参数。
  const args = checks.checkArgs(flags);
  const app = new cordis.Context();

  //M 骨架三个，挂一个等一个，先后不能换。
  await app.plugin(resourcesModule.Resources, { dir: args.dataDir });
  await app.plugin(toolsModule.Tools);
  await app.plugin(sessionsModule.Sessions);

  //==========================================================
  //M 决定要挂哪些插件并监听它们的启动状态
  //==========================================================
  //M 按配置顺序发起挂载，逐个等到启动完成或超过等待上限。
  const { plugins: configured, pluginMountTimeoutMs } = app.resources.config;

  //M 试运行（基地换版前先试跑新程序）只挂 http，够它做健康检查就行，不开渠道。
  /** 这次真要挂的插件。 */
  let entries = configured;
  if (args.candidate) {
    entries = configured.filter((entry) => entry.name === 'http');
  }

  //G 试运行却没配 http → 健康检查没法做，直接报错。
  if (args.candidate && entries.length === 0) {
    throw new Error('试运行模式需要挂 http 插件，才能做健康检查');
  }

  const starting = new Map<cordis.Fiber, resourcesModule.PluginStatus>();

  function recordPluginFailure(row: resourcesModule.PluginStatus, error: unknown): void {
    //G 启动真的失败才记为失败，错误原文给标准错误排查。
    const text = textModule.getErrorMessage(error);
    console.error(`插件 ${row.name} 没挂上：${text}`);
    row.state = 'failed';
    row.error = text;
    if (/Cannot find module/iu.test(text)) {
      //G health 和教程只给出找不到入口的原因，不带模块系统的绝对路径。
      row.error = '找不到这个插件（自带名单里没有，也没有对应的入口文件）';
    }
  }

  //M 以真实 fiber 为键。等依赖或超时后继续启动的插件都能更新自己的那一行。
  app.on('internal/status', (fiber) => {
    const row = starting.get(fiber);
    if (row === undefined) return;

    if (fiber.state === cordis.FiberState.ACTIVE) {
      starting.delete(fiber);
      row.state = 'ok';
      row.error = '';
      return;
    }
    if (fiber.state !== cordis.FiberState.FAILED) return;

    //M 缺依赖时首轮等待可能早已返回，由状态事件取出随后启动失败的原因。
    void fiber.await().catch((error: unknown) => {
      if (!starting.delete(fiber)) return;

      recordPluginFailure(row, error);
    });
  }, { prepend: true });

  //==========================================================
  //M 按配置顺序发起挂载并限时等待
  //==========================================================
  for (const entry of entries) {
    //M 先按配置名找内置插件，也为加载失败的状态记录注入声明。
    const builtIn = pluginIndex.BUILT_IN[entry.name];
    const row: resourcesModule.PluginStatus = {
      name: entry.name,
      state: 'mounting',
      error: '',
      inject: builtIn?.inject ?? [],
    };
    try {
      let plugin = builtIn;
      if (plugin === undefined) {
        //M 内置表查不到才从外部插件文件夹加载入口。
        const root = app.resources.root;
        plugin = await loadExternalPlugin(entry.name, root);
      }

      //M 等待 Cordis apply。状态监听使用 thenable 后面的原 fiber。
      row.inject = plugin.inject ?? [];
      const mounted = app.plugin(plugin, entry.config);
      const fiber = mounted.ctx.fiber;
      starting.set(fiber, row);

      //M 首次等待结束时也可能在等注入，记成等服务。异步失败即使发生在超时之后也照常记账。
      const finished = fiber.await().then(() => {
        if (fiber.state === cordis.FiberState.PENDING && row.error === '') {
          row.state = 'waiting';
        }
        return true;
      }, (error: unknown) => {
        if (starting.delete(fiber)) {
          recordPluginFailure(row, error);
        }
        return true;
      });

      const timer = new AbortController();
      const options = { signal: timer.signal };
      const deadline = timers.setTimeout(pluginMountTimeoutMs, false, options);
      const waiting = [finished, deadline];
      try {
        const inTime = await Promise.race(waiting);
        if (!inTime && starting.has(fiber)) {
          //G 到点只结束本次等待，状态还是 mounting。保留 fiber，让它完成后还能发状态和服务通知。
          const seconds = pluginMountTimeoutMs / 1000;
          row.error = `启动超过 ${String(seconds)} 秒，先挂后面的，它继续在后台起`;
          console.error(`插件 ${row.name} ${row.error}`);
        }
      } finally {
        timer.abort();
      }
    } catch (error) {
      recordPluginFailure(row, error);
    }
    //M 维持配置顺序，每次发起挂载只占一行，供 health 和启动流程读。
    app.resources.pluginStatus.push(row);
  }

  //==========================================================
  //M 记录缺失依赖，通知开工并续跑会话
  //==========================================================
  //G 缺注入的插件会等服务出现，把缺哪些服务写进说明。
  for (const row of app.resources.pluginStatus) {
    if (row.state !== 'waiting') continue;

    const missing = row.inject.filter((service) => app.get(service) === undefined);
    if (missing.length === 0) continue;

    const names = missing.join('、');
    console.error(`插件 ${row.name} 没开工：它要用的 ${names} 没人提供，看看 plugins 里是不是少挂了`);
    row.error = `它要用的 ${names} 没人提供`;
  }

  //M 配置的插件都已发起挂载，告诉大家开工，带上命令行里剩下的参数。
  app.emit('ready', args.rest);

  //M 上次没跑完的会话（库里还是 running 的），接着跑。
  for (const row of app.sessions.find({ state: 'running' })) {
    void app.sessions.open(row.id).run();
  }
}


/**
 * 从外部插件文件夹加载入口，优先使用 index.ts，再找 index.js。
 * @param name 外部插件的文件夹路径，相对路径从运行时目录算。
 * @param root 配置所在的运行时目录。
 * @returns 这个插件的模块（导出 name、inject、apply）。导出得不对，Cordis 挂它的时候会报错。
 */
async function loadExternalPlugin(name: string, root: string): Promise<pluginIndex.PluginModule> {
  //M 按运行时目录解析外部路径，保留已有的入口优先级。
  const dir = path.resolve(root, name);
  let entry = path.join(dir, 'index.ts');
  if (!fs.existsSync(entry)) {
    entry = path.join(dir, 'index.js');
  }

  //M 动态 import 认的是网址：路径先转成 file:// 网址，Windows 的盘符路径才不会被当成别的协议。
  const entryUrl = pathToFileURL(entry).href;
  const loaded = await import(entryUrl) as pluginIndex.PluginModule & {
    default?: pluginIndex.PluginModule;
  };

  //M 模块有 default 导出就用 default（DSH 的加载器也是这么做的）。
  return loaded.default ?? loaded;
}


//M 程序从这里开始：去掉 bun 和脚本路径，剩下的交给 main；没跑成打一行原因，退出码 1。
const argv = process.argv.slice(2);
try {
  await main(argv);
} catch (error) {
  console.error(`没跑成：${textModule.getErrorMessage(error)}`);
  process.exit(1);
}
