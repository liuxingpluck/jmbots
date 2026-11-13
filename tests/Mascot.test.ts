/**
 * 标题栏鲸鱼娘的离线测试（docs/界面/任务书/发0.2.6_DSH.md 第 1 步）：
 * moodOf 按进度和审核状态算出该显示哪种样子；Images.ts 的 40 张图都在、每张 whale/*.webp 文件都存在。
 * 组件长什么样靠 AOBB 截图核对，这里不起浏览器。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as types from '../web/src/Types.ts';


/** Mood 的几种值（和 Mascot.tsx 里的 Mood 一致）。 */
type Mood = 'idle' | 'dispatch' | 'work' | 'search' | 'wait' | 'done' | 'error';


/** 从 Mascot.tsx 里取出来的东西。 */
interface MascotModule {
  /** 从这个机器人的进度算出现在的状态。 */
  moodOf: (items: types.ProgressView[], waiting: boolean) => Mood;
}


/**
 * 动态加载 Mascot.tsx。
 * 路径写成变量，免得根目录的 tsconfig 把带 JSX 的 .tsx 拉进 tests 的编译范围（它没有配 jsx）。
 * @returns 测试要用的函数。
 */
async function loadMascot(): Promise<MascotModule> {
  /** 模块路径。 */
  const modulePath = '../web/src/Mascot/Mascot.tsx';
  return (await import(modulePath)) as MascotModule;
}


/**
 * 造一条进度。
 * @param patch 要改的字段。
 */
function progressOf(patch: Partial<types.ProgressView> = {}): types.ProgressView {
  return { id: 1, bot: '小测', messageIds: [1], text: '测试', stage: 'thinking', action: '调用模型', startedAt: Date.now(), ...patch };
}


bunTest.describe('鲸鱼娘的状态（moodOf）', () => {
  bunTest.test('分派中：dispatch', async () => {
    const mascot = await loadMascot();
    bunTest.expect(mascot.moodOf([progressOf({ stage: 'dispatching' })], false)).toBe('dispatch');
  });

  bunTest.test('机器人在等审核：wait', async () => {
    const mascot = await loadMascot();
    //M 机器人在等审核：没有进度也要显示等待。
    bunTest.expect(mascot.moodOf([], true)).toBe('wait');
    //M 有进度在跑、同时也在等审核：还是 wait。
    bunTest.expect(mascot.moodOf([progressOf()], true)).toBe('wait');
  });

  bunTest.test('动作里调用 find/read/memory/web_search：search', async () => {
    const mascot = await loadMascot();
    //M 四种算查资料的工具。
    for (const tool of ['find', 'read', 'memory', 'web_search']) {
      bunTest.expect(mascot.moodOf([progressOf({ action: `调用 ${tool} 做点什么` })], false)).toBe('search');
    }
    //M 别的工具不算查资料，按干活算。
    bunTest.expect(mascot.moodOf([progressOf({ action: '调用 edit 改文件' })], false)).toBe('work');
  });

  bunTest.test('别的在跑：work；几件事同时跑也是 work', async () => {
    const mascot = await loadMascot();
    bunTest.expect(mascot.moodOf([progressOf({ stage: 'thinking', action: '调用模型' })], false)).toBe('work');
    bunTest.expect(
      mascot.moodOf([progressOf({ id: 1, stage: 'thinking', action: '调用模型' }), progressOf({ id: 2, stage: 'running', action: '调用 exec' })], false),
    ).toBe('work');
  });

  bunTest.test('刚结束 8 秒内：done 是 done，error 是 error', async () => {
    const mascot = await loadMascot();
    /** 现在。 */
    const now = Date.now();
    //M 1 秒前做完：done。
    bunTest.expect(mascot.moodOf([progressOf({ stage: 'done', endedAt: now - 1000 })], false)).toBe('done');
    //M 1 秒前出错：error。
    bunTest.expect(mascot.moodOf([progressOf({ stage: 'error', endedAt: now - 1000 })], false)).toBe('error');
  });

  bunTest.test('都没有：idle；结束超过 8 秒的不算', async () => {
    const mascot = await loadMascot();
    bunTest.expect(mascot.moodOf([], false)).toBe('idle');
    //M 9 秒前结束的 done、error 都已经回到 idle。
    bunTest.expect(mascot.moodOf([progressOf({ stage: 'done', endedAt: Date.now() - 9000 })], false)).toBe('idle');
    bunTest.expect(mascot.moodOf([progressOf({ stage: 'error', endedAt: Date.now() - 9000 })], false)).toBe('idle');
  });

  bunTest.test('优先级：分派 > 等审核 > 查资料 > 干活 > 刚结束', async () => {
    const mascot = await loadMascot();
    /** 一堆同时存在的情况。 */
    const items = [
      progressOf({ id: 1, stage: 'dispatching', action: '调用模型' }),
      progressOf({ id: 3, stage: 'thinking', action: '调用 web_search 搜索' }),
      progressOf({ id: 4, stage: 'thinking', action: '调用模型' }),
      progressOf({ id: 5, stage: 'error', endedAt: Date.now() - 1000 }),
    ];
    //M 有分派就是分派，别的都往后排。
    bunTest.expect(mascot.moodOf(items, false)).toBe('dispatch');
    //M 去掉分派，查资料赢过干活。
    bunTest.expect(mascot.moodOf(items.slice(1), false)).toBe('search');
    //M 去掉查资料，只剩干活和刚结束的错误：干活优先。
    bunTest.expect(mascot.moodOf([items[2]!, items[3]!], false)).toBe('work');
    //M 等审核赢过查资料和干活。
    bunTest.expect(mascot.moodOf(items.slice(1), true)).toBe('wait');
  });
});


bunTest.describe('鲸鱼娘的图片（Images.ts）', () => {
  bunTest.test('40 张图都在，每张 whale/*.webp 文件都存在', async () => {
    /** 图片模块。 */
    const modulePath = '../web/src/Mascot/Images.ts';
    /** 图片清单。 */
    const images = (await import(modulePath)) as { IMAGES: Record<string, string> };
    /** 图片名。 */
    const names = Object.keys(images.IMAGES);
    //M 正好 40 张。
    bunTest.expect(names.length).toBe(40);
    //M 每个地址都是 /assets/<文件名>（打包后图片就在 assets/ 下）；每个名字在 whale/ 里有一张真的文件，大小不为 0。
    for (const name of names) {
      /** 图片地址。 */
      const url = images.IMAGES[name]!;
      bunTest.expect(url.startsWith('/assets/')).toBe(true);
      bunTest.expect(path.basename(url)).toBe(`${name}.webp`);
      /** 源文件。 */
      const file = path.join(import.meta.dir, '..', 'web', 'src', 'Mascot', 'whale', `${name}.webp`);
      bunTest.expect(fs.existsSync(file)).toBe(true);
      bunTest.expect(fs.statSync(file).size).toBeGreaterThan(0);
    }
    //M 文件夹里的 .webp 也正好是这 40 张，没有多的、少的。
    /** 文件夹。 */
    const whaleDir = path.join(import.meta.dir, '..', 'web', 'src', 'Mascot', 'whale');
    /** 文件夹里的图片名。 */
    const onDisk = fs.readdirSync(whaleDir).filter((item) => item.endsWith('.webp')).sort();
    bunTest.expect(onDisk).toEqual(names.map((name) => `${name}.webp`).sort());
  });
});
