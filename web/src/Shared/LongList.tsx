/**
 * 可能变长的列表：条数少时照旧逐条画，到阈值才交给 react-virtuoso 只画看得见的。
 * 少量时不多包一层，DOM 和样式跟原来一样；虚拟时外层 CSS 的 gap 管不到每条，按 gap 给每条补下边距。
 * 用在右栏“正在运行”、聊天区进度条、待办、决策图侧栏的留言。
 */
import * as react from 'react';
import * as virtuoso from 'react-virtuoso';


/** 到多少条才虚拟化，和教程页的阈值一样。 */
export const VIRTUAL_FROM = 30;

/** 没有外层滚动容器时，自己滚动的窗口默认高度，像素。 */
const DEFAULT_HEIGHT = 240;


/** LongList 的参数。 */
interface LongListProps<T> {
  /** 全部条目。 */
  items: T[];
  /** 每条的稳定键，由调用方传入；条目没有号的才用下标。 */
  getKey: (item: T, index: number) => string | number;
  /** 画一条，由调用方传入。 */
  render: (item: T, index: number) => react.ReactNode;
  /** 条目之间的间距，像素；和外层 CSS 的 gap 写成一样。 */
  gap?: number;
  /** 外层本来就会滚动的容器；给了就跟着它滚，不另起一条滚动条。 */
  scrollParent?: HTMLElement | null;
  /** 没有外层滚动容器时，自己滚动的窗口高度，像素。 */
  height?: number;
}


/**
 * 少量照旧、多了才虚拟的列表。
 * @param props 条目、取键、画一条，以及虚拟时的间距、滚动容器或窗口高度。
 * @returns 少量时是条目本身（不包外层）；多了是 Virtuoso。
 */
export function LongList<T>(props: LongListProps<T>): react.JSX.Element {
  //M 不到阈值：原样逐条画，不多包一层。
  if (props.items.length < VIRTUAL_FROM) {
    return (
      <>
        {props.items.map((item, index) => (
          <react.Fragment key={props.getKey(item, index)}>
            {props.render(item, index)}
          </react.Fragment>
        ))}
      </>
    );
  }

  //M 虚拟时每条外面包一层，用下边距代替外层的 gap；flow-root 把条目自己的外边距收在里面，Virtuoso 才量得准高度。
  const itemStyle = { display: 'flow-root', paddingBottom: props.gap ?? 0 };
  const getItem = (index: number, item: T) => (
    <div style={itemStyle}>{props.render(item, index)}</div>
  );
  const getItemKey = (index: number, item: T) => props.getKey(item, index);

  //M 外层会滚：跟着外层滚，只画视口附近的条目。
  if (props.scrollParent) {
    return (
      <virtuoso.Virtuoso
        customScrollParent={props.scrollParent}
        data={props.items}
        computeItemKey={getItemKey}
        itemContent={getItem}
      />
    );
  }

  //M 外层不会滚：自己占一块固定高度的窗口。
  const style = { height: props.height ?? DEFAULT_HEIGHT };
  return (
    <virtuoso.Virtuoso
      style={style}
      data={props.items}
      computeItemKey={getItemKey}
      itemContent={getItem}
    />
  );
}
