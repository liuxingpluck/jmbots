/// <reference types="bun" />
/**
 * 极限压缩认知架构（CompactMetaData.ts）完整性、工作记忆上限与 ≤30 字防啰嗦守卫自测。
 * 跑法：bun test web/src/Tutorial/CompactMetaData.test.ts
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as meta from './CompactMetaData.ts';

/** 项目根目录：本测试位于 web/src/Tutorial/ 下，往上三层。 */
const ROOT_DIR = path.join(import.meta.dir, '..', '..', '..');

/** 真实插件源码根目录（仅用 readdirSync 读目录名，不读取任何插件内部文件内容）。 */
const PLUGINS_DIR = path.join(ROOT_DIR, 'src7', 'plugins');

/** 组块阅读文档目录（校验学习路线引用的 .md 篇目全部真实存在）。 */
const READINGS_DIR = path.join(ROOT_DIR, 'src7', 'docs', '组块阅读');

/** 每条展示短句与卡片字段的硬性字数红线。 */
const MAX_FIELD_CHARS = 30;


/**
 * 计算文本的真实 Unicode 字符数。
 * @param text 待检查文案。
 */
function countChars(text: string): number {
  return [...text].length;
}


/**
 * 动态扫描 src7/plugins 下的真实子目录名（自动跳过 Index.ts 等非目录文件）并按字典序返回。
 */
function listRealPluginDirs(): string[] {
  return fs
    .readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}


/**
 * 收集 BLOCKS 内全部子角色挂载的插件名序列（保留重复项以便检测重复归组）。
 */
function collectBlockPlugins(): string[] {
  const names: string[] = [];
  for (const block of meta.BLOCKS) {
    for (const role of block.roles) {
      for (const pluginName of role.plugins) {
        names.push(pluginName);
      }
    }
  }
  return names;
}


