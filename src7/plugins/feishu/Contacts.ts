/**
 * 飞书来往流水：收到的每条消息记一行进运行时目录 data/logs/feishu-contacts.jsonl（开发阶段不打码），
 * 写明谁在哪个聊天说了什么、最后怎么处理的；前台判断完要不要接话（bot/judged）再补记一行。
 * 网页的 GET /api/feishu/contacts（apply 里登记）、跨聊天认目标（Reply.ts）、群里认名字（index.ts 的 getNames）读它。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as textModule from '../../utils/Text.ts';
import * as utils from '../../utils/index.ts';
import type { Feishu } from './index.ts';


/** 来往流水的一行（data/logs/feishu-contacts.jsonl、GET /api/feishu/contacts）。 */
export interface Contact {
  /** 收到的本地时间，2026-11-17 10:30:05 的样子（textModule.formatLocalTime）。 */
  at: string;
  /** 哪个飞书应用收的。 */
  app: string;
  /** p2p、group。 */
  chatType: string;
  chatId: string;
  /** 群名：登记的或查到的；私聊、查不到是 ''。 */
  chatName: string;
  /** 说话人 open_id。 */
  openId: string;
  /** 说话人名字：登记的或查到的；都没有是 ''。 */
  sender: string;
  /** 有没有 @ 机器人；私聊算 @ 了。 */
  atMe: boolean;
  /** 话的前 80 字，超了带“…”（附件是 [图片] 这类标记）。 */
  text: string;
  /** 最后怎么处理的：交给会话、转外部助手、只记、丢了、别的插件处理掉了、没处理成：原因。 */
  outcome: string;
}


/** 飞书来往流水：Feishu 构造时建一个，挂在 feishu.contacts 上。 */
export class FeishuContacts {
  /**
   * 登记 bot/judged 监听。构造时不碰运行时目录（目录在第一次读写时才建）。
   * @param ctx 飞书插件的 Cordis 上下文（随插件卸载自动注销监听）。
   * @param feishu 飞书渠道：认地址是不是飞书应用的。
   */
  constructor(
    private readonly ctx: cordis.Context,
    private readonly feishu: Feishu,
  ) {
    //M 前台在会话跑完以后才判断完的话（bot/judged）：补记一行流水，写明判断的结果。
    this.ctx.on('bot/judged', (address, text, outcome) => {
      this.logJudged(address, text, outcome);
    });
  }

  /**
   * 来往流水记一行：运行时目录 data/logs/feishu-contacts.jsonl，追加。开发阶段不打码。
   * 收消息（Inbound.ts）每条收尾时调。
   * @param contact 这条消息的时间、应用、聊天、说话人、有没有 @、话的前 80 字。
   * @param outcome 最后怎么处理的。
   * 副作用：写文件；写不进只打日志，不挡消息。
   */
  log(contact: Omit<Contact, 'outcome'>, outcome: string): void {
    const line: Contact = { ...contact, outcome };
    try {
      //M 以追加行写入 data/logs/feishu-contacts.jsonl 记录全量来往流水。
      fs.appendFileSync(this.getFile(), `${JSON.stringify(line)}\n`, 'utf8');
    } catch (error) {
      //M 写流水失败仅打印带时间戳日志，不阻断正常消息处理。
      const logTime = textModule.formatLocalTime(Date.now(), 'date');
      console.error(`${logTime} 飞书：来往流水没写进去：${textModule.getErrorMessage(error)}`);
    }
  }

  /**
   * 最近的来往流水，接口 GET /api/feishu/contacts 用。
   * @param limit 最多几条。
   * @returns 新的在前。
   */
  list(limit: number): Contact[] {
    //M 解析流水文件路径，未生成过直接返回空列表。
    const file = this.getFile();
    if (!fs.existsSync(file)) return [];

    const lines = fs.readFileSync(file, 'utf8').split('\n').filter((line) => line.trim() !== '');
    return lines.slice(-limit).reverse().map((line) => JSON.parse(line) as Contact);
  }

  /** @returns 来往流水文件的绝对路径（文件夹没有就建）。 */
  private getFile(): string {
    //M 确保 data/logs 运行时子目录存在并拼接飞书来往流水 jsonl 路径。
    return path.join(this.ctx.resources.ensureRuntimeDir('data', 'logs'), 'feishu-contacts.jsonl');
  }

  /**
   * 前台补报一次判断的结果：补记一行流水，outcome 写 judge:回 / judge:不回(0.32)。
   * @param address 回话地址（不是飞书的忽略）。
   * @param text 那句话。
   * @param outcome 判断的结果。
   */
  private logJudged(address: unknown, text: string, outcome: string): void {
    //M 从透传地址安全取出 appId，确认属于飞书渠道再补记决策结果流水。
    const appId = utils.getStringField(address, 'appId');
    if (!this.feishu.apps.has(appId)) return;
    const contact: Omit<Contact, 'outcome'> = {
      //M 汇总日期戳、聊天元信息与裁剪后正文构成流水条，写入来往记录。
      at: textModule.formatLocalTime(Date.now(), 'date'), app: appId, chatType: utils.getStringField(address, 'chatType'),
      chatId: utils.getStringField(address, 'chatId'), chatName: utils.getStringField(address, 'chatName'),
      openId: utils.getStringField(address, 'openId'), sender: utils.getStringField(address, 'senderName'), atMe: false,
      text: textModule.clipText(text.trim(), 80),
    };
    //M 将前台补充判定的结果标签追加写入联系人流水文件。
    this.log(contact, outcome);
  }
}
