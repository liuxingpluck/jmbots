/**
 * 会话循环（src/executors/AgentLoop.ts）和 exec 审核（ExecReview.ts）的离线测试：假的模型、假的渠道、真的数据库和文件库。
 * 测 docs/10 第 10 节点名要测的：执行前被打断、插话、到上限、重启补“结果未知”、自动感应、兜底回复、exec 的审核和等确认。
 */
import type * as piAi from '@earendil-works/pi-ai';
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as approvalsModule from '../src/capabilities/Approvals.ts';
import * as eventsModule from '../src/capabilities/Events.ts';
import type * as depsModule from '../src/capabilities/Deps.ts';
import * as filesModule from '../src/capabilities/Files.ts';
import type * as model from '../src/capabilities/Model.ts';
import * as secretsModule from '../src/capabilities/Secrets.ts';
import * as storeModule from '../src/capabilities/Store.ts';
import * as builders from './Builders.ts';
import * as resourcesModule from '../src/resources/Resources.ts';


/** 假模型收到的一次调用。 */
interface Call {
  /** 系统提示词积木。 */
  system: Record<string, string>;
  /** 对话。 */
  messages: piAi.Message[];
}


/** 假模型这一次回什么。 */
interface Answer {
  /** 文字。 */
  text?: string;
  /** 工具调用。 */
  calls?: { name: string; args: Record<string, unknown> }[];
  /** 这次的输入 token（上下文多长）；不写是 10。 */
  tokens?: number;
}


/** 测试用的一套依赖。 */
interface Harness {
  deps: builders.TestDeps;
  store: storeModule.Store;
  sent: { channel: string; text: string }[];
  cards: approvalsModule.PendingApproval[];
  calls: Call[];
  workDir: string;
}


/**
 * 一条消息里的文字。
 * @param message 消息。
 */
function textOf(message: piAi.Message): string {
  if (message.role === 'system') {
    return '';
  }
  return typeof message.content === 'string' ? message.content : message.content.map((block) => (block.type === 'text' ? block.text : '')).join('');
}


/**
 * 建一套依赖：临时运行时目录、内存数据库、假模型、假渠道。
 * @param answer 假模型：主会话的第几次调用回什么（审核的小循环另走 review）。
 * @param options 一次运行最多几步、审核的小循环回什么、假模型 request.thinking 的值、记忆库配置。
 */
async function harness(answer: (call: Call, index: number, h: Harness) => Answer, options: { maxRounds?: number; review?: string; thinking?: string; indexUrl?: string; memoryLibs?: string } = {}): Promise<Harness> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-loop-'));
  /** engine 下多出来的配置。 */
  const engineLines = [`  max_rounds: ${String(options.maxRounds ?? 300)}`];
  if (options.indexUrl) {
    engineLines.push(`  index_url: ${JSON.stringify(options.indexUrl)}`);
  }
  if (options.memoryLibs) {
    engineLines.push(`  memory_libs: ${JSON.stringify(options.memoryLibs)}`);
  }
  fs.writeFileSync(path.join(dir, 'config.yaml'), `providers: {}\ndefault_model: magpie/test\nbots:\n  - name: 周小灵\n    language: zh\nengine:\n${engineLines.join('\n')}\n`);
  const resources = await resourcesModule.Resources.load(dir);
  const files = new filesModule.Files(resources);
  await files.ensureBot('周小灵');
  const store = new storeModule.Store(':memory:');
  /** 先建好对象，假模型里要引用它。 */
  const h = { store, sent: [], cards: [], calls: [], workDir: path.join(files.paths('周小灵').workspaceRoot, '日常', 'files') } as unknown as Harness;
  /** 主会话调了几次。 */
  let mainIndex = 0;
  /** 工具调用编号。 */
  let callId = 0;
  const ai = builders.fakeAi({
    chat: (input) => {
      /** 这次调用。 */
      const call: Call = { system: input.system, messages: input.messages };
      /** 是审核的小循环。 */
      const review = (input.system.prompt ?? '').includes('命令审核员');
      if (!review) {
        h.calls.push(call);
      }
      /** 回什么。 */
      const reply: Answer = review ? { text: options.review ?? '{"safe": true, "what": "打印", "risk": "无", "advice": "执行"}' } : answer(call, mainIndex++, h);
      /** 工具调用。 */
      const toolCalls: piAi.ToolCall[] = (reply.calls ?? []).map((item) => ({ type: 'toolCall', id: `c${++callId}`, name: item.name, arguments: item.args as piAi.JsonObject }));
      const message: piAi.AssistantMessage = {
        role: 'assistant',
        content: [...(reply.text ? [{ type: 'text' as const, text: reply.text }] : []), ...toolCalls],
        api: 'openai-completions',
        provider: 'magpie',
        model: 'test',
        usage: { input: reply.tokens ?? 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: toolCalls.length > 0 ? 'toolUse' : 'stop',
        timestamp: Date.now(),
      };
      return Promise.resolve({ message, text: reply.text ?? '', thinking: '', toolCalls, ms: 1, request: { model: input.model, thinkingAsked: options.thinking ?? 'off', thinking: options.thinking ?? 'off', system: '', tools: [], messages: [] } });
    },
    decide: () => Promise.reject(new Error('测试里没配决策模型')),
    hasDecision: () => false,
    listModels: () => [{ id: 'magpie/test', name: 'test', kind: 'chat', contextWindow: 100_000, thinking: ['off', 'low'], vision: false, price: { input: 0, output: 0 } }],
  });
  const out: depsModule.Outlet = {
    send: (channel, _address, text) => {
      h.sent.push({ channel, text });
      return Promise.resolve();
    },
    sendApproval: (_channel, _address, pending) => {
      h.cards.push(pending);
      return Promise.resolve(['http']);
    },
    publishDoc: () => Promise.reject(new Error('没开飞书')),
    deleteDoc: () => Promise.reject(new Error('没开飞书')),
  };
  h.deps = { resources, store, files, ai, secrets: new secretsModule.Secrets([]), approvals: new approvalsModule.Approvals(), out };
  return h;
}