bunTest.describe('极限压缩元模型（CompactMetaData）红线守卫', () => {
  bunTest.test('真实 src7/plugins 子目录集合 === BLOCKS 全部插件 === CARDS 键集合，无遗漏无重复', () => {
    //M 动态扫描 src7/plugins 下的真实子目录（自动跳过 Index.ts 等非目录文件）。
    const realDirs = listRealPluginDirs();

    const blockPlugins = collectBlockPlugins();
    const uniqueBlockPlugins = [...new Set(blockPlugins)].sort();
    const cardKeys = Object.keys(meta.CARDS).sort();

    //M 严禁同一个插件在多个块或子角色重复出现。
    bunTest.expect(blockPlugins.length).toBe(uniqueBlockPlugins.length);
    bunTest.expect(uniqueBlockPlugins).toEqual(realDirs);
    bunTest.expect(cardKeys).toEqual(realDirs);
  });

  bunTest.test('工作记忆红线：5 原子、3 连线、L0 ≤ 5 块、每块 L1 ≤ 6 角色、每角色 ≤ 3 插件', () => {
    bunTest.expect(meta.ATOMS.length).toBe(5);
    bunTest.expect(meta.LINKS.length).toBe(3);
    bunTest.expect(meta.BLOCKS.length).toBeGreaterThan(0);
    bunTest.expect(meta.BLOCKS.length).toBeLessThanOrEqual(5);

    for (const atom of meta.ATOMS) {
      //M 确认原子标注的源码文件在仓库中真实存在。
      const colon = atom.site.lastIndexOf(':');
      const relFile = atom.site.slice(0, colon);
      bunTest.expect(colon).toBeGreaterThan(0);
      bunTest.expect(fs.existsSync(path.join(ROOT_DIR, relFile))).toBe(true);
    }

    for (const block of meta.BLOCKS) {
      bunTest.expect(block.roles.length).toBeGreaterThan(0);
      bunTest.expect(block.roles.length).toBeLessThanOrEqual(6);
      for (const role of block.roles) {
        bunTest.expect(role.plugins.length).toBeGreaterThan(0);
        bunTest.expect(role.plugins.length).toBeLessThanOrEqual(3);
      }
    }
  });

  bunTest.test('防啰嗦红线：所有原子、连线、块、子角色展示文案及 Card 三字段均非空且 ≤ 30 字符', () => {
    /** 收集所有超长或空串违规项，报错时一次性定位。 */
    const violations: string[] = [];

    const checkText = (label: string, value: string): void => {
      const len = countChars(value.trim());
      if (len === 0) {
        violations.push(`${label} 不能为空`);
        return;
      }
      if (len > MAX_FIELD_CHARS) {
        violations.push(`${label} 超出 ${String(MAX_FIELD_CHARS)} 字（实测 ${String(len)} 字）：${value}`);
      }
    };

    for (const atom of meta.ATOMS) {
      checkText(`ATOM[${atom.id}].name`, atom.name);
      checkText(`ATOM[${atom.id}].line`, atom.line);
      checkText(`ATOM[${atom.id}].site`, atom.site);
    }

    for (const link of meta.LINKS) {
      checkText(`LINK[${link.name}].name`, link.name);
      checkText(`LINK[${link.name}].line`, link.line);
    }

    for (const block of meta.BLOCKS) {
      checkText(`BLOCK[${block.id}].name`, block.name);
      checkText(`BLOCK[${block.id}].line`, block.line);
      for (const role of block.roles) {
        checkText(`ROLE[${block.id}/${role.name}].name`, role.name);
      }
    }

    for (const pluginName of Object.keys(meta.CARDS)) {
      const card = meta.CARDS[pluginName];
      if (card === undefined) {
        continue;
      }
      checkText(`CARD[${pluginName}].duty`, card.duty);
      checkText(`CARD[${pluginName}].hook`, card.hook);
      checkText(`CARD[${pluginName}].io`, card.io);
    }

    bunTest.expect(violations).toEqual([]);
  });

  bunTest.test('纵向学习路线守卫：STAGES ≤ 4 段、每段 ≤ 4 块、每块 3~5 概念，且引用 .md 篇目全部真实存在', () => {
    bunTest.expect(meta.STAGES.length).toBeGreaterThan(0);
    bunTest.expect(meta.STAGES.length).toBeLessThanOrEqual(4);

    /** 收集死链或越界项，一次性报错。 */
    const problems: string[] = [];

    for (const stage of meta.STAGES) {
      if (stage.title.trim() === '' || stage.unlock.trim() === '') {
        problems.push(`STAGE[${stage.id}] 缺少标题或解锁目标`);
      }
      if (stage.chunks.length === 0 || stage.chunks.length > 4) {
        problems.push(`STAGE[${stage.id}] 块数越界：${String(stage.chunks.length)}`);
      }
      for (const chunk of stage.chunks) {
        const count = chunk.concepts.length;
        if (count < 3 || count > 5) {
          problems.push(`CHUNK[${chunk.id}] 概念数须在 3~5 之间，实测 ${String(count)}`);
        }
        if (chunk.lab.trim() === '' || chunk.quiz.trim() === '') {
          problems.push(`CHUNK[${chunk.id}] 缺少实验或自测题`);
        }
        if (chunk.docs.length === 0) {
          problems.push(`CHUNK[${chunk.id}] 未关联任何组块篇目`);
        }
        for (const docFile of chunk.docs) {
          if (!docFile.endsWith('.md')) {
            problems.push(`CHUNK[${chunk.id}] 篇目须带 .md 后缀：${docFile}`);
          }
          if (!fs.existsSync(path.join(READINGS_DIR, docFile))) {
            problems.push(`CHUNK[${chunk.id}] 篇目不存在：src7/docs/组块阅读/${docFile}`);
          }
        }
      }
    }

    bunTest.expect(problems).toEqual([]);
  });

  bunTest.test('洋葱圈守卫：4 层同心圆（1 骨架核 + 3 插件环）覆盖全部 34 插件、全在 CARDS 且文案 ≤ 30 字', () => {
    //M 核验严格 4 层：1 个圆心骨架核（level=0）+ 3 个非核心插件环（level=1..3）。
    bunTest.expect(meta.ONION_RINGS.length).toBe(4);
    const coreRings = meta.ONION_RINGS.filter((ring) => ring.isCore === true);
    const pluginRings = meta.ONION_RINGS.filter((ring) => ring.isCore !== true);
    bunTest.expect(coreRings.length).toBe(1);
    bunTest.expect(pluginRings.length).toBe(3);

    const levels = meta.ONION_RINGS.map((ring) => ring.level);
    bunTest.expect(levels).toEqual([0, 1, 2, 3]);

    //M 收集非核心 3 环的全部插件名，校验零重复、零遗漏且全部在 CARDS 中存在。
    const ringPlugins: string[] = [];
    for (const ring of pluginRings) {
      for (const pluginName of ring.items) {
        ringPlugins.push(pluginName);
      }
    }
    const uniqueRingPlugins = [...new Set(ringPlugins)].sort();
    const realDirs = listRealPluginDirs();

    bunTest.expect(ringPlugins.length).toBe(uniqueRingPlugins.length);
    bunTest.expect(uniqueRingPlugins).toEqual(realDirs);

    const missingCards: string[] = [];
    for (const pluginName of uniqueRingPlugins) {
      if (meta.CARDS[pluginName] === undefined) {
        missingCards.push(pluginName);
      }
    }
    bunTest.expect(missingCards).toEqual([]);

    //M 核验各环名称、副标、职责摘要均非空且严格 ≤ 30 字符。
    const violations: string[] = [];
    const checkField = (label: string, value: string): void => {
      const len = countChars(value.trim());
      if (len === 0) {
        violations.push(`${label} 不能为空`);
        return;
      }
      if (len > MAX_FIELD_CHARS) {
        violations.push(`${label} 超出 ${String(MAX_FIELD_CHARS)} 字（实测 ${String(len)} 字）：${value}`);
      }
    };

    for (const ring of meta.ONION_RINGS) {
      checkField(`ONION[${ring.id}].name`, ring.name);
      checkField(`ONION[${ring.id}].tagline`, ring.tagline);
      checkField(`ONION[${ring.id}].summary`, ring.summary);
    }

    bunTest.expect(violations).toEqual([]);
  });
});
