/**
 * 密钥替身在引擎里的端到端离线测试：假模型 + 临时运行时目录 + 内存数据库。
 *
 * 盯两件事：
 *   1. 工具结果里出现 config.yaml 里的密钥真值时，存进数据库、交给模型的都是 {{secret:N}} 替身；
 *   2. 模型把替身写进工具参数时，真正执行前换回真值（写文件拿到的是真值）。
 * 不联网、不读真实的 F:\aidata\AIJMBots\config.yaml，密钥用假的。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as engineModule from '../src/events/Loop.ts';
import * as events from '../src/events/Events.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import type * as modelModule from '../src/capabilities/Model.ts';


/** 假的密钥真值；测试只验证替身机制，不碰真实密钥。 */
const FAKE_SECRET = 'fake-secret-abcdefgh';

/** 测试用的机器人名。 */
const BOT = '测试机器人';

/** 假 config.yaml：一个供应商、一个默认模型；密钥放在 api_key 里。 */
const CONFIG = [
  'providers:',
  '  fake:',
  '    base_url: http://127.0.0.1:1/v1',
  `    api_key: ${FAKE_SECRET}`,
  'default_model: fake/m1',
  'engine:',
  '  max_steps: 10',
].join('\n');


/**
 * 建好临时运行时目录：config.yaml 和一个不限制工具、按规则判断的机器人。
 * @returns 目录；调用方负责删。
 */
