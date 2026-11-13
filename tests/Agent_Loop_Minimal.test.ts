/**
 * 会话（src/agentLoop/Session.ts）和模型客户端（src/agentLoop/ModelClient.ts）的离线测试。
 * 不联网：会话用假的模型客户端和假的工具，测试里手动让它们回话、做完；模型客户端用假的 fetch。
 */
import * as bunTest from 'bun:test';
import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as clientModule from '../src/agentLoop/ModelClient.ts';
import * as sessionModule from '../src/agentLoop/Session.ts';


/** 一个还没回的请求。 */
interface WaitingRequest {
  /** 让它回话。 */
  resolve: (reply: clientModule.ModelReply) => void;
  /** 让它出错。 */
  reject: (error: Error) => void;
}

/** 假的模型客户端：不联网。收到的请求记下来，测试里手动让最早那个还没回的请求回话或出错。 */
class FakeModelClient extends clientModule.ModelClient {
  /** 收到的请求，按顺序。 */
  readonly requests: clientModule.ModelRequest[] = [];

  /** 还没回的请求，按顺序。 */
  private readonly waiting: WaitingRequest[] = [];

  constructor() {
    super({}, 1000);
  }

  /**
   * 记下请求，等测试让它回话或出错。
   * @param request 会话拼好的请求。
   */
  override complete(request: clientModule.ModelRequest): Promise<clientModule.ModelReply> {
    this.requests.push(request);
    const pending = Promise.withResolvers<clientModule.ModelReply>();
    const waitingRequest: WaitingRequest = {
      resolve: pending.resolve,
      reject: pending.reject,
    };
    this.waiting.push(waitingRequest);
    return pending.promise;
  }

  /**
   * 让最早那个还没回的请求回话。
   * @param reply 回话。
   */
  respond(reply: clientModule.ModelReply): void {
    const waitingRequest = this.waiting.shift();
    assert.ok(waitingRequest, '没有在等回话的请求');
    waitingRequest.resolve(reply);
  }

  /**
   * 让最早那个还没回的请求出错。
   * @param reason 出错的原因。
   */
  fail(reason: string): void {
    const waitingRequest = this.waiting.shift();
    assert.ok(waitingRequest, '没有在等回话的请求');
    const error = new Error(reason);
    waitingRequest.reject(error);
  }
}

/** 一个在跑的工具调用。 */
interface RunningCall {
  /** 模型给的参数。 */
  argumentsText: string;
  /** 让它做完。 */
  finish: (result: string) => void;
}

/** 假的工具：调用记下来，测试里手动让它做完。 */
class ManualTool extends sessionModule.Tool {
  /** 名字。 */
  readonly name: string;

  /** 说明。 */
  readonly description = '测试用的工具';

  /** 参数：没有。 */
  readonly parameters = {
    type: 'object',
    properties: {},
  };

  /** 在跑的调用，按开始的顺序。 */
  readonly running: RunningCall[] = [];

  /**
   * @param name 名字。
   */
  constructor(name: string) {
    super();
    this.name = name;
  }

  /**
   * 记下调用，等测试让它做完。
   * @param argumentsText 模型给的参数。
   */
  run(argumentsText: string): Promise<string> {
    const pending = Promise.withResolvers<string>();
    const runningCall: RunningCall = {
      argumentsText,
      finish: pending.resolve,
    };
    this.running.push(runningCall);
    return pending.promise;
  }
}


/** 一个测试用到的东西：会话、假的模型客户端、假的工具，和监听收到的通知。 */
interface Rig {
  /** 会话。 */
  session: sessionModule.Session;
  /** 假的模型客户端。 */
  client: FakeModelClient;
  /** 假的工具，名字是 think。 */
  tool: ManualTool;
  /** reply 监听收到的回话。 */
  replies: string[];
  /** failed 监听收到的原因。 */
  failures: string[];
  /** toolStarted 监听收到的调用。 */
  startedCalls: sessionModule.ToolCall[];
}

