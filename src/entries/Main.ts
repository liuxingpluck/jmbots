/**
 * 入口（docs/10 5.1、6.15）。version 打印版本和每个版本做了什么（JSON，基地比版本用）；serve 开服务：
 *   bun src/entries/Main.ts serve [--port 30086] [--mode candidate] [--runtime 运行时目录]
 *   --runtime 不写用环境变量 JMBOTS_RUNTIME，再不写是程序所在的目录（从源码跑时是仓库里的 jmbotsData/）。HTTP 一律监听 0.0.0.0。
 *   --mode candidate：换版本时的试运行（scripts/Swap_Serve.ts 用）：只开 HTTP 看健康，不开飞书、不起循环、不收拾数据库。
 * 进程号写进运行时 data/serve_<端口>.pid，换版本时按它停旧进程。
 * 建对象、开渠道、起循环都在 App.ts 的 class App 里。
 */
import * as embedded from '../resources/Embedded.ts';
import * as resourcesModule from '../resources/Resources.ts';
import * as utils from '../utils/Utils.ts';
import * as checks from '../utils/Checks.ts';
import * as versions from '../Versions.ts';
import * as appModule from './App.ts';


/**
 * serve：建应用、开起来（开渠道、起每个机器人的循环、接着跑重启前没跑完的会话）。
 * @param argv 命令行参数（serve 后面的）。
 * @returns 无（服务一直跑）。
 * 副作用：监听端口、连飞书、写 pid 文件、调模型……
 */
async function serve(argv: string[]): Promise<void> {
  //M 入口一次确定参数和资源，内部对象只接收明确的值。
  /** 命令行和环境变量在此汇合，返回明确目录和模式。 */
  const startup = checks.readStartupOptions(argv, process.env.JMBOTS_RUNTIME);
  /** 已加载的配置、提示词和机器人资源。 */
  const resources = await resourcesModule.Resources.load(startup.runtime);
  /** 配置里的监听默认值，供入口校验。 */
  const httpSettings = resources.getHttp();
  const listenDefaults = {
    port: httpSettings.port,
    host: '0.0.0.0',
  };
  /** 命令行覆盖配置后，入口确定的监听参数。 */
  const listen = checks.readListenOptions(listenDefaults, argv);
  /** 内部应用只接收已经确定的值。 */
  const appOptions = {
    candidate: startup.candidate,
    port: listen.port,
  };

  const app = await appModule.App.create(resources, appOptions);
  await app.start();
}


/**
 * 照命令行做事。
 * @param argv 命令行参数（去掉 bun 和脚本名）。
 * @returns 无。
 */
async function main(argv: string[]): Promise<void> {
  if (argv[0] === 'version') {
    /** 给基地读取的版本信息，不带运行时配置。 */
    const versionInfo = {
      version: versions.VERSIONS[0]!.version,
      builtAt: embedded.builtTime(),
      versions: versions.VERSIONS,
    };
    const versionJson = JSON.stringify(versionInfo);
    console.log(versionJson);
    return;
  }
  if (argv[0] === 'serve') {
    /** 去掉子命令，只把启动选项交给 serve。 */
    const serveArgs = argv.slice(1);
    await serve(serveArgs);
    return;
  }
  const defaultRuntime = checks.resolveRuntimeDirectory(undefined);
  const usage = '用法：bun src/entries/Main.ts serve [--port 30086] '
    + '[--mode candidate] [--runtime 运行时目录（默认 ' + defaultRuntime + '）]';
  console.log(usage);
}


/** 命令行前两项属于运行时和脚本，不传给应用命令入口。 */
const commandArgs = process.argv.slice(2);
await main(commandArgs).catch((error: unknown) => {
  console.error(`${utils.formatTime()} 起不来：${utils.errorText(error)}`);
  process.exit(1);
});
