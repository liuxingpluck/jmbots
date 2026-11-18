/** 用教程现有的插件说明和消息轨迹生成两棵导图。 */
import type * as api from './TutorialApi.ts';
import type * as i18n from '../I18n.ts';
import type * as readme from './ReadmeTabs.tsx';

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

/** 未展开的节点不建子树，展开状态用稳定的键记录。 */
export function getProjectTree(
  plugins: readonly api.PluginItem[],
  docs: ReadonlyMap<string, PluginDoc>,
  expanded: ReadonlySet<string>,
  t: i18n.Translate,
): Branch {
  const root: Branch = { id: 'project', label: 'jmbots', children: [] };
  //M 系统骨架和普通插件分别挂到根的两支。
  const skeletonLabel = t('骨架');
  const pluginsLabel = t('插件');
  const skeleton: Branch = { id: 'skeleton', label: skeletonLabel, children: [], expand: 'skeleton' };
  const modules: Branch = { id: 'plugins', label: pluginsLabel, children: [], expand: 'plugins' };
  root.children.push(skeleton, modules);
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
    const item: Branch = {
      id: `step:${number}`,
      label: `#${number} ${step.title}`,
      children: [],
      pick: { kind: 'step', no: step.no },
    };
    //M 把详情入口挂到该插件下。
    stage.children.push(item);
  }
  return root;
}