/**
 * 新开一个会话，排一条消息给它。
 * @param h 依赖。
 * @param text 原话。
 * @param title 标题。
 */
function newSession(h: Harness, text: string, title = '测试'): { session: storeModule.SessionRow; message: storeModule.MessageRow } {
  const message = add(h, text);
  const session = h.store.createSession({ bot: '周小灵', workspace: '日常', title, model: 'magpie/test', thinking: null });
  h.store.queueMessages([message.id], session.id, null);
  return { session, message };
}


/**
 * 记一条收件。
 * @param h 依赖。
 * @param text 原话。
 */
function add(h: Harness, text: string): storeModule.MessageRow {
  return h.store.addMessage({ bot: '周小灵', channel: 'http', source: '测试', address: {}, file: path.join(h.deps.files.paths('周小灵').messageDir, `http_${Date.now()}_${Math.random()}.md`), text });
}


/**
 * 等到条件成立（最多 5 秒）；afterDecision 是 void 异步，只能轮询。
 * @param condition 条件。
 */
async function until(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 250 && !condition(); index += 1) {
    await Bun.sleep(20);
  }
}


/**
 * 造一个被重启切断的会话：一条用户消息，一条助手回复，那次运行记成出错。
 * @param h 依赖。
 * @param content 助手回复的内容：工具调用，或者只有文字。
 */
function cutSession(h: Harness, content: piAi.AssistantMessage['content']): { session: storeModule.SessionRow; message: storeModule.MessageRow } {
  const message = add(h, '跑个命令');
  const session = h.store.createSession({ bot: '周小灵', workspace: '日常', title: '被切断的', model: 'magpie/test', thinking: null });
  const cut: piAi.AssistantMessage = {
    role: 'assistant',
    content,
    api: 'openai-completions',
    provider: 'magpie',
    model: 'test',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  };
  h.store.updateSession(session.id, { replyTo: message.id, messages: [{ message: { role: 'user', content: '跑个命令', timestamp: Date.now() }, run: 1, messageIds: [message.id] }, { message: cut, run: 1 }], runs: [{ n: 1, startedAt: Date.now(), endedAt: Date.now(), ending: 'error', steps: 1 }] });
  return { session, message };
}


