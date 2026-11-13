/**
 * 技能列表、模型评价、三栏宽度、附件链接排版的离线测试（task-7）。
 * 全部在临时运行时目录里做，不读真实的 config.yaml，不联网；网页部分只测纯函数，不起浏览器。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as filesModule from '../src/capabilities/Files.ts';
import * as resourcesModule from '../src/resources/Resources.ts';
import * as attachments from '../web/src/Chat/Attachments.ts';
import * as widths from '../web/src/Layout/Widths.ts';


/**
 * 建一个临时运行时目录，里面有一个机器人“周小灵”。
 * @returns 资源、文件库和临时目录路径。
 */
async function setup(): Promise<{ resources: resourcesModule.Resources; files: filesModule.Files; dir: string }> {
  /** 临时运行时目录。 */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-files-resources-web-'));
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'providers: {}\nbots:\n  - name: 周小灵\n    language: zh\n');
  /** 资源。 */
  const resources = await resourcesModule.Resources.load(dir);
  /** 文件库。 */
  const files = new filesModule.Files(resources);
  await files.ensureBot('周小灵');
  return { resources, files, dir };
}


/**
 * 在某个技能根目录下写一个 SKILL.md。
 * @param root 技能根目录（全局 skills/ 或个人 skills/）。
 * @param folder 技能文件夹名。
 * @param content SKILL.md 原文。
 * @returns SKILL.md 的绝对路径。
 */
