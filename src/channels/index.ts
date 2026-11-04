/**
 * 渠道装配：按 config.yaml 的 `channels:` 把该起的渠道起起来，并给引擎配好"能用哪些本事"。
 *
 * 为什么要有这个文件（用户 2026-11-04 指出）：核心说好了不认识任何一家渠道，但入口 Main.ts
 * 原来直接 import 了 Feishu、FeishuDoc、FeishuMedia 自己接线——抽象只做了一半。现在
 * **"飞书"两个字只出现在 channels/ 里面**，入口只调这里的两个函数。
 *
 * 再加一种渠道（微信、钉钉……）只改这一个文件：在 STARTERS 和 HOOKS 里各加一行。
 * 同一种渠道接好几个号就在 config.yaml 里写成数组，这里会挨个起。
 *
 * HTTP 也是一种渠道，只是它特殊两点：永远要起（网页和接口都靠它，换版本的健康检查也靠它），
 * 而且监听地址要回传给入口（领取人是 `serve@端口`）。所以它单独走 startHttp，不进 STARTERS。
 */
import * as path from 'node:path';
import * as feishu from './Feishu.ts';
import * as feishuDoc from './FeishuDoc.ts';
import * as feishuMedia from './FeishuMedia.ts';
import * as http from './Http.ts';
import * as checks from '../utils/Checks.ts';
import * as utils from '../utils/Utils.ts';
import type * as engineModule from '../events/Loop.ts';
import type * as eventsModule from '../events/Events.ts';
import type * as modelModule from '../capabilities/Model.ts';
import type * as resourcesModule from '../resources/Resources.ts';


/** 装配渠道要的东西。 */
export interface LoadInput {
  /** 资源：从这里读开了哪些渠道。 */
  resources: resourcesModule.Resources;

  /** 数据库。 */
  store: eventsModule.EventStore;

  /** 引擎：渠道收到的话交给它分派。 */
  engine: engineModule.Engine;

  /** 模型：HTTP 的 /api/models 要用。 */
  ai: modelModule.Ai;

  /** 试运行的新版本：只起 HTTP，不接聊天渠道（换版本时和正在跑的旧服务抢活会出乱子）。 */
  candidate: boolean;

  /** 命令行参数：--host、--port 比 config.yaml 优先。 */
  argv: string[];
}


/** 装配好之后告诉入口的东西。 */
export interface Loaded {
  /** HTTP 实际监听在哪：入口拿它拼领取人 `serve@端口`，也打印给人看。 */
  listen: { host: string; port: number };

  /** 接上了哪些聊天渠道，一个名字一行，打印给人看。 */
  started: string[];
}


/**
 * 一种渠道怎么"接上来收消息"。
 * @param settings 这一份渠道设置（config.yaml 里那一段）。
 * @param input 装配要的东西。
 * @returns 一句说明，打印给人看；没真接上就返回 undefined。
 */
type Starter = (settings: Record<string, unknown>, input: LoadInput) => Promise<string | undefined>;


/**
 * 接上飞书：长连接收消息，外加发件箱轮询。
 * @param settings config.yaml 的 channels.feishu（可能是数组里的一份）。
 * @param input 装配要的东西。
 * @returns 一句说明；没填 app_id/app_secret 就返回 undefined。
 * 副作用：建飞书长连接，起发件箱轮询。
 */
const startFeishu: Starter = async (settings, input) => {
  /** 读好的飞书设置。 */
  const ready = feishu.readChannelSettings(settings);
  if (!ready) {
    return undefined;
  }
  /** 传输层。 */
  const transport = feishu.createSdkTransport({ enabled: true, app_id: ready.app_id, app_secret: ready.app_secret, bot: ready.bot });
  await feishu.startFeishu({ transport, settings: ready, store: input.store, engine: input.engine, resources: input.resources });
  feishu.startOutbox(input.resources, feishu.createSender(transport, input.store));
  return `飞书：已接上，消息交给机器人 ${ready.bot}；${feishu.OUTBOX_DIR} 里的文件会发给最近私聊的人`;
};


/** 渠道名 → 怎么接上来收消息。加一种渠道就在这里加一行。 */
const STARTERS: Record<string, Starter> = {
  feishu: startFeishu,
};


/**
 * 一种渠道能给引擎提供哪些本事（发消息、问选项、发文档……）。
 * @param settings 这一份渠道设置。
 * @param store 数据库。
 * @returns 本事；这份设置不完整就返回 undefined。
 */
type HookBuilder = (settings: Record<string, unknown>, store: eventsModule.EventStore) => engineModule.ChannelHooks | undefined;


/**
 * 飞书能给引擎提供的本事。
 * @param settings config.yaml 的 channels.feishu。
 * @param store 数据库。
 * @returns 本事；没填 app_id/app_secret 就返回 undefined。
 */
