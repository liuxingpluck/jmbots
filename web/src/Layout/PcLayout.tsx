/**
 * PC 布局：顶栏下面三栏，左目录、中文档列表、右文档正文。
 * 只管摆放，不碰数据；栏目内容由 App 传进来。第 4 步的手机布局用同样的三个栏目，只是一次显示一层。
 */
import type { ReactNode } from 'react';


/** PcLayout 的参数。 */
interface PcLayoutProps {
  /** 顶栏。 */
  header: ReactNode;
  /** 左栏：目录。 */
  left: ReactNode;
  /** 中栏：文档列表。 */
  middle: ReactNode;
  /** 右栏：文档正文。 */
  right: ReactNode;
}


/** 按固定宽度排三栏：左 240px、中 360px、右栏占剩下的宽度（宽度写在 App.css 的 .pc-layout）。 */
export default function PcLayout(props: PcLayoutProps) {
  return (
    <div className="pc-layout">
      <header className="pc-header">{props.header}</header>
      <aside className="pc-pane pc-left">{props.left}</aside>
      <section className="pc-pane pc-middle">{props.middle}</section>
      <main className="pc-pane pc-right">{props.right}</main>
    </div>
  );
}
