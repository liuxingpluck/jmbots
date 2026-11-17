/**
 * 记忆关系图谱页和 memory-graph 插件说话（同源相对地址）。令牌用 web/src/Token.ts（和主网页同一份）。
 * 接口见 src7/plugins/memory-graph/index.ts。
 */

/** 图上的点。kind：person 人、org 组织、item 编号/日期/数、thing 事（后端按名字猜，只用来上色）。 */
export interface GraphNode { id: number; name: string; kind: string; degree: number }
/** 图上的边：label 关系词，text 原句，docs 出自哪几段原文。 */
export interface GraphEdge { id: number; source: number; target: number; label: string; text: string; docs: number[] }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[]; total: { nodes: number; edges: number }; hitEdges?: number[]; hitNodes?: number[] }
/** 一条命中原文。via：keyword / vector / graph 哪几路命中。 */
export interface Hit { id: number; title: string; snippet: string; score: number; via: string[]; relations?: string[]; customer: string; scope: string }
export interface Found { hits: Hit[]; mode: string; queryEntities: string[]; relations: string[]; total_ms: number; warnings?: string[]; graph: Graph & { hitEdges: number[]; hitNodes: number[] } }
export interface Doc { id: number; title: string; text: string; customer: string; scope: string }
export interface Customer { customer: string; bot: string; docs: number; scope: string }

//M 2026-11-14 22:50 EST：令牌用 Token.ts 那一份（会从地址栏去掉 ?token=）。
import { TOKEN, withToken } from '../Token.ts';

/** GET 一个接口，出错抛接口给的 error。 */
export async function get<T>(path: string): Promise<T> {
  const response = await fetch(withToken(path, TOKEN));
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? String(response.status));
  return body;
}