const feishuHooks: HookBuilder = (settings, store) => {
  /** 读好的飞书设置。 */
  const ready = feishu.readChannelSettings(settings);
  if (!ready) {
    return undefined;
  }
  /** 传输层（发消息用；和收消息那条长连接是两回事，这里不联网直到真发）。 */
  const transport = feishu.createSdkTransport({ enabled: true, app_id: ready.app_id, app_secret: ready.app_secret, bot: ready.bot });
  /** 云文档发布器：发布和删除共用一个。 */
  const publisher = feishuDoc.createDocPublisher(feishuMedia.createOpenApi(ready.app_id, ready.app_secret));
  return {
    send: feishu.createSender(transport, store),
    ask: feishu.createChoiceSender(transport, store),
    sendMedia: feishu.createMediaSender(transport, store),
    publishDoc: feishuDoc.createDocSender(publisher, store),
    deleteDoc: feishuDoc.createDocRemover(publisher),
  };
};


/** 渠道名 → 它能给引擎提供哪些本事。加一种渠道就在这里加一行。 */
const HOOKS: Record<string, HookBuilder> = {
  feishu: feishuHooks,
};


/**
 * 按 config.yaml 配好引擎能用的渠道本事。
 * 开了好几个渠道时，同一项本事谁先登记谁生效（先到先得，顺序就是 config.yaml 里的顺序）。
 * @param resources 资源。
 * @param store 数据库。
 * @returns 本事；一个渠道都没开时是 undefined（引擎就只有默认工具）。
 */
export function buildChannelHooks(resources: resourcesModule.Resources, store: eventsModule.EventStore): engineModule.ChannelHooks | undefined {
  /** 合起来的本事。 */
  const merged: engineModule.ChannelHooks = {};
  /** 有没有哪家真的提供了本事。 */
  let any = false;
  for (const { name, settings } of resources.listChannels()) {
    /** 这一家的本事。 */
    const hooks = HOOKS[name]?.(settings, store);
    if (!hooks) {
      continue;
    }
    any = true;
    //G 先到先得：已经有人提供这项本事就不覆盖，免得后面开的渠道把前面的顶掉。
    for (const key of Object.keys(hooks) as (keyof engineModule.ChannelHooks)[]) {
      if (hooks[key] !== undefined && merged[key] === undefined) {
        Object.assign(merged, { [key]: hooks[key] });
      }
    }
  }
  return any ? merged : undefined;
}


/**
 * 算出 HTTP 监听在哪：命令行 --host/--port 优先，其次 config.yaml 的 http，再其次 0.0.0.0:30086。
 * 入口要先知道端口才能拼领取人（`serve@端口`），所以单独露出来；loadChannels 里用的是同一个函数，结果一致。
 * @param resources 资源。
 * @param argv 命令行参数。
 * @returns 地址和端口。无副作用。
 */
export function resolveListen(resources: resourcesModule.Resources, argv: string[]): { host: string; port: number } {
  /** config.yaml 的 http。 */
  const httpConfig = resources.getHttp();
  return checks.readListenOptions(
    { host: checks.optionalString(httpConfig.host, 'http.host') ?? '0.0.0.0', port: Number(httpConfig.port ?? 30086) },
    argv,
  );
}


/**
 * 起 HTTP，再按 config.yaml 把聊天渠道挨个接上。
 * @param input 装配要的东西。
 * @returns HTTP 监听在哪、接上了哪些渠道。
 * @throws HTTP 起不来时抛错（网页和换版本的健康检查都靠它，起不来不能继续）。
 * 副作用：监听端口，建各渠道的连接，写 data\serve_<端口>.pid。
 */
export async function loadChannels(input: LoadInput): Promise<Loaded> {
  /** 地址和端口。 */
  const listen = resolveListen(input.resources, input.argv);
  /** config.yaml 的 http（取 token）。 */
  const httpConfig = input.resources.getHttp();
  /** HTTP 服务。 */
  const app = http.createHttp({
    resources: input.resources,
    store: input.store,
    engine: input.engine,
    ai: input.ai,
    token: checks.optionalString(httpConfig.token, 'http.token') ?? process.env.JMBOTS_TOKEN,
    webDir: path.resolve(import.meta.dir, '..', '..', 'dist', 'web'),
  });
  await app.listen({ host: listen.host, port: listen.port });

  /** 接上了哪些聊天渠道。 */
  const started: string[] = [];
  //G 试运行的新版本不接聊天渠道：它和正在跑的旧服务同时在，抢同一批消息会出乱子。
  if (input.candidate) {
    return { listen, started };
  }
  for (const { name, settings } of input.resources.listChannels()) {
    /** 这一家怎么接。 */
    const starter = STARTERS[name];
    if (!starter) {
      console.log(`${utils.formatTime()} config.yaml 里开了渠道 ${name}，但代码里还没有它的接入方式，先跳过`);
      continue;
    }
    try {
      /** 接上之后的说明。 */
      const note = await starter(settings, input);
      if (note) {
        started.push(note);
      }
    } catch (error) {
      //G 一家接不上不能连累别家（飞书挂了，HTTP 和网页还得能用）。
      console.error(`${utils.formatTime()} 渠道 ${name} 没接上（别的渠道照常）：${utils.errorText(error)}`);
    }
  }
  return { listen, started };
}
