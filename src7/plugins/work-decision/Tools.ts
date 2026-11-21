/**
 * 工作决策的模型工具：
 *   ask_owner（后台会话）：把要主人定的事登记成待定节点；
 *   work_topics（前后台会话，只读）：查决策图的专题和节点，拿 topicId 配合 kb_search、kb_save 用。
 * 两个工具都只给本人会话用。
 */
import * as crypto from 'node:crypto';
import * as piAi from '@earendil-works/pi-ai';
import type * as cordis from 'cordis';
import * as protocol from '../channels/index.ts';
import * as notifications from './Notify.ts';
import type * as storeModule from './Store.ts';
import * as types from './Types.ts';

/** 登记 ask_owner，收件身份和工作区来自当前会话。 */
export function registerAskOwner(
  ctx: cordis.Context,
  store: storeModule.Store,
  notice: notifications.OwnerNotice | undefined,
): void {
  const parameters = piAi.Type.Object({
    title: piAi.Type.String(),
    summary: piAi.Type.String(),
    options: piAi.Type.Array(piAi.Type.Object({
      id: piAi.Type.String(),
      text: piAi.Type.String(),
      recommended: piAi.Type.Optional(piAi.Type.Boolean()),
      cost: piAi.Type.Optional(piAi.Type.String()),
    }), { minItems: 2, maxItems: 8 }),
    body: piAi.Type.Optional(piAi.Type.String()),
  });
  //M 只给后台会话登记异步提问工具。
  ctx.tools.register({
    definition: {
      name: 'ask_owner',
      description: '把需要主人决定的事登记到工作决策。给出标题、一句话背景和选项，可附 Markdown 正文。主人选完会把结果送回本会话。',
      parameters,
    },
    sessionKinds: ['work'],
    run(args, session, _signal, callId) {
      const row = session.row;
      //G 工作决策可通知主人并写入本人项目，工具须确认会话属于本人。
      const isOwner = protocol.isOwnerTurn(row.channel, row.address);
      if (!isOwner) throw new Error('只有本人会话可以登记工作决策');

      //M 工具从已绑定会话取项目和回执去向，并用工具调用号识别重试。
      const hash = crypto.createHash('sha256');
      const source = JSON.stringify([row.id, callId]);
      const digest = hash.update(source).digest('hex');
      const id = `ask-${digest.slice(0, 24)}`;
      const input = {
        ...args,
        id,
        bot: row.bot,
        workspaceId: row.workspaceId,
        asker: { kind: 'session', sessionId: row.id },
      } as types.DecisionAsk;
      //M 幂等提问与正常接口共用工作区和选项校验。
      const saved = store.ask(input);
      //M 写入待定项后请求通知，工具立即交回节点。
      notifications.notifyNew(ctx, notice, saved.graph, saved.tasks);

      //M 决策编号既是重试键，也是页面的直达链接。
      const query = new URLSearchParams({ focus: id });
      const url = `${notifications.PAGE}?${query.toString()}`;
      return JSON.stringify({ id, url });
    },
  });
}


/** 状态的中文徽章。 */
const STATUS_LABELS: Record<types.DecisionStatus, string> = {
  open: '待定',
  decided: '已定',
  working: '进行中',
  done: '已完成',
  dropped: '已放弃',
};

/** 列表的先后：待定、进行中排前面，同状态新的在前。 */
const STATUS_ORDER: readonly types.DecisionStatus[] = ['open', 'working', 'decided', 'done', 'dropped'];

/** 不传 limit 时列几条。 */
const TOPIC_LIMIT = 15;

/** 列表里一句话摘要最多几个字。 */
const LINE_SUMMARY_MAX = 60;

/** 详情里正文最多几个字，太长的截掉，免得撑爆上下文。 */
const BODY_MAX = 2000;

/** 详情里最多带最近几条留言。 */
const NOTES_MAX = 5;

/** 列表和详情末尾都附的用法提示。 */
const KB_TIP = '提示：拿 topicId 可配合 kb_search（传 topicId 查这个专题挂的资料）、kb_save（传 topicId 把资料挂到这个专题）。';


/**
 * 截到 max 个字，超了加省略号。
 * @param text 原文。
 * @param max 最多几个字。
 * @returns 截好的文字。
 */
