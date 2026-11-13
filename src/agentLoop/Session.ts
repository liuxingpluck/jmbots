/**
 * 会话（第 2 步：接上真模型、工具和插话）。
 *
 * 一个会话对一个模型。用户说话 → 请求模型 → 模型要调工具就执行工具，工具结果再交给模型 →
 * 一直到模型不再调工具，这次的回话交给用户，这件事就做完了。
 *
 * 它是一个状态机：处在某个状态 → 来了一个事件 → 存下 → 改状态 → 触发执行。事件全部从 handle() 进来。
 * 请求模型、执行工具都是异步的，什么时候做完不知道：做完了也变成一个事件（模型回话、模型出错、工具做完），
 * 再从 handle() 进来。
 *
 *   行  现在的状态       来了什么事件                  存下什么                         改成什么状态    触发什么
 *   1   idle             用户消息（设了模型）          这句话记进 messages              wait_response   请求模型
 *   2   idle             用户消息（还没设模型）        不存                             不变            告诉用户先设模型
 *   3   wait_response    用户消息（插话）              记进 queue 排队                  不变            不触发
 *       run_tools
 *   4   wait_response    模型回话，要调工具            回话记进 messages                run_tools       执行每个工具
 *   5   wait_response    模型回话，不调工具，没排队    回话记进 messages                idle            回复用户
 *   6   wait_response    模型回话，不调工具，有排队    回话记进 messages，排队的挪进去  不变            回复用户，再请求模型
 *   7   wait_response    模型出错，没排队              不存                             idle            告诉用户出错
 *   8   wait_response    模型出错，有排队              排队的挪进 messages              不变            告诉用户出错，再请求模型
 *   9   run_tools        工具做完，还有没做完的        结果记进 messages                不变            不触发
 *   10  run_tools        工具做完，全做完了            结果记进 messages，排队的挪进去  wait_response   请求模型
 *   11  任何状态         换模型                        model 换成新的                   不变            不触发
 *
 * 插话的规矩（接话）：模型或工具在跑时用户说的话先排队，不打断正在做的事。
 *   - 模型要调工具：执行工具，工具结果和排队的话一起交给模型。
 *   - 模型不调工具：这件事做完了，回话先交给用户，再拿排队的话重新请求模型。
 * 同一时间最多一个模型请求在跑，所以不会收到过期的回话。
 * 换模型是特殊的动作事件：不看状态、不改状态、不触发执行，只改存下的设置，下一次请求起用新模型。
 * 表里没有的组合直接报错，不悄悄丢掉。
 * 外面用 on() 登记监听，会话回复用户、出错、开始执行工具时调用（见 SessionListeners）。
 */
import * as fs from 'node:fs';
import * as utils from '../utils/Utils.ts';
import type * as clientModule from './ModelClient.ts';


/** 会话现在在做什么。 */
export enum SessionState {
  /** 空闲：没在等模型，也没有工具在跑。来了用户消息就请求模型。 */
  Idle = 'idle',
  /** 等回话：请求已经发给模型，在等它回话。 */
  WaitResponse = 'wait_response',
  /** 执行工具：模型要调的工具在跑，等它们都做完。 */
  RunTools = 'run_tools',
}


/** 模型要调一次工具。 */
export interface ToolCall {
  /** 这次调用的 ID，模型给的。工具结果要带上它，模型才知道是哪次调用的结果。 */
  id: string;
  /** 调哪个工具。 */
  name: string;
  /** 参数：模型写的 JSON 原文，工具自己解析。 */
  argumentsText: string;
}

/** 用户说的一句话。 */
export interface UserMessage {
  /** 谁说的：用户。 */
  role: 'user';
  /** 说了什么。 */
  text: string;
}

/** 模型回的一次话。 */
export interface AssistantMessage {
  /** 谁说的：模型。 */
  role: 'assistant';
  /** 回的话；只调工具时可能是空字符串。 */
  text: string;
  /** 要调的工具；不调工具时是空数组。 */
  toolCalls: ToolCall[];
  /** 思考过程（有的模型会给）；没有是空字符串。下一次请求原样带回去。 */
  thinking: string;
}