/** 测试用的系统提示词文件放在哪个临时目录。 */
const promptDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-loop-'));
/** 测试用的系统提示词文件（绝对路径）。 */
const promptPath = path.join(promptDir, 'system.md');
/** 测试用的系统提示词。 */
const PROMPT = '你是测试用的助手。';
fs.writeFileSync(promptPath, PROMPT);

/**
 * 测试用的模型。
 * @param modelId 模型 ID。
 */
function testModel(modelId: string): clientModule.ModelConfig {
  return {
    provider: 'test_provider',
    modelId,
    api: 'openai-completions',
    reasoning: false,
    contextWindow: null,
    maxOutputTokens: null,
    inputTypes: ['text'],
  };
}

/**
 * 建一套测试用的会话，登记三个监听，把收到的通知记下来。
 * @param withModel 建会话时给不给模型。
 */
function createRig(withModel = true): Rig {
  const client = new FakeModelClient();
  const tool = new ManualTool('think');
  const options: sessionModule.SessionOptions = {
    systemPromptPath: promptPath,
    tools: [tool],
    modelClient: client,
  };
  if (withModel) {
    options.model = testModel('first-model');
  }
  const session = new sessionModule.Session(options);
  const rig: Rig = {
    session,
    client,
    tool,
    replies: [],
    failures: [],
    startedCalls: [],
  };
  session.on('reply', (text) => {
    rig.replies.push(text);
  });
  session.on('failed', (reason) => {
    rig.failures.push(reason);
  });
  session.on('toolStarted', (call) => {
    rig.startedCalls.push(call);
  });
  return rig;
}

/**
 * 用户说一句的事件。
 * @param text 用户说的话。
 */
function userSays(text: string): sessionModule.UserMessageEvent {
  return {
    type: sessionModule.SessionEventType.UserMessage,
    text,
  };
}

/**
 * 换模型的事件。
 * @param modelId 换成哪个模型。
 */
function changeModel(modelId: string): sessionModule.ChangeModelEvent {
  return {
    type: sessionModule.SessionEventType.ChangeModel,
    model: testModel(modelId),
  };
}

/**
 * 模型的回话：不调工具。
 * @param text 回的话。
 */
function textReply(text: string): clientModule.ModelReply {
  return {
    text,
    toolCalls: [],
    thinking: '',
  };
}

/**
 * 模型的回话：调工具。
 * @param calls 要调的工具。
 */
function toolReply(...calls: sessionModule.ToolCall[]): clientModule.ModelReply {
  return {
    text: '',
    toolCalls: calls,
    thinking: '',
  };
}

/**
 * 一次工具调用。
 * @param id 调用 ID。
 * @param name 调哪个工具。
 */
function toolCall(id: string, name = 'think'): sessionModule.ToolCall {
  return {
    id,
    name,
    argumentsText: '{"about":"测试"}',
  };
}

/**
 * 第几次请求模型（从 0 数）。
 * @param rig 测试用的会话。
 * @param index 第几次。
 */
function requestAt(rig: Rig, index: number): clientModule.ModelRequest {
  const request = rig.client.requests[index];
  assert.ok(request, `没有第 ${index + 1} 次请求`);
  return request;
}

/**
 * 让第几个在跑的工具做完（从 0 数）。
 * @param rig 测试用的会话。
 * @param index 第几个。
 * @param result 工具的结果。
 */
function finishTool(rig: Rig, index: number, result: string): void {
  const runningCall = rig.tool.running[index];
  assert.ok(runningCall, `没有第 ${index + 1} 个在跑的工具`);
  runningCall.finish(result);
}

/**
 * 消息的角色，按顺序。
 * @param messages 消息。
 */
function roles(messages: sessionModule.Message[]): string[] {
  return messages.map((message) => message.role);
}

/** 等异步的结果（模型回话、工具做完）变成事件进 handle()。 */
async function settle(): Promise<void> {
  await Bun.sleep(0);
}


