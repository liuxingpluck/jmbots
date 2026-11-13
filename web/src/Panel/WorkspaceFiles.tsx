/**
 * 一个工作区的文件树（G批设计 7.2）：懒加载，单击行往输入框插标签，文件行尾的按钮走预览。
 * 骨架照 Panel/MemoryFiles.tsx 的 attach/toNodes/loadData；不加定时轮询（Workspace 已有 3 秒轮询）。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import * as react from 'react';
import * as api from '../Api.ts';
import * as context from '../Context.ts';
import * as i18n from '../I18n.ts';
import type * as types from '../Types.ts';


/** 树上的一个节点。 */
interface TreeNode {
  /** 键：绝对路径（根节点是工作区目录）。 */
  key: string;
  /** 显示的名字。 */
  title: string;
  /** 是不是文件（没有子节点）。 */
  isLeaf: boolean;
  /** 是不是文件夹：决定标签的图标。 */
  dir: boolean;
  /** 相对工作区的路径（正斜杠，如 素材/笔记.md）；根节点是空串。 */
  rel: string;
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
 * @param root 工作区目录（绝对路径），算相对路径用。
 */
function toNodes(entries: api.DirEntry[], root: string): TreeNode[] {
  return entries.map((entry) => ({
    key: entry.path,
    title: entry.name,
    isLeaf: !entry.dir,
    dir: entry.dir,
    rel: relativeOf(entry.path, root),
  }));
}


/**
 * 绝对路径换成相对工作区的路径（正斜杠）；不在工作区下就原样。
 * @param target 绝对路径。
 * @param root 工作区目录。
 */
function relativeOf(target: string, root: string): string {
  //G 后端给的路径理应都在工作区下；不在就原样显示，不猜。
  if (!target.startsWith(root)) {
    return target;
  }
  return target.slice(root.length).replace(/^[\\/]+/u, '').split('\\').join('/');
}


/** WorkspaceFiles 的属性。 */
interface WorkspaceFilesProps {
  /** 哪个机器人的工作区。 */
  bot: string;
  /** 工作区：名字、说明、绝对路径。 */
  workspace: { name: string; description: string; dir: string };
}


/**
 * 一个工作区的文件树：根节点是工作区名，展开时懒加载；单击行插标签，文件行尾按钮预览。
 * @param props 机器人和工作区。
 */
export function WorkspaceFiles(props: WorkspaceFilesProps): react.JSX.Element {
  const t = i18n.useT();
  const addWorkspaceTag = context.useUi((state) => state.addWorkspaceTag);
  const openPanel = context.useUi((state) => state.openPanel);
  /** 树。 */
  const [tree, setTree] = react.useState<TreeNode[]>([]);
  /** 出错的原因。 */
  const [error, setError] = react.useState('');
  /** 刷新次数：变了就重置这棵树重取。 */
  const [reloadKey, setReloadKey] = react.useState(0);
  /** 工作区目录。 */
  const dir = props.workspace.dir;

  react.useEffect(() => {
    //M 打开取一次根目录（不轮询）；刷新按钮改 reloadKey 再来一遍。
    setTree([{ key: dir, title: props.workspace.name, isLeaf: false, dir: true, rel: '' }]);
    setError('');
    /** 停了没有（卸载或刷新后不再写状态）。 */
    let stopped = false;
    void api.listDir(dir).then(
      (entries) => {
        if (!stopped) {
          setTree((old) => attach(old, dir, toNodes(entries, dir)));
        }
      },
      (problem: unknown) => {
        if (!stopped) {
          setError(problem instanceof Error ? problem.message : String(problem));
        }
      },
    );
    return () => {
      stopped = true;
    };
  }, [dir, props.workspace.name, reloadKey]);

  /**
   * 点开一个文件夹：去取里面有什么。
   * @param node 文件夹。
   */
  const loadData = async (node: { key: react.Key }): Promise<void> => {
    /** 这个文件夹的绝对路径。 */
    const target = String(node.key);
    try {
      /** 目录里的东西。 */
      const entries = await api.listDir(target);
      setTree((old) => attach(old, target, toNodes(entries, dir)));
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : String(problem));
    }
  };

  /**
   * 单击一行：往输入框插一个标签（文件写文件名，文件夹写文件夹名，根写「工作区名 工作区」）。
   * @param node 点到的节点。
   */
  const tagOf = (node: TreeNode): types.WorkspaceTag => {
    if (node.rel === '') {
      return {
        path: node.key,
        label: t('{name} 工作区', { name: props.workspace.name }),
        kind: 'dir',
      };
    }
    return { path: node.key, label: node.title, kind: node.dir ? 'dir' : 'file' };
  };

  return (
    <section className="jm-workspace-files">
      <div className="jm-workspace-files-head">
        <span className="jm-muted">{t('文件')}</span>
        <antd.Button
          size="small"
          type="text"
          icon={<icons.ReloadOutlined />}
          aria-label={t('刷新文件树')}
          title={t('刷新文件树')}
          onClick={() => setReloadKey((key) => key + 1)}
        />
      </div>
      {error && <div className="jm-field-error">{error}</div>}
      {/* //M 普通 Tree 单击标题不展开（expandAction 是 DirectoryTree 才有的），展开只认箭头，正好“单击只插标签”。 */}
      <antd.Tree<TreeNode>
        key={reloadKey}
        className="jm-memory-tree"
        treeData={tree}
        loadData={loadData}
        showLine
        titleRender={(node) => (
          <span
            className="jm-workspace-file-row"
            title={node.rel === '' ? dir : `${props.workspace.name}/${node.rel}`}
          >
            <span className="jm-workspace-file-name">{node.title}</span>
            {!node.dir && (
              <button
                type="button"
                className="jm-workspace-file-eye"
                aria-label={t('预览 {name}', { name: node.title })}
                onClick={(event) => {
                  //G 别让这一次点击又插一个标签：这个按钮只做预览。
                  event.stopPropagation();
                  openPanel('preview', { path: node.key, name: node.title });
                }}
              >
                <icons.EyeOutlined />
              </button>
            )}
          </span>
        )}
        onSelect={(_keys, info) => {
          addWorkspaceTag(tagOf(info.node));
        }}
      />
    </section>
  );
}
