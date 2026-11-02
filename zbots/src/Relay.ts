/**
 * 转给开发助手的两个工具：周小灵自己判断什么时候调 ask_dsh 或 note_for_claude。
 * ask_dsh 通过有界 Dsh_Control 支持 current/new/specified，只返回受理事实，不等待任务完成。
 * note_for_claude 保留原有兼容，不在本轮主动调用。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as agent from './Agent.ts';
import type * as runtime from './Runtime.ts';
import * as utils from './Utils.ts';
import * as dsh from './DshSession.ts';


/**
 * 创建开发助手工具，不在注册时联网或读取认证配置。
 * @param zbots 运行时，只有目录用于保存请求及留言。
 * @param dshSession 已配置默认会话 ID；current 使用它，new/specified 不改写它。
 * @param options 宿主控制器选项，默认有界 CLI；不暴露给模型。
 * @returns 工具定义与执行函数，执行时才产生文件和外部提交。
 */
export function createRelayTools(zbots: runtime.Runtime, dshSession: string | undefined, options: dsh.SessionOptions = {}): agent.AgentTool[] {
  return [
    {
      definition: {
        name: 'ask_dsh',
        description: '把开发任务交给 DSH。默认 current 沿用已配置默认会话；new 新建 Astra/max；specified 指定 jmai 会话。必须回报实际 sessionId 和 requestId。accepted 仅表示排队受理，不能说已开始或已完成；busy 不等于卡死。状态不明时禁止自动新建或换请求ID重发，同一条重试沿用 request_id。',
        parameters: piAi.Type.Object({
          task: piAi.Type.String({ description: '任务、前因后果和用户原话。', minLength: 1 }),
          session_mode: piAi.Type.Optional(piAi.Type.Union([piAi.Type.Literal('current'), piAi.Type.Literal('new'), piAi.Type.Literal('specified')], { description: '省略为 current（已配置默认会话），不会沿用最近 new。' })),
          session_id: piAi.Type.Optional(piAi.Type.String({ description: '仅 specified 填写，必须是 jmai 内未归档的 session-UUID。' })),
          request_id: piAi.Type.Optional(piAi.Type.String({ description: '同一条重试沿用上次回执的 requestId；省略自动生成。', minLength: 8, maxLength: 96 })),
        }),
      },
      async execute(args) {
        // g: 先校验所有模式/标识，不能用错误参数产生外部副作用。
        const request = dsh.parseRequest(args);
        // r: 不把任务或配置回显到监听日志，仅记录提交回执中的安全字段。
        return dsh.describeReceipt(await dsh.submitTask(zbots.dir, dshSession, request, options));
      },
    },
    {
      definition: {
        name: 'note_for_claude',
        description: '给 Claude 留言。Claude 是 VSCode 里负责定方案、做决定的 AI，只在它的 VSCode 会话开着时看得到。',
        parameters: piAi.Type.Object({ message: piAi.Type.String({ description: '给 Claude 的留言。', minLength: 1 }) }),
      },
      async execute(args) {
        // g: 只接收非空文字，避免把无效参数记成已交接。
        if (typeof args.message !== 'string' || !args.message.trim()) {
          throw new Error('note_for_claude 的 message 要写非空文字。');
        }
        // m: 留言压成一行追加，时间与控制台一致，供开着的 Claude 会话查看。
        /** 留言文件的绝对路径。 */
        const file = path.join(zbots.dir, 'feishu', '给Claude.md');
        /** 本次留言时间，在文件和控制台中保持一致。 */
        const time = utils.formatTime();
        /** 多行留言压成单行，避免破坏追加记录的格式。 */
        const message = args.message.replace(/\s*\r?\n\s*/g, ' ⏎ ');
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.appendFile(file, `- ${time} ${message}\n`);
        console.log(`${time} 给 Claude 的留言：${message}`);
        return '已记下给 Claude 的留言。Claude 的 VSCode 会话开着时会看到。';
      },
    },
  ];
}


/** 兼容旧字符串调用：沿用配置默认会话，返回结构化受理回执，不等执行完成。 */
export async function relayToDsh(zbots: runtime.Runtime, session: string | undefined, text: string): Promise<string> {
  return dsh.describeReceipt(await dsh.submitTask(zbots.dir, session, { task: text }));
}
