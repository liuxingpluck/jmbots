/**
 * 技能：干活的会话每一步调模型前，扫全局 skills/ 和机器人自己的 bots/<机器人>/skills/，
 * 每个技能一行“名字：一句说明（@SKILL.md 的路径）”拼进系统提示词；再登记一个只读工具 skill，按名字交回那份 SKILL.md 全文。
 * 为什么另加 skill 工具：技能文件在工作区外面，base-tools 的 read 只许读工作区，模型读不到（skills.md 第 10 节第 1 条，总管 11-14 定了甲案）。
 * 照 0.4 src/capabilities/Files.ts:1132-1183。设计：docs/src7插件设计/skills.md。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import * as yaml from 'yaml';


/** 插件名。 */
export const name = 'skills';

/** 用到的服务：resources 拿目录；tools 登记 skill 工具。 */
export const inject = ['resources', 'tools'];


/** 说明最多几个字。 */
const DESCRIPTION_MAX = 200;

/** 技能清单那段的标题和说明（照 0.4 AgentLoop.ts:152-155，读的那句改成用 skill 工具）。 */
const HEAD = '# 技能\n\nskills/ 下的技能。要做的事对得上哪个，先用 skill 工具读它的 SKILL.md 再照着做：';


/** 一个技能。 */
export interface Skill {
  name: string;
  description: string;
  file: string;
}


/**
 * 扫几个技能根目录。同名时后面的盖掉前面的（先全局、后个人，个人优先），按名字排。
 * @param roots 根目录，先全局后个人。
 */
export function list(roots: string[]): Skill[] {
  const found = new Map<string, Skill>();
  for (const root of roots) {
    const entries = fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }) : [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;

      const file = path.join(root, entry.name, 'SKILL.md');
      const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
      if (text.trim() === '') continue;

      //M 开头有 ---…--- 就用 yaml 解析出 name、description；解析坏了当没有。
      let head: Record<string, unknown> = {};
      let body = text;
      const front = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/u.exec(text);
      if (front !== null) {
        body = text.slice(front[0].length);
        try {
          const parsed: unknown = yaml.parse(front[1] ?? '');
          if (typeof parsed === 'object' && parsed !== null) head = parsed as Record<string, unknown>;
        } catch {
          head = {};
        }
      }
      const skillName = (typeof head['name'] === 'string' ? head['name'].trim() : '') || entry.name;
      const firstLine = body.split(/\r?\n/u).map((line) => line.trim()).find((line) => line !== '') ?? '';
      let description = (typeof head['description'] === 'string' ? head['description'] : '') || firstLine.replace(/^#+\s*/u, '');
      description = description.replace(/\s+/gu, ' ').trim();
      if ([...description].length > DESCRIPTION_MAX) description = `${[...description].slice(0, DESCRIPTION_MAX).join('')}…`;
      found.set(skillName, { name: skillName, description, file });
    }
  }
  return [...found.values()].sort((left, right) => left.name.localeCompare(right.name));
}


/**
 * 挂上技能。
 * apply 是 Cordis 插件的入口：inject 里的服务就绪后 Cordis 调一次。没有配置。
 * @param ctx Cordis 给这个插件的 ctx。
 */
export function apply(ctx: cordis.Context): void {
  /** 这个机器人能用的技能：先全局后个人。每次现扫，不缓存（改了马上生效）。 */
  const skillsOf = (bot: string): Skill[] => list([ctx.resources.dir('skills'), ctx.resources.dir('bots', bot, 'skills')]);

  //M 听 session/request：只给干活的会话加技能清单（前台、小会话不带，同 0.4）。
  ctx.on('session/request', (request) => {
    const row = request.session.row;
    if (row.kind !== 'work') return;

    const skills = skillsOf(row.bot);
    if (skills.length === 0) return;
    request.system.push(`${HEAD}\n${skills.map((skill) => `- ${skill.name}：${skill.description}（@${skill.file}）`).join('\n')}`);
  });

  //M 只读工具 skill：按名字（清单里的名字）交回 SKILL.md 全文；同一个技能文件夹里的别的文件用 file 参数读。
  ctx.tools.register({
    definition: {
      name: 'skill',
      description: '读一个技能：name 是技能清单里的名字，交回它的 SKILL.md 全文。'
        + 'SKILL.md 里提到同一个技能文件夹里的别的文件（脚本、模板）时，用 file 给相对技能文件夹的路径来读。只读，不能改。',
      parameters: piAi.Type.Object({
        name: piAi.Type.String({ description: '技能名' }),
        file: piAi.Type.Optional(piAi.Type.String({ description: '技能文件夹里的别的文件，相对路径；不给就是 SKILL.md' })),
      }),
    },
    kinds: ['work'],
    run: (args, session) => {
      const skills = skillsOf(session.row.bot);
      const skill = skills.find((item) => item.name === args['name']);
      if (skill === undefined) {
        throw new Error(`没有技能「${String(args['name'])}」。有的是：${skills.map((item) => item.name).join('、') || '（一个也没有）'}`);
      }
      const folder = path.dirname(skill.file);
      const target = path.resolve(folder, typeof args['file'] === 'string' && args['file'] !== '' ? args['file'] : 'SKILL.md');
      const back = path.relative(folder, target);
      if (back.startsWith('..') || path.isAbsolute(back)) throw new Error(`只能读技能文件夹 ${folder} 里的文件`);
      if (!fs.existsSync(target) || !fs.statSync(target).isFile()) throw new Error(`技能里没有这个文件：${back}`);
      return fs.readFileSync(target, 'utf8');
    },
  });
}