bunTest.describe('会话循环', () => {
  bunTest.test('调了 reply 就不重复发；第一条输入带“这个会话”和记忆概要；结束后空闲、文件写好', async () => {
    const h = await harness((_call, index) => (index === 0 ? { calls: [{ name: 'reply', args: { text: '你好' } }] } : { text: '好了' }));
    const { session } = newSession(h, '打个招呼');
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(h.sent.map((item) => item.text)).toEqual(['你好']);
    const first = textOf(h.calls[0]!.messages[0]!);
    bunTest.expect(first).toContain('# 这个会话');
    bunTest.expect(first).toContain('# 记忆概要');
    bunTest.expect(first).toMatch(/\[HTTP · \d{4}-\d\d-\d\d \d\d:\d\d:\d\d · 消息 #\d+\]\n打个招呼/);
    bunTest.expect(h.calls[0]!.system.prompt).toContain('jmbots');
    const after = h.store.getSession(session.id)!;
    bunTest.expect(after.status).toBe('idle');
    bunTest.expect(after.runs[0]!.ending).toBe('done');
    bunTest.expect(after.runs[0]!.steps).toBe(2);
    const files = h.deps.files.sessionFiles(after);
    bunTest.expect([files.md, files.json, files.compact].every((file) => fs.existsSync(file))).toBe(true);
  });

  bunTest.test('一次运行后，存下的助手消息带 effort（假模型 request.thinking 的值）', async () => {
    /** 假模型这一步 request.thinking 的值。 */
    const thinking = 'high';
    const h = await harness(() => ({ text: '好了' }), { thinking });
    const { session } = newSession(h, '想一下');
    await builders.runnerOf(h.deps).runSession(session.id);
    /** 这次运行存下的助手消息。 */
    const assistants = h.store.getSession(session.id)!.messages.filter((item) => item.message.role === 'assistant');
    bunTest.expect(assistants.length).toBeGreaterThan(0);
    bunTest.expect(assistants.every((item) => item.effort === thinking)).toBe(true);
  });

  bunTest.test('没 reply 过：把最后的回答当回复发出去', async () => {
    const h = await harness(() => ({ text: '答案是 42' }));
    const { session } = newSession(h, '问个问题');
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(h.sent.map((item) => item.text)).toEqual(['答案是 42']);
  });

  bunTest.test('工具执行前被打断：不执行，写“未执行”；插话进下一步', async () => {
    /** 插话的那条。 */
    let later: storeModule.MessageRow | undefined;
    const h = await harness((call, index, self) => {
      if (index === 0) {
        //M 模型正在想的时候，用户改了主意：分派打断这个会话，并把新话排给它。
        const sessionId = self.store.listSessions('周小灵')[0]!.id;
        later = add(self, '先别写了');
        self.store.updateSession(sessionId, { interrupt: later.id });
        self.store.queueMessages([later.id], sessionId, null);
        return { calls: [{ name: 'write', args: { path: 'a.txt', content: 'x' } }] };
      }
      const texts = call.messages.map(textOf);
      bunTest.expect(texts.some((text) => text.startsWith('未执行：用户在你执行前打断了'))).toBe(true);
      bunTest.expect(texts.at(-1)).toContain('先别写了');
      return { text: '好，停了' };
    });
    const { session } = newSession(h, '写个文件');
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(fs.existsSync(path.join(h.workDir, 'a.txt'))).toBe(false);
    bunTest.expect(h.sent.map((item) => item.text)).toEqual(['好，停了']);
    bunTest.expect(h.store.getMessage(later!.id)?.status).toBe('taken');
    bunTest.expect(h.store.getSession(session.id)?.replyTo).toBe(later!.id);
  });

  bunTest.test('到上限：回一句“走了 N 步还没做完”，结局是到上限', async () => {
    const h = await harness(() => ({ calls: [{ name: 'find', args: { name: '*.none' } }] }), { maxRounds: 2 });
    const { session } = newSession(h, '一直找');
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(h.calls).toHaveLength(2);
    bunTest.expect(h.sent.map((item) => item.text)).toEqual(['走了 2 步还没做完，先停在这里；回“继续”接着做。']);
    bunTest.expect(h.store.getSession(session.id)?.runs[0]!.ending).toBe('limit');
  });

  bunTest.test('重启切断的工具：先补“结果未知”再调模型，最后的回答照样发出去', async () => {
    const h = await harness((call) => {
      bunTest.expect(textOf(call.messages.at(-1)!)).toStartWith('结果未知');
      return { text: '我查一下' };
    });
    const { session } = cutSession(h, [{ type: 'toolCall', id: 'old', name: 'exec', arguments: { command: 'echo 1' } }]);
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(h.calls).toHaveLength(1);
    bunTest.expect(h.sent.map((item) => item.text)).toEqual(['我查一下']);
    bunTest.expect(h.store.getSession(session.id)?.runs).toHaveLength(2);
  });

  bunTest.test('重启前已经回复过这条消息：接着跑完不重复发', async () => {
    const h = await harness(() => ({ text: '好了' }));
    const { session, message } = cutSession(h, [{ type: 'toolCall', id: 'old', name: 'exec', arguments: { command: 'echo 1' } }]);
    h.store.addReply(message.id, { at: Date.now(), session: { id: session.id, title: session.title, file: 'x.md' }, text: '先回一句' });
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(h.calls).toHaveLength(1);
    bunTest.expect(h.sent).toEqual([]);
  });

  bunTest.test('重启时模型已经答完、还没发出去：直接发，不再调模型', async () => {
    const h = await harness(() => ({ text: '不该调到这里' }));
    const { session } = cutSession(h, [{ type: 'text', text: '答案是 42' }]);
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(h.calls).toHaveLength(0);
    bunTest.expect(h.sent.map((item) => item.text)).toEqual(['答案是 42']);
  });

  bunTest.test('打断落在最后一个工具执行时：新话进了对话就不再拦，模型接下来调的工具照常执行、回答照常发出', async () => {
    /** 排给它的新话。 */
    let later: storeModule.MessageRow | undefined;
    const h = await harness((call, index) => {
      if (index === 0) {
        return { calls: [{ name: 'reply', args: { text: '开始了' } }] };
      }
      if (index === 1) {
        bunTest.expect(textOf(call.messages.at(-1)!)).toContain('停一下');
        return { calls: [{ name: 'write', args: { path: 'b.txt', content: 'y' } }] };
      }
      return { text: '停了，只写了 b.txt' };
    });
    const original = h.deps.out;
    h.deps.out = {
      ...original,
      send: async (channel, address, text) => {
        //M reply 这个工具执行到一半时，分派打断这个会话，并把新话排给它。
        if (!later) {
          const sessionId = h.store.listSessions('周小灵')[0]!.id;
          later = add(h, '停一下');
          h.store.updateSession(sessionId, { interrupt: later.id });
          h.store.queueMessages([later.id], sessionId, null);
        }
        await original.send(channel, address, text);
      },
    };
    const { session } = newSession(h, '干活');
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(fs.existsSync(path.join(h.workDir, 'b.txt'))).toBe(true);
    bunTest.expect(h.sent.map((item) => item.text)).toEqual(['开始了', '停了，只写了 b.txt']);
    const after = h.store.getSession(session.id)!;
    bunTest.expect(after.interrupt).toBeNull();
    bunTest.expect(after.runs[0]!.ending).toBe('done');
  });

  bunTest.test('上次运行收尾时才写上的打断，不带进下一次运行', async () => {
    const h = await harness((_call, index) => {
      if (index === 0) {
        return { text: '第一次回答' };
      }
      return index === 1 ? { calls: [{ name: 'write', args: { path: 'c.txt', content: 'z' } }] } : { text: '写好了' };
    });
    const original = h.deps.out;
    h.deps.out = {
      ...original,
      send: async (channel, address, text) => {
        //M 兜底回复发送时，分派正好要打断它（新话去了别的会话）。
        if (text === '第一次回答') {
          h.store.updateSession(h.store.listSessions('周小灵')[0]!.id, { interrupt: 999 });
        }
        await original.send(channel, address, text);
      },
    };
    const { session } = newSession(h, '第一件');
    await builders.runnerOf(h.deps).runSession(session.id);
    const second = add(h, '第二件');
    h.store.queueMessages([second.id], session.id, null);
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(fs.existsSync(path.join(h.workDir, 'c.txt'))).toBe(true);
    bunTest.expect(h.sent.map((item) => item.text)).toEqual(['第一次回答', '写好了']);
    bunTest.expect(h.store.getSession(session.id)?.runs[1]!.ending).toBe('done');
  });

  bunTest.test('“这次不压”之后再涨也不越过上限的 90%：到了就直接压', async () => {
    const h = await harness((call, index) => {
      //M 上限 100K：第一步到 85K（过了 80% 的阈值，提醒一句），第二步到 91K（过了 90%，直接压）。
      if (index === 0) {
        return { tokens: 85_000, calls: [{ name: 'find', args: { name: '*.none' } }] };
      }
      if (index === 1) {
        bunTest.expect(textOf(call.messages.at(-1)!)).toContain('上下文已经');
        return { tokens: 91_000, calls: [{ name: 'find', args: { name: '*.none' } }] };
      }
      return textOf(call.messages.at(-1)!).includes('请把以上对话压缩成一段摘要') ? { text: '摘要正文' } : { text: '做完了' };
    });
    const { session } = newSession(h, '干活');
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(h.calls.some((call) => textOf(call.messages.at(-1)!).includes('请把以上对话压缩成一段摘要'))).toBe(true);
    bunTest.expect(textOf(h.calls.at(-1)!.messages[0]!)).toContain('摘要正文');
  });

  bunTest.test('同一步里 summary 压缩后面还有工具：摘要后面不留找不到调用的工具结果', async () => {
    const h = await harness((_call, index) => (index === 0 ? { calls: [{ name: 'summary', args: { text: '前面的摘要', compress: true } }, { name: 'find', args: { name: '*.none' } }] } : { text: '好了' }));
    const { session } = newSession(h, '干活');
    await builders.runnerOf(h.deps).runSession(session.id);
    const messages = h.calls[1]!.messages;
    bunTest.expect(textOf(messages[0]!)).toContain('前面的摘要');
    bunTest.expect(messages.some((message) => message.role === 'toolResult')).toBe(false);
  });

  bunTest.test('压缩时刚进来的话不压进摘要：接在摘要后面，还是原话', async () => {
    const h = await harness((call, index) => {
      if (index === 0) {
        return { text: '第一件做完了', tokens: 95_000 };
      }
      if (textOf(call.messages.at(-1)!).includes('请把以上对话压缩成一段摘要')) {
        bunTest.expect(call.messages.map(textOf).join('\n')).not.toContain('第二件的原话');
        return { text: '摘要正文' };
      }
      return { text: '第二件做完了' };
    });
    const { session } = newSession(h, '第一件');
    await builders.runnerOf(h.deps).runSession(session.id);
    const second = add(h, '第二件的原话');
    h.store.queueMessages([second.id], session.id, null);
    await builders.runnerOf(h.deps).runSession(session.id);
    const messages = h.calls.at(-1)!.messages;
    bunTest.expect(textOf(messages[0]!)).toContain('摘要正文');
    bunTest.expect(textOf(messages.at(-1)!)).toContain('第二件的原话');
    bunTest.expect(h.sent.map((item) => item.text)).toEqual(['第一件做完了', '第二件做完了']);
  });

  bunTest.test('自动感应：同一工作区新开了会话，在第一条输入后面插一句，只说一次', async () => {
    const h = await harness((call, index) => {
      const texts = call.messages.map(textOf).join('\n');
      if (index === 0) {
        bunTest.expect(texts).toContain('（系统）自动感应');
        bunTest.expect(texts).toContain('新开了会话「另一件事」');
        return { calls: [{ name: 'find', args: { name: '*.none' } }] };
      }
      bunTest.expect(texts.split('（系统）自动感应').length).toBe(2);
      return { text: '知道了' };
    });
    const { session } = newSession(h, '干活');
    await Bun.sleep(5);
    h.store.createSession({ bot: '周小灵', workspace: '日常', title: '另一件事', model: 'magpie/test', thinking: null });
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(h.calls).toHaveLength(2);
  });
});


bunTest.describe('exec 审核', () => {
  bunTest.test('非法 exec 参数在审核前返回错误，不创建卡片或执行命令', async () => {
    /** 两种非法输入分别覆盖命令和超时入口。 */
    const invalidInputs = [
      { command: '   ' },
      { command: 'echo bad > invalid-exec.txt', timeout: 0 },
    ];
    for (const args of invalidInputs) {
      const h = await harness((_call, index) => {
        if (index === 0) {
          const call = {
            name: 'exec',
            args,
          };
          return { calls: [call] };
        }
        return { text: '参数有误' };
      });
      const { session } = newSession(h, '执行非法参数');
      const runner = builders.runnerOf(h.deps);
      await runner.runSession(session.id);

      const current = h.store.getSession(session.id)!;
      const result = current.messages.find((stored) => {
        return stored.message.role === 'toolResult';
      })!.message as piAi.ToolResultMessage;
      const outputPath = path.join(h.workDir, 'invalid-exec.txt');
      bunTest.expect(result.isError).toBe(true);
      bunTest.expect(h.cards).toHaveLength(0);
      bunTest.expect(h.deps.approvals.list()).toHaveLength(0);
      bunTest.expect(fs.existsSync(outputPath)).toBe(false);
    }
  });

  bunTest.test('碰密钥文件：程序的规矩直接拒绝，不执行', async () => {
    const h = await harness((call, index) => {
      if (index === 0) {
        return { calls: [{ name: 'exec', args: { command: 'type config.yaml' } }] };
      }
      bunTest.expect(textOf(call.messages.at(-1)!)).toStartWith('未执行：不准执行：命令碰了密钥文件 config.yaml');
      return { text: '不能读配置' };
    });
    const { session } = newSession(h, '读配置');
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(h.calls).toHaveLength(2);
  });

  bunTest.test('没配决策模型：小循环说安全就执行', async () => {
    const h = await harness((call, index) => {
      if (index === 0) {
        return { calls: [{ name: 'exec', args: { command: 'echo hi' } }] };
      }
      bunTest.expect(textOf(call.messages.at(-1)!)).toContain('退出码 0');
      return { text: '跑完了' };
    });
    const { session } = newSession(h, '跑 echo');
    await builders.runnerOf(h.deps).runSession(session.id);
    const result = h.store.getSession(session.id)!.messages.find((stored) => stored.message.role === 'toolResult')!.message as piAi.ToolResultMessage;
    bunTest.expect((result.details as { by: string }).by).toBe('llm');
  });

  bunTest.test('小循环说有风险：runSession 不等确认，会话空闲；用户同意后执行，结果排给会话再跑一次', async () => {
    const h = await harness(
      (_call, index) => {
        if (index === 0) {
          return { calls: [{ name: 'exec', args: { command: 'echo approved > approved.txt' } }] };
        }
        return { text: index === 1 ? '等用户确认' : '执行完了' };
      },
      { review: '{"safe": false, "what": "打印一句话", "risk": "无", "advice": "同意"}' },
    );
    const { session } = newSession(h, '跑 echo');
    //M 待确认挂着的时候这次运行就要结束，不能等用户。
    await builders.runnerOf(h.deps).runSession(session.id);
    const waiting = h.store.getSession(session.id)!;
    bunTest.expect(waiting.status).toBe('idle');
    bunTest.expect(waiting.runs).toHaveLength(1);
    bunTest.expect(waiting.runs[0]!.ending).toBe('done');
    bunTest.expect(h.deps.approvals.list()).toHaveLength(1);
    bunTest.expect(h.cards).toHaveLength(1);
    bunTest.expect(h.cards[0]!.review.what).toBe('打印一句话');
    bunTest.expect(fs.existsSync(path.join(h.workDir, 'approved.txt'))).toBe(false);
    /** 待确认的号。 */
    const id = h.deps.approvals.list()[0]!.id;
    /** 那次 exec 的工具结果。 */
    const result = waiting.messages.find((stored) => stored.message.role === 'toolResult' && stored.message.toolName === 'exec')!.message as piAi.ToolResultMessage;
    bunTest.expect(textOf(result)).toStartWith(`已提交审核，还没执行（待确认 #${id}）`);
    //M 同意：afterDecision 是 void 异步，轮询等它把结果排给会话并再跑一次。
    h.deps.approvals.decide(id, true, '测试');
    await until(() => {
      const current = h.store.getSession(session.id)!;
      const note = h.store.listMessages('周小灵').find((row) => row.text.startsWith(`（系统）待确认 #${id}：`));
      return current.status === 'idle' && current.runs.length >= 2 && note !== undefined && note.replies.length > 0;
    });
    const after = h.store.getSession(session.id)!;
    bunTest.expect(after.status).toBe('idle');
    bunTest.expect(after.runs).toHaveLength(2);
    bunTest.expect(after.runs[1]!.ending).toBe('done');
    bunTest.expect(fs.existsSync(path.join(h.workDir, 'approved.txt'))).toBe(true);
    /** 结果那条收件。 */
    const note = h.store.listMessages('周小灵').find((row) => row.text.startsWith(`（系统）待确认 #${id}：`))!;
    bunTest.expect(note.sessionId).toBe(session.id);
    bunTest.expect(note.status).toBe('taken');
    bunTest.expect(note.text).toStartWith(`（系统）待确认 #${id}：用户同意了（测试），命令已经执行。\n命令：echo approved > approved.txt\n结果：`);
    bunTest.expect(note.replies.length).toBeGreaterThan(0);
    bunTest.expect(h.sent.some((item) => item.text === '执行完了')).toBe(true);
  });

  bunTest.test('用户拒绝：命令不执行，结果“命令没有执行”排给会话再跑一次', async () => {
    const h = await harness(
      (_call, index) => {
        if (index === 0) {
          return { calls: [{ name: 'exec', args: { command: 'echo refused > refused.txt' } }] };
        }
        return { text: index === 1 ? '等用户确认' : '知道了' };
      },
      { review: '{"safe": false, "what": "写文件", "risk": "会创建文件", "advice": "拒绝"}' },
    );
    const { session } = newSession(h, '写 refused');
    await builders.runnerOf(h.deps).runSession(session.id);
    const waiting = h.store.getSession(session.id)!;
    bunTest.expect(waiting.status).toBe('idle');
    bunTest.expect(waiting.runs[0]!.ending).toBe('done');
    bunTest.expect(h.deps.approvals.list()).toHaveLength(1);
    bunTest.expect(fs.existsSync(path.join(h.workDir, 'refused.txt'))).toBe(false);
    /** 待确认的号。 */
    const id = h.deps.approvals.list()[0]!.id;
    //M 拒绝：afterDecision 是 void 异步，轮询等它把“没有执行”排给会话并再跑一次。
    h.deps.approvals.decide(id, false, '飞书卡片');
    await until(() => {
      const current = h.store.getSession(session.id)!;
      const note = h.store.listMessages('周小灵').find((row) => row.text.startsWith(`（系统）待确认 #${id}：`));
      return current.status === 'idle' && current.runs.length >= 2 && note !== undefined && note.replies.length > 0;
    });
    const after = h.store.getSession(session.id)!;
    bunTest.expect(after.status).toBe('idle');
    bunTest.expect(after.runs).toHaveLength(2);
    bunTest.expect(after.runs[1]!.ending).toBe('done');
    bunTest.expect(fs.existsSync(path.join(h.workDir, 'refused.txt'))).toBe(false);
    /** 结果那条收件。 */
    const note = h.store.listMessages('周小灵').find((row) => row.text.startsWith(`（系统）待确认 #${id}：`))!;
    bunTest.expect(note.sessionId).toBe(session.id);
    bunTest.expect(note.status).toBe('taken');
    bunTest.expect(note.text).toBe(`（系统）待确认 #${id}：用户拒绝了（飞书卡片），命令没有执行。\n命令：echo refused > refused.txt`);
    bunTest.expect(note.replies.length).toBeGreaterThan(0);
    bunTest.expect(h.sent.some((item) => item.text === '知道了')).toBe(true);
  });
});


/**
 * 一条消息里的图片块（content 是字符串时没有图片块）。
 * @param message 消息。
 */
function imageBlocks(message: piAi.Message): piAi.ImageContent[] {
  if (typeof message.content === 'string') {
    return [];
  }
  return message.content.filter((block): block is piAi.ImageContent => block.type === 'image');
}


/**
 * 准备一个能看图、工具结果带一张真图的会话：模型清单标成 vision、临时目录写一张 .png、预置用户/助手/工具结果三段对话。
 * 不排队任何消息，感应点挪到未来，消息顺序完全由预置决定，不受 runSession 收插话和自动感应干扰。
 * @param h 依赖（只改它的 ai.listModels 和库里的会话）。
 * @param tailUser 工具结果后面接的用户原话；不写就是后面没有用户消息。
 * @returns 会话、图片应转成的 base64。
 */
function presetImageCase(h: Harness, tailUser?: string): { session: storeModule.SessionRow; imageData: string } {
  //M 让这次的模型能看图：覆盖清单，上下文给足，buildRequest 不会裁剪消息。
  /** 原来的假模型库。 */
  const old = h.deps.ai;
  h.deps.ai = builders.fakeAi({
    chat: (input) => old.chat(input),
    decide: (input) => old.decide(input),
    hasDecision: () => old.hasDecision(),
    listModels: (): model.ModelSummary[] => [{ id: 'magpie/test', name: 'test', kind: 'chat', contextWindow: 1_000_000, thinking: ['off', 'low'], vision: true, price: { input: 0, output: 0 } }],
  });
  /** 临时目录里的一张真图（按用户要求不删）。 */
  const imgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-img-'));
  const bytes = Buffer.from('fake-png');
  const imgPath = path.join(imgDir, 'shot.png');
  fs.writeFileSync(imgPath, bytes);
  const message = add(h, '先读个图');
  const session = h.store.createSession({ bot: '周小灵', workspace: '日常', title: '看图', model: 'magpie/test', thinking: null });
  /** 助手那条：一个 read 工具调用，和后面的工具结果对得上，repairCut 不会补“结果未知”。 */
  const assistant: piAi.AssistantMessage = {
    role: 'assistant',
    content: [{ type: 'toolCall', id: 'c1', name: 'read', arguments: {} }],
    api: 'openai-completions',
    provider: 'magpie',
    model: 'test',
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'toolUse',
    timestamp: Date.now(),
  };
  /** 工具结果：文字 + images 里那张图。 */
  const toolResult: piAi.ToolResultMessage = { role: 'toolResult', toolCallId: 'c1', toolName: 'read', content: [{ type: 'text', text: '读到了一张图' }], isError: false, timestamp: Date.now() };
  const messages: storeModule.StoredMessage[] = [
    { message: { role: 'user', content: '先读个图', timestamp: Date.now() }, run: 1, messageIds: [message.id] },
    { message: assistant, run: 1 },
    { message: toolResult, run: 1, images: [imgPath] },
  ];
  if (tailUser !== undefined) {
    messages.push({ message: { role: 'user', content: tailUser, timestamp: Date.now() }, run: 1 });
  }
  //M 感应点挪到未来：自动感应不会插话，预置的消息顺序原样进 buildRequest。
  h.store.updateSession(session.id, { messages, sensedAt: Date.now() + 60_000 });
  return { session, imageData: bytes.toString('base64') };
}


bunTest.describe('能看图的模型：工具结果的图片怎么送', () => {
  bunTest.test('工具结果后面紧跟用户消息：toolResult 不带图，图并进那条用户消息，用户原话还在', async () => {
    const h = await harness(() => ({ text: '看到了' }));
    const { session, imageData } = presetImageCase(h, '这张图里是什么？');
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(h.calls.length).toBeGreaterThan(0);
    /** 发给假模型的那次请求。 */
    const request = h.calls[0]!;
    /** 那条工具结果。 */
    const tool = request.messages.find((item) => item.role === 'toolResult')!;
    bunTest.expect(imageBlocks(tool)).toHaveLength(0);
    bunTest.expect(textOf(tool)).toContain('读到了一张图');
    /** 并进了图的那条用户消息。 */
    const user = request.messages.find((item) => item.role === 'user' && imageBlocks(item).length > 0)!;
    const images = imageBlocks(user);
    bunTest.expect(images).toHaveLength(1);
    bunTest.expect(images[0]!.data).toBe(imageData);
    bunTest.expect(images[0]!.mimeType).toBe('image/png');
    bunTest.expect(textOf(user)).toContain('这张图里是什么？');
  });

  bunTest.test('工具结果后面没有用户消息：图留在 toolResult 的 content 里', async () => {
    const h = await harness(() => ({ text: '看到了' }));
    const { session, imageData } = presetImageCase(h);
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(h.calls.length).toBeGreaterThan(0);
    /** 发给假模型的那次请求。 */
    const request = h.calls[0]!;
    /** 那条工具结果。 */
    const tool = request.messages.find((item) => item.role === 'toolResult')!;
    const images = imageBlocks(tool);
    bunTest.expect(images).toHaveLength(1);
    bunTest.expect(images[0]!.data).toBe(imageData);
    bunTest.expect(images[0]!.mimeType).toBe('image/png');
    bunTest.expect(textOf(tool)).toContain('读到了一张图');
    /** 没有用户消息被塞进图。 */
    const users = request.messages.filter((item) => item.role === 'user');
    bunTest.expect(users.flatMap((item) => imageBlocks(item))).toHaveLength(0);
  });
});


bunTest.describe('一次运行结束撤“正在输入”', () => {
  bunTest.test('结束后调 deps.out.stopTyping，带那条收件的 channel 和 address', async () => {
    const h = await harness(() => ({ text: '好了' }));
    /** 记下撤“正在输入”的调用。 */
    const stopped: { channel: string; address: Record<string, unknown> }[] = [];
    h.deps.out = {
      ...h.deps.out,
      stopTyping: (channel, address) => {
        stopped.push({ channel, address });
        return Promise.resolve();
      },
    };
    const { session, message } = newSession(h, '打个招呼');
    await builders.runnerOf(h.deps).runSession(session.id);
    /** 那条收件。 */
    const row = h.store.getMessage(message.id)!;
    bunTest.expect(stopped.length).toBeGreaterThan(0);
    bunTest.expect(stopped[0]!.channel).toBe('http');
    bunTest.expect(stopped[0]!.channel).toBe(row.channel);
    bunTest.expect(stopped[0]!.address).toEqual({});
    bunTest.expect(stopped[0]!.address).toEqual(row.address);
  });
});


/**
 * 往机器人的记忆目录种一份 .md，供开会话时程序替模型搜记忆用。
 * @param h 依赖。
 * @param name 文件名（别用 索引.md/index.md，Recall 会跳过概要文件）。
 * @param content 正文。
 * @returns 这个记忆文件的绝对路径，正好是开场消息里 @ 后面该出现的路径。
 */
function seedMemory(h: Harness, name: string, content: string): string {
  //M 目录 ensureBot 已建好，再 mkdir 一次只是保险；种文件要在 runSession 之前。
  const dir = h.deps.files.paths('周小灵').memoryDir;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}


bunTest.describe('开会话时程序替模型搜记忆（0.2.5）', () => {
  bunTest.test('搜到相关记忆：第一条输入带「可能相关的记忆」、@绝对路径和命中的字，仍带「这个会话」「记忆概要」', async () => {
    const h = await harness(() => ({ text: '好了' }));
    //M 开会话前种一份能对上「给Claude留话」的记忆，让 recall 搜得到。
    const memoryFile = seedMemory(h, 'claude.md', 'claude 留话\nclaude 留话\n');
    const { session } = newSession(h, '给Claude留话');
    //M 感应点挪到未来：记忆文件是刚写的，别让自动感应把「记忆变化」插进对话。
    h.store.updateSession(session.id, { sensedAt: Date.now() + 60_000 });
    await builders.runnerOf(h.deps).runSession(session.id);
    /** 第一条输入的全文。 */
    const first = textOf(h.calls[0]!.messages[0]!);
    bunTest.expect(first).toContain('# 可能相关的记忆');
    bunTest.expect(first).toContain(`@${memoryFile}`);
    bunTest.expect(first).toMatch(/claude|留话/);
    //G 记忆段是加上去的，原来的开场不能被挤掉。
    bunTest.expect(first).toContain('# 这个会话');
    bunTest.expect(first).toContain('# 记忆概要');
  });

  bunTest.test('没搜到相关记忆（只种了无关文件）：第一条输入不带「可能相关的记忆」，开场照旧', async () => {
    const h = await harness(() => ({ text: '好了' }));
    //M 有记忆文件、但跟原话完全对不上：recall 该返回空，开场就不放记忆段。
    seedMemory(h, 'other.md', '天气不错\n随便写写\n');
    const { session } = newSession(h, '给Claude留话');
    h.store.updateSession(session.id, { sensedAt: Date.now() + 60_000 });
    await builders.runnerOf(h.deps).runSession(session.id);
    /** 第一条输入的全文。 */
    const first = textOf(h.calls[0]!.messages[0]!);
    //G 只有搜到才放：这次没搜到，不该出现记忆段。
    bunTest.expect(first).not.toContain('# 可能相关的记忆');
    bunTest.expect(first).toContain('# 这个会话');
    bunTest.expect(first).toContain('# 记忆概要');
  });

  bunTest.test('插话收进下一步时不加记忆段：「可能相关的记忆」整段只出现一次，插话那条只是原话', async () => {
    const h = await harness((_call, index, self) => {
      if (index === 0) {
        //M 模型正在想的时候用户改了主意：分派打断这个会话，并把新话排给它。
        const sessionId = self.store.listSessions('周小灵')[0]!.id;
        const later = add(self, '先别写了');
        self.store.updateSession(sessionId, { interrupt: later.id });
        self.store.queueMessages([later.id], sessionId, null);
        return { calls: [{ name: 'write', args: { path: 'a.txt', content: 'x' } }] };
      }
      return { text: '好，停了' };
    });
    //M 先种好跟第一条消息对得上的记忆，让第一条输入确实带记忆段；感应点挪到未来避免自动感应插话。
    seedMemory(h, 'claude.md', 'claude 留话\nclaude 留话\n');
    const { session } = newSession(h, '给Claude留话');
    h.store.updateSession(session.id, { sensedAt: Date.now() + 60_000 });
    await builders.runnerOf(h.deps).runSession(session.id);
    bunTest.expect(h.calls[1]).toBeDefined();
    /** 第二次调用整段对话拼起来的文字。 */
    const joined = h.calls[1]!.messages.map(textOf).join('\n');
    //M 记忆段只该在第一条输入里：first 为 false 的插话那条只是 body，不带记忆段。
    bunTest.expect(joined.split('# 可能相关的记忆').length - 1).toBe(1);
    /** 最后一条用户消息，也就是插话那条。 */
    const lastUser = h.calls[1]!.messages.filter((item) => item.role === 'user').at(-1)!;
    bunTest.expect(textOf(lastUser)).toContain('先别写了');
    bunTest.expect(textOf(lastUser)).not.toContain('# 可能相关的记忆');
    //G 打断在工具执行前生效，a.txt 没被写出来（延续「工具执行前被打断」用例）。
    bunTest.expect(fs.existsSync(path.join(h.workDir, 'a.txt'))).toBe(false);
  });

  bunTest.test('配了 memory_libs：开场消息里有记忆库 RAG 的片段', async () => {
    /** 假基地给的绝对路径。 */
    const abs = path.join(os.tmpdir(), '假基地', '飞书发件箱.md');
    /** 假基地：/rag/search 回一条和原话对得上的 RAG 命中。 */
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        /** 地址。 */
        const url = new URL(request.url);
        if (url.pathname === '/rag/search') {
          return Response.json({ hits: [{ lib: '资料', path: '飞书发件箱.md', abs_path: abs, title: '飞书发件箱', start_line: 3, end_line: 9, text: '飞书发件箱：往 outbox 放一份 md', score: 1 }], not_indexed: [] });
        }
        return Response.json({ hits: [] });
      },
    });
    try {
      /** 测试环境。 */
      const h = await harness(() => ({ text: '好了' }), { indexUrl: `http://127.0.0.1:${server.port}`, memoryLibs: '资料' });
      const { session } = newSession(h, '飞书发件箱怎么用');
      h.store.updateSession(session.id, { sensedAt: Date.now() + 60_000 });
      await builders.runnerOf(h.deps).runSession(session.id);
      /** 第一条输入的全文。 */
      const first = textOf(h.calls[0]!.messages[0]!);
      bunTest.expect(first).toContain('# 可能相关的记忆');
      bunTest.expect(first).toContain(`@${abs}`);
      bunTest.expect(first).toContain('飞书发件箱');
      bunTest.expect(first).toContain('第 3–9 行 · 飞书发件箱');
    } finally {
      await server.stop(true);
    }
  });
});


