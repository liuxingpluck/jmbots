/**
 * 入口：挂骨架，照 config.yaml 的 plugins 段挂插件，接着跑上次没跑完的会话。
 * 运行：bun src7/Main.ts [--data 运行时目录] [给命令行渠道的其余参数]
 * 命令行参数的校验在 utils/Checks.ts，这里只留主线。
 *
 * 离线假模型：运行时目录的 config.yaml 里写一家名叫 fake、地址 fake:// 的供应商，
 * 或设环境变量 JMBOTS_FAKE=1。假模型第一步会调用 time 工具，第二步回一句中文。
 * 开发机连不到模型 API 时用它跑通链路；真模型请在能上网的机器上跑。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import { pathToFileURL } from 'node:url';
import * as cordis from 'cordis';
import * as botsModule from './Bots.ts';
import * as pluginIndex from './plugins/Index.ts';
import * as resourcesModule from './Resources.ts';
import * as sessionsModule from './Sessions.ts';
import * as toolsModule from './Tools.ts';
import * as checks from './utils/Checks.ts';


/**
 * 启动。
 * @param argv 命令行参数。
 * 副作用：挂插件、开数据库、可能发模型请求。
 */
async function main(argv: string[]): Promise<void> {
  //M args = checks.checkArgs(argv)。
  const args = checks.checkArgs(argv);
  //M app = new cordis.Context()。
  const app = new cordis.Context();
  //M 骨架四个，挂一个等一个，先后不能换：
  //M   resourcesModule.Resources（{ dir: args.dataDir }）→ toolsModule.Tools → sessionsModule.Sessions → botsModule.Bots。
  //G 骨架哪个没起来 → 打出原因，退出码 1。
  try {
    await app.plugin(resourcesModule.Resources, { dir: args.dataDir });
    await app.plugin(toolsModule.Tools);
    await app.plugin(sessionsModule.Sessions);
    await app.plugin(botsModule.Bots);
  } catch (error) {
    console.error(`骨架没起来：${messageOf(error)}`);
    process.exit(1);
  }
  //M 插件：app.resources.getPlugins() 的每一项（name、config），照写的先后，挂一个等一个：
  for (const entry of app.resources.getPlugins()) {
    try {
      //M   模块 = await loadPlugin(name, app.resources.paths.root)；
      const mod = await loadPlugin(entry.name, app.resources.paths.root);
      /** 给这个插件的配置。 */
      let config = entry.config;
      //M   name 是 cli → 配置里加上 argv: args.rest（命令行里剩下的参数归命令行渠道）；
      if (mod.name === 'cli') {
        const base = isRecord(config) ? config : {};
        config = { ...base, argv: args.rest };
      }
      //M   await app.plugin(模块, 配置)。
      await app.plugin(mod, config);
    } catch (error) {
      //G   找不到、导出的东西不对、起不来 → 打一行原因，不挡别的插件。
      console.error(`插件 ${entry.name} 没挂上：${messageOf(error)}`);
    }
  }
  //M 都挂完以后：app.bots.resume()，接着跑上次没跑完的会话。
  app.bots.resume();
}


/**
 * 照 config.yaml 里写的 name 取出一个插件。
 * @param name 自带插件的名字（就是 plugins/ 下的文件夹名），或者别人写的插件的文件夹路径。
 * @param root config.yaml 所在的目录（就是运行时目录）；以 . 开头的相对路径从它算。
 * @returns 这个插件的模块。
 * @throws 找不到，或者导出的东西不对。
 */
async function loadPlugin(name: string, root: string): Promise<pluginIndex.PluginModule> {
  //M 是自带的名字（pluginIndex.BUILT_IN 里有）→ return 它。
  const builtIn = pluginIndex.BUILT_IN[name];
  if (builtIn !== undefined) {
    return builtIn;
  }
  //M 不是 → 当成文件夹路径：以 . 开头的接在 root 后面，绝对路径原样用；
  const dir = path.isAbsolute(name) ? name : path.resolve(root, name);
  //M   入口 = 文件夹下的 index.ts，没有就 index.js；
  let entry = path.join(dir, 'index.ts');
  if (!fs.existsSync(entry)) {
    entry = path.join(dir, 'index.js');
  }
  if (!fs.existsSync(entry)) {
    throw new Error(`找不到插件入口（要有 index.ts 或 index.js）：${dir}`);
  }
  //M   模块 = await import(入口)；它有 default 导出就用 default（和 DSH 的加载器一样的做法）。
  const loaded: unknown = await import(pathToFileURL(entry).href);
  //M return checks.checkPlugin(模块, name)。
  return checks.checkPlugin(loaded, name);
}


/**
 * 把抛出来的错收成一句话。
 * @param error 抛出来的值。
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/**
 * 是不是普通对象。
 * @param value 任意值。
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}


try {
  await main(process.argv.slice(2));
} catch (error) {
  console.error(`没跑成：${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
