/**
 * 记忆关系图谱页和 memory-graph 插件说话（同源相对地址）。令牌用 web/src/Token.ts（和主网页同一份）。
 * 接口见 src7/plugins/memory-graph/index.ts。
 */
import { TOKEN, withToken } from '../Token.ts';

/** 图上的点。kind：person 人、org 组织、item 编号/日期/数、thing 事（后端按名字猜，只用来上色）。 */
export interface GraphNode {
  id: number;
  name: string;
  kind: string;
  degree: number;
}

/** 图上的边：label 关系词，text 原句，docs 出自哪几段原文。 */
export interface GraphEdge {
  id: number;
  source: number;
  target: number;
  label: string;
  text: string;
  docs: number[];
}

/** 记忆关系图谱数据：包含当前展示的节点、边、全局总数以及可选的检索命中标记。 */
export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  total: { nodes: number; edges: number };
  hitEdges?: number[];
  hitNodes?: number[];
}

/** 一条命中原文。via：keyword / vector / graph 哪几路命中。 */
export interface Hit {
  id: number;
  title: string;
  snippet: string;
  score: number;
  via: string[];
  relations?: string[];
  customer: string;
  scope: string;
}

/** 记忆检索接口返回的完整结果，含命中原文、模式、问句实体、关系与命中子图。 */
export interface Found {
  hits: Hit[];
  mode: string;
  queryEntities: string[];
  relations: string[];
  total_ms: number;
  warnings?: string[];
  graph: Graph & { hitEdges: number[]; hitNodes: number[] };
}

/** 一段关联原文记录，含编号、标题、正文及归属客户/作用域。 */
export interface Doc {
  id: number;
  title: string;
  text: string;
  customer: string;
  scope: string;
}

/** 一个可选客户条目，含客户标识、所属机器人、文档段数与作用域。 */
export interface Customer {
  customer: string;
  bot: string;
  docs: number;
  scope: string;
}

/**
 * GET 一个接口，支持 AbortSignal 中止，出错抛接口给的 error。
 * @param path 同源相对接口路径（可已带查询参数）。
 * @param signal 可选请求取消信号。
 * @returns 解析后的 JSON 响应体。
 */
export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  //M 给相对接口地址拼上统一访问令牌并透传取消信号，供图谱页读取后端数据。
  const response = await fetch(withToken(path, TOKEN), { signal });
  const body = await response.json() as T & { error?: string };
  //G 后端返回非 2xx 时抛出错因，避免把错误载荷当正常结构继续渲染。
  if (!response.ok) throw new Error(body.error ?? String(response.status));
  return body;
}