/** 一个工具的结果。 */
export interface ToolMessage {
  /** 谁说的：工具。 */
  role: 'tool';
  /** 是哪次调用的结果（ToolCall 的 id）。 */
  callId: string;
  /** 哪个工具，打印时看得清。 */
  toolName: string;
  /** 结果；出错时是出错原因。 */
  text: string;
}

/** 对话里的一条消息。 */
export type Message = UserMessage | AssistantMessage | ToolMessage;


/** 工具：模型能调用的一件事。具体的工具继承它，如 ThinkTool.ts 的 ThinkTool。 */
export abstract class Tool {
  /** 名字：模型调用时写的就是它。 */
  abstract readonly name: string;

  /** 说明：告诉模型这个工具做什么、什么时候用。 */
  abstract readonly description: string;

  /** 参数的 JSON Schema，原样交给模型。 */
  abstract readonly parameters: Record<string, unknown>;

  /**
   * 执行。
   * @param argumentsText 模型给的参数，JSON 原文。
   * @returns 结果，原样交回给模型。
   * @throws 参数不对、执行出错时抛错；会话接住，把原因当结果交回给模型。
   */
  abstract run(argumentsText: string): Promise<string>;
}


/** 事件的种类。 */
export enum SessionEventType {
  /** 用户说了一句（从外面来）。 */
  UserMessage = 'user_message',
  /** 模型回话了（请求模型的结果）。 */
  ModelResponded = 'model_responded',
  /** 模型出错了：连不上、超时、回的不对（请求模型的结果）。 */
  ModelFailed = 'model_failed',
  /** 一个工具做完了（执行工具的结果）。 */
  ToolFinished = 'tool_finished',
  /** 换模型：特殊的动作事件，只改设置（从外面来）。 */
  ChangeModel = 'change_model',
}

/** 用户消息事件。 */
export interface UserMessageEvent {
  /** 事件的种类。 */
  type: SessionEventType.UserMessage;
  /** 用户说的话。 */
  text: string;
}

/** 模型回话事件。 */
export interface ModelRespondedEvent {
  /** 事件的种类。 */
  type: SessionEventType.ModelResponded;
  /** 模型回的话；只调工具时可能是空字符串。 */
  text: string;
  /** 模型要调的工具；不调工具时是空数组。 */
  toolCalls: ToolCall[];
  /** 模型的思考过程；没有是空字符串。 */
  thinking: string;
}

/** 模型出错事件。 */
export interface ModelFailedEvent {
  /** 事件的种类。 */
  type: SessionEventType.ModelFailed;
  /** 出错的原因。 */
  reason: string;
}

/** 工具做完事件。 */
export interface ToolFinishedEvent {
  /** 事件的种类。 */
  type: SessionEventType.ToolFinished;
  /** 是哪次调用（ToolCall 的 id）。 */
  callId: string;
  /** 哪个工具。 */
  toolName: string;
  /** 结果；出错时是出错原因。 */
  result: string;
}

/** 换模型事件。 */
export interface ChangeModelEvent {
  /** 事件的种类。 */
  type: SessionEventType.ChangeModel;
  /** 换成哪个模型。 */
  model: clientModule.ModelConfig;
}

/** 进会话的事件。 */
export type SessionEvent =
  | UserMessageEvent
  | ModelRespondedEvent
  | ModelFailedEvent
  | ToolFinishedEvent
  | ChangeModelEvent;


/** 会话往外发的通知：外面用 Session.on() 登记，到时候调用。 */
export interface SessionListeners {
  /** 回复用户：模型不再调工具了，这次的回话交给用户。参数是回话。 */
  reply: (text: string) => void;
  /** 出错了，告诉用户：还没设模型、模型出错。参数是原因。 */
  failed: (reason: string) => void;
  /** 开始执行一个工具。参数是模型要的这次调用。 */
  toolStarted: (call: ToolCall) => void;
}


