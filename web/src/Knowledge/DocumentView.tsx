/**
 * 右栏“文档”：显示选中文档的标题、标签、时间和正文；没选文档时显示欢迎卡片（光斑和标题入场动效，见 Effects/）。
 * 文档 ID 来自网址（ViewStore）；列表里只有摘要，全文按需经 KnowledgeStore 的 openDocument 去取。骨架阶段正文按纯文本显示，Markdown 渲染第 5 步再加。
 * 正文不加动效。
 */
import * as antd from 'antd';
import * as react from 'react';
import BlurText from '../Effects/BlurText.tsx';
import SpotlightCard from '../Effects/SpotlightCard.tsx';
import * as format from '../Format.ts';
import * as knowledgeStore from '../KnowledgeStore.ts';
import type { DocumentDetail } from '../Types.ts';
import * as viewStore from '../ViewStore.ts';


/** 文档栏：文档 ID 来自 ViewStore，全文来自 KnowledgeStore。 */
export default function DocumentView() {
  /** 网址里的选中状态。 */
  const current = viewStore.useViewStore((state) => state.route);
  /** 最近一次取回的全文；还没取过时为 null。 */
  const loaded = knowledgeStore.useKnowledgeStore((state) => state.opened);
  /** 取全文的动作。 */
  const openDocument = knowledgeStore.useKnowledgeStore((state) => state.openDocument);

  // m: 网址里换了文档就去取全文；过时的结果由 openDocument 丢掉。
  react.useEffect(() => {
    if (current.documentId !== null) {
      void openDocument(current.documentId);
    }
  }, [current.documentId, openDocument]);

  // g: 没选文档、全文还没回来、取失败或这篇不存在时，各给一个提示。
  if (current.documentId === null) {
    return <WelcomeCard />;
  }
  if (loaded === null || loaded.documentId !== current.documentId) {
    return (
      <div className="document-placeholder">
        <antd.Spin />
      </div>
    );
  }
  if (loaded.error !== null) {
    return <antd.Result status="error" title="读取失败" subTitle={loaded.error} />;
  }
  if (loaded.detail === null) {
    return <antd.Empty className="document-placeholder" description="这篇文档不存在" />;
  }
  return <DocumentBody detail={loaded.detail} />;
}


/**
 * 没选文档时的欢迎卡片：标题逐字模糊入场，鼠标经过时卡片上有光斑；动效关着时静止。
 * 只在 PC 上出现：手机上要选了文档才会进到这一层。
 */
function WelcomeCard() {
  return (
    <div className="document-placeholder">
      <SpotlightCard className="welcome-card" intensity={0.12}>
        <antd.Typography.Title level={3} className="welcome-title">
          <BlurText text="JMAI 知识库" animateBy="letters" delay={60} blur={8} distance={18} />
        </antd.Typography.Title>
        <antd.Typography.Text type="secondary">从中间的列表选一篇文档，正文会显示在这里。</antd.Typography.Text>
      </SpotlightCard>
    </div>
  );
}


/** DocumentBody 的参数。 */
interface DocumentBodyProps {
  /** 要显示的全文。 */
  detail: DocumentDetail;
}


/** 正文区：标题，标签和时间，分隔线，正文。 */
function DocumentBody(props: DocumentBodyProps) {
  return (
    <article className="document-view">
      <antd.Typography.Title level={3}>{props.detail.title}</antd.Typography.Title>
      <div className="document-meta">
        {props.detail.tags.map((tag) => (
          <antd.Tag key={tag}>{tag}</antd.Tag>
        ))}
        <span className="document-time">{format.formatTime(props.detail.createdAt)}</span>
      </div>
      <antd.Divider />
      <div className="document-content">{props.detail.content}</div>
    </article>
  );
}
