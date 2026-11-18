/**
 * 源码根目录名（仓库下放 Main.ts 的那一层）。
 * 代码里拼“源码根/…”路径、认“源码根/…”开头的地方都从这里取，以后目录改名只改 SOURCE_DIR 这一处。
 * 用常量、不从 import.meta.dir 往上算：编进单个程序以后，每个模块的 import.meta.dir 都是 Bun 的虚拟根（B:\~BUN\root），
 *   算不出目录名；编译版教程页取源码的登记名（scripts/Build_Src7.ts 的 writeEntry）也是这个名字开头。
 * 本文件不 import 任何模块：网页（web/src/VscodeLink.tsx、Tutorial/ReadmeTabs.tsx）也直接 import 它，打包时一起打进网页。
 */


/** 源码根目录名。 */
export const SOURCE_DIR = 'src7';

/** 源码根目录前缀，带正斜杠，相对仓库根的源码路径都这样开头，如 src7/Main.ts。 */
export const SOURCE_PREFIX = `${SOURCE_DIR}/`;

/** 源码前缀前面可以是的字：路径分隔符、空白、引号、括号、冒号、等号。 */
const BOUNDARY = /[\\/\s"'`([<:=]/u;

/** 前面紧挨着的是 web/ 这一层（前面是开头或分隔符）：那是网页的源码，不是后端源码根。 */
const WEB_TAIL = /(?:^|[\\/\s"'`([<:=])web[\\/]$/u;


/**
 * 一段文字（多半是路径）里最后一处真正的源码前缀从哪起。
 * 要求前面是开头或分隔符（mysrc7/ 不算），且不是 web/ 后面那个（目录改名成 src 后，web/src/ 不能误认成源码根）。
 * @param text 文字，如 F:\aidata\source\jmbots\src7\Main.ts 换成正斜杠后、或 web/src/App.tsx。
 * @returns 下标；没有是 -1。
 */
export function getSourceStart(text: string): number {
  //M 从后往前一处处试，第一处符合的就是。
  let at = text.lastIndexOf(SOURCE_PREFIX);
  while (at >= 0) {
    if (isSourceStart(text, at)) return at;

    //G 已经试到开头：没有了（再往前找会一直找回 0）。
    if (at === 0) return -1;

    at = text.lastIndexOf(SOURCE_PREFIX, at - 1);
  }
  return -1;
}


/**
 * text 的 at 处起的源码前缀是不是真的源码根（前面是开头或分隔符，且不在 web/ 下面）。
 * @param text 文字。
 * @param at 源码前缀的下标。
 */
function isSourceStart(text: string, at: number): boolean {
  if (at === 0) return true;

  //G 前一个字不是分隔符：是别的目录名的尾巴，如 mysrc7/。
  const before = text.charAt(at - 1);
  if (!BOUNDARY.test(before)) return false;

  //G 紧挨着 web/：网页的源码。
  const head = text.slice(0, at);
  return !WEB_TAIL.test(head);
}
