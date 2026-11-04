/**
 * 引擎按渠道能力给工具的离线测试：假模型 + 临时运行时目录 + 内存数据库。
 *
 * 渠道没给 publishDoc 时模型不该看到发文档的工具；给了才看得到。发消息这类基础能力也照同一规则。
 * 不联网、不读真实 config.yaml、不建真渠道。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as engineModule from '../src/events/Loop.ts';
import * as events from '../src/events/Events.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import type * as modelModule from '../src/capabilities/Model.ts';


/** 测试用的机器人名。 */
const BOT = '测试机器人';

/** 假 config.yaml：一个供应商、一个默认模型。 */
const CONFIG = [
  'providers:',
  '  fake:',
  '    base_url: http://127.0.0.1:1/v1',
  '    api_key: fake-key-abcdefgh',
  'default_model: fake/m1',
].join('\n');


/**
 * 建好临时运行时目录：config.yaml 和一个不限制工具的机器人。
 * @returns 目录；调用方负责删。
 */
function makeRuntimeDir(): string {
  /** 临时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-engine-channel-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG);
  fs.mkdirSync(path.join(dir, 'bots', BOT), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bots', BOT, 'config.yaml'), 'description: 测试用\njudge: rule\n');
  return dir;
}


/**
 * 造一个只回话、不调工具的假模型，并把每次拿到的工具名记下来。
 * @param seenTools 每次 chat 收到的工具名列表。
 * @returns 假的 Ai。
 */
function fakeAi(seenTools: string[][]): modelModule.Ai {
  return {
    chat: (input) => {
      seenTools.push(input.tools.map((tool) => tool.name));
      /** 回复文字。 */
      const text = '这一步不调工具';
      return Promise.resolve({
        message: { role: 'assistant', content: [{ type: 'text', text }] } as unknown as modelModule.ChatOutput['message'],
        text,
        thinking: '',
        toolCalls: [],
        ms: 1,
        request: { model: 'fake/m1', thinkingAsked: 'off', thinking: 'off', system: '', tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })), messages: input.messages },
      });
    },
    decide: () => Promise.reject(new Error('不该调用决策模型')),
    hasDecision: () => false,
    listModels: () => [{ id: 'fake/m1', name: 'm1', kind: 'chat' as const, contextWindow: 8000, thinking: ['off'], price: { input: 0, output: 0 } }],
  };
}


/**
 * 跑一条什么工具都不调的任务，返回第一次 chat 拿到的工具名。
 * @param resources 资源。
 * @param store 数据库。
 * @param channel 渠道能力。
 * @returns 工具名列表。
 */
async function runOnceAndGetTools(resources: resourcesModule.Resources, store: events.EventStore, channel: engineModule.ChannelHooks): Promise<string[]> {
  /** 每次 chat 收到的工具名。 */
  const seenTools: string[][] = [];
  /** 引擎。 */
  const engine = engineModule.createEngine({ resources, store, ai: fakeAi(seenTools), owner: 'test@1', channel });
  /** 提交的任务。 */
  const submitted = engine.submit({ input: '随便说句话', source: '命令行', bot: BOT });
  await engine.runPending(submitted.sessionId);
  return seenTools[0] ?? [];
}


bunTest.test('channel 没给 publishDoc：模型拿不到发文档的工具', async () => {
  /** 临时运行时目录。 */
  const dir = makeRuntimeDir();
  try {
    /** 资源。 */
    const resources = await resourcesModule.Resources.load(dir);
    /** 数据库。 */
    const store = events.openEventStore(':memory:');
    /** 只开了发消息的渠道。 */
    const tools = await runOnceAndGetTools(resources, store, { send: () => Promise.resolve('msg_1') });
    //M 基础能力还在，说明这只是“没声明文档能力”，不是整个渠道工具都没给。
    bunTest.expect(tools).toContain('feishu_send');
    //G 没给 publishDoc 却把 feishu_doc 给模型，模型会调用一个跑不起来的工具。
    bunTest.expect(tools).not.toContain('feishu_doc');
    bunTest.expect(tools).not.toContain('feishu_doc_delete');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('channel 给了 publishDoc：模型拿得到 feishu_doc 和 feishu_doc_delete', async () => {
  /** 临时运行时目录。 */
  const dir = makeRuntimeDir();
  try {
    /** 资源。 */
    const resources = await resourcesModule.Resources.load(dir);
    /** 数据库。 */
    const store = events.openEventStore(':memory:');
    /** 声明支持文档的渠道。 */
    const tools = await runOnceAndGetTools(resources, store, { publishDoc: () => Promise.resolve('doc_1') });
    //M 发布和删除是一组能力，给了 publishDoc 就要两个工具都能用。
    bunTest.expect(tools).toContain('feishu_doc');
    bunTest.expect(tools).toContain('feishu_doc_delete');
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
