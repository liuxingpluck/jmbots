/**
 * 手机布局：一次只显示一层，目录 → 文档列表 → 文档，左上角的返回键回到上一层。
 * 用的是和 PC 一样的三个栏目，只按网址决定显示哪一个。屏幕宽度小于 768px 时由 App 选用。
 */
import * as icons from '@ant-design/icons';
import * as antd from 'antd';
import type { ReactNode } from 'react';
import * as knowledgeStore from '../KnowledgeStore.ts';
import type * as route from '../Route.ts';
import type { KnowledgeBase } from '../Types.ts';
import * as viewStore from '../ViewStore.ts';


/** MobileLayout 的参数。 */
interface MobileLayoutProps {
  /** 搜索框；只在文档列表这一层显示。 */
  search: ReactNode;
  /** 目录这一层的内容。 */
  left: ReactNode;
  /** 文档列表这一层的内容。 */
  middle: ReactNode;
  /** 文档这一层的内容。 */
  right: ReactNode;
}


/** 手机上当前显示的一层：目录、文档列表、文档。 */
type MobileLevel = 'bases' | 'documents' | 'document';


/** 手机布局：顶部一行，下面是当前这一层的内容。 */
export default function MobileLayout(props: MobileLayoutProps) {
  /** 网址里的选中状态，决定显示哪一层。 */
  const current = viewStore.useViewStore((state) => state.route);
  /** 全部目录，用来在返回键上显示目录名。 */
  const bases = knowledgeStore.useKnowledgeStore((state) => state.bases);

  // m: 按网址定出当前这一层，再取这一层的内容。
  /** 当前显示的一层。 */
  const level = readLevel(current);
  /** 每一层对应的内容。 */
  const panes: Record<MobileLevel, ReactNode> = { bases: props.left, documents: props.middle, document: props.right };
  /** 当前目录的名字，显示在文档这一层的返回键上。 */
  const baseName = findBaseName(current.baseId, bases);

  return (
    <div className="mobile-layout">
      <header className="mobile-header">
        <MobileHeader level={level} baseId={current.baseId} baseName={baseName} search={props.search} />
      </header>
      <main className="mobile-pane">{panes[level]}</main>
    </div>
  );
}


/** MobileHeader 的参数。 */
interface MobileHeaderProps {
  /** 当前显示的一层。 */
  level: MobileLevel;
  /** 当前的目录 ID，文档这一层返回时回到这个目录的列表。 */
  baseId: route.Route['baseId'];
  /** 当前目录的名字。 */
  baseName: string;
  /** 文档列表这一层显示的搜索框。 */
  search: ReactNode;
}


/** 顶部一行：目录这一层显示名称；列表这一层是返回键加搜索框；文档这一层是返回键加目录名。 */
function MobileHeader(props: MobileHeaderProps) {
  /** 返回上一层的动作。 */
  const goUp = viewStore.useViewStore((state) => state.goUp);
  // m: 目录是最上层，没有返回键。
  if (props.level === 'bases') {
    return (
      <>
        <span className="top-bar-brand">JMAI</span>
        <span className="mobile-title">知识库</span>
      </>
    );
  }
  // m: 列表这一层退回目录。
  if (props.level === 'documents') {
    return (
      <>
        <antd.Button
          type="text"
          className="mobile-back"
          icon={<icons.LeftOutlined />}
          onClick={() => goUp({ baseId: null, documentId: null })}
        >
          目录
        </antd.Button>
        {props.search}
      </>
    );
  }
  // m: 文档这一层退回所在目录的列表。
  return (
    <antd.Button
      type="text"
      className="mobile-back"
      icon={<icons.LeftOutlined />}
      onClick={() => goUp({ baseId: props.baseId, documentId: null })}
    >
      <span className="mobile-title">{props.baseName}</span>
    </antd.Button>
  );
}


/** 按网址决定显示哪一层：选了文档显示正文，选了目录显示列表，都没选显示目录。 */
function readLevel(current: route.Route): MobileLevel {
  if (current.documentId !== null) {
    return 'document';
  }
  if (current.baseId !== null) {
    return 'documents';
  }
  return 'bases';
}


/** 目录 ID 对应的名字；没选目录或选“全部文档”时是“全部文档”，目录不存在时是“目录”。 */
function findBaseName(baseId: route.Route['baseId'], bases: KnowledgeBase[]): string {
  if (baseId === null || baseId === 'all') {
    return '全部文档';
  }
  return bases.find((base) => base.id === baseId)?.name ?? '目录';
}
