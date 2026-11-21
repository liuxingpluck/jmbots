/**
 * 版本表：编译出来的程序跑 `version` 时打印这份 JSON，给基地认版本、列更新说明。
 * 版本说明是数据，放在同目录的 Versions.json；换版在 Versions.json 最前面加一项。
 */
import * as embedded from './Embedded.ts';
import versionsData from './Versions.json' with { type: 'json' };


/** 版本说明，新的在前，内容来自 Versions.json。 */
export const VERSIONS = versionsData;

/** 现在的版本号：Versions.json 第一项的 version。 */
export const VERSION = VERSIONS[0]!.version;


/**
 * 打印版本 JSON 到标准输出。
 * 副作用：写一行 JSON。
 */
export function printVersionInfo(): void {
  //M 仅打印最近 20 条更新说明，防 Windows 64KiB 匿名管道满载导致基地读版本死锁超时；完整历史仍在 VERSIONS。
  const payload = {
    version: VERSION,
    builtAt: embedded.getBuiltTime() || Date.now(),
    versions: VERSIONS.slice(0, 20),
  };
  console.log(JSON.stringify(payload));
}
