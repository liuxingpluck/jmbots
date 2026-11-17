/**
 * 微信定位/搜索/核对/粘贴探针/单次发送入口。中文参数从 UTF-8 JSON 读取。
 * 用法：third_party\runtimes\bun\bun.exe src\entries\Wx.ts --args-file var\tmp\Wx_Request.json
 * 副作用由 JSON 中的 operation 决定；send 仅放行固定授权文字并有一次性门禁。
 * 依赖：Paths、Watch、WxLocate、WxControl；不读或打印聊天正文、密钥、截图。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as util from 'node:util';
import * as cordis from 'cordis';
import * as paths from '../services/Paths.ts';
import * as watch from '../services/Watch.ts';
import * as wxLocate from '../services/WxLocate.ts';
import * as wxControl from '../services/WxControl.ts';

/** 一次明确的操作请求文件。 */
interface RequestFile extends wxControl.WxOperation {
  /** 由账号接口核实过的目标。 */
  target: wxControl.WxTarget;
  /** 当前 AOBW 根地址。 */
  aobwUrl: string;
  /** 结果文件，项目内相对路径。 */
  out: string;
  /** 为 true 时另测现有点阵定位，仅支持 locate。 */
  testDm?: boolean;
}

/** 读取请求、挂插件、完成一步并写不含正文的结果。 */
async function main(): Promise<void> {
  const args = util.parseArgs({ options: { 'args-file': { type: 'string' } }, strict: true });
  if (!args.values['args-file']) {
    throw new Error('请提供 UTF-8 的 --args-file');
  }
  const root = path.resolve(import.meta.dir, '../..');
  const request = JSON.parse(fs.readFileSync(path.resolve(root, args.values['args-file']), 'utf8').replace(/^\uFEFF/, '')) as RequestFile;
  if (!request.target?.account || !request.target.chat || !request.target.name || !request.out) {
    throw new Error('请求缺少目标或结果路径');
  }
  const app = new cordis.Context();
  const fibers = [app.plugin(paths.Paths, { root }), app.plugin(watch.Watch), app.plugin(wxLocate.WxLocate, { url: request.aobwUrl })];
  try {
    for (const fiber of fibers) {
      await fiber;
    }
    const control = app.plugin(wxControl.WxControl, { aobwUrl: request.aobwUrl });
    fibers.push(control);
    await control;
    const started = performance.now();
    const result = await app.wxcontrol.run(request.target, request);
    if (request.testDm && request.operation === 'locate') {
      try {
        const hit = await app.wxlocate.findChat(request.target.name);
        result.dm = hit === null ? { found: false } : { found: true, x: hit.x, y: hit.y, confidence: hit.confidence, matches: hit.matches, ms: hit.ms };
      } catch {
        result.dm = { found: false, error: 'dm_locate_failed' };
      }
    }
    result.totalMs = Math.round(performance.now() - started);
    const out = app.paths.managed(request.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } finally {
    for (const fiber of fibers.reverse()) {
      await fiber.dispose();
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(error instanceof Error ? error.message : '微信操作失败');
  process.exitCode = 1;
}
