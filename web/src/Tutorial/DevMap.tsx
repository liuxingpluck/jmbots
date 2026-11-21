/**
 * 新插件开发速查地图：盖在教程页上的一整屏，按卡片讲会话四关口、HTTP 启动骨架、数据读写断点和三类扩展模板。
 * 每个源码位置可以原地展开真实源码（SourceToggle）、一键跳 VS Code（SiteLink）；模板一键复制（copyText）。
 * 数据在 DevMapData.ts；由 TutorialPage 在地址带 ?view=dev-map 或点顶栏「开发地图」时 lazy 加载。
 */
import { useState, type JSX } from 'react';
import { SiteLink } from '../VscodeLink.tsx';
import { SourceToggle, copyText } from './Code.tsx';
import { DEV_CARDS, getSite } from './DevMapData.ts';
import type { DevCard } from './DevMapData.ts';
import './DevMap.css';


/**
 * 一张卡上的模板代码块：右上角一个复制按钮，按钮上的字随结果变。
 * @param props.code 模板代码。
 */
function TemplateBlock(props: { code: string }): JSX.Element {
  const [said, setSaid] = useState('复制模板');
  return (
    <div className="tu-dm-template">
      <button type="button" className="tu-dm-copy" onClick={() => copyText(props.code, setSaid)}>{said}</button>
      <pre>{props.code}</pre>
    </div>
  );
}


/**
 * 一张速查卡。
 * @param props.card 卡片数据。
 */
function CardView(props: { card: DevCard }): JSX.Element {
  const { card } = props;
  return (
    <section className="tu-dm-card" id={`dev-map-${card.key}`}>
      <h2>{card.title}</h2>
      <p className="tu-dm-summary">{card.summary}</p>
      <ol className="tu-dm-items">
        {card.items.map((item) => (
          <li key={item.title}>
            <div className="tu-dm-item-title">{item.title}</div>
            <div className="tu-dm-note">{item.note}</div>
            <ul className="tu-dm-anchors">
              {item.anchors.map((anchor) => {
                const site = getSite(anchor);
                return (
                  <li key={site}>
                    <SiteLink site={site} />
                    <SourceToggle site={site} label="看源码" />
                  </li>
                );
              })}
            </ul>
          </li>
        ))}
      </ol>
      {card.template !== '' && <TemplateBlock code={card.template} />}
    </section>
  );
}


/**
 * 开发地图整屏。
 * @param props.onClose 关掉地图回教程页；实现在 TutorialPage 的 toggleDevMap，由它传进来。
 */
export function DevMap(props: { onClose: () => void }): JSX.Element {
  //M 点导航胶囊：滚到那张卡。
  const jump = (key: string): void => {
    document.getElementById(`dev-map-${key}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="tu-dm" role="dialog" aria-label="新插件开发地图">
      <header className="tu-dm-top">
        <span className="tu-dm-brand">新插件开发地图</span>
        <nav className="tu-dm-nav" aria-label="卡片">
          {DEV_CARDS.map((card) => (
            <button key={card.key} type="button" onClick={() => jump(card.key)}>{card.title}</button>
          ))}
        </nav>
        <button type="button" className="tu-dm-close" onClick={props.onClose}>关闭 ×</button>
      </header>
      <div className="tu-dm-body">
        <p className="tu-dm-lead">
          一条消息：渠道 emitInbound → bot/receive → 会话循环（四关口）→ session/change(done) → channel/reply → channel/replied。
          加功能先想挂在哪个事件上，再照下面的模板抄一个插件；每个位置都能原地看源码。
        </p>
        {DEV_CARDS.map((card) => <CardView key={card.key} card={card} />)}
        <section className="tu-dm-card">
          <h2>新插件清单</h2>
          <ul className="tu-dm-check">
            <li>src7/plugins/&lt;名字&gt;/index.ts 导出 name、version、inject、apply</li>
            <li>同目录写 说明.md，以版本号开头：干什么、依赖、听和发的事件、对外函数、数据表、配置</li>
            <li>在 src7/plugins/Index.ts 静态 import 并写进插件表</li>
            <li>建表、改表走 db 插件的版本迁移；写接口先 ctx.http.isVerified</li>
            <li>插件之间只靠事件：要别人帮忙就发一个事件、等一个事件</li>
          </ul>
        </section>
      </div>
    </div>
  );
}
