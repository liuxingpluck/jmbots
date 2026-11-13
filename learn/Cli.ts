/**
 * 命令行入口：读 learn/config.yaml，挂上 Agent 和自带的 time 工具，跑一轮循环。
 * 只依赖 Cordis、pi-ai 和 yaml，不引用 src6。
 * 不打印配置原文和密钥。运行：bun learn/Cli.ts 你好
 *
 * 挂了两个异步的 before-tool 监听者：骨架用 parallel，两个都会跑，各自把意见 push 进 event.votes。
 * 本入口对 time 放行（只 push note，不 push skip）；若要拦住，push `{ plugin, skip: 理由 }`。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import * as piAi from '@earendil-works/pi-ai';
import * as cordis from 'cordis';
import * as yaml from 'yaml';
import * as agentModule from './Agent.ts';


/** 本目录（learn/），配置文件在这里。 */
const LEARN_DIR = import.meta.dirname;

/** 系统提示词：告诉模型有 time 工具，回答要短。 */
const SYSTEM = '你是一个助手。需要知道现在几点时调用 time 工具。用中文简短回答。';

/** 最多调几步模型。 */
const MAX_STEPS = 4;

/** 给模型看的 time 工具定义：没有参数，返回当前本地时间和时区。 */
const TIME_TOOL: piAi.Tool = {
  name: 'time',
  description: '返回当前本地时间和时区。',
  parameters: piAi.Type.Object({}),
};


/**
 * 给控制台输出上色（36 青、33 黄、31 红）。
 * @param color ANSI 颜色号。
 * @param text 要打印的文字。
 * @returns 带颜色码的字符串。
 */
function paint(color: string, text: string): string {
  return `\x1b[${color}m${text}\x1b[0m`;
}


/**
 * 把抛出来的错收成一句话。
 * @param error 抛出来的值。
 * @returns 错误信息。
 */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}


/** 命令行入口：读配置、挂插件、跑一轮、拔插件。 */
class Cli {
  /**
   * 读配置、挂上 Agent 和 time 工具、跑一轮、拔插件。
   * @param argv 去掉 bun 和脚本路径之后的参数，拼成用户提示词；空的就用「你好」。
   * @returns 模型出错是 true（调用方再以非 0 退出）；正常结束是 false。
   * @throws 配置读不了、没有默认模型或插件起不来时抛错。
   */
  async run(argv: string[]): Promise<boolean> {
    /** 用户提示词。 */
    const prompt = argv.join(' ').trim() || '你好';
    /** 整棵插件树的根。 */
    const app = new cordis.Context();
    /** 挂上的插件，收尾时按相反顺序拔，避免泄漏。 */
    const fibers = [
      app.plugin(agentModule.Agent),
      app.plugin((ctx: cordis.Context) => this.attach(ctx)),
    ];
    for (const fiber of fibers) {
      await fiber;
    }
    try {
      /** 循环结果。 */
      const result = await app.agent.run({
        model: this.modelOf(path.join(LEARN_DIR, 'config.yaml')),
        system: SYSTEM,
        messages: [{ role: 'user', content: prompt, timestamp: Date.now() }],
        tools: [TIME_TOOL],
        maxSteps: MAX_STEPS,
      });
      //G 模型出错：过程事件已经打过，这里把失败原因打红，交给调用方退出。
      if (result.error !== undefined) {
        console.log(paint('31', `[agent/error] ${result.error}`));
        return true;
      }
      return false;
    } finally {
      for (const fiber of [...fibers].reverse()) {
        await fiber.dispose();
      }
    }
  }

  /**
   * 挂上 time 工具，演示两个异步的 before-tool 都会跑并 push 进 votes，并打印 after-tool、done。
   * @param ctx 根 ctx。
   * @returns 无。
   */
  private attach(ctx: cordis.Context): void {
    //M 演示 1：异步 before-tool，await 之后把放行意见推进 votes（对 time 不 skip，方便真跑看到工具）。
    ctx.on('agent/before-tool', async (event) => {
      await Promise.resolve();
      event.votes.push({ plugin: 'cli-log', note: '放行' });
      console.log(paint('36', `[agent/before-tool] ${event.call.name} ${JSON.stringify(event.call.arguments)}`));
      // 若要拦住：event.votes.push({ plugin: 'cli-log', skip: '入门骨架不允许这个工具' });
    });
    //M 演示 2：另一个异步 before-tool，同样会跑（parallel 不会因前一个结束而跳过），也推进 votes。
    ctx.on('agent/before-tool', async (event) => {
      await Promise.resolve();
      event.votes.push({ plugin: 'cli-audit', note: '已记录' });
    });
    //M 响应 agent/tool：只处理 time，别的名字让给其他插件（没人接时骨架会回「没有执行者」）。serial，第一个接手的执行。
    ctx.on('agent/tool', (event) => {
      if (event.call.name !== 'time') {
        return;
      }
      /** 系统时区名，和本地时间一起回给模型。 */
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      return { text: `${new Date().toLocaleString('zh-CN', { hour12: false })}（${zone}）`, isError: false };
    });
    ctx.on('agent/after-tool', (event) => {
      /** 成败标记。 */
      const flag = event.isError ? '出错' : '完成';
      console.log(paint('33', `[agent/after-tool] ${event.call.name}（${flag}）：${event.text}`));
    });
    ctx.on('agent/done', (event) => {
      console.log(paint('31', `[agent/done] ${event.text}`));
    });
  }


