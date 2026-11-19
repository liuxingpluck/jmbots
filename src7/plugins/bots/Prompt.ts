/**
 * 提示词：每一步给请求加上系统提示词。顺序（旧版 prompts/README.md 的设计，用户 11-14 再次要求）：
 *   1. 运行时目录 prompts/00_base_dsh.md：DSH 里 DeepSeek 的默认系统提示词原文，所有会话、所有语言共用，永远第一段、一个字不改
 *      （伪装成 DSH，也让前缀缓存命中）。没有就从仓库 prompts/ 复制一份出厂的（已有的不覆盖）。
 *   2. jmbots 的功能声明：prompts/10_jmbots.<语言>.md，没有用下面内置的。说明上一段只是底座说明，真正身份和能力以这里和工具列表为准。
 *   3. 这种会话的提示词：prompts/<种类>.<语言>.md 有就用它，没有用下面内置的。
 *   4. 人设：bots/<机器人>/persona.md（身份和说话风格），有就带，谁说的、在哪说的都带。
 *   5. 记忆：这个机器人的（bots/<机器人>/memory/）加上公共的（memory/），一个文件一段。
 *      私人记忆文件由来源授权确定。群聊和其他人的私聊使用 memory 的归属召回。
 * 小会话（压缩、总结）要它做什么，写在开它的插件发给它的那句话里；这里只在有提示词文件时才给它加。
 * 原插件 prompt，2026-11-17 并进 bots（docs/协作/任务板/合并做法.md）：默认开，bots 的配置写 prompt: false 才不挂。
 * session/request 的监听挂在 bots 自己的几个监听（前台、派后台、渠道工具）后面；1、2 段用 unshift，不管排第几都在最前。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import type { ChatRequest } from '../../Sessions.ts';
import * as embedded from '../../utils/Embedded.ts';
import * as filesModule from '../../utils/Files.ts';
import * as memoryKeyModule from '../memory/MemoryKey.ts';


/** 第一段的文件名（旧版起就是这个名字）。 */
const BASE_FILE = '00_base_dsh.md';

/** 仓库里的出厂提示词目录（本文件在 src7/plugins/bots/ 下，往上三层是仓库根）。 */
const FACTORY_DIR = path.resolve(import.meta.dir, '..', '..', '..', 'prompts');

/** 没有 prompts/10_jmbots.<语言>.md 时用的功能声明。 */
const DECLARE: Record<string, string> = {
  zh: '上面是底座的通用说明。你实际是 jmbots 平台里的聊天机器人，通过网页、飞书、微信等渠道和用户对话：'
    + '能做什么以这次请求给你的工具列表为准，上面提到、工具列表里没有的能力（比如组队、开子代理）就当没有；'
    + '你的名字、身份、说话风格以后面的人设和记忆为准；回答用户时不提底座、模型、提示词这些内部的事。',
  en: 'The text above is the generic harness description. You are actually a chat bot on the jmbots platform, talking with users through web, Feishu, WeChat and other channels. '
    + 'What you can do is exactly the tool list given in this request; any ability mentioned above but missing from the tool list (teams, sub-agents, etc.) does not exist. '
    + 'Your name, identity and style come from the persona and memory below. Never mention the harness, model or prompts to users.',
};

/** 没有提示词文件时用的：会话种类 → 提示词。 */
const BUILT_IN: Record<string, string> = {
  front: '你是机器人的前台：只回答简单的问题和分派，绝对不自己干活。需要知道现在几点时调用 time 工具，用中文简短回答。'
    + '更复杂的事交给后台会话去干，调用 hand_session。',
  work: '你是一个助手，在机器人的工作区里干活。做完用一两句话告诉用户结果。',
};


