/**
 * 入口：挂骨架，照 config.yaml 的 plugins 段挂插件，告诉大家开工，接着跑上次没跑完的会话。
 * 运行：bun src7/Main.ts [--data|--runtime 运行时目录] [给命令行渠道的其余参数]
 *   编译版还认：version（打印 JSON 后退出）、serve [--runtime 目录] [--port 端口] [--mode candidate]
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
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
     * 骨架和插件都挂完了，可以开工了。命令行渠道等到它才把命令行里带的那句话发出去。只是通知。
     * 谁发：src7/Main.ts 的 main
     * 谁接：
     *   src7/plugins/approval/Outbound.ts 的 Outbound.constructor
     *   src7/plugins/assist/index.ts 的 apply
     *   src7/plugins/base-bridge/UpdateWatch.ts 的 mountUpdateWatch
     *   src7/plugins/bots/DispatchResults.ts 的 DispatchResults.listen
     *   src7/plugins/cli/index.ts 的 Cli.constructor
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
  //M version 子命令：只打印版本表就退出，不起服务。
  if (argv[0] === 'version') {
    versions.print();
    return;
  }

  //M 在挂骨架和插件之前统一标记报错，也覆盖配置与挂载失败。
  backendLog.install();

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

  //M 插件：照 config.yaml 里写的先后，挂一个等一个。这个先后也是 session/request 挨个问的先后。
  //M   机器人（bots）、渠道、工具、提示词都是插件，骨架不认得它们。
  /** 挂上去的插件（带配置里的名字）；下面查它们要的服务用。 */
  const mounted: { name: string; plugin: pluginIndex.PluginModule }[] = [];
  /** config.yaml 里写的全部插件。 */
  const configured = app.resources.config.plugins;

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

  for (const entry of entries) {
    try {
      //M 从内置清单或外部文件夹动态加载插件并挂入 Cordis，拿到插件实例以记入挂载表。
      const plugin = await loadPlugin(entry.name, app.resources.root);
      await app.plugin(plugin, entry.config);
      mounted.push({ name: entry.name, plugin });

      //M 挂上了：结果写到 resources.pluginStatus，给 /api/health 和 /flow/ 用。
      app.resources.pluginStatus.push({
        name: entry.name,
        mounted: true,
        started: true,
        missing: [],
        error: '',
        inject: plugin.inject ?? [],
      });
    } catch (error) {
      //G 找不到、起不来 → 打一行原因，不挡别的插件。
      const text = textModule.getMessage(error);
      console.error(`插件 ${entry.name} 没挂上：${text}`);

      //G 写给 health / /flow/ 的原因不带模块系统的绝对路径：找不到模块的，换成一句人话。
      let reason = text;
      if (/Cannot find module/iu.test(text)) {
        reason = '找不到这个插件（自带名单里没有，也没有对应的入口文件）';
      }

      //M 没挂上也记一行；它声明要的服务照自带名单里写的填（别人写的插件没加载成，填空）。
      const builtIn = pluginIndex.BUILT_IN[entry.name];
      app.resources.pluginStatus.push({
        name: entry.name,
        mounted: false,
        started: false,
        missing: [],
        error: reason,
        inject: builtIn?.inject ?? [],
      });
    }
  }

  //G 插件要用的服务到现在还没人提供 → Cordis 会让它一直等着，不开工也不报错。打一行说清它在等谁。
  for (const item of mounted) {
    /** 它声明要的服务。 */
    const wanted = item.plugin.inject ?? [];
    /** 其中到现在还没人提供的。 */
    const missing = wanted.filter((service) => app.get(service) === undefined);
    if (missing.length === 0) continue;

    const names = missing.join('、');
    console.error(`插件 ${item.name} 没开工：它要用的 ${names} 没人提供，看看 plugins 里是不是少挂了`);

    //M 把挂载结果里它那一行改成没开工，写上缺谁。
    const row = app.resources.pluginStatus.find((status) => status.name === item.name);
    if (row !== undefined) {
      row.started = false;
      row.missing = missing;
    }
  }

  //M 都挂完了：告诉大家开工，带上命令行里剩下的参数。
  app.emit('ready', args.rest);

  //M 上次没跑完的会话（库里还是 running 的），接着跑。
  for (const row of app.sessions.find({ state: 'running' })) {
    void app.sessions.open(row.id).run();
  }
}


/**
 * 照 config.yaml 里写的 name 取出一个插件。
 * @param name 自带插件的名字，或者别人写的插件的文件夹路径。
 * @param root 运行时目录；相对路径从它算。
 * @returns 这个插件的模块（导出 name、inject、apply）。导出得不对，Cordis 挂它的时候会报错。
 */
async function loadPlugin(name: string, root: string): Promise<pluginIndex.PluginModule> {
  //M 自带的：名字在名单里。
  const builtIn = pluginIndex.BUILT_IN[name];
  if (builtIn !== undefined) return builtIn;

  //M 别人写的：name 是文件夹路径，入口是里面的 index.ts，没有就 index.js。
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
  console.error(`没跑成：${textModule.getMessage(error)}`);
  process.exit(1);
}
