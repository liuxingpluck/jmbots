/**
 * 知识库左栏：全部 / 未归类计数、可折叠目录树（新建子目录、重命名、删除）、标签云单选筛选。
 * 桌面上支持原生 HTML5 拖拽：把文档拖到目录上是移动文档，把目录拖到目录上是移动目录；手机不拖，改在编辑器里选目录。
 * 增删改都交给 KnowledgePage 去调接口，这里只管显示和收手势。
 */
import * as react from 'react';
import * as api from './KnowledgeApi.ts';

/** 拖文档时 dataTransfer 里的类型，值是文档号（DocList 设）。 */
export const DOC_MIME = 'application/x-kb-doc';
/** 拖目录时 dataTransfer 里的类型，值是目录号。 */
export const DIR_MIME = 'application/x-kb-dir';

/** 左栏的入参：数据、当前筛选和各个操作，操作实现都在 KnowledgePage。 */
interface DirTreeProps {
  /** 目录树、标签、计数；还没拉到时是 undefined。 */
  tree: api.KnowledgeTreeResponse | undefined;
  /** 当前选中的目录号；UNASSIGNED 是未归类；undefined 是全部。 */
  dir: string | undefined;
  /** 当前选中的标签。 */
  tag: string | undefined;
  /** 只读：不显示增删改按钮、不接拖拽。 */
  readOnly: boolean;
  /** 能不能拖拽（桌面才开）。 */
  dragEnabled: boolean;
  /** 选目录；undefined 回到全部。实现在 KnowledgePage 的 pickDir。 */
  pickDir: (dir: string | undefined) => void;
  /** 选标签；再点一次传 undefined 取消。 */
  pickTag: (tag: string | undefined) => void;
  /** 新建目录，parentId 为 null 建在顶层。 */
  createDir: (parentId: string | null) => void;
  /** 重命名目录。 */
  renameDir: (dir: api.KnowledgeDir) => void;
  /** 删除目录（文档不删）。 */
  removeDir: (dir: api.KnowledgeDir) => void;
  /** 把文档移到目录；null 是移成未归类。 */
  moveDoc: (docId: string, dirId: string | null) => void;
  /** 把目录移到别的目录下；null 是移到顶层。 */
  moveDir: (dirId: string, parentId: string | null) => void;
}

/** 一个拖放目标能接什么。 */
interface DropAccept {
  /** 接文档：放下后文档移到这个目录（null 是未归类）。 */
  doc: boolean;
  /** 接目录：放下后目录移到这个目录下面（null 是顶层）。 */
  dir: boolean;
}


/**
 * 算出一个拖放目标的三个事件处理；不能拖时交回空对象。
 * @param props 左栏入参（拿 moveDoc、moveDir）。
 * @param target 目标目录号；null 是“未归类”或“顶层”。
 * @param accept 这个目标接文档还是接目录。
 * @param key 悬停高亮用的名字（目录号，或“全部”“未归类”各自的名字）。
 * @param setOver 记下当前悬停的目标，用来高亮。
 */
function getDropHandlers(
  props: DirTreeProps,
  target: string | null,
  accept: DropAccept,
  key: string,
  setOver: (key: string | undefined) => void,
): react.HTMLAttributes<HTMLElement> {
  if (!props.dragEnabled || props.readOnly) return {};

  /** 拖过来的东西这里接不接。 */
  const canTake = (event: react.DragEvent): boolean => {
    const kinds = event.dataTransfer.types;
    if (accept.doc && kinds.includes(DOC_MIME)) return true;

    return accept.dir && kinds.includes(DIR_MIME);
  };

  return {
    onDragOver: (event) => {
      //G 接不了的不 preventDefault，浏览器就显示“不能放”。
      if (!canTake(event)) return;

      event.preventDefault();
      setOver(key);
    },
    onDragLeave: () => setOver(undefined),
    onDrop: (event) => {
      setOver(undefined);
      const docId = event.dataTransfer.getData(DOC_MIME);
      if (accept.doc && docId !== '') {
        event.preventDefault();
        props.moveDoc(docId, target);
        return;
      }

      //G 目录拖到自己身上不算；拖到自己子孙下面由后端拦环路。
      const dirId = event.dataTransfer.getData(DIR_MIME);
      if (!accept.dir || dirId === '' || dirId === target) return;

      event.preventDefault();
      props.moveDir(dirId, target);
    },
  };
}


/** 一行目录的入参。 */
interface DirRowProps {
  /** 左栏入参。 */
  tree: DirTreeProps;
  /** 这一行的目录。 */
  node: api.KnowledgeDirNode;
  /** 第几层，从 0 开始，用来缩进。 */
  depth: number;
  /** 收起的目录号。 */
  collapsed: ReadonlySet<string>;
  /** 收起或展开一个目录。 */
  toggle: (id: string) => void;
  /** 当前悬停的拖放目标。 */
  over: string | undefined;
  /** 记下悬停目标。 */
  setOver: (key: string | undefined) => void;
}


