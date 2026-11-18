/**
 * 右栏“记忆”上面的文件树（docs/界面/01_界面设计.md 第 9 节）：这个机器人 memory/ 里的文件。
 * 文件夹点开时才去取里面有什么；选文件走预览。
 */
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import * as privacy from '../Privacy/Mask.tsx';
import * as vscodeLink from '../VscodeLink.tsx';


/** 文件树最高多少像素；交给 antd Tree 的 height，开它自带的虚拟滚动（用户 11-17），文件少时照旧矮。 */
const TREE_HEIGHT = 240;


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
    if (node.key === key) return { ...node, children };

    if (!node.children) return node;

    //M 当前节点未命中目标时，继续递归向已加载的子节点树挂接新目录项。
    return { ...node, children: attach(node.children, key, children) };
  });
}


/**
 * 目录里的东西变成树节点。
 * @param entries 目录里的东西。
 */
function toNodes(entries: api.DirEntry[]): TreeNode[] {
  return entries.map((entry) => ({ key: entry.path, title: entry.name, isLeaf: !entry.dir }));
}


/**
 * 右栏“记忆”顶部的记忆文件树组件：按需加载当前机器人 `memory/` 目录下的文件夹并支持点击预览。
 * @returns 记忆文件树视图；演示打码开启时返回脱敏占位提示。
 * 副作用：切换机器人时请求根目录列表，展开文件夹时懒加载子目录并更新本地树状态；点击文件节点会打开右栏预览页签。
 */
export function MemoryFiles(): react.JSX.Element {
  //M 取当前语言翻译函数与演示打码开关状态。
  const t = i18n.useT();
  const masked = privacy.useMask();
  /** 正在聊的机器人。 */
  //M 订阅当前选中的机器人与打开预览面板动作，用于读取记忆目录并预览文件。
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
    //M 切换机器人后先查记忆目录路径，再列出根目录内容并转为树节点。
    void api
      .botInfo(bot)
      .then((info) => api.listDir(info.paths.memoryDir))
      .then(
        (entries) => setTree(toNodes(entries)),
        (problem: unknown) => {
          let message = String(problem);
          if (problem instanceof Error) {
            message = problem.message;
          }
          setError(message);
        },
      );
  }, [bot]);

  /**
   * 点开一个文件夹：去取里面有什么。
   * @param node 文件夹。
   */
  const loadData = async (node: { key: react.Key }): Promise<void> => {
    /** 目录里的东西。 */
    //M 懒加载展开文件夹的下一级目录项，并把转换后的树节点挂回对应父节点。
    const entries = await api.listDir(String(node.key));
    setTree((old) => attach(old, String(node.key), toNodes(entries)));
  };

  //G 文件名和路径也可能带客户名，不向 DOM 输出树节点或路径键。
  if (masked) return <div className="jm-muted">记忆文件（已打码）</div>;

  return (
    <section className="jm-memory-files">
      <h4>{t('记忆文件')}</h4>
      {error && <div className="jm-field-error">{error}</div>}
      {!error && tree.length === 0 && <div className="jm-muted">{t('还没有')}</div>}
      <antd.Tree<TreeNode>
        className="jm-memory-tree"
        height={TREE_HEIGHT}
        treeData={tree}
        loadData={loadData}
        showLine
        titleRender={(node) => (
          <span className="jm-workspace-file-row" title={node.key}>
            <span className="jm-workspace-file-name">{node.title}</span>
            <vscodeLink.VsCodeOpen site={node.key} />
          </span>
        )}
        onSelect={(_keys, info) => {
          if (info.node.isLeaf) {
            openPanel('preview', { path: info.node.key, name: info.node.title });
          }
        }}
      />
    </section>
  );
}
