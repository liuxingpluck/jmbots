/**
 * 会话的 对话.md：运行时目录 bots/<机器人>/sessions/<会话号>/对话.md（web-api 的 Timeline.sessionFiles 照这个位置找）。
 * 对话里每接一条就往文件末尾追加一段，不重写整份：会话再长，每次也只写新的那一段。
 * 文件不在（第一次写、被人删了）就先写一个开头：会话号、种类、机器人、模型。
 * 都是函数，不存状态；journal/index.ts 在收到通知时调。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type { Resources } from '../../Resources.ts';
import type { Session } from '../../Sessions.ts';
import * as cut from '../../utils/Cut.ts';
import * as textModule from '../../utils/Text.ts';


/** 工具结果在 md 里最多留多少字：md 是给人翻的，全文在库里。 */
const RESULT_MAX_CHARS = 4000;

/** 状态的人话。 */
const STATES: Record<string, string> = { done: '做完了', stopped: '停下了', failed: '出错了', running: '在转' };


/**
 * 对话里新接了一条：追加一段。
 * @param resources 拿运行时目录。
 * @param session 哪场会话。
 * @param message 用户的话、模型的回答、工具的结果。
 * 副作用：写文件。
 */
export function append(resources: Resources, session: Session, message: piAi.Message): void {
  //G 系统消息（pi 的 system 这种）不是对话，不写。
  if (message.role === 'system') return;

  const time = textModule.clock(message.timestamp, 'date');
  if (message.role === 'user') {
    write(resources, session, `## 用户 · ${time}\n\n${piAi.contentText(message.content)}\n`);
    return;
  }
  if (message.role === 'assistant') {
    //M 模型的回答：说的话，加上它要调的工具（一行一个，参数是 JSON）。
    const calls = message.content.filter((block) => block.type === 'toolCall');
    const lines = calls.map((call) => `> 调用工具 \`${call.name}\` ${JSON.stringify(call.arguments)}`);
    const said = piAi.contentText(message.content);
    const body = [said === '' ? '（没说话）' : said, ...lines].join('\n\n');
    write(resources, session, `## 模型 · ${time}（${message.provider}/${message.model}）\n\n${body}\n`);
    return;
  }

  //M 工具的结果：放进 ~~~ 围起来的块里（结果里常有 ```，用 ~~~ 不会被它截断），太长只留开头。
  const mark = message.isError ? '（出错）' : '';
  const result = cut.chars(piAi.contentText(message.content), RESULT_MAX_CHARS);
  write(resources, session, `## 工具结果 \`${message.toolName}\`${mark} · ${time}\n\n~~~text\n${result}\n~~~\n`);
}


/**
 * 会话中途先跟用户说的一句（bots.say）。
 * @param resources 拿运行时目录。
 * @param session 哪场会话。
 * @param text 说的话。
 * 副作用：写文件。
 */
export function said(resources: Resources, session: Session, text: string): void {
  write(resources, session, `## 中途告诉用户 · ${textModule.clock(Date.now(), 'date')}\n\n${text}\n`);
}


/**
 * 这一轮结束了：写一行分隔，带结束的状态。
 * @param resources 拿运行时目录。
 * @param session 哪场会话。
 * 副作用：写文件。
 */
export function ended(resources: Resources, session: Session): void {
  const state = STATES[session.row.state] ?? session.row.state;
  write(resources, session, `---\n\n*这一轮${state} · ${textModule.clock(Date.now(), 'date')}*\n`);
}


/**
 * 追加一段；文件不在先写开头。
 * @param resources 拿运行时目录。
 * @param session 哪场会话。
 * @param section 这一段 md。
 * 副作用：可能建目录；写文件。
 */
function write(resources: Resources, session: Session, section: string): void {
  const row = session.row;
  const file = path.join(resources.dir('bots', row.bot, 'sessions', session.id), '对话.md');
  if (!fs.existsSync(file)) {
    const parent = row.parent === undefined ? '' : `，嵌在 ${row.parent} 里`;
    const head = `# 会话 ${session.id}\n\n- 机器人：${row.bot}\n- 种类：${row.kind}${parent}\n- 模型：${row.model}\n`;
    fs.writeFileSync(file, head, 'utf8');
  }
  fs.appendFileSync(file, `\n${section}`, 'utf8');
}
