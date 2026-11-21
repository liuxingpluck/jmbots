/// <reference types="bun" />
/**
 * 竖线全景防漂移自测：SpineCanvas.tsx 里每个源码锚点的 mark，必须真的出现在 site 写的那个文件、那一行上下 3 行内。
 * 改了源码导致行号漂移时这里变红，照报错改 SpineCanvas.tsx 里那条 site 的行号即可（和 DevMapData.test.ts 一个办法）。
 * 跑法：bun test web/src/Tutorial/SpineCanvas.test.ts
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as spine from './SpineCanvas.tsx';

/** 项目根：本文件在 web/src/Tutorial/ 下，往上三层。 */
const ROOT = path.join(import.meta.dir, '..', '..', '..');

/** 允许 mark 离标注的行号差几行。 */
const SLACK = 3;


/**
 * 收齐两条主轴上全部锚点：主轴节点、紫色侧卡、工具循环支路里的节点。
 * @returns 全部锚点，照出现的先后。
 */
function getAllAnchors(): spine.SpineAnchor[] {
  const anchors: spine.SpineAnchor[] = [];
  for (const step of [...spine.BOOT_SPINE_STEPS, ...spine.SESSION_SPINE_STEPS]) {
    if (step.kind === 'tool-loop') {
      for (const node of step.steps) {
        anchors.push(...node.anchors);
      }
      continue;
    }
    anchors.push(...step.node.anchors);
    if (step.side !== undefined) {
      anchors.push(...step.side.anchors);
    }
  }
  return anchors;
}


/**
 * 锚点的 mark 在不在 site 那一行上下 SLACK 行里。
 * @param anchor 源码锚点。
 * @returns 命中的行号；空数组就是漂了。
 */
function getHits(anchor: spine.SpineAnchor): number[] {
  const colon = anchor.site.lastIndexOf(':');
  const file = anchor.site.slice(0, colon);
  const line = Number(anchor.site.slice(colon + 1));
  const lines = fs.readFileSync(path.join(ROOT, file), 'utf8').split(/\r?\n/u);
  const hits: number[] = [];
  const from = Math.max(1, line - SLACK);
  const to = Math.min(lines.length, line + SLACK);
  for (let no = from; no <= to; no += 1) {
    if (lines[no - 1]?.includes(anchor.mark) === true) {
      hits.push(no);
    }
  }
  return hits;
}


describe('竖线全景源码锚点', () => {
  test('每个锚点都写了 site 和 mark', () => {
    const anchors = getAllAnchors();
    expect(anchors.length).toBeGreaterThanOrEqual(72);
    for (const anchor of anchors) {
      expect(anchor.site).toMatch(/^src7\/.+\.ts:\d+$/u);
      expect(anchor.mark.length).toBeGreaterThan(0);
    }
  });

  test('每个 mark 都在标注行上下 3 行内', () => {
    //M 一次收齐所有漂移的，报错时一眼看全。
    const drifted: string[] = [];
    for (const anchor of getAllAnchors()) {
      if (getHits(anchor).length > 0) continue;

      drifted.push(`${anchor.site} 找不到「${anchor.mark}」`);
    }
    expect(drifted).toEqual([]);
  });
});