function makeRuntimeDir(): string {
  /** 临时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-engine-secrets-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), CONFIG);
  fs.mkdirSync(path.join(dir, 'bots', BOT), { recursive: true });
  fs.writeFileSync(path.join(dir, 'bots', BOT, 'config.yaml'), 'description: 测试用\njudge: rule\n');
  return dir;
}


/**
 * 造一条工具调用。
 * @param id 调用 ID。
 * @param name 工具名。
 * @param args 参数。
 * @returns Pi 格式的工具调用。
 */
function toolCall(id: string, name: string, args: Record<string, unknown>): modelModule.ChatOutput['toolCalls'][number] {
  return { type: 'toolCall', id, name, arguments: args } as modelModule.ChatOutput['toolCalls'][number];
}


/**
 * 造一个按剧本回复的假模型。
 * @param steps 每次 chat 依次用的回复；“done” 那一步没有工具调用。
 * @param seen 每次 chat 的入参记进来，供断言模型看到的内容。
 * @returns 假的 Ai。
 */
function fakeAi(steps: { text: string; toolCalls: modelModule.ChatOutput['toolCalls'] }[], seen: modelModule.ChatInput[]): modelModule.Ai {
  /** 已经调了几次。 */
  let calls = 0;
  return {
    chat: (input) => {
      seen.push(input);
      /** 这次用的剧本；超出后一直用最后一步。 */
      const step = steps[Math.min(calls, steps.length - 1)]!;
      calls += 1;
      return Promise.resolve({
        message: { role: 'assistant', content: [{ type: 'text', text: step.text }] } as unknown as modelModule.ChatOutput['message'],
        text: step.text,
        thinking: '',
        toolCalls: step.toolCalls,
        ms: 1,
        request: {
          model: 'fake/m1',
          thinkingAsked: 'off',
          thinking: 'off',
          system: '',
          tools: input.tools.map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
          messages: input.messages,
        },
      });
    },
    //G 这个测试不该走决策模型；真被调用说明判断方式配错了。
    decide: () => Promise.reject(new Error('不该调用决策模型')),
    hasDecision: () => false,
    listModels: () => [{ id: 'fake/m1', name: 'm1', kind: 'chat' as const, contextWindow: 8000, thinking: ['off'], price: { input: 0, output: 0 } }],
  };
}


bunTest.test('工具结果里的密钥真值：存进数据库、交给模型的都是 {{secret:N}} 替身', async () => {
  /** 临时运行时目录。 */
  const dir = makeRuntimeDir();
  try {
    /** 资源。 */
    const resources = await resourcesModule.Resources.load(dir);
    /** 工作区目录。 */
    const workspaceDir = path.join(dir, 'workspaces', '默认', 'files');
    fs.mkdirSync(workspaceDir, { recursive: true });
    fs.writeFileSync(path.join(workspaceDir, 'secret.txt'), `token=${FAKE_SECRET}\n`);
    /** 数据库。 */
    const store = events.openEventStore(':memory:');
    /** 每次调模型的入参。 */
    const seen: modelModule.ChatInput[] = [];
    /** 第一次读文件，第二次收尾。 */
    const ai = fakeAi([
      { text: '我先读一下文件', toolCalls: [toolCall('call_1', 'read', { path: 'secret.txt' })] },
      { text: '读完了', toolCalls: [] },
    ], seen);
    /** 引擎。 */
    const engine = engineModule.createEngine({ resources, store, ai, owner: 'test@1' });
    /** 提交的任务。 */
    const submitted = engine.submit({ input: '看看 secret.txt 里写了什么', source: '命令行', bot: BOT });
    await engine.runPending(submitted.sessionId);

    //M 数据库里不能出现真值，只能出现替身；工具结果要能看出读了什么。
    /** 这条 execution 的工具结果。 */
    const rows = store.listToolResults(submitted.eventId);
    bunTest.expect(rows).toHaveLength(1);
    bunTest.expect(rows[0]?.toolName).toBe('read');
    bunTest.expect(String(rows[0]?.output)).toContain('{{secret:1}}');
    bunTest.expect(String(rows[0]?.output)).not.toContain(FAKE_SECRET);
    //M 模型下一步看到的历史工具结果也必须是替身，否则真值就随着上下文进了模型。
    /** 第二次调模型时看到的工具结果消息。 */
    const toolMessages = (seen[1]?.messages ?? []).filter((message) => message.role === 'toolResult');
    bunTest.expect(toolMessages).toHaveLength(1);
    bunTest.expect(JSON.stringify(toolMessages[0]?.content)).toContain('{{secret:1}}');
    bunTest.expect(JSON.stringify(toolMessages[0]?.content)).not.toContain(FAKE_SECRET);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


bunTest.test('模型把替身写进工具参数：真正落盘的是密钥真值', async () => {
  /** 临时运行时目录。 */
  const dir = makeRuntimeDir();
  try {
    /** 资源。 */
    const resources = await resourcesModule.Resources.load(dir);
    /** 工作区目录。 */
    const workspaceDir = path.join(dir, 'workspaces', '默认', 'files');
    fs.mkdirSync(workspaceDir, { recursive: true });
    /** 数据库。 */
    const store = events.openEventStore(':memory:');
    /** 每次调模型的入参。 */
    const seen: modelModule.ChatInput[] = [];
    /** 第一次把替身写进文件，第二次收尾。 */
    const ai = fakeAi([
      { text: '我把值写进去', toolCalls: [toolCall('call_1', 'edit', { path: '写出来.txt', content: 'token={{secret:1}}\n' })] },
      { text: '写好了', toolCalls: [] },
    ], seen);
    /** 引擎。 */
    const engine = engineModule.createEngine({ resources, store, ai, owner: 'test@1' });
    /** 提交的任务。 */
    const submitted = engine.submit({ input: '把密钥写进文件', source: '命令行', bot: BOT });
    await engine.runPending(submitted.sessionId);

    //M 引擎在真正执行工具前把替身换回真值：文件里应该是真值，不是 {{secret:1}}。
    bunTest.expect(fs.readFileSync(path.join(workspaceDir, '写出来.txt'), 'utf8')).toBe(`token=${FAKE_SECRET}\n`);
    //M 工具结果（已写入路径）不能把真值带进数据库。
    /** 这条 execution 的工具结果。 */
    const rows = store.listToolResults(submitted.eventId);
    bunTest.expect(rows).toHaveLength(1);
    bunTest.expect(String(rows[0]?.output)).not.toContain(FAKE_SECRET);
    store.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
