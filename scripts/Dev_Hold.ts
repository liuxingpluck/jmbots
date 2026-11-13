/**
 * 开发模式开关：按住看门狗，让它只看不动手（不起服务、不回退、不存快照）。
 * 开发时我们会反复停服务、改坏代码，看门狗照常守着就会跟我们打架。
 *
 * 用法：
 *   bun scripts/Dev_Hold.ts on [分钟]   按住，默认 120 分钟，到点自动放开
 *   bun scripts/Dev_Hold.ts off         放开
 *   bun scripts/Dev_Hold.ts status      看现在按没按住
 */
import * as serveProcess from './Serve_Process.ts';


/**
 * 把到期时间写成人看得懂的样子。
 * @param until 到期时间，毫秒。
 * @returns 例如 "02:31:40（还有 118 分钟）"。
 */
function describe(until: number): string {
  /** 还剩多少分钟，向上取整。 */
  const minutes = Math.ceil((until - Date.now()) / 60_000);
  return `${new Date(until).toLocaleTimeString('zh-CN', { hour12: false })}（还有 ${minutes} 分钟）`;
}


/**
 * 跑一次命令行。
 * @returns 无。
 */
function main(): void {
  /** 运行时目录。 */
  const runtimeDir = serveProcess.runtimeDir();
  /** 子命令。 */
  const action = (process.argv[2] ?? 'status').toLowerCase();
  /** 现在按到什么时候；没按住就是 undefined。 */
  const until = serveProcess.devHoldUntil(runtimeDir);

  if (action === 'status') {
    console.log(until === undefined ? '看门狗正常守着（没按住）' : `开发模式按住中，到 ${describe(until)}`);
    return;
  }
  if (action === 'off') {
    console.log(serveProcess.releaseDev(runtimeDir) ? '已放开，看门狗恢复正常（最多 30 秒后生效）' : '本来就没按住');
    return;
  }
  if (action === 'on') {
    /** 按多少分钟。 */
    const minutes = Number(process.argv[3] ?? serveProcess.DEV_HOLD_DEFAULT_MINUTES);
    if (!Number.isFinite(minutes) || minutes <= 0) {
      throw new Error('分钟数要是大于 0 的数字');
    }
    console.log(`已按住看门狗，到 ${describe(serveProcess.holdDev(runtimeDir, minutes))}；完事记得 bun scripts/Dev_Hold.ts off`);
    return;
  }
  throw new Error(`不认识的命令 ${action}，只能是 on / off / status`);
}


//G 只有直接跑才执行；测试 import 它不能真的去按锁。
if (import.meta.main) {
  main();
}
