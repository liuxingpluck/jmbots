/**
 * 提示词：每一步给请求加上系统提示词。顺序（旧版 prompts/README.md 的设计，用户 11-14 再次要求）：
 *   1. 运行时目录 prompts/00_base_dsh.md：DSH 里 DeepSeek 的默认系统提示词原文，所有会话、所有语言共用，永远第一段、一个字不改
 *      （伪装成 DSH，也让前缀缓存命中）。没有就从仓库 prompts/ 复制一份出厂的（已有的不覆盖）。
 *   2. jmbots 的功能声明：prompts/10_jmbots.<语言>.md，没有用下面内置的。说明上一段只是底座说明，真正身份和能力以这里和工具列表为准。
 *   3. 这种会话的提示词：prompts/<种类>.<语言>.md 有就用它，没有用下面内置的。
 *   4. 人设：bots/<机器人>/persona.md（身份和说话风格），有就带，谁说的、在哪说的都带。
 *   5. 记忆：这个机器人的（bots/<机器人>/memory/）加上公共的（memory/），一个文件一段。
 *      用户的私人记忆：非本人、不受信的群里（utils/Workspace.ts 的 privateAllowed）不带。
 * 小会话（压缩、总结）要它做什么，写在开它的插件发给它的那句话里；这里只在有提示词文件时才给它加。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as embedded from '../../utils/Embedded.ts';
import * as workspaceModule from '../../utils/Workspace.ts';
import type * as cordis from 'cordis';
import type { ChatRequest } from '../../Chat.ts';


/** 插件名。 */
export const name = 'prompt';

/** 用到的服务。 */
export const inject = ['resources', 'bots'];


/** 第一段的文件名（旧版起就是这个名字）。 */
const BASE_FILE = '00_base_dsh.md';

/** 仓库里的出厂提示词目录（本文件在 src7/plugins/prompt/ 下）。 */
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


/** 提示词。 */
class Prompt {
  /**
   * 挂上监听。
   * @param ctx Cordis 给的 ctx。
   */
  constructor(private readonly ctx: cordis.Context) {
    //M 出厂的第一段复制进运行时目录（已有的不覆盖，用户改的是运行时那份）。
    const base = path.join(this.ctx.resources.dir('prompts'), BASE_FILE);
    const factory = path.join(FACTORY_DIR, BASE_FILE);
    if (!fs.existsSync(base) && fs.existsSync(factory)) fs.copyFileSync(factory, base);
    if (!fs.existsSync(base) && embedded.isCompiled()) void embedded.exportFile(`prompts/${BASE_FILE}`, base);
    this.ctx.on('session/request', (request) => {
      this.onRequest(request);
    });
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

    //M 第一段 DSH 原文（每次现读，除去首尾空白一字不改）、第二段 jmbots 功能声明：用 unshift 放最前，不管插件排第几都是开头。
    const base = path.join(prompts, BASE_FILE);
    const baseText = fs.existsSync(base) ? fs.readFileSync(base, 'utf8').trim() : '';
    const declareFile = path.join(prompts, `10_jmbots.${language}.md`);
    const declare = fs.existsSync(declareFile) ? fs.readFileSync(declareFile, 'utf8').trim() : (DECLARE[language] ?? DECLARE['zh'] ?? '');
    request.system.unshift(...[baseText, declare].filter((text) => text !== ''));

    //M 第三段：这种会话的提示词。
    const file = path.join(this.ctx.resources.dir('prompts'), `${row.kind}.${language}.md`);
    const first = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim() : BUILT_IN[row.kind];
    if (first !== undefined && first !== '') {
      request.system.push(first);
    }

    //G 小会话不带人设和记忆。
    if (row.kind !== 'front' && row.kind !== 'work') return;

    //M 第四段：人设 bots/<机器人>/persona.md，有就带，任何一轮都带（里面只有身份和说话风格，不是私人记忆）。
    const persona = path.join(this.ctx.resources.dir('bots', row.bot), 'persona.md');
    const personaText = fs.existsSync(persona) ? fs.readFileSync(persona, 'utf8').trim() : '';
    if (personaText !== '') request.system.push(personaText);

    //G 非本人（builder、guest）、不受信的群里不带记忆：记忆目录里是用户的私人记忆，群里的回复大家都看得到。
    if (!workspaceModule.privateAllowed(row.address)) return;

    //M 记忆：两个目录下的 .md、.txt，按文件名的先后，一个文件一段。
    const dirs = [this.ctx.resources.dir('bots', row.bot, 'memory'), this.ctx.resources.dir('memory')];
    for (const dir of dirs) {
      const names = fs.readdirSync(dir).filter((item) => item.endsWith('.md') || item.endsWith('.txt'));
      for (const item of names.sort()) {
        const memory = fs.readFileSync(path.join(dir, item), 'utf8').trim();
        if (memory !== '') {
          request.system.push(memory);
        }
      }
    }
  }
}


/**
 * 挂上提示词。
 * apply 是 Cordis 插件的入口函数：Main.ts 里 app.plugin(本模块, 配置) 时，Cordis 先等 inject 里写的服务都就绪，
 * 再调一次 apply(ctx, 配置)。插件在 apply 里通过 ctx 听事件、登记工具；插件被拔掉时，这些登记自动撤掉。
 * 详见 plugins/Index.ts 的 PluginModule。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  new Prompt(ctx);
}