/** 建会话要给的东西。 */
export interface SessionOptions {
  /** 系统提示词文件的绝对路径，建会话时读进来。 */
  systemPromptPath: string;
  /** 一开始用的模型；没有就不写，之后用换模型事件设上。 */
  model?: clientModule.ModelConfig;
  /** 模型能调用的工具。 */
  tools: Tool[];
  /** 把请求发给模型的客户端（ModelClient.ts 的 ModelClient）。 */
  modelClient: clientModule.ModelClient;
}


/** 会话：一个用户对一个模型，模型可以调工具，用户可以插话。 */
export class Session {
  /** 会话 ID：年月日时分秒、3 位毫秒、3 位随机数，共 20 位数字。建会话时自己生成（src/utils/Utils.ts 的 createSessionId）。 */
  readonly id: string;

  /** 建会话的时刻（毫秒），打印“第几秒发生的”用。 */
  readonly createdAt: number;

  /** 现在在做什么。 */
  state: SessionState = SessionState.Idle;

  /** 用哪个模型。undefined 是还没设。只经 handle(换模型事件) 改，下一次请求起生效。 */
  model: clientModule.ModelConfig | undefined;

  /** 系统提示词：建会话时从文件读进来，每次请求模型都带上。 */
  readonly systemPrompt: string;

  /** 对话，按发生顺序。每次请求模型都整份带上。 */
  readonly messages: Message[] = [];

  /** 排队的插话：模型或工具在跑时用户说的话，等这一轮有结果了再挪进 messages。 */
  readonly queue: UserMessage[] = [];

  /** 这一轮还没做完的工具调用（ToolCall 的 id）。 */
  private readonly runningCallIds = new Set<string>();

  /** 模型能调用的工具。 */
  private readonly tools: Tool[];

  /** 把请求发给模型的客户端。 */
  private readonly modelClient: clientModule.ModelClient;

  /** 外面登记的监听，按通知分开放。 */
  private readonly listeners: { [Name in keyof SessionListeners]: SessionListeners[Name][] } = {
    reply: [],
    failed: [],
    toolStarted: [],
  };

  /**
   * 建一个会话：自己生成 ID，读系统提示词，状态是 idle。只是建好，不请求模型。
   * @param options 系统提示词路径、模型（可以没有）、工具、模型客户端。
   * @throws 系统提示词文件读不到时抛错。
   */
  constructor(options: SessionOptions) {
    /** 现在，ID 和建会话的时刻都用它。 */
    const now = new Date();
    this.id = utils.createSessionId(now);
    this.createdAt = now.getTime();
    this.model = options.model;
    this.systemPrompt = fs.readFileSync(options.systemPromptPath, 'utf8');
    this.tools = options.tools;
    this.modelClient = options.modelClient;
  }

  /**
   * 登记监听：会话发出这个通知时调用它。
   * 监听函数是外面传进来的（演示里是 Main.ts 登记的）。它在 handle() 里面被调用，这时状态已经改好了。
   * @param name 哪种通知：reply、failed、toolStarted。
   * @param listener 到时候调用的函数。
   */
  on<Name extends keyof SessionListeners>(name: Name, listener: SessionListeners[Name]): void {
    this.listeners[name].push(listener);
  }

