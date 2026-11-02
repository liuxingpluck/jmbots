/**
 * 左栏“目录”：最上面是“全部文档”，下面是目录树，底部是“新建目录”。
 * 点目录只改网址（ViewStore 的 goTo），选中状态和收起了哪些目录都记在 ViewStore，切换 PC／手机布局时不丢。新建目录第 3 步接上，现在按钮是灰的。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import type { TreeDataNode } from 'antd';
import * as react from 'react';
import * as knowledgeStore from '../KnowledgeStore.ts';
import type * as route from '../Route.ts';
import type { KnowledgeBase } from '../Types.ts';
import * as viewStore from '../ViewStore.ts';


/** “全部文档”在树里的 key；其余节点的 key 是目录 ID 的字符串。 */
const ALL_KEY = 'all';


/** 目录栏：目录来自知识库数据，选中状态和收起状态来自 ViewStore。 */
export default function BaseTree() {
  /** 全部目录。 */
  const bases = knowledgeStore.useKnowledgeStore((state) => state.bases);
  /** 网址里的选中状态，用来高亮当前目录。 */
  const current = viewStore.useViewStore((state) => state.route);
  /** 用户手动收起的目录 key。 */
  const collapsedKeys = viewStore.useViewStore((state) => state.collapsedKeys);
  /** 改收起目录的动作。 */
  const setCollapsedKeys = viewStore.useViewStore((state) => state.setCollapsedKeys);
  /** 跳转的动作。 */
  const goTo = viewStore.useViewStore((state) => state.goTo);

  // m: 把平铺的目录排成树，最前面加“全部文档”；目录不变就不重算。
  /** 交给 antd Tree 的节点。 */
  const treeData = react.useMemo<TreeDataNode[]>(
    () => [{ key: ALL_KEY, title: '全部文档', icon: <icons.AppstoreOutlined /> }, ...buildTree(bases, null)],
    [bases],
  );
  /** 全部目录的 key。 */
  const baseKeys = bases.map((base) => String(base.id));
  /** 当前展开的目录：全部目录减去用户收起的。 */
  const expandedKeys = baseKeys.filter((key) => !collapsedKeys.includes(key));

  return (
    <div className="base-tree">
      <div className="pane-title">目录</div>
      <antd.Tree
        className="base-tree-body"
        blockNode
        showIcon
        treeData={treeData}
        selectedKeys={[current.baseId === null ? ALL_KEY : String(current.baseId)]}
        expandedKeys={expandedKeys}
        onExpand={(keys) => setCollapsedKeys(baseKeys.filter((key) => !keys.includes(key)))}
        onSelect={(_keys, info) => selectBase(info.node.key, current, goTo)}
      />
      <antd.Button className="base-tree-add" icon={<icons.PlusOutlined />} disabled>
        新建目录
      </antd.Button>
    </div>
  );
}


/** 把平铺的目录按上级关系排成树；同一层按 position 从小到大。 */
function buildTree(bases: KnowledgeBase[], parentId: number | null): TreeDataNode[] {
  return bases
    .filter((base) => base.parentId === parentId)
    .sort((left, right) => left.position - right.position)
    .map((base) => ({
      key: String(base.id),
      title: base.name,
      icon: <icons.FolderOutlined />,
      children: buildTree(bases, base.id),
    }));
}


/**
 * 点了树上的节点：网址改到这个目录，并清掉选中的文档。
 * 用被点的节点本身，而不是 antd 给的选中列表：再点一次已高亮的节点时那个列表是空的，手机上就进不去“全部文档”了。
 */
function selectBase(key: react.Key, current: route.Route, goTo: (next: route.Route) => void): void {
  /** 要去的目录：“全部文档”或某个目录 ID。 */
  const baseId = key === ALL_KEY ? 'all' : Number(key);
  // g: 已经停在这个目录的列表上，再点一次不用跳。
  if (baseId === current.baseId && current.documentId === null) {
    return;
  }
  // m: 跳到这个目录的列表。
  goTo({ baseId, documentId: null });
}