bunTest.beforeEach(() => {
  //M 会话打印的每一行不真的打印，测试输出干净。
  bunTest.spyOn(console, 'log').mockImplementation(() => {});
});
bunTest.afterEach(() => {
  bunTest.mock.restore();
});
bunTest.afterAll(() => {
  fs.rmSync(promptDir, {
    recursive: true,
    force: true,
  });
});


bunTest.test('建会话：自己生成 20 位 ID，状态 idle，读进系统提示词，不请求模型', () => {
  const rig = createRig();

  assert.match(rig.session.id, /^\d{20}$/);
  assert.equal(rig.session.state, sessionModule.SessionState.Idle);
  assert.equal(rig.session.systemPrompt, PROMPT);
  assert.equal(rig.client.requests.length, 0);
});

bunTest.test('第 1 行：空闲时用户说话，马上请求模型，请求里有系统提示词、消息和工具', () => {
  const rig = createRig();
  rig.session.handle(userSays('你好'));

  assert.equal(rig.session.state, sessionModule.SessionState.WaitResponse);
  const request = requestAt(rig, 0);
  assert.equal(request.model.modelId, 'first-model');
  assert.equal(request.systemPrompt, PROMPT);
  assert.deepEqual(request.messages, [
    {
      role: 'user',
      text: '你好',
    },
  ]);
  assert.deepEqual(
    request.tools.map((tool) => tool.name),
    ['think'],
  );
});

bunTest.test('第 2、11 行：建会话时没给模型，用户说话先告诉用户设模型；换模型事件设上以后就能请求', () => {
  const rig = createRig(false);
  rig.session.handle(userSays('你好'));

  assert.equal(rig.session.state, sessionModule.SessionState.Idle);
  assert.equal(rig.session.messages.length, 0);
  assert.equal(rig.client.requests.length, 0);
  assert.match(rig.failures[0] ?? '', /还没设模型/);

  rig.session.handle(changeModel('first-model'));
  assert.equal(rig.session.state, sessionModule.SessionState.Idle);
  assert.equal(rig.client.requests.length, 0);

  rig.session.handle(userSays('你好'));
  assert.equal(rig.session.state, sessionModule.SessionState.WaitResponse);
  assert.equal(requestAt(rig, 0).model.modelId, 'first-model');
});

bunTest.test('第 5 行：模型不调工具，回话交给用户，回到空闲', async () => {
  const rig = createRig();
  rig.session.handle(userSays('你好'));
  rig.client.respond(textReply('你好呀'));
  await settle();

  assert.equal(rig.session.state, sessionModule.SessionState.Idle);
  assert.deepEqual(rig.replies, ['你好呀']);
  assert.deepEqual(roles(rig.session.messages), ['user', 'assistant']);
});

bunTest.test('第 4、10 行：模型要调工具，执行工具，工具结果交给模型，直到不再调工具', async () => {
  const rig = createRig();
  rig.session.handle(userSays('想一想'));
  rig.client.respond(toolReply(toolCall('call_1')));
  await settle();

  assert.equal(rig.session.state, sessionModule.SessionState.RunTools);
  assert.equal(rig.tool.running.length, 1);
  assert.deepEqual(
    rig.startedCalls.map((call) => call.id),
    ['call_1'],
  );

  finishTool(rig, 0, '想好了');
  await settle();
  assert.equal(rig.session.state, sessionModule.SessionState.WaitResponse);
  const second = requestAt(rig, 1);
  assert.deepEqual(roles(second.messages), ['user', 'assistant', 'tool']);
  assert.deepEqual(second.messages[2], {
    role: 'tool',
    callId: 'call_1',
    toolName: 'think',
    text: '想好了',
  });

  rig.client.respond(textReply('答案'));
  await settle();
  assert.equal(rig.session.state, sessionModule.SessionState.Idle);
  assert.deepEqual(rig.replies, ['答案']);
});

