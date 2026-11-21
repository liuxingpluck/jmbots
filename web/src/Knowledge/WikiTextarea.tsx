/**
 * 知识库源码编辑框，带 Obsidian 式的 [[ 联想：敲出 [[ 后在光标下方弹出候选标题，边敲边过滤，
 * 上下键挑、回车或 Tab 插入 [[标题]]，Esc 收起；点候选也能插入。没有对上的标题时可以照敲的字插入一个新词条链接。
 * 候选来自 KnowledgePage 用整库图谱建的标题索引（WikiLinks.ts 的 TitleIndex）。
 */
import * as react from 'react';
import * as wiki from './WikiLinks.ts';

/** 最多列几个候选。 */
const MAX_SUGGESTIONS = 8;

/** 浮层宽度（和 CSS .kb-wiki-pop 一致），靠右时往左挪，不出框。 */
const POP_WIDTH = 260;

/** 量光标位置时从编辑框抄到影子 div 上的样式。 */
const MIRROR_STYLES = [
  'boxSizing',
  'width',
  'paddingTop',
  'paddingRight',
  'paddingBottom',
  'paddingLeft',
  'borderTopWidth',
  'borderRightWidth',
  'borderBottomWidth',
  'borderLeftWidth',
  'fontFamily',
  'fontSize',
  'fontWeight',
  'lineHeight',
  'letterSpacing',
  'tabSize',
] as const;


/** WikiTextarea 的入参。 */
export interface WikiTextareaProps {
  /** 正文。 */
  value: string;
  /** 只读：不弹联想。 */
  readOnly: boolean;
  /** 标题索引。 */
  titles: wiki.TitleIndex;
  /** 正文变了。实现在 KnowledgeEditor 的 setField('content', …)。 */
  onChange: (value: string) => void;
}

/** 正在联想的状态。 */
interface Suggest {
  /** 没写完的 [[。 */
  open: wiki.OpenLink;
  /** 候选标题；最后一个可能是“照敲的字新建”。 */
  items: string[];
  /** 现在高亮第几个。 */
  active: number;
  /** 浮层相对编辑框外层的位置。 */
  top: number;
  /** 浮层左边。 */
  left: number;
}


/**
 * 量光标在编辑框里的位置：照编辑框的样式铺一个看不见的 div，放进光标前的字，量末尾标记的位置。
 * @param area 编辑框。
 * @param caret 光标位置。
 * @returns 相对编辑框左上角（已减去滚动）的位置，top 是光标这一行的底边。
 */
function getCaretPoint(area: HTMLTextAreaElement, caret: number): { top: number; left: number } {
  const style = window.getComputedStyle(area);
  const mirror = document.createElement('div');
  for (const key of MIRROR_STYLES) {
    mirror.style[key] = style[key];
  }
  mirror.style.position = 'absolute';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.textContent = area.value.slice(0, caret);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.append(marker);
  document.body.append(mirror);

  //M 行高读不出数字（normal）时按字号的 1.7 倍算。
  let lineHeight = Number.parseFloat(style.lineHeight);
  if (Number.isNaN(lineHeight)) {
    lineHeight = Number.parseFloat(style.fontSize) * 1.7;
  }
  const top = marker.offsetTop - area.scrollTop + lineHeight;
  const left = marker.offsetLeft - area.scrollLeft;
  mirror.remove();
  return { top, left };
}