function writeSkill(root: string, folder: string, content: string): string {
  /** SKILL.md 的路径。 */
  const file = path.join(root, folder, 'SKILL.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}


/**
 * 假的浏览器本地存储。
 */
function memoryStorage(): Storage {
  /** 存的东西。 */
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}


bunTest.describe('技能列表', () => {
  bunTest.test('全局和个人都列；同名用个人的；不给机器人只看全局；个人 skills 不存在不报错', async () => {
    /** 文件库和临时目录。 */
    const { files, dir } = await setup();
    //M 全局先放两个技能：一个独有，一个和个人同名。
    /** 全局独有。 */
    const globalOnly = writeSkill(path.join(dir, 'skills'), 'alpha', '---\nname: alpha\ndescription: 全局技能\n---\n# 正文');
    /** 全局的同名技能。 */
    const sharedGlobal = writeSkill(path.join(dir, 'skills'), 'shared', '---\nname: shared\ndescription: 全局版\n---\n');
    //M 个人再放两个：一个独有，一个覆盖全局。
    /** 个人独有。 */
    const personalOnly = writeSkill(path.join(dir, 'bots', '周小灵', 'skills'), 'beta', '---\nname: beta\ndescription: 个人技能\n---\n');
    /** 个人的同名技能。 */
    const sharedPersonal = writeSkill(path.join(dir, 'bots', '周小灵', 'skills'), 'shared', '---\nname: shared\ndescription: 个人版\n---\n');
    //M 结果按名字排；同名只留个人那条，file 指向个人文件。
    bunTest.expect(await files.listSkills('周小灵')).toEqual([
      { name: 'alpha', description: '全局技能', file: globalOnly },
      { name: 'beta', description: '个人技能', file: personalOnly },
      { name: 'shared', description: '个人版', file: sharedPersonal },
    ]);
    //M 不给机器人：只看全局，同名用全局的。
    bunTest.expect(await files.listSkills()).toEqual([
      { name: 'alpha', description: '全局技能', file: globalOnly },
      { name: 'shared', description: '全局版', file: sharedGlobal },
    ]);
    //M 机器人没有个人 skills/：不报错，还是只列全局。
    bunTest.expect(await files.listSkills('没有个人技能')).toEqual([
      { name: 'alpha', description: '全局技能', file: globalOnly },
      { name: 'shared', description: '全局版', file: sharedGlobal },
    ]);
  });
});


bunTest.describe('模型评价', () => {
  bunTest.test('memory/模型评价.md 有就优先，没有才读 knowledge/模型评价.md', async () => {
    /** 资源和临时目录。 */
    const { resources, dir } = await setup();
    /** 旧位置的文件。 */
    const oldFile = path.join(dir, 'knowledge', '模型评价.md');
    /** 公共记忆里的文件。 */
    const sharedFile = path.join(dir, 'memory', '模型评价.md');
    //M 两个都没有：空字符串。
    bunTest.expect(await resources.readModelReview()).toBe('');
    //M 只有旧位置：读旧的。
    fs.mkdirSync(path.dirname(oldFile), { recursive: true });
    fs.writeFileSync(oldFile, '旧位置里的评价');
    bunTest.expect(await resources.readModelReview()).toBe('旧位置里的评价');
    //M 新位置也有了：优先读新的。
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile, '公共记忆里的评价');
    bunTest.expect(await resources.readModelReview()).toBe('公共记忆里的评价');
  });

  bunTest.test('超过 1200 字截断，并写明全文路径', async () => {
    /** 资源和临时目录。 */
    const { resources, dir } = await setup();
    /** 公共记忆里的文件。 */
    const sharedFile = path.join(dir, 'memory', '模型评价.md');
    /** 1300 字的评价。 */
    const long = '评'.repeat(1300);
    fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
    fs.writeFileSync(sharedFile, long);
    //M 前 1200 字原样，后面一句说明共多少字、去哪看全文。
    bunTest.expect(await resources.readModelReview()).toBe(`${long.slice(0, 1200)}\n……（模型评价共 1300 字，这里只给前 1200 字；要看全文读 ${sharedFile}）`);
  });
});


bunTest.describe('三栏宽度', () => {
  bunTest.test('clampWidths 左栏不超过 MAX_LEFT_WIDTH（右栏展开、收起都算）', () => {
    /** 存过的、过大的左栏。 */
    const wanted = { left: 999, right: 420 };
    //M 右栏展开：左栏收回上限。
    const open = widths.clampWidths(1600, wanted, true);
    bunTest.expect(open.left).toBe(widths.MAX_LEFT_WIDTH);
    bunTest.expect(open.left).toBeLessThanOrEqual(widths.MAX_LEFT_WIDTH);
    //M 右栏收起也一样。
    const closed = widths.clampWidths(1600, wanted, false);
    bunTest.expect(closed.left).toBe(widths.MAX_LEFT_WIDTH);
    bunTest.expect(closed.left).toBeLessThanOrEqual(widths.MAX_LEFT_WIDTH);
  });

  bunTest.test('loadWidths 读到存过的 999，交给 clamp 也收回不超过 300', () => {
    /** 假的浏览器本地存储。 */
    const storage = memoryStorage();
    storage.setItem('jmbots.columns', JSON.stringify({ left: 999, right: 420 }));
    /** 读回来的旧宽度。 */
    const loaded = widths.loadWidths(storage);
    bunTest.expect(loaded).toEqual({ left: 999, right: 420 });
    //M 旧版本存的 999 直接上界面会被 clamp 收回上限。
    bunTest.expect(widths.clampWidths(1600, loaded, true).left).toBeLessThanOrEqual(widths.MAX_LEFT_WIDTH);
    bunTest.expect(widths.clampWidths(1600, loaded, false).left).toBeLessThanOrEqual(widths.MAX_LEFT_WIDTH);
  });
});


bunTest.describe('附件链接排版', () => {
  bunTest.test('文字后面的附件另起一段（中间空行）', () => {
    /** 换成链接后的文字。 */
    const linked = attachments.withAttachmentLinks('看看 @F:/a/1.png');
    //M 文字和附件之间是空行，附件后面的空位原样保留。
    bunTest.expect(linked).toBe(`看看 \n\n[1.png](${attachments.FILE_SCHEME}${encodeURIComponent('F:/a/1.png')}) `);
    bunTest.expect(linked).toContain('\n\n[');
  });

  bunTest.test('连着的几个附件在同一段，中间只有空格没有空行', () => {
    /** 两个附件连着的文字。 */
    const linked = attachments.withAttachmentLinks('@F:/a/1.png @F:/a/2.png');
    bunTest.expect(linked).not.toContain('\n');
    /** 第一个链接结束到第二个链接开始之间的字符。 */
    const firstEnd = linked.indexOf(')') + 1;
    const secondStart = linked.indexOf('[', firstEnd);
    const between = linked.slice(firstEnd, secondStart);
    bunTest.expect(between.length).toBeGreaterThan(0);
    bunTest.expect(between.trim()).toBe('');
  });

  bunTest.test('全是附件时开头最多一个空格，不会变成代码块', () => {
    /** 两个附件、没有文字。 */
    const linked = attachments.withAttachmentLinks('@F:/a/1.png @F:/a/2.png');
    /** 开头的空格。 */
    const leading = /^ */.exec(linked)?.[0] ?? '';
    bunTest.expect(leading.length).toBeLessThanOrEqual(1);
    bunTest.expect(linked.startsWith('    [')).toBe(false);
  });
});