/** 一行目录和它的子目录（递归）。 */
function DirRow(props: DirRowProps): react.JSX.Element {
  const { tree, node, depth, collapsed } = props;
  const isOpen = !collapsed.has(node.id);
  const hasChildren = node.children.length > 0;

  //M 折叠箭头：没子目录的留空位对齐。
  let arrow = '';
  if (hasChildren && isOpen) {
    arrow = '▾';
  }
  if (hasChildren && !isOpen) {
    arrow = '▸';
  }

  //M 目录行本身可以拖（移动目录），也能接文档和目录。
  const dropHandlers = getDropHandlers(tree, node.id, { doc: true, dir: true }, node.id, props.setOver);
  const canDrag = tree.dragEnabled && !tree.readOnly;
  const onDragStart = (event: react.DragEvent): void => {
    event.dataTransfer.setData(DIR_MIME, node.id);
    event.dataTransfer.effectAllowed = 'move';
  };
  const indent = { paddingLeft: `${String(8 + depth * 14)}px` };

  return (
    <li>
      <div
        className="kb-dir-row"
        data-active={tree.dir === node.id}
        data-over={props.over === node.id}
        style={indent}
        draggable={canDrag}
        onDragStart={onDragStart}
        {...dropHandlers}
      >
        <button type="button" className="kb-dir-arrow" onClick={() => props.toggle(node.id)} aria-label="展开或收起">
          {arrow}
        </button>
        <button type="button" className="kb-dir-name" onClick={() => tree.pickDir(node.id)} title={node.name}>
          {node.name}
        </button>
        <span className="kb-count">{node.docCount}</span>
        {!tree.readOnly && (
          <span className="kb-dir-actions">
            <button type="button" onClick={() => tree.createDir(node.id)} title="新建子目录">＋</button>
            <button type="button" onClick={() => tree.renameDir(node)} title="重命名">✎</button>
            <button type="button" onClick={() => tree.removeDir(node)} title="删除目录（文档不删）">×</button>
          </span>
        )}
      </div>
      {hasChildren && isOpen && (
        <ul className="kb-dir-list">
          {node.children.map((child) => (
            <DirRow key={child.id} {...props} node={child} depth={depth + 1} />
          ))}
        </ul>
      )}
    </li>
  );
}


/** 知识库左栏。 */
export function DirTree(props: DirTreeProps): react.JSX.Element {
  const [collapsed, setCollapsed] = react.useState<ReadonlySet<string>>(new Set());
  const [over, setOver] = react.useState<string>();
  const tree = props.tree;

  //M 收起和展开：每次换一个新 Set，React 才认得出变了。
  const toggle = react.useCallback((id: string) => {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      next.add(id);
      return next;
    });
  }, []);

  //M “全部”接目录（移到顶层），“未归类”接文档（清掉目录）。
  const allDrop = getDropHandlers(props, null, { doc: false, dir: true }, ':all', setOver);
  const unassignedDrop = getDropHandlers(props, null, { doc: true, dir: false }, ':unassigned', setOver);
  const totalDocs = tree?.totalDocs ?? 0;
  const unassignedDocs = tree?.unassignedDocs ?? 0;
  const dirs = tree?.dirs ?? [];
  const tags = tree?.tags ?? [];

  return (
    <nav className="kb-tree" aria-label="目录与标签">
      <div className="kb-tree-head">
        <span>目录</span>
        {!props.readOnly && (
          <button type="button" className="kb-link-btn" onClick={() => props.createDir(null)}>＋ 新目录</button>
        )}
      </div>
      <div
        className="kb-dir-row"
        data-active={props.dir === undefined}
        data-over={over === ':all'}
        {...allDrop}
      >
        <span className="kb-dir-arrow" />
        <button type="button" className="kb-dir-name" onClick={() => props.pickDir(undefined)}>全部</button>
        <span className="kb-count">{totalDocs}</span>
      </div>
      <div
        className="kb-dir-row"
        data-active={props.dir === api.UNASSIGNED}
        data-over={over === ':unassigned'}
        {...unassignedDrop}
      >
        <span className="kb-dir-arrow" />
        <button type="button" className="kb-dir-name" onClick={() => props.pickDir(api.UNASSIGNED)}>未归类</button>
        <span className="kb-count">{unassignedDocs}</span>
      </div>
      <ul className="kb-dir-list">
        {dirs.map((node) => (
          <DirRow
            key={node.id}
            tree={props}
            node={node}
            depth={0}
            collapsed={collapsed}
            toggle={toggle}
            over={over}
            setOver={setOver}
          />
        ))}
      </ul>
      {tags.length > 0 && (
        <>
          <div className="kb-tree-head"><span>标签</span></div>
          <div className="kb-tags">
            {tags.map((item) => {
              const isActive = props.tag === item.name;
              //M 再点一次已选的标签就是取消。
              let next: string | undefined = item.name;
              if (isActive) {
                next = undefined;
              }
              return (
                <button
                  key={item.id}
                  type="button"
                  className="kb-tag"
                  data-active={isActive}
                  onClick={() => props.pickTag(next)}
                >
                  #{item.name}<span className="kb-count">{item.docCount}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
    </nav>
  );
}