bunTest.test('事件：装了事件总线，一次运行按先后报 开始 → 每一步 → 每个工具（含回复）→ 结束（docs/11_附 第 9 节的验收，离线）', async () => {
  /** 先调 reply 发一句，再回“好了”。 */
  const h = await harness((_call, index) => (index === 0 ? { calls: [{ name: 'reply', args: { text: '你好呀' } }] } : { text: '好了' }));
  h.deps.events = new eventsModule.EventBus(h.store, h.deps.resources, h.deps.secrets);
  const { session } = newSession(h, '打个招呼');
  await builders.runnerOf(h.deps).runSession(session.id);
  /** 这个会话的事件，按先后。 */
  const rows = h.deps.events.list({ sessionId: session.id, limit: 100 });
  bunTest.expect(rows.map((row) => row.type)).toEqual([
    'run.started',
    'turn.started',
    'message.taken',
    'search.started',
    'search.done',
    'step.before',
    'context.built',
    'step.after',
    'tool.before',
    'reply.before',
    'reply.sent',
    'tool.after',
    'step.before',
    'context.built',
    'step.after',
    'run.ended',
  ]);
  bunTest.expect(rows.at(-1)!.data).toMatchObject({ ending: 'done', replied: true });
  bunTest.expect(rows.find((row) => row.type === 'reply.before')!.data.text).toBe('你好呀');
  bunTest.expect(rows.every((row) => row.bot === '周小灵')).toBe(true);
});