function clip(text: string, max: number): string {
  const chars = [...text.trim()];
  if (chars.length <= max) return chars.join('');

  return `${chars.slice(0, max - 1).join('')}…`;
}


/**
 * 列表里的一行：[topicId=…]〔状态〕标题 — 摘要。
 * @param node 节点。
 * @returns 一行 Markdown。
 */
function getTopicLine(node: types.DecisionNode): string {
  let line = `- [topicId=${node.id}]〔${STATUS_LABELS[node.status]}〕${node.title}`;
  const summary = clip(node.summary.replace(/\s+/gu, ' '), LINE_SUMMARY_MAX);
  if (summary !== '') {
    line += ` — ${summary}`;
  }
  return line;
}


/**
 * 一个节点的详情：标题、状态、归属、上下级、摘要、选项和结论、正文、最近留言。
 * @param node 要看的节点。
 * @param graph 整张图（找上级和下级）。
 * @returns Markdown 文本。
 */
function getTopicDetail(node: types.DecisionNode, graph: types.DecisionGraph): string {
  const lines = [`## [topicId=${node.id}] ${node.title}`, ''];
  lines.push(`- 状态：${STATUS_LABELS[node.status]}（${node.status}），类别：${node.kind}`);

  //M 归属：项目名照公开快照（工作区改名跟着变），没归属的不写。
  const rootId = getRootId(node, graph);
  const project = graph.projects?.find((item) => item.root === rootId);
  if (project !== undefined) {
    lines.push(`- 项目：${project.name}`);
  }

  //M 上级和下级都给 topicId，模型可以顺着再查。
  const parent = graph.nodes.find((item) => item.id === node.parent);
  if (parent !== undefined) {
    lines.push(`- 上级：[topicId=${parent.id}] ${parent.title}`);
  }
  const children = graph.nodes.filter((item) => item.parent === node.id);
  if (children.length > 0) {
    lines.push('- 下级：');
    for (const child of children) {
      lines.push(`  ${getTopicLine(child)}`);
    }
  }
  if (node.summary !== '') {
    lines.push(`- 摘要：${node.summary}`);
  }

  //M 选项：★ 推荐，✓ 已选；已定的写上谁定、什么时候定。
  for (const option of node.options ?? []) {
    let mark = '';
    if (option.recommended === true) {
      mark += '★';
    }
    if (option.id === node.chosen) {
      mark += '✓';
    }
    let line = `- 选项 ${option.id}${mark}：${option.text}`;
    if (option.cost !== undefined) {
      line += `（代价：${option.cost}）`;
    }
    lines.push(line);
  }
  if (node.decidedAt !== undefined) {
    lines.push(`- 定于：${new Date(node.decidedAt).toISOString()}，由 ${node.decidedBy ?? '未记录'}`);
  }

  //M 正文太长截掉；最近几条留言照先后。
  if (node.body !== undefined && node.body.trim() !== '') {
    lines.push('', '### 正文', clip(node.body, BODY_MAX));
  }
  const notes = (node.notes ?? []).slice(-NOTES_MAX);
  if (notes.length > 0) {
    lines.push('', '### 最近留言');
    for (const note of notes) {
      lines.push(`- ${note.author}：${clip(note.text, LINE_SUMMARY_MAX)}`);
    }
  }
  lines.push('', KB_TIP);
  return lines.join('\n');
}


/**
 * 顺着上级找到这个节点所在的根（项目的目标节点）。
 * @param node 节点。
 * @param graph 整张图。
 * @returns 根节点号；断链时是最后找到的那个。
 */
function getRootId(node: types.DecisionNode, graph: types.DecisionGraph): string {
  const byId = new Map(graph.nodes.map((item) => [item.id, item]));
  const seen = new Set<string>();
  let current = node;
  while (current.parent !== null && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = byId.get(current.parent);
    if (parent === undefined) return current.id;

    current = parent;
  }
  return current.id;
}


/**
 * 列表：按状态和关键词筛，待定、进行中排前面；没给筛选条件时先写各状态计数。
 * @param graph 整张图。
 * @param status 只看这个状态；空串不筛。
 * @param query 关键词，大小写不敏感，比节点号、标题、摘要、正文；空串不筛。
 * @param limit 最多几条。
 * @returns Markdown 文本。
 */
