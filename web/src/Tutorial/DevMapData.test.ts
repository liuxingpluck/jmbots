/// <reference types="bun" />
/**
 * 开发地图防漂移自测：DevMapData.ts 里每个源码位置的 mark，必须真的出现在那个文件 line 上下 3 行内。
 * 改了源码导致行号漂移时这里变红，照报错改 DevMapData.ts 的行号即可。
 * 跑法：bun test web/src/Tutorial/DevMapData.test.ts
 */
import { describe, expect, test } from 'bun:test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as data from './DevMapData.ts';

/** 项目根：本文件在 web/src/Tutorial/ 下，往上三层。 */
const ROOT = path.join(import.meta.dir, '..', '..', '..');

/** 允许 mark 离标注的行号差几行。 */
const SLACK = 3;


/**
 * 在文件里找 mark 落在哪几行（只看 line 上下 SLACK 行）。
 * @param anchor 源码位置。
 * @returns 命中的行号；空数组就是漂了。
 */
function getHits(anchor: data.DevAnchor): number[] {
  const text = fs.readFileSync(path.join(ROOT, anchor.file), 'utf8');
  const lines = text.split(/\r?\n/u);
  const hits: number[] = [];
  const from = Math.max(1, anchor.line - SLACK);
  const to = Math.min(lines.length, anchor.line + SLACK);
  for (let no = from; no <= to; no += 1) {
    if (lines[no - 1]?.includes(anchor.mark) === true) {
      hits.push(no);
    }
  }
  return hits;
}


describe('开发地图源码锚点', () => {
  test('每张卡都有标题、条目，每条都有源码位置', () => {
    expect(data.DEV_CARDS.length).toBeGreaterThanOrEqual(6);
    for (const card of data.DEV_CARDS) {
      expect(card.items.length).toBeGreaterThan(0);
      for (const item of card.items) {
        expect(item.anchors.length).toBeGreaterThan(0);
      }
    }
  });

  test('每个 mark 都在标注行上下 3 行内', () => {
    //M 一次收齐所有漂移的，报错时一眼看全。
    const drifted: string[] = [];
    for (const card of data.DEV_CARDS) {
      for (const item of card.items) {
        for (const anchor of item.anchors) {
          if (getHits(anchor).length > 0) continue;

          drifted.push(`${data.getSite(anchor)} 找不到「${anchor.mark}」`);
        }
      }
    }
    expect(drifted).toEqual([]);
  });

  test('数据读写卡正好 6 个断点', () => {
    const card = data.DEV_CARDS.find((one) => one.key === 'data');
    expect(card?.items.length).toBe(6);
  });
});
