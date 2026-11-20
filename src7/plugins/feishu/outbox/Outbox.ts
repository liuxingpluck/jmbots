/**
 * 飞书发件箱：外面的程序往运行时目录 integrations/feishu/outbox/ 放 .md 文件，这里每 5 秒看一次，
 * 发给配置里第一个应用最近私聊的人，发完挪进 integrations/feishu/sent/。
 * 每个插件实例各自管理投递状态；上一轮没做完这一轮跳过；一份发失败这一轮停下，下一轮再试。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type * as cordis from 'cordis';
import * as textModule from '../../../utils/Text.ts';
import type { Feishu } from '../index.ts';


/** 多久看一次，毫秒。 */
export const OUTBOX_INTERVAL_MS = 5000;


/**
 * 开发件箱：ready 时开定时器，插件被拔掉时停。
 * @param feishu 飞书渠道。
 * @param ctx 本插件的 ctx。
 */
export function setup(feishu: Feishu, ctx: cordis.Context): void {
  //M 初始化发件箱待发与已发目录，确保运行时目录存在。
  const outbox = ctx.resources.ensureRuntimeDir('integrations', 'feishu', 'outbox');
  const sent = ctx.resources.ensureRuntimeDir('integrations', 'feishu', 'sent');
  let busy = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  /** 看一遍发件箱。 */
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      const names = fs.readdirSync(outbox).filter((name) => name.endsWith('.md')).sort();
      for (const name of names) {
        const from = path.join(outbox, name);
        if (!fs.statSync(from).isFile()) continue;
        const text = fs.readFileSync(from, 'utf8').trim();
        if (text !== '') {
          //M 查询最近私聊用户作为默认投递目标，无私聊记录则抛错中止本轮。
          const to = feishu.lastPrivate();
          if (to === undefined) {
            throw new Error('飞书还没有人私聊过，不知道发给谁');
          }
          //M 通过飞书文本消息通道把发件箱正文推给该用户。
          await feishu.sendText(to, text);
        }

        //M 发完（空的也）挪进 sent/，同名已有就覆盖。
        fs.renameSync(from, path.join(sent, name));

        //T 跟踪：发件箱发出一份。
        const vars = { file: name, length: text.length };
        ctx.emit('trace', 'Outbox.tick', 'trace.feishu.sendOutbox', 'feishu.sendText(lastPrivate(), text)', vars);
      }
    } catch (error) {
      const failedAt = new Date().toLocaleString('zh-CN', { hour12: false });
      console.error(`${failedAt} 飞书发件箱：发送失败，下一轮再试：${textModule.getErrorMessage(error)}`);
    } finally {
      busy = false;
    }
  };

  ctx.on('ready', () => {
    timer = setInterval(() => {
      //M 周期性触发发件箱扫描投递，防重入由内部 busy 标志位兜底。
      void tick();
    }, OUTBOX_INTERVAL_MS);
  });

  //M 插件被拔掉时停定时器。
  ctx.effect(() => {
    return () => {
      if (timer !== undefined) clearInterval(timer);
    };
  });
}
