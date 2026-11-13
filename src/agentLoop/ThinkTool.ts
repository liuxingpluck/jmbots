/**
 * 工具 think：模拟“想一想”，等几秒再回一句“想好了”。
 * 不联网、不花钱，用来制造一段“工具在跑”的时间，好在这段时间里插话。
 */
import * as checks from '../utils/Checks.ts';
import * as sessionModule from './Session.ts';


/** think 工具：等几秒，回一句想好了。 */
export class ThinkTool extends sessionModule.Tool {
  /** 名字：模型调用时写 think。 */
  readonly name = 'think';

  /** 说明：告诉模型什么时候用。 */
  readonly description = '花几秒钟认真想一想一个问题，想好了会告诉你。回答需要想一想的问题之前先调用它。';

  /** 参数：about 是要想的问题。 */
  readonly parameters = {
    type: 'object',
    properties: {
      about: {
        type: 'string',
        description: '要想的问题',
      },
    },
    required: ['about'],
  };

  /** 想多少秒（Main.ts 从 Config.json 的 thinkSeconds 传进来）。 */
  private readonly seconds: number;

  /**
   * @param seconds 想多少秒。
   */
  constructor(seconds: number) {
    super();
    this.seconds = seconds;
  }

  /**
   * 想一想：等几秒，回一句想好了。
   * @param argumentsText 模型给的参数，JSON 原文，如 {"about":"天空为什么是蓝的"}。
   * @returns 想好了的一句话。
   * @throws 参数不是 JSON、没写 about 时抛错（会话接住，把原因交回给模型）。
   */
  async run(argumentsText: string): Promise<string> {
    //M 参数是模型写的，外部输入，在这里检查。
    const parsed: unknown = JSON.parse(argumentsText);
    const args = checks.asRecord(parsed, 'think 的参数');
    const about = checks.requireString(args.about, 'think 的参数 about');

    //M 想一想：就是等几秒。
    const milliseconds = this.seconds * 1000;
    await Bun.sleep(milliseconds);
    return `想了 ${this.seconds} 秒，想好了：“${about}”可以回答了。`;
  }
}