bunTest.test('第 3、10 行：模型在跑时插话先排队；模型要调工具时，工具结果和插话一起交给模型', async () => {
  const rig = createRig();
  rig.session.handle(userSays('第一句'));
  rig.session.handle(userSays('模型在跑时插话'));

  assert.equal(rig.session.state, sessionModule.SessionState.WaitResponse);
  assert.equal(rig.session.queue.length, 1);
  assert.equal(rig.client.requests.length, 1);

  rig.client.respond(toolReply(toolCall('call_1')));
  await settle();
  assert.equal(rig.session.state, sessionModule.SessionState.RunTools);
  assert.equal(rig.session.queue.length, 1);

  finishTool(rig, 0, '想好了');
  await settle();
  const second = requestAt(rig, 1);
  assert.deepEqual(roles(second.messages), ['user', 'assistant', 'tool', 'user']);
  assert.deepEqual(second.messages[3], {
    role: 'user',
    text: '模型在跑时插话',
  });
  assert.equal(rig.session.queue.length, 0);
});

bunTest.test('第 3、10 行：工具在跑时插话先排队，工具做完后排在工具结果后面交给模型', async () => {
  const rig = createRig();
  rig.session.handle(userSays('第一句'));
  rig.client.respond(toolReply(toolCall('call_1')));
  await settle();
  rig.session.handle(userSays('工具在跑时插话'));

  assert.equal(rig.session.state, sessionModule.SessionState.RunTools);
  assert.equal(rig.session.queue.length, 1);
  assert.equal(rig.client.requests.length, 1);

  finishTool(rig, 0, '想好了');
  await settle();
  assert.equal(rig.session.state, sessionModule.SessionState.WaitResponse);
  assert.deepEqual(roles(requestAt(rig, 1).messages), ['user', 'assistant', 'tool', 'user']);
});

bunTest.test('第 6 行：模型不调工具、有排队的插话（接话）：先回复用户，再拿插话请求模型', async () => {
  const rig = createRig();
  rig.session.handle(userSays('第一句'));
  rig.session.handle(userSays('插话'));
  rig.client.respond(textReply('第一句的回答'));
  await settle();

  assert.deepEqual(rig.replies, ['第一句的回答']);
  assert.equal(rig.session.state, sessionModule.SessionState.WaitResponse);
  assert.equal(rig.session.queue.length, 0);
  assert.deepEqual(roles(requestAt(rig, 1).messages), ['user', 'assistant', 'user']);

  rig.client.respond(textReply('插话的回答'));
  await settle();
  assert.equal(rig.session.state, sessionModule.SessionState.Idle);
  assert.deepEqual(rig.replies, ['第一句的回答', '插话的回答']);
});

bunTest.test('第 9、10 行：一次要调两个工具，两个都做完才请求模型', async () => {
  const rig = createRig();
  rig.session.handle(userSays('想两件事'));
  rig.client.respond(toolReply(toolCall('call_1'), toolCall('call_2')));
  await settle();
  assert.equal(rig.tool.running.length, 2);

  finishTool(rig, 1, '第二件想好了');
  await settle();
  assert.equal(rig.session.state, sessionModule.SessionState.RunTools);
  assert.equal(rig.client.requests.length, 1);

  finishTool(rig, 0, '第一件想好了');
  await settle();
  assert.equal(rig.session.state, sessionModule.SessionState.WaitResponse);
  assert.deepEqual(roles(requestAt(rig, 1).messages), ['user', 'assistant', 'tool', 'tool']);
});

bunTest.test('第 7、8 行：模型出错时告诉用户、不卡住；有排队的插话就接着请求', async () => {
  const rig = createRig();
  rig.session.handle(userSays('第一句'));
  rig.client.fail('连不上');
  await settle();

  assert.equal(rig.session.state, sessionModule.SessionState.Idle);
  assert.match(rig.failures[0] ?? '', /连不上/);

  rig.session.handle(userSays('第二句'));
  rig.session.handle(userSays('插话'));
  rig.client.fail('又连不上');
  await settle();
  assert.equal(rig.session.state, sessionModule.SessionState.WaitResponse);
  assert.equal(rig.failures.length, 2);
  assert.deepEqual(roles(requestAt(rig, 2).messages), ['user', 'user', 'user']);
});

