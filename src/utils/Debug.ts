/**
 * 调试打印（用户 11-07：“做一个通用的 log 调试打印函数，把那些关键的断点打出来，并且执行速度加慢一点”，原话第 95 节）。
 * 环境变量 JMBOTS_DEBUG=1 时，每个关键位置打一行：第几个点、时刻、在哪、关键变量；JMBOTS_DEBUG_SLOW_MS 大于 0 时每个点再停这么久，看得清。
 * 不设 JMBOTS_DEBUG 时什么都不做：不算变量、不打印、不停。
 * 配合 VS Code 用：.vscode/launch.json 里的“调试 HTTP 一条线”，在调试控制台看打印，想细看哪一步就在那一行下断点（docs/12_调试HTTP一条线.md）。
 */


/** 开没开调试打印。 */
const ENABLED = process.env.JMBOTS_DEBUG === '1';

/** 每个点停多久，毫秒；0 是不停。 */
const SLOW_MS = Math.max(0, Number(process.env.JMBOTS_DEBUG_SLOW_MS ?? '0') || 0);

/** 每个变量最多打多少字，长的截掉。 */
const MAX_TEXT = 160;

/** 已经打到第几个点（从 1 起，看先后）。 */
let count = 0;


/**
 * 一个变量打成一小段：字符串压成一行、截短；别的转 JSON 再截短。
 * @param value 变量。
 */
function brief(value: unknown): string {
  /** 先变成文字。 */
  let text: string;
  if (typeof value === 'string') {
    text = JSON.stringify(value.replace(/\s+/g, ' '));
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}…（共 ${String(text.length)} 字）` : text;
}


/** 开没开调试打印（调用处要算贵一点的东西时先问一声）。 */
export function enabled(): boolean {
  return ENABLED;
}


/**
 * 打一个点。
 * @param where 在哪，如“HTTP 收到 POST /api/message”。
 * @param vars 关键变量：给一个函数，没开调试时不调用，不多算。
 * @returns 开了慢速时等 JMBOTS_DEBUG_SLOW_MS 毫秒；没开调试时立刻返回。
 * 副作用：开了调试时往控制台打一行。从不抛错（取变量出错就打出错的原因）。
 */
export async function point(where: string, vars: () => Record<string, unknown> = () => ({})): Promise<void> {
  if (!ENABLED) {
    return;
  }
  count += 1;
  /** 打出来的变量。 */
  let shown: string;
  try {
    shown = Object.entries(vars())
      .map(([key, value]) => `${key}=${brief(value)}`)
      .join('  ');
  } catch (error) {
    shown = `（变量没取到：${error instanceof Error ? error.message : String(error)}）`;
  }
  /** 时刻（时:分:秒.毫秒，本机时区）。 */
  const clock = `${new Date().toTimeString().slice(0, 8)}.${String(Date.now() % 1000).padStart(3, '0')}`;
  console.log(`[调试 ${String(count).padStart(3, ' ')} ${clock}] ${where}${shown ? `  ${shown}` : ''}`);
  if (SLOW_MS > 0) {
    await new Promise((resolve) => setTimeout(resolve, SLOW_MS));
  }
}