  /**
   * 唯一入口：看现在的状态和来的事件 → 存下 → 改状态 → 触发执行。
   * 下面每个 if 对应文件头表里的一行，排在前面的先比。
   * @param event 进会话的事件：外面来的，或者模型、工具做完变成的。
   * @throws 表里没有的组合。
   */
  handle(event: SessionEvent): void {
    /** 处理前的状态，改完以后和新状态一起打印。 */
    const stateBefore = this.state;
    /** 事件内容，原样打印。 */
    const eventText = JSON.stringify(event);
    /** 会话建好多少秒了。 */
    const seconds = this.elapsedSeconds();
    console.log('');
    console.log(`[事件 第 ${seconds} 秒] ${event.type}，现在的状态 ${stateBefore}`);
    console.log(`  内容 ${eventText}`);

    //M 第 1 行：空闲时用户说话，设了模型 → 记进 messages，改成等回话，请求模型。
    if (this.state === SessionState.Idle && event.type === SessionEventType.UserMessage && this.model) {
      const userMessage: UserMessage = {
        role: 'user',
        text: event.text,
      };
      this.messages.push(userMessage);
      console.log('  存下 用户这句话记进对话');

      //M 先改状态再触发：触发出去的事做完回来时，看到的已经是新状态。
      this.state = SessionState.WaitResponse;
      console.log(`  状态 ${stateBefore} → ${this.state}`);
      this.requestModel();
      return;
    }

    //G 第 2 行：空闲时用户说话，还没设模型 → 不存，状态不变，告诉用户先设模型。
    if (this.state === SessionState.Idle && event.type === SessionEventType.UserMessage) {
      console.log('  存下 不存');
      console.log(`  状态 不变，还是 ${this.state}`);
      this.tellFailure('还没设模型：先发一个换模型事件，再说话');
      return;
    }

    //M 第 3 行：模型或工具在跑时用户插话 → 记进 queue 排队，状态不变，不触发，不打断正在做的事。
    if (
      (this.state === SessionState.WaitResponse || this.state === SessionState.RunTools) &&
      event.type === SessionEventType.UserMessage
    ) {
      const userMessage: UserMessage = {
        role: 'user',
        text: event.text,
      };
      this.queue.push(userMessage);
      console.log(`  存下 插话排队，现在排着 ${this.queue.length} 条`);
      console.log(`  状态 不变，还是 ${this.state}`);
      return;
    }

    //M 第 4 行：等回话时模型回话，要调工具 → 回话记进 messages，改成执行工具，执行每个工具。
    if (
      this.state === SessionState.WaitResponse &&
      event.type === SessionEventType.ModelResponded &&
      event.toolCalls.length > 0
    ) {
      const assistantMessage: AssistantMessage = {
        role: 'assistant',
        text: event.text,
        toolCalls: event.toolCalls,
        thinking: event.thinking,
      };
      this.messages.push(assistantMessage);
      for (const call of event.toolCalls) {
        this.runningCallIds.add(call.id);
      }
      console.log(`  存下 模型的回话记进对话，它要调 ${event.toolCalls.length} 个工具`);

      this.state = SessionState.RunTools;
      console.log(`  状态 ${stateBefore} → ${this.state}`);
      this.runTools(event.toolCalls);
      return;
    }

    //M 第 5、6 行：等回话时模型回话，不调工具 → 这件事做完了：回话记进 messages，交给用户。
    if (this.state === SessionState.WaitResponse && event.type === SessionEventType.ModelResponded) {
      const assistantMessage: AssistantMessage = {
        role: 'assistant',
        text: event.text,
        toolCalls: event.toolCalls,
        thinking: event.thinking,
      };
      this.messages.push(assistantMessage);
      console.log('  存下 模型的回话记进对话，它没调工具，这件事做完了');

      //M 第 5 行：没有排队的插话 → 改回空闲，回复用户。
      if (this.queue.length === 0) {
        this.state = SessionState.Idle;
        console.log(`  状态 ${stateBefore} → ${this.state}`);
        this.replyToUser(event.text);
        return;
      }

      //M 第 6 行：有排队的插话（接话）→ 排队的挪进 messages，还是等回话；先回复用户，再拿排队的话请求模型。
      this.moveQueueIntoMessages();
      console.log(`  状态 不变，还是 ${this.state}（接着等下一次回话）`);
      this.replyToUser(event.text);
      this.requestModel();
      return;
    }

    //M 第 7、8 行：等回话时模型出错 → 这次请求没有结果，告诉用户出错，不卡在等回话。
    if (this.state === SessionState.WaitResponse && event.type === SessionEventType.ModelFailed) {
      //M 第 7 行：没有排队的插话 → 不存，改回空闲，告诉用户出错。
      if (this.queue.length === 0) {
        console.log('  存下 不存');
        this.state = SessionState.Idle;
        console.log(`  状态 ${stateBefore} → ${this.state}`);
        this.tellFailure(event.reason);
        return;
      }

      //M 第 8 行：有排队的插话 → 排队的挪进 messages，还是等回话；告诉用户出错，再拿排队的话请求模型。
      this.moveQueueIntoMessages();
      console.log(`  状态 不变，还是 ${this.state}（接着等下一次回话）`);
      this.tellFailure(event.reason);
      this.requestModel();
      return;
    }

    //M 第 9、10 行：执行工具时，这一轮的一个工具做完了 → 结果记进 messages。
    if (
      this.state === SessionState.RunTools &&
      event.type === SessionEventType.ToolFinished &&
      this.runningCallIds.has(event.callId)
    ) {
      const toolMessage: ToolMessage = {
        role: 'tool',
        callId: event.callId,
        toolName: event.toolName,
        text: event.result,
      };
      this.messages.push(toolMessage);
      this.runningCallIds.delete(event.callId);
      console.log(`  存下 工具 ${event.toolName} 的结果记进对话，这一轮还有 ${this.runningCallIds.size} 个没做完`);

      //M 第 9 行：还有没做完的 → 状态不变，接着等。
      if (this.runningCallIds.size > 0) {
        console.log(`  状态 不变，还是 ${this.state}`);
        return;
      }

      //M 第 10 行：全做完了 → 排队的插话挪进 messages（排在工具结果后面），改成等回话，请求模型。
      this.moveQueueIntoMessages();
      this.state = SessionState.WaitResponse;
      console.log(`  状态 ${stateBefore} → ${this.state}`);
      this.requestModel();
      return;
    }

    //M 第 11 行：换模型，特殊的动作事件。不看状态、不改状态、不触发执行，只把 model 换掉。
    if (event.type === SessionEventType.ChangeModel) {
      /** 换之前的模型，打印用。 */
      const modelBefore = describeModel(this.model);
      this.model = event.model;
      /** 换之后的模型，打印用。 */
      const modelAfter = describeModel(this.model);
      console.log(`  存下 模型 ${modelBefore} → ${modelAfter}，下一次请求起用它`);
      console.log(`  状态 不变，还是 ${this.state}`);
      return;
    }

    //G 表里没有的组合：直接报错，不悄悄丢掉。
    throw new Error(`表里没有这个组合：状态 ${this.state} 时收到 ${event.type}`);
  }