bunTest.test('模型要了一个没有的工具：出错原因当结果交回给模型', async () => {
  const rig = createRig();
  rig.session.handle(userSays('第一句'));
  rig.client.respond(toolReply(toolCall('call_1', 'nope')));
  await settle();

  assert.equal(rig.session.state, sessionModule.SessionState.WaitResponse);
  const toolMessage = requestAt(rig, 1).messages[2];
  assert.ok(toolMessage?.role === 'tool');
  assert.match(toolMessage.text, /没有叫 nope 的工具/);
});

bunTest.test('第 11 行：换模型是一个事件，任何状态都不改状态、不触发，下一次请求用新模型', async () => {
  const rig = createRig();
  rig.session.handle(userSays('第一句'));
  rig.session.handle(changeModel('second-model'));
  assert.equal(rig.session.state, sessionModule.SessionState.WaitResponse);
  assert.equal(rig.client.requests.length, 1);

  rig.client.respond(toolReply(toolCall('call_1')));
  await settle();
  rig.session.handle(changeModel('third-model'));
  assert.equal(rig.session.state, sessionModule.SessionState.RunTools);

  finishTool(rig, 0, '想好了');
  await settle();
  assert.equal(requestAt(rig, 0).model.modelId, 'first-model');
  assert.equal(requestAt(rig, 1).model.modelId, 'third-model');
});

bunTest.test('表里没有的组合直接报错，状态和对话都不变', async () => {
  const rig = createRig();
  const strayReply: sessionModule.ModelRespondedEvent = {
    type: sessionModule.SessionEventType.ModelResponded,
    text: '没人问就回话',
    toolCalls: [],
    thinking: '',
  };
  assert.throws(() => rig.session.handle(strayReply), /表里没有这个组合/);
  assert.equal(rig.session.state, sessionModule.SessionState.Idle);

  rig.session.handle(userSays('第一句'));
  const strayTool: sessionModule.ToolFinishedEvent = {
    type: sessionModule.SessionEventType.ToolFinished,
    callId: 'call_x',
    toolName: 'think',
    result: '没人调就做完了',
  };
  assert.throws(() => rig.session.handle(strayTool), /表里没有这个组合/);
  assert.equal(rig.session.state, sessionModule.SessionState.WaitResponse);
  assert.equal(rig.session.messages.length, 1);

  //M 执行工具时，来了不是这一轮的工具结果。
  rig.client.respond(toolReply(toolCall('call_1')));
  await settle();
  assert.throws(() => rig.session.handle(strayTool), /表里没有这个组合/);
  assert.equal(rig.session.state, sessionModule.SessionState.RunTools);
});


/** 假的 fetch 收到的一次请求。 */
interface SentRequest {
  /** 地址。 */
  url: string;
  /** 请求头。 */
  headers: Record<string, string>;
  /** 请求体，JSON 原文。 */
  bodyText: string;
}

/** 测试要看的请求体的样子。 */
interface SentBody {
  /** 模型 ID。 */
  model: string;
  /** 最多输出。 */
  max_tokens?: number;
  /** 协议格式的消息。 */
  messages: Record<string, unknown>[];
  /** 协议格式的工具。 */
  tools?: { function: { name: string } }[];
}

/**
 * 把 fetch 换成假的：记下请求，回一个给定的回应。
 * @param status HTTP 状态码。
 * @param responseText 回应的正文。
 * @returns 收到的请求，按顺序。
 */
function fakeFetch(status: number, responseText: string): SentRequest[] {
  const sent: SentRequest[] = [];
  /** 假的 fetch：模型客户端传的是字符串地址和字符串请求体。 */
  const fakeImplementation = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    assert.ok(typeof input === 'string', '模型客户端应该传字符串地址');
    assert.ok(init, '模型客户端应该传请求设置');
    assert.ok(typeof init.body === 'string', '模型客户端应该传字符串请求体');
    const sentRequest: SentRequest = {
      url: input,
      headers: init.headers as Record<string, string>,
      bodyText: init.body,
    };
    sent.push(sentRequest);
    const responseInit = {
      status,
    };
    const response = new Response(responseText, responseInit);
    return Promise.resolve(response);
  };

  //M Bun 的 fetch 还带一个 preconnect，假的没有，按 fetch 的类型交进去。
  bunTest.spyOn(globalThis, 'fetch').mockImplementation(fakeImplementation as typeof fetch);
  return sent;
}

