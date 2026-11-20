/** 用教程现有的插件说明、消息轨迹与数据流转生成项目结构树、插件归组树及端到端数据流转图。 */
import type * as api from './TutorialApi.ts';
import type * as i18n from '../I18n.ts';
import type * as readme from './ReadmeTabs.tsx';
import * as programView from './ProgramView.tsx';
import { formatShortSite, resolveStepTitle } from './StepDataFlow.tsx';

export type PluginDoc = ReturnType<typeof readme.getMindReadme>;
export type Pick =
  | { kind: 'plugin'; name: string; tab?: string }
  | { kind: 'event'; name: string }
  | { kind: 'step'; no: number };

export interface Branch {
  id: string;
  label: string;
  children: Branch[];
  pick?: Pick;
  expand?: string;
}

/** 端到端数据流转图单个步骤卡片的数据规格。 */
export interface FlowNodeSpec {
  id: string;
  step: number;
  node: string;
  layer: 'skeleton' | 'plugin';
  ms: number;
  error: boolean;
  title: string;
  fnText: string;
  summary: string;
  hasChanges: boolean;
  position: { x: number; y: number };
}

/** 端到端数据流转图有向连接边的数据规格。 */
export interface FlowEdgeSpec {
  id: string;
  fromStep: number;
  toStep: number;
  source: string;
  target: string;
  sourceHandle: 'left' | 'right' | 'bottom';
  targetHandle: 'left' | 'right' | 'top';
  label: string;
}

/** 未展开的节点不建子树，展开状态用稳定的键记录。 */
export function getProjectTree(
  plugins: readonly api.PluginItem[],
  docs: ReadonlyMap<string, PluginDoc>,
  expanded: ReadonlySet<string>,
  t: i18n.Translate,
  programs: readonly api.ProgramItem[],
): Branch {
  const root: Branch = { id: 'project', label: 'jmbots', children: [] };
  //M 系统骨架和普通插件分别挂到根的两支。
  const skeletonLabel = t('骨架');
  const pluginsLabel = t('插件');
  const skeleton: Branch = { id: 'skeleton', label: skeletonLabel, children: [], expand: 'skeleton' };
  const modules: Branch = { id: 'plugins', label: pluginsLabel, children: [], expand: 'plugins' };
  //M 进程插件单独一支：三方握手图一个叶子，再挂 config 里登记的每个程序。
  const programsLabel = t('进程插件');
  const processes: Branch = { id: 'programs', label: programsLabel, children: [], expand: 'programs' };
  root.children.push(skeleton, modules, processes);
  if (expanded.has(processes.id)) {
    const handshakeLabel = t('三方握手图');
    const handshakePick = { kind: 'plugin', name: programView.HANDSHAKE } as const;
    processes.children.push({ id: 'programs:handshake', label: handshakeLabel, children: [], pick: handshakePick });
    for (const program of programs) {
      //M 节点用带前缀的名字选中，右栏显示它的状态、接口和说明。
      const name = programView.PROGRAM_PREFIX + program.name;
      const pick = { kind: 'plugin', name } as const;
      processes.children.push({ id: `program:${program.name}`, label: program.title, children: [], pick });
    }
  }
  for (const plugin of plugins) {
    let group = modules;
    if (plugin.kind === 'skeleton') group = skeleton;
    if (!expanded.has(group.id)) continue;

    //M 节点使用插件名关联原说明栏和展开状态。
    const id = `plugin:${plugin.name}`;
    const pick = { kind: 'plugin', name: plugin.name } as const;
    const branch: Branch = { id, label: plugin.name, children: [], pick, expand: id };
    group.children.push(branch);
    if (!expanded.has(id)) continue;

    const doc = docs.get(plugin.name);
    if (doc === undefined) continue;

    //M 每个插件的说明分成听、发、函数三个分支，叶子保留点开右栏所需的标识。
    const listenedLabel = t('听的事件');
    const emittedLabel = t('发的事件');
    const functionsLabel = t('对外函数');
    const listened = getSection(branch, 'listened', listenedLabel, doc.listened);
    const emitted = getSection(branch, 'emitted', emittedLabel, doc.emitted);
    const functions = getSection(branch, 'functions', functionsLabel, doc.functions);
    for (const section of [listened, emitted, functions]) {
      if (section.children.length > 0) branch.children.push(section);
    }
  }
  return root;
}

/** 用插件和说明栏目标识生成分组，避免同名事件节点冲突。 */
function getSection(parent: Branch, kind: string, label: string, names: string[]): Branch {
  const id = `${parent.id}:${kind}`;
  const children = names.map((name): Branch => {
    let pick: Pick = { kind: 'event', name };
    if (kind === 'functions' && parent.pick?.kind === 'plugin') {
      pick = { kind: 'plugin', name: parent.pick.name, tab: 'public-fns' };
    }
    return { id: `${id}:${name}`, label: name, children: [], pick };
  });
  return { id, label, children };
}

/** 按首次经过的插件排序，插件下仍按原轨迹的步骤号排序。 */
export function getTrailTree(trail: api.Trail, t: i18n.Translate): Branch {
  //M 当前消息的步骤按首次经过的插件归组。
  const rootLabel = t('这条消息走过的路');
  const root: Branch = { id: 'trace', label: rootLabel, children: [] };
  const stages = new Map<string, Branch>();
  for (const step of trail.steps) {
    let stage = stages.get(step.node);
    if (stage === undefined) {
      //M 同一插件多次经过时合在同一枝上，叶子保留原步骤号和详情。
      stage = { id: `stage:${step.node}`, label: step.node, children: [] };
      stages.set(step.node, stage);
      root.children.push(stage);
    }
    //M 步骤号同时用于显示和定位原画布里的同一步。
    const number = String(step.no);
    const stepTitle = resolveStepTitle(step, t);
    const item: Branch = {
      id: `step:${number}`,
      label: `#${number} ${stepTitle}`,
      children: [],
      pick: { kind: 'step', no: step.no },
    };
    //M 把详情入口挂到该插件下。
    stage.children.push(item);
  }
  return root;
}

