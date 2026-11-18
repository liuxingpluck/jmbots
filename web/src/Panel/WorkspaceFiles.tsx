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
import * as privacy from '../Privacy/Mask.tsx';
import * as vscodeLink from '../VscodeLink.tsx';
import type * as types from '../Types.ts';


/** 文件树最高多少像素（原来是 CSS 的 max-height: 260px）；交给 antd Tree 的 height，开它自带的虚拟滚动。 */
const TREE_HEIGHT = 260;


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
    if (node.key === key) return { ...node, children };

    if (!node.children) return node;

    //M 未命中目标节点但存在已加载子节点时继续递归向下查找并挂载。
    return { ...node, children: attach(node.children, key, children) };
  });
}


/**
 * 目录里的东西变成树节点。
 * @param entries 目录里的东西。
 * @param root 工作区目录（绝对路径），算相对路径用。
 */
function toNodes(entries: api.DirEntry[], root: string): TreeNode[] {
  //M 将后端目录项转换为树节点结构，并换算出相对工作区的展示路径。
  return entries.map((entry) => ({
    key: entry.path,
    title: entry.name,
    isLeaf: !entry.dir,
    dir: entry.dir,
    rel: getRelativePath(entry.path, root),
  }));
}


/**
 * 绝对路径换成相对工作区的路径（正斜杠）；不在工作区下就原样。
 * @param target 绝对路径。
 * @param root 工作区目录。
 */
function getRelativePath(target: string, root: string): string {
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
 * @param props 机器人和工作区信息（机器人名与工作区名称、说明、目录）。
 * @returns 工作区文件树区域元素。
 * 副作用：挂载及展开文件夹时请求目录列表接口，单击节点添加工作区标签或打开文件预览。
 */
export function WorkspaceFiles(props: WorkspaceFilesProps): react.JSX.Element {
  //M 订阅翻译函数、演示打码状态，以及向输入框插标签和打开预览的动作。
  const t = i18n.useT();
  const masked = privacy.useMask();
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
    //M 请求工作区根目录列表，仅在未卸载或未刷新时挂回树根节点。
    void api.listDir(dir).then(
      (entries) => {
        if (!stopped) {
          setTree((old) => attach(old, dir, toNodes(entries, dir)));
        }
      },
      (problem: unknown) => {
        if (!stopped) {
          let message = String(problem);
          if (problem instanceof Error) {
            message = problem.message;
          }
          setError(message);
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
      //M 懒加载展开目录的子项并挂载到对应树节点下。
      const entries = await api.listDir(target);
      setTree((old) => attach(old, target, toNodes(entries, dir)));
    } catch (problem) {
      let message = String(problem);
      if (problem instanceof Error) {
        message = problem.message;
      }
      setError(message);
    }
  };

  /**
   * 单击一行：往输入框插一个标签（文件写文件名，文件夹写文件夹名，根写「工作区名 工作区」）。
   * @param node 点到的节点。
   */
  const getTag = (node: TreeNode): types.WorkspaceTag => {
    if (node.rel === '') {
      return {
        path: node.key,
        label: t('{name} 工作区', { name: props.workspace.name }),
        kind: 'dir',
      };
    }
    let kind: 'dir' | 'file' = 'file';
    if (node.dir) {
      kind = 'dir';
    }
    return { path: node.key, label: node.title, kind };
  };

  //G 演示打码开启时只展示脱敏后的占位文本，不挂载真实文件树。
  let treeNode: react.ReactNode = <div className="jm-muted">{privacy.text('文件树', true)}</div>;
  if (!masked) {
    treeNode = (
      <antd.Tree<TreeNode>
        key={reloadKey}
        className="jm-memory-tree"
        height={TREE_HEIGHT}
        treeData={tree}
        loadData={loadData}
        showLine
        titleRender={(node) => {
          let tip = `${props.workspace.name}/${node.rel}`;
          if (node.rel === '') {
            tip = dir;
          }
          //M 渲染树节点行，对提示路径、节点名及预览按钮无障碍标签执行脱敏。
          return (
            <span className="jm-workspace-file-row" title={privacy.text(tip, masked)}>
              <span className="jm-workspace-file-name">{privacy.name(node.title, masked)}</span>
              {!node.dir && (
                <button
                  type="button"
                  className="jm-workspace-file-eye"
                  aria-label={t('预览 {name}', { name: privacy.name(node.title, masked) })}
                  onClick={(event) => {
                    //G 别让这一次点击又插一个标签：这个按钮只做预览。
                    event.stopPropagation();
                    openPanel('preview', { path: node.key, name: node.title });
                  }}
                >
                  <icons.EyeOutlined />
                </button>
              )}
              {!masked && <vscodeLink.VsCodeOpen site={node.key} />}
            </span>
          );
        }}
        onSelect={(_keys, info) => {
          if (masked) return;

          //M 单击节点时把选中的文件或目录转为工作区标签插入输入框。
          addWorkspaceTag(getTag(info.node));
        }}
      />
    );
  }

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
      {
        //G 目录读取失败时展示按演示状态脱敏后的错误提示。
        error && <div className="jm-field-error">{privacy.text(error, masked)}</div>
      }
      {/* //M 普通 Tree 单击标题不展开（expandAction 是 DirectoryTree 才有的），展开只认箭头，正好“单击只插标签”。 */}
      {/* //M 给了 height 才开 antd Tree 自带的虚拟滚动（用户 11-17）；height 是最高多少，文件少时照旧矮。 */}
      {treeNode}
    </section>
  );
}