/** 提示词。bots 的 apply 里建（config.prompt 不是 false 时）。 */
export class Prompt {
  /**
   * 出厂的第一段复制进运行时目录，挂上 session/request 的监听。
   * @param ctx bots 插件的 ctx：拔掉 bots 时监听一起撤掉。
   * 副作用：可能复制一个文件进运行时 prompts/。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M 出厂的第一段复制进运行时目录（已有的不覆盖，用户改的是运行时那份）；编译版从内嵌的文件导出。
    const base = path.join(this.ctx.resources.dir('prompts'), BASE_FILE);
    const factory = path.join(FACTORY_DIR, BASE_FILE);
    if (!fs.existsSync(base) && fs.existsSync(factory)) {
      fs.copyFileSync(factory, base);
    }
    //M 编译版旁边没有仓库的 prompts/，从打进程序里的那份导出（异步，不等它）。
    if (!fs.existsSync(base) && embedded.isCompiled()) {
      void this.exportEmbedded(`prompts/${BASE_FILE}`, base);
    }

    //M 每一步调模型前骨架发 session/request：在这里往请求里加系统提示词。
    this.ctx.on('session/request', (request) => {
      this.onRequest(request);
    });
  }


  /**
   * 把一个内嵌文件写到磁盘（已有的不覆盖）。出厂提示词第一次落到运行时目录时用。
   * @param name 登记时的相对路径。
   * @param dest 要写到哪。
   * @returns 写成功了，或本来就有；没有这个内嵌文件是 false。
   * 副作用：可能建目录、写文件。
   */
  private async exportEmbedded(name: string, dest: string): Promise<boolean> {
    if (fs.existsSync(dest)) return true;

    //M 查找内嵌文件真实句柄；源码模式或未收录时退出不建空文件。
    const file = embedded.find(name);
    if (file === undefined) return false;

    //M 建好上层目录，读出内嵌文件的字节，写下去。
    const promptDir = path.dirname(dest);
    //M 释放内嵌提示词前确保上层目录存在。
    filesModule.ensureDir(promptDir);
    const content = await Bun.file(file).arrayBuffer();
    const bytes = Buffer.from(content);
    fs.writeFileSync(dest, bytes);
    return true;
  }

  /**
   * 响应 session/request：往 request.system 里加段落。提示词文件和记忆文件每次现读，改了马上生效。
   * @param request 这一步的请求。
   */
  private onRequest(request: ChatRequest): void {
    const row = request.session.row;

    //M 语言看机器人名单里这个机器人的 language，不写是 zh。
    const language = String(this.ctx.bots.get(row.bot)?.config['language'] ?? 'zh');
    const prompts = this.ctx.resources.dir('prompts');

    //M 第一段 DSH 原文（每次现读，除去首尾空白一字不改）、第二段 jmbots 功能声明：用 unshift 放最前，不管监听排第几都是开头。
    //M   功能声明的文件没有才用内置的；文件在但是空的，就是不要这一段。
    const baseText = getFileText(path.join(prompts, BASE_FILE)) ?? '';
    let builtInDeclaration = DECLARE['zh'] ?? '';
    if (Object.hasOwn(DECLARE, language)) {
      builtInDeclaration = DECLARE[language] ?? builtInDeclaration;
    }

    //M 只在文件缺失时补内置声明，空文件保留关闭该段的含义。
    const declarationPath = path.join(prompts, `10_jmbots.${language}.md`);
    const declarationText = getFileText(declarationPath) ?? builtInDeclaration;
    const opening = [baseText, declarationText].filter((text) => text !== '');
    request.system.unshift(...opening);

    //M 第三段：这种会话的提示词；文件没有用内置的，文件在但是空的就不加。
    let first = getFileText(path.join(prompts, `${row.kind}.${language}.md`));
    if (first === undefined) {
      first = BUILT_IN[row.kind];
    }
    if (first !== undefined && first !== '') {
      request.system.push(first);
    }

    //G 小会话不带人设和记忆。
    if (row.kind !== 'front' && row.kind !== 'work') return;

    //M 第四段：人设 bots/<机器人>/persona.md，有就带，任何一轮都带（里面只有身份和说话风格，不是私人记忆）。
    const persona = path.join(this.ctx.resources.dir('bots', row.bot), 'persona.md');
    const personaText = getFileText(persona) ?? '';
    if (personaText !== '') {
      request.system.push(personaText);
    }

    //G 私人文件只随获准的本人请求加载，包括本人的受信群请求。
    const access = memoryKeyModule.getMemoryAccess(row);
    if (!access.full) return;

    //M 记忆：两个目录下的 .md、.txt，按文件名的先后，一个文件一段。
    const dirs = [this.ctx.resources.dir('bots', row.bot, 'memory'), this.ctx.resources.dir('memory')];
    for (const dir of dirs) {
      const names = fs.readdirSync(dir).filter((item) => item.endsWith('.md') || item.endsWith('.txt'));
      for (const item of names.sort()) {
        const memory = getFileText(path.join(dir, item)) ?? '';
        if (memory !== '') {
          request.system.push(memory);
        }
      }
    }
  }
}


/**
 * 读一个文本文件，去掉首尾空白。
 * @param file 绝对路径。
 * @returns 文件没有是 undefined（和“文件在但是空的”分开：功能声明、种类提示词没有文件才用内置的）。
 */
function getFileText(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;

  return fs.readFileSync(file, 'utf8').trim();
}