/** 带 [[ 联想的源码编辑框。 */
export function WikiTextarea(props: WikiTextareaProps): react.JSX.Element {
  const { value, readOnly, titles, onChange } = props;
  const areaRef = react.useRef<HTMLTextAreaElement>(null);
  const [suggest, setSuggest] = react.useState<Suggest>();

  /** Esc 收起的那个 [[ 的起点：同一个 [[ 不再弹，换个地方敲 [[ 才弹。 */
  const dismissedRef = react.useRef(-1);

  /** 插入后要放光标的位置：等 React 把新正文写进编辑框后再放。 */
  const caretRef = react.useRef<number | undefined>(undefined);

  react.useLayoutEffect(() => {
    const area = areaRef.current;
    const caret = caretRef.current;
    if (area === null || caret === undefined) return;

    caretRef.current = undefined;
    area.focus();
    area.setSelectionRange(caret, caret);
  }, [value]);

  /** 看光标前有没有没写完的 [[，有就算候选、量位置，没有就收起。 */
  const refresh = (area: HTMLTextAreaElement): void => {
    const caret = area.selectionStart;
    const open = wiki.getOpenLink(area.value, caret);

    //M 光标已经不在没写完的 [[ 里：忘掉 Esc 收起过的那个，下次敲 [[ 照常弹。
    if (open === undefined) {
      dismissedRef.current = -1;
    }
    if (readOnly || open === undefined || open.start === dismissedRef.current) {
      setSuggest(undefined);
      return;
    }

    //M 候选：索引里对上的标题；敲了字又没有一模一样的，末尾加一个“照敲的字”当新词条。
    const items = wiki.getSuggestions(titles, open.query, MAX_SUGGESTIONS);
    const typed = open.query.trim();
    const hasExact = items.some((item) => item.toLowerCase() === typed.toLowerCase());
    if (typed !== '' && !hasExact) {
      items.push(typed);
    }
    if (items.length === 0) {
      setSuggest(undefined);
      return;
    }

    const point = getCaretPoint(area, caret);
    const maxLeft = Math.max(0, area.clientWidth - POP_WIDTH);
    const left = Math.min(point.left, maxLeft);
    setSuggest((current) => {
      let active = 0;
      if (current !== undefined && current.open.start === open.start) {
        active = Math.min(current.active, items.length - 1);
      }
      return { open, items, active, top: point.top, left };
    });
  };

  /** 选中一个候选：换成 [[标题]]，光标放到 ]] 后面。 */
  const pick = (title: string): void => {
    const area = areaRef.current;
    if (area === null || suggest === undefined) return;

    const inserted = wiki.insertWikiLink(area.value, suggest.open, area.selectionStart, title);
    caretRef.current = inserted.caret;
    setSuggest(undefined);
    onChange(inserted.text);
  };

  const onKeyDown = (event: react.KeyboardEvent<HTMLTextAreaElement>): void => {
    //G 没在联想、或中文输入法还在选字：照常打字。
    if (suggest === undefined || event.nativeEvent.isComposing || event.keyCode === 229) return;

    const count = suggest.items.length;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      let step = 1;
      if (event.key === 'ArrowUp') {
        step = count - 1;
      }
      setSuggest({ ...suggest, active: (suggest.active + step) % count });
      return;
    }
    if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      pick(suggest.items[suggest.active]!);
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      dismissedRef.current = suggest.open.start;
      setSuggest(undefined);
    }
  };

  //M 新词条那一项：不在索引里的标题。
  const isNewTitle = (title: string): boolean => !titles.has(title.toLowerCase());

  return (
    <div className="kb-source-wrap">
      <textarea
        ref={areaRef}
        className="kb-source"
        value={value}
        placeholder="用 Markdown 写正文；敲 [[ 链接到别的词条"
        readOnly={readOnly}
        spellCheck={false}
        onChange={(event) => {
          onChange(event.target.value);
          refresh(event.target);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          //M 只有挪光标的键要重新看一眼；打字已经在 onChange 里看过。
          const moves = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
          if (moves.includes(event.key)) {
            refresh(event.currentTarget);
          }
        }}
        onClick={(event) => refresh(event.currentTarget)}
        onScroll={() => setSuggest(undefined)}
        onBlur={() => setSuggest(undefined)}
      />
      {suggest !== undefined && (
        <ul className="kb-wiki-pop" role="listbox" style={{ top: suggest.top, left: suggest.left }}>
          {suggest.items.map((title, index) => (
            <li
              key={title}
              role="option"
              aria-selected={index === suggest.active}
              data-active={index === suggest.active}
              onMouseDown={(event) => {
                //M 用 mousedown 并阻止默认：不让编辑框先失焦把浮层收掉。
                event.preventDefault();
                pick(title);
              }}
            >
              <span className="kb-wiki-pop-title">{title}</span>
              {isNewTitle(title) && <span className="kb-wiki-pop-new">新词条</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