  /** 会话建好多少秒了，保留 1 位小数，打印用。 */
  elapsedSeconds(): string {
    const milliseconds = Date.now() - this.createdAt;
    const seconds = milliseconds / 1000;
    return seconds.toFixed(1);
  }

  /** 触发：请求模型。系统提示词、全部消息、工具拼成一次请求发出去；结果回来变成事件，再从 handle() 进来。 */
  private requestModel(): void {
    //G 走到这里一定设了模型：只有设了模型的第 1 行会开始请求，换模型事件也不会把模型换没。
    if (!this.model) {
      throw new Error('请求模型时还没设模型');
    }
    //M 拼请求。messages 复制一份：之后会话再加消息，不影响已经发出去的这次。
    const request: clientModule.ModelRequest = {
      model: this.model,
      systemPrompt: this.systemPrompt,
      messages: [...this.messages],
      tools: this.tools,
    };
    /** 工具名字，打印用。 */
    const toolNames = this.tools.map((tool) => tool.name).join('、');
    /** 用哪个模型，打印用。 */
    const modelText = describeModel(this.model);
    console.log(`  触发 请求模型 ${modelText}`);
    console.log(`    带上 系统提示词 ${this.systemPrompt.length} 字，工具 [${toolNames}]，消息 ${request.messages.length} 条：`);
    for (const message of request.messages) {
      /** 一条消息，原样打印。 */
      const messageText = JSON.stringify(message);
      console.log(`    ${messageText}`);
    }

    void this.callModel(request);
  }