/** 提炼精简的有向边短标签（不超过 20 字，优先用事件或动作短名，绝不撞上相邻卡片）。 */
function formatCompactEdgeLabel(outgoing: api.StepDataFlow['outgoing']): string {
  //M 优先取简洁 via（如 channel/direct、before-model），超长时剥去尾随类型后缀并截断到 20 字内。
  let text = outgoing.via.trim();
  if (text === '' && outgoing.label.trim() !== '') {
    text = outgoing.label.split('·')[0]?.trim() ?? '';
  }
  if (text === '') text = outgoing.dataType.trim();
  if (text === '') text = '顺次接力';

  if ([...text].length > 18 && text.includes('·')) {
    text = text.split('·')[0]?.trim() ?? text;
  }
  const chars = [...text];
  if (chars.length <= 20) return text;

  return `${chars.slice(0, 19).join('')}…`;
}

/** 拼装单张数据流转卡片上的函数名与短源码位置。 */
function formatFlowFnLine(item: api.StepDataFlow): string {
  const shortSite = formatShortSite(item.fnSite);
  if (item.fnName !== '' && shortSite !== '') return `${item.fnName} · ${shortSite}`;
  if (item.fnName !== '') return item.fnName;
  if (shortSite !== '') return shortSite;

  return item.stage;
}

/** 提炼节点底部展示的一句话数据变化胶囊文案。 */
function resolveCardSummary(item: api.StepDataFlow): string {
  if (item.summary !== '') return item.summary;

  const first = item.changes[0];
  if (first !== undefined) {
    let key = first.target;
    if (first.field !== '') key = `${first.target}.${first.field}`;
    return `${key}: ${first.before || '空'} → ${first.after || '空'}`;
  }
  const input = item.inputs[0];
  if (input !== undefined) return `${input.key}: ${input.value}`;

  return '';
}

/**
 * 按真实时间顺序 #1 → #2 → … → #N 生成交互式数据流转图坐标与带标签有向边。
 * 左右模式固定最多 3 列蛇形网格（列间留足 >= 188px 净空，行间 >= 106px 净空），上下模式走纵向接力链。
 */
export function buildDataFlowGraph(
  trail: api.Trail,
  dataFlow: api.TrailDataFlow,
  direction: 'sides' | 'down',
  t: i18n.Translate,
): { nodes: FlowNodeSpec[]; edges: FlowEdgeSpec[] } {
  //M 建立原始步骤速查表，取耗时、报错标记与本地化标题。
  const rawByNo = new Map<number, api.TrailStep>();
  for (const step of trail.steps) rawByNo.set(step.no, step);

  const count = dataFlow.steps.length;
  let cols = 3;
  if (count <= 3) cols = Math.max(1, count);

  const nodes: FlowNodeSpec[] = [];
  const gridPos: { row: number; col: number }[] = [];

  for (let index = 0; index < count; index++) {
    const item = dataFlow.steps[index];
    if (item === undefined) continue;

    const raw = rawByNo.get(item.step);
    let title = item.stage;
    if (raw !== undefined) title = resolveStepTitle(raw, t);

    //M 计算 3 列蛇形坐标（464px 列距，236px 行距）或上下纵向链路坐标（228px 行距）。
    let row = index;
    let col = 0;
    let x = 0;
    let y = index * 228;
    if (direction === 'sides') {
      row = Math.floor(index / cols);
      const offset = index % cols;
      col = offset;
      if (row % 2 === 1) col = cols - 1 - offset;
      x = col * 464;
      y = row * 236;
    }

    gridPos.push({ row, col });
    nodes.push({
      id: `flow:${String(item.step)}`,
      step: item.step,
      node: item.node,
      layer: item.layer,
      ms: raw?.ms ?? 0,
      error: raw?.error ?? false,
      title,
      fnText: formatFlowFnLine(item),
      summary: resolveCardSummary(item),
      hasChanges: item.changes.length > 0,
      position: { x, y },
    });
  }

  //M 相邻步骤逐跳相连，按蛇形行进方向自动挑选贴边接口并附带精简胶囊标签。
  const edges: FlowEdgeSpec[] = [];
  for (let index = 0; index + 1 < nodes.length; index++) {
    const fromNode = nodes[index];
    const toNode = nodes[index + 1];
    const fromFlow = dataFlow.steps[index];
    const posA = gridPos[index];
    const posB = gridPos[index + 1];
    if (!fromNode || !toNode || !fromFlow || !posA || !posB) continue;

    let sourceHandle: 'left' | 'right' | 'bottom' = 'bottom';
    let targetHandle: 'left' | 'right' | 'top' = 'top';
    if (direction === 'sides' && posA.row === posB.row && posB.col > posA.col) {
      sourceHandle = 'right';
      targetHandle = 'left';
    }
    if (direction === 'sides' && posA.row === posB.row && posB.col < posA.col) {
      sourceHandle = 'left';
      targetHandle = 'right';
    }

    edges.push({
      id: `flow-edge:${String(fromNode.step)}→${String(toNode.step)}`,
      fromStep: fromNode.step,
      toStep: toNode.step,
      source: fromNode.id,
      target: toNode.id,
      sourceHandle,
      targetHandle,
      label: formatCompactEdgeLabel(fromFlow.outgoing),
    });
  }

  return { nodes, edges };
}
