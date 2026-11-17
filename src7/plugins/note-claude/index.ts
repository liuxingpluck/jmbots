/**
 * 工具 note_claude：给 Claude（帮用户写 jmbots 代码的 AI）留言，在 integrations/claude/inbox/ 写一个 md 文件。
 * Claude 那边用 ztools/claude-link/Claude_Link.mjs 自己来取（文件名要以 20 位时刻开头，它才排得对先后）。不读、不等回复、不通知谁。
 * 照 0.4 src/capabilities/tools/Tools.ts:601-611、1543-1564。设计：docs/src7插件设计/note-claude.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import { safeName, stampId } from '../../utils/Names.ts';


/** 插件名。 */
export const name = 'note-claude';

/** 用到的服务：resources 找目录；tools 登记工具。 */
export const inject = ['resources', 'tools'];


/**
 * 登记 note_claude。没有状态，不建 class。
 * apply 是 Cordis 插件的入口：inject 里的服务都就绪后调一次。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  //M tools.register：前台和后台都给（用户对前台说“告诉 Claude ……”时不用转后台）；小会话不给。
  ctx.tools.register({
    definition: {
      name: 'note_claude',
      description: '给 Claude（帮用户写 jmbots 代码的 AI）留话：用户的话是说给 Claude 的（原话一字不改转过去）、发现 jmbots 自己的问题、卡住了想让 Claude 看。'
        + '写成一个文件，Claude 定时看；不会马上有回复。',
      parameters: piAi.Type.Object({
        title: piAi.Type.String({ description: '一句话标题' }),
        text: piAi.Type.String({ description: '要说的话：发生了什么、在哪个会话、希望 Claude 做什么' }),
      }),
    },
    kinds: ['front', 'work'],
    run: (args, session) => {
      const title = String(args['title']);
      //M resources.dir：运行时目录下的文件夹，没有就建。
      const file = path.join(ctx.resources.dir('integrations', 'claude', 'inbox'), `${stampId()}_${safeName(title)}.md`);
      const time = new Date().toLocaleString('sv-SE');
      fs.writeFileSync(file, `# ${title}\n\n- 机器人：${session.row.bot}\n- 会话：${session.row.id}\n- 时间：${time}\n\n${String(args['text'])}\n`, 'utf8');
      //T 跟踪：给 Claude 留言。
      ctx.emit('trace', 'NoteClaude.run', '给 Claude 留言', 'fs.writeFileSync', { 会话: session.row.id, 文件: file });
      return `已留给 Claude：${file}`;
    },
  });
}