  /**
   * 等模型回话（异步）。回话变成“模型回话”事件，出错变成“模型出错”事件，都从 handle() 进来。
   * @param request 拼好的请求。
   */
  private async callModel(request: clientModule.ModelRequest): Promise<void> {
    /** 模型的回话。 */
    let reply: clientModule.ModelReply;
    try {
      reply = await this.modelClient.complete(request);
    } catch (error) {
      const failedEvent: ModelFailedEvent = {
        type: SessionEventType.ModelFailed,
        reason: String(error),
      };
      this.handle(failedEvent);
      return;
    }

    const respondedEvent: ModelRespondedEvent = {
      type: SessionEventType.ModelResponded,
      text: reply.text,
      toolCalls: reply.toolCalls,
      thinking: reply.thinking,
    };
    this.handle(respondedEvent);
  }

  /**
   * 触发：执行模型要调的每个工具，同时开跑；每个做完都变成“工具做完”事件，从 handle() 进来。
   * @param calls 模型要的工具调用。
   */
  private runTools(calls: ToolCall[]): void {
    for (const call of calls) {
      console.log(`  触发 执行工具 ${call.name}，参数 ${call.argumentsText}`);
      void this.runTool(call);
      for (const listener of this.listeners.toolStarted) {
        listener(call);
      }
    }
  }

  /**
   * 执行一个工具（异步），做完变成“工具做完”事件，从 handle() 进来。
   * 工具名写错、参数不对、执行出错都不悄悄丢：出错原因当结果交回给模型。
   * @param call 模型要的这次调用。
   */
  private async runTool(call: ToolCall): Promise<void> {
    /** 工具的结果，原样交回给模型；出错时是出错原因。 */
    let result: string;
    try {
      //M 先 await 再进 handle()：哪怕马上就有结果（比如工具名写错），也等触发它的这次 handle() 走完再进来。
      result = await this.findAndRunTool(call);
    } catch (error) {
      result = `工具 ${call.name} 出错：${String(error)}`;
    }

    const finishedEvent: ToolFinishedEvent = {
      type: SessionEventType.ToolFinished,
      callId: call.id,
      toolName: call.name,
      result,
    };
    this.handle(finishedEvent);
  }

  /**
   * 按名字找到工具并执行。
   * @param call 模型要的这次调用。
   * @returns 工具的结果。
   * @throws 没有这个名字的工具、工具执行出错时抛错。
   */
  private async findAndRunTool(call: ToolCall): Promise<string> {
    const tool = this.tools.find((item) => item.name === call.name);
    //G 模型要了一个没有的工具。
    if (!tool) {
      throw new Error(`没有叫 ${call.name} 的工具`);
    }
    const result = await tool.run(call.argumentsText);
    return result;
  }

  /** 存下：排队的插话挪进 messages，排在最后，下一次请求一起交给模型。 */
  private moveQueueIntoMessages(): void {
    /** 挪几条。 */
    const count = this.queue.length;
    //G 没有排队的插话：不用挪。
    if (count === 0) {
      return;
    }
    const moved = this.queue.splice(0, count);
    this.messages.push(...moved);
    console.log(`  存下 排队的 ${count} 条插话挪进对话`);
  }

  /**
   * 触发：把回话交给用户，调用登记的 reply 监听。
   * @param text 模型的回话。
   */
  private replyToUser(text: string): void {
    console.log(`  触发 回复用户：${text}`);
    for (const listener of this.listeners.reply) {
      listener(text);
    }
  }

  /**
   * 触发：告诉用户出错了，调用登记的 failed 监听。
   * @param reason 原因。
   */
  private tellFailure(reason: string): void {
    console.log(`  触发 告诉用户出错：${reason}`);
    for (const listener of this.listeners.failed) {
      listener(reason);
    }
  }
}


/**
 * 模型写成“供应商/模型 ID（最多输出 多少）”，打印用。只改了最多输出的换模型也看得出换了什么。
 * @param model 模型；还没设时是 undefined。
 */
function describeModel(model: clientModule.ModelConfig | undefined): string {
  if (!model) {
    return '（还没设）';
  }
  /** 最多输出：没写就是模型默认。 */
  let maxOutputText = '模型默认';
  if (model.maxOutputTokens !== null) {
    maxOutputText = String(model.maxOutputTokens);
  }
  return `${model.provider}/${model.modelId}（最多输出 ${maxOutputText}）`;
}
