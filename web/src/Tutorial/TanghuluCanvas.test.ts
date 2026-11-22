/// <reference types="bun" />
/**
 * 教程页「糖葫芦 + 列间事件菱形」画布拓扑与 9 步飞书消息旅程完整性自测。
 * 跑法：bun test web/src/Tutorial/TanghuluCanvas.test.ts
 */
import { describe, expect, test } from 'bun:test';
import * as tanghulu from './TanghuluData.ts';

describe('糖葫芦插件架构画布拓扑与飞书消息旅程', () => {
  test('包含 20 个糖葫芦纵列节点与 8 个列间事件菱形且源码路径均指向 src7/', () => {
    const allNodes = Object.values(tanghulu.TANGHULU_NODES);
    expect(allNodes.length).toBe(28);
    const tanghuluCount = allNodes.filter((n) => n.type === 'tanghulu').length;
    const diamondCount = allNodes.filter((n) => n.type === 'diamond').length;
    expect(tanghuluCount).toBe(20);
    expect(diamondCount).toBe(8);

    for (const node of allNodes) {
      expect(node.title.length).toBeGreaterThan(0);
      expect(node.human).toContain('【人话讲透】');
      expect(node.sourceDir).toContain('src7/');
      expect(node.schemaText.length).toBeGreaterThan(10);
    }
  });

  test('40 条有向事件连线起点终点均存在于节点表且生成合法的 SVG 路径', () => {
    expect(tanghulu.TANGHULU_EDGES.length).toBe(40);
    for (const edge of tanghulu.TANGHULU_EDGES) {
      expect(tanghulu.TANGHULU_NODES[edge.from]).toBeDefined();
      expect(tanghulu.TANGHULU_NODES[edge.to]).toBeDefined();
      const d = tanghulu.buildTanghuluEdgePath(edge);
      expect(d.startsWith('M ')).toBe(true);
    }
  });

  test('9 步飞书消息旅程覆盖从入站、列间菱形、四关口、知识检索到出站回执闭环', () => {
    expect(tanghulu.TANGHULU_JOURNEY.length).toBe(9);
    for (const [idx, step] of tanghulu.TANGHULU_JOURNEY.entries()) {
      expect(step.step).toBe(idx + 1);
      expect(tanghulu.TANGHULU_NODES[step.focusNode]).toBeDefined();
      for (const nid of step.activeNodes) {
        expect(tanghulu.TANGHULU_NODES[nid]).toBeDefined();
      }
    }
    const chain = tanghulu.getConnectedTanghuluChain('ev-ch-msg');
    expect(chain.upstreamNodes.has('ch-3')).toBe(true);
    expect(chain.downstreamNodes.has('bot-1')).toBe(true);
    expect(chain.activeEdgeIds.has('e-ch3-evmsg')).toBe(true);
  });
});
