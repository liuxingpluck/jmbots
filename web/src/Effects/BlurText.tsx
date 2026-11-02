/**
 * 模糊入场文字：文字一块块从模糊、透明、略偏上的位置落下变清晰，挂上页面时播一次。
 * 只给短标题、空状态这类短文字用，不给正文用。动效关着（见 PrefsStore.ts）时直接显示文字。
 * 读屏软件读到的是一整段原文，拆开的小块对它隐藏。
 *
 * 改编自 React Bits 的 BlurText（TS-CSS 版，https://reactbits.dev/r/BlurText-TS-CSS.json，2026-10-29 取），动画用 motion 12。
 * 版权和许可见同目录 ReactBits_LICENSE.md（MIT + Commons Clause）。
 * 改动：只留默认的 blur 效果、从上方落下、挂上页面就播；去掉另外四种效果、滚动进入/悬停/点击触发、循环、变色和悬停聚焦；按项目规范改写。
 */
import * as motionReact from 'motion/react';
import * as react from 'react';
import type { CSSProperties } from 'react';
import * as prefsStore from '../PrefsStore.ts';


/** BlurText 的参数。 */
interface BlurTextProps {
  /** 要显示的文字。 */
  text: string;
  /** 按词拆（以空格分开）还是按字拆；中文没有空格，要逐字入场就用 'letters'。默认按词。 */
  animateBy?: 'words' | 'letters';
  /** 相邻两块开始入场的间隔（ms），默认 200。 */
  delay?: number;
  /** 开始时的模糊半径（px），默认 10。 */
  blur?: number;
  /** 开始时在最终位置上方多远（px），默认 50。 */
  distance?: number;
}


/** 拆好的一块文字。 */
interface Piece {
  /** 第几块，从 0 起；决定它晚多久开始入场。 */
  index: number;
  /** 这一块显示的文字。 */
  content: string;
  /** React 的 key。 */
  key: string;
}


/** 每块入场的时长（秒）：原组件默认 stepDuration 0.35 秒 × 2 步。 */
const DURATION = 0.7;


/** 不换行空格：词后面的空格用它，放在行内块里也不会被浏览器吞掉。源码里不直接写这个字符：它和普通空格看起来一样，lint 也不允许。 */
const NO_BREAK_SPACE = String.fromCharCode(0xa0);


/** 只给读屏软件看的整段原文：不占位置、不能选中。 */
const SCREEN_READER_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
  userSelect: 'none',
};


/** 整段文字：词与词之间可以换行。 */
const TEXT_STYLE: CSSProperties = { display: 'inline-flex', flexWrap: 'wrap' };


/** 一个词的各块放在一起，词内不断行。 */
const WORD_STYLE: CSSProperties = { display: 'inline-flex' };


/** 每一块：行内块，并提前告诉浏览器这三项会变。 */
const PIECE_STYLE: CSSProperties = { display: 'inline-block', willChange: 'transform, filter, opacity' };


/** 模糊入场文字；动效关着时就是普通文字。 */
export default function BlurText(props: BlurTextProps) {
  /** 现在能不能播动效。 */
  const allowed = prefsStore.usePrefsStore(prefsStore.motionAllowed);
  // g: 动效关着时直接显示文字。
  if (!allowed) {
    return <span>{props.text}</span>;
  }
  return <BlurPieces {...props} />;
}


/** 拆成小块、逐块入场的文字；每次挂上页面播一次。 */
function BlurPieces(props: BlurTextProps) {
  /** 开始时的模糊半径（px）。 */
  const blur = Math.max(0, props.blur ?? 10);
  /** 开始时在上方多远（px）。 */
  const distance = props.distance ?? 50;
  /** 相邻两块的间隔（秒）。 */
  const stagger = Math.max(0, props.delay ?? 200) / 1000;
  /** 按词分好组的小块。 */
  const words = react.useMemo(() => splitText(props.text, props.animateBy ?? 'words'), [props.text, props.animateBy]);

  return (
    <span style={TEXT_STYLE}>
      <span style={SCREEN_READER_ONLY}>{props.text}</span>
      {words.map((pieces, w) => (
        <span key={`word-${w}`} style={WORD_STYLE}>
          {pieces.map((piece) => (
            <motionReact.motion.span
              key={piece.key}
              aria-hidden="true"
              style={PIECE_STYLE}
              initial={{ filter: `blur(${blur}px)`, opacity: 0, y: -distance }}
              animate={{ filter: 'blur(0px)', opacity: 1, y: 0 }}
              transition={{
                duration: DURATION,
                delay: piece.index * stagger,
                ease: 'linear',
                // 位移用带一点回弹的弹簧，落到位置时轻轻弹一下。
                y: { type: 'spring', visualDuration: DURATION / 2, bounce: 0.35, delay: piece.index * stagger },
              }}
            >
              {piece.content}
            </motionReact.motion.span>
          ))}
        </span>
      ))}
    </span>
  );
}


/**
 * 把文字拆成小块，按词（以空格分开）分组；同一个词的块放在一组，组内不断行。
 * 按词拆时每个词一块，词后的空格并进这一块；按字拆时每个字一块，词之间的空格单独一块。块的序号从 0 起连续编。
 */
function splitText(text: string, animateBy: 'words' | 'letters'): Piece[][] {
  /** 以空格分开的词。 */
  const words = text.split(' ');
  /** 下一块的序号。 */
  let next = 0;
  return words.map((word, w) => {
    /** 是不是最后一个词；最后一个词后面不跟空格。 */
    const isLast = w === words.length - 1;
    if (animateBy === 'words') {
      /** 这个词整块。 */
      const piece: Piece = { index: next, content: isLast ? word : `${word}${NO_BREAK_SPACE}`, key: `word-${w}` };
      next += 1;
      return [piece];
    }
    /** 这个词的每个字。 */
    const pieces: Piece[] = Array.from(word).map((char, c) => ({ index: next + c, content: char, key: `char-${w}-${c}` }));
    next += pieces.length;
    if (!isLast) {
      pieces.push({ index: next, content: NO_BREAK_SPACE, key: `space-${w}` });
      next += 1;
    }
    return pieces;
  });
}