function getTopicList(graph: types.DecisionGraph, status: string, query: string, limit: number): string {
  const lines: string[] = [];

  //M 没给筛选条件：先给概览，各状态多少个。
  if (status === '' && query === '') {
    const counts = STATUS_ORDER.map((item) => {
      const count = graph.nodes.filter((node) => node.status === item).length;
      return `${STATUS_LABELS[item]} ${String(count)}`;
    });
    lines.push(`决策图共 ${String(graph.nodes.length)} 个节点：${counts.join('，')}。`);
  }

  //M 筛选：状态精确比，关键词转小写后在节点号、标题、摘要、正文里找。
  const needle = query.toLowerCase();
  const matched = graph.nodes.filter((node) => {
    if (status !== '' && node.status !== status) return false;

    if (needle === '') return true;

    const text = [node.id, node.title, node.summary, node.body ?? ''].join('\n').toLowerCase();
    return text.includes(needle);
  });

  //M 排序：状态先后，同状态新建的在前。
  const sorted = [...matched].sort((a, b) => {
    const order = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
    if (order !== 0) return order;

    return b.createdAt - a.createdAt;
  });
  if (sorted.length === 0) {
    lines.push('没有符合条件的节点。');
    return lines.join('\n');
  }

  const shown = sorted.slice(0, limit);
  lines.push(`列出 ${String(shown.length)} / ${String(sorted.length)} 个：`);
  for (const node of shown) {
    lines.push(getTopicLine(node));
  }
  if (sorted.length > shown.length) {
    lines.push(`还有 ${String(sorted.length - shown.length)} 个没列，可加 status、query 缩小范围或调大 limit（最多 40）。`);
  }
  lines.push('', '传 nodeId 看单个节点的详情。', KB_TIP);
  return lines.join('\n');
}


/**
 * 登记 work_topics：只读查决策图的专题和节点。
 * @param ctx 插件 ctx。
 * @param store 决策图存储（只调 getPublicGraph）。
 */
export function registerWorkTopics(ctx: cordis.Context, store: storeModule.Store): void {
  const statusLiterals = types.STATUSES.map((status) => piAi.Type.Literal(status));
  const parameters = piAi.Type.Object({
    nodeId: piAi.Type.Optional(piAi.Type.String({ description: '看单个节点的详情（topicId）' })),
    status: piAi.Type.Optional(piAi.Type.Union(statusLiterals, {
      description: '按状态筛：open 待定、working 进行中、decided 已定、done 已完成、dropped 已放弃',
    })),
    query: piAi.Type.Optional(piAi.Type.String({ description: '关键词，比节点号、标题、摘要、正文，大小写不敏感' })),
    limit: piAi.Type.Optional(piAi.Type.Integer({ minimum: 1, maximum: 40, description: '最多列几条，默认 15' })),
  });
  //M 前台、后台会话都能查；只读，不改图。
  ctx.tools.register({
    definition: {
      name: 'work_topics',
      description: '只读查主人的工作决策台：不传参数看概览（各状态计数，待定、进行中排前面），'
        + '可按 status、query 筛，传 nodeId 看单个节点详情。每项带 topicId，可配合 kb_search、kb_save 查、记关联资料。',
      parameters,
    },
    sessionKinds: ['front', 'work'],
    run(args, session) {
      const row = session.row;
      //G 决策图是主人的内部安排，外人会话（群里的 guest、客户）一律拒绝。
      const isOwner = protocol.isOwnerTurn(row.channel, row.address);
      if (!isOwner) throw new Error('只有本人会话可以查看工作决策');

      //M 参数已照 schema 校验过，这里只取值、补默认。
      const nodeId = String(args['nodeId'] ?? '').trim();
      const status = String(args['status'] ?? '');
      const query = String(args['query'] ?? '').trim();
      const limit = Number(args['limit'] ?? TOPIC_LIMIT);
      const graph = store.getPublicGraph();

      //M 传了 nodeId：只看这一个，找不到告诉模型怎么查。
      if (nodeId !== '') {
        const node = graph.nodes.find((item) => item.id === nodeId);
        if (node === undefined) return `没有节点 ${nodeId}。不传参数或传 query 可以先列出节点，拿到 topicId 再查。`;

        return getTopicDetail(node, graph);
      }
      return getTopicList(graph, status, query, limit);
    },
  });
}