bunTest.test('模型客户端：请求体是 chat completions 的格式，回话里的工具调用读回来', async () => {
  const responseText = JSON.stringify({
    choices: [
      {
        message: {
          content: null,
          tool_calls: [
            {
              id: 'call_9',
              type: 'function',
              function: {
                name: 'think',
                arguments: '{"about":"x"}',
              },
            },
          ],
        },
      },
    ],
  });
  const sent = fakeFetch(200, responseText);
  const providers = {
    test_provider: {
      base_url: 'http://example.test/v1/',
      api_key: 'test-key',
    },
  };
  const client = new clientModule.ModelClient(providers, 1000);
  const model = testModel('some-model');
  model.maxOutputTokens = 100;
  const request: clientModule.ModelRequest = {
    model,
    systemPrompt: PROMPT,
    messages: [
      {
        role: 'user',
        text: '想一想',
      },
      {
        role: 'assistant',
        text: '',
        toolCalls: [toolCall('call_1')],
        thinking: '先想想',
      },
      {
        role: 'tool',
        callId: 'call_1',
        toolName: 'think',
        text: '想好了',
      },
    ],
    tools: [new ManualTool('think')],
  };

  const reply = await client.complete(request);

  //M 发出去的：地址、密钥、请求体。
  const sentRequest = sent[0];
  assert.ok(sentRequest);
  assert.equal(sentRequest.url, 'http://example.test/v1/chat/completions');
  assert.equal(sentRequest.headers.authorization, 'Bearer test-key');
  const body = JSON.parse(sentRequest.bodyText) as SentBody;
  assert.equal(body.model, 'some-model');
  assert.equal(body.max_tokens, 100);
  assert.deepEqual(body.messages[0], {
    role: 'system',
    content: PROMPT,
  });
  assert.deepEqual(body.messages[2], {
    role: 'assistant',
    content: '',
    tool_calls: [
      {
        id: 'call_1',
        type: 'function',
        function: {
          name: 'think',
          arguments: '{"about":"测试"}',
        },
      },
    ],
    reasoning_content: '先想想',
  });
  assert.deepEqual(body.messages[3], {
    role: 'tool',
    tool_call_id: 'call_1',
    content: '想好了',
  });
  assert.equal(body.tools?.[0]?.function.name, 'think');

  //M 读回来的：工具调用。
  assert.deepEqual(reply, {
    text: '',
    toolCalls: [
      {
        id: 'call_9',
        name: 'think',
        argumentsText: '{"about":"x"}',
      },
    ],
    thinking: '',
  });
});

bunTest.test('模型客户端：HTTP 出错、没有这家供应商、回的不对时抛错（会话收到就是模型出错）', async () => {
  const providers = {
    test_provider: {
      base_url: 'http://example.test/v1',
    },
  };
  const client = new clientModule.ModelClient(providers, 1000);
  const request: clientModule.ModelRequest = {
    model: testModel('some-model'),
    systemPrompt: PROMPT,
    messages: [],
    tools: [],
  };

  fakeFetch(500, 'boom');
  await assert.rejects(client.complete(request), /HTTP 500：boom/);

  bunTest.mock.restore();
  fakeFetch(200, '{"error":"没有额度"}');
  await assert.rejects(client.complete(request), /没有 choices/);

  const otherModel = testModel('some-model');
  otherModel.provider = 'missing_provider';
  const otherRequest: clientModule.ModelRequest = {
    ...request,
    model: otherModel,
  };
  await assert.rejects(client.complete(otherRequest), /providers 里没有 missing_provider/);
});