  /**
   * 用 yaml 库读 default_model 和它所属供应商，拼成骨架要的模型对象。
   * 用 parseDocument，错误收在 errors 里，不带原文片段（原文可能有密钥）。
   * @param configPath learn/config.yaml 的路径。
   * @returns 骨架要的模型对象。
   * @throws 文件不在、YAML 不合法、没写 default_model 或供应商不合法时抛错。错误信息不带原文和密钥。
   */
  private modelOf(configPath: string): agentModule.AgentModel {
    //G 没有配置就没法调模型，提示复制样例。
    if (!fs.existsSync(configPath)) {
      throw new Error('找不到 learn/config.yaml，请先复制 config.example.yaml 并填写密钥');
    }
    /** 解析文档；含密钥，不打印。 */
    const document = yaml.parseDocument(fs.readFileSync(configPath, 'utf8').replace(/^\uFEFF/u, ''));
    if (document.errors[0] !== undefined) {
      /** 出错的行号；解析器没给就是问号。 */
      const line = document.errors[0].linePos?.[0]?.line;
      throw new Error(`learn/config.yaml 不是合法的 YAML（第 ${String(line ?? '?')} 行）`);
    }
    /** 转成普通对象；含密钥，不打印。 */
    const raw = document.toJS() as Record<string, unknown>;
    /** 默认模型完整 ID，必须写成 供应商名/模型 ID。 */
    const id = raw.default_model;
    if (typeof id !== 'string' || id.indexOf('/') <= 0 || id.endsWith('/')) {
      throw new Error('default_model 必须写成 供应商名/模型 ID');
    }
    /** 第一条斜杠：后面都归模型 ID。 */
    const slash = id.indexOf('/');
    /** 供应商名。 */
    const name = id.slice(0, slash);
    /** 供应商内的模型 ID。 */
    const modelId = id.slice(slash + 1);
    /** 默认模型所属的那一家。 */
    const fields = (raw.providers as Record<string, Record<string, unknown>> | undefined)?.[name];
    if (fields === undefined) {
      throw new Error('default_model 引用了没配置的供应商');
    }
    /** 请求地址。 */
    const baseUrl = fields.base_url;
    /** 请求密钥；不写是空串。 */
    const apiKey = fields.api_key ?? '';
    /** 请求协议；不写按 OpenAI Chat Completions。 */
    const api = fields.api ?? 'openai-completions';
    //G 地址错误不回显原值，里面可能带凭据。
    if (typeof baseUrl !== 'string' || (!baseUrl.startsWith('http://') && !baseUrl.startsWith('https://'))) {
      throw new Error('providers 的 base_url 必须是 HTTP 或 HTTPS 地址');
    }
    if (typeof apiKey !== 'string') {
      throw new Error('providers 的 api_key 必须是字符串');
    }
    if (api !== 'openai-completions' && api !== 'openai-responses' && api !== 'anthropic-messages') {
      throw new Error('providers 的 api 必须是 openai-completions、openai-responses、anthropic-messages 之一');
    }
    /** 这一家下面手写的这个模型；没有就用默认的上下文长度和最大输出。 */
    const written = (fields.models as Record<string, Record<string, unknown>> | undefined)?.[modelId];
    return {
      baseUrl: baseUrl.replace(/\/+$/u, ''),
      id: modelId,
      apiKey,
      contextWindow: typeof written?.context_window === 'number' ? written.context_window : 128_000,
      maxTokens: typeof written?.max_output_tokens === 'number' ? written.max_output_tokens : 8192,
      api,
      provider: name,
    };
  }
}


/**
 * 入口：跑一轮；模型出错或配置读不了时以非 0 退出。
 * 不把 exitCode 赋给 process（类型上是只读的），而是显式 process.exit。
 */
try {
  /** 模型有没有出错。 */
  const failed = await new Cli().run(process.argv.slice(2));
  if (failed) {
    process.exit(1);
  }
} catch (error) {
  console.error(`没跑成：${errorText(error)}`);
  process.exit(1);
}
