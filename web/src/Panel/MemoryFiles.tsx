/**
 * 右栏“记忆”上面的文件树（docs/界面/01_界面设计.md 第 9 节）：这个机器人 memory/ 里的文件。
 * 文件夹点开时才去取里面有什么；选文件走预览。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';


/** 树上的一个节点。 */
interface TreeNode {
  /** 键：绝对路径。 */
  key: string;
  /** 显示的名字。 */
  title: string;
  /** 是不是文件（没有子节点）。 */
  isLeaf: boolean;
  /** 子节点；还没取时没有。 */
  children?: TreeNode[];
}


/**
 * 把取到的子节点挂到树上。
 * @param nodes 现在的树。
 * @param key 父节点的键。
 * @param children 子节点。
 */
function attach(nodes: TreeNode[], key: string, children: TreeNode[]): TreeNode[] {
  return nodes.map((node) => {
    if (node.key === key) {
      return { ...node, children };
    }
    return node.children ? { ...node, children: attach(node.children, key, children) } : node;
  });
}


/**
 * 目录里的东西变成树节点。
 * @param entries 目录里的东西。
 */
function toNodes(entries: api.DirEntry[]): TreeNode[] {
  return entries.map((entry) => ({ key: entry.path, title: entry.name, isLeaf: !entry.dir }));
}


/** 记忆文件。 */
export function MemoryFiles(): react.JSX.Element {
  const t = i18n.useT();
  /** 正在聊的机器人。 */
  const bot = context.useUi((state) => state.currentBot);
  const openPanel = context.useUi((state) => state.openPanel);
  /** 树。 */
  const [tree, setTree] = react.useState<TreeNode[]>([]);
  /** 出错的原因。 */
  const [error, setError] = react.useState('');

  react.useEffect(() => {
    setTree([]);
    setError('');
    if (!bot) {
      return;
    }
    void api
      .botInfo(bot)
      .then((info) => api.listDir(info.paths.memoryDir))
      .then(
        (entries) => setTree(toNodes(entries)),
        (problem: unknown) => setError(problem instanceof Error ? problem.message : String(problem)),
      );
  }, [bot]);

  /**
   * 点开一个文件夹：去取里面有什么。
   * @param node 文件夹。
   */
  const loadData = async (node: { key: react.Key }): Promise<void> => {
    /** 目录里的东西。 */
    const entries = await api.listDir(String(node.key));
    setTree((old) => attach(old, String(node.key), toNodes(entries)));
  };

  return (
    <section className="jm-memory-files">
      <h4>{t('记忆文件')}</h4>
      {error && <div className="jm-field-error">{error}</div>}
      {!error && tree.length === 0 && <div className="jm-muted">{t('还没有')}</div>}
      <antd.Tree<TreeNode>
        className="jm-memory-tree"
        treeData={tree}
        loadData={loadData}
        showLine
        onSelect={(_keys, info) => {
          if (info.node.isLeaf) {
            openPanel('preview', { path: info.node.key, name: info.node.title });
          }
        }}
      />
    </section>
  );
}
