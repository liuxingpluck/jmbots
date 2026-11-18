/** 将守卫告警写入既有飞书发件箱；不依赖飞书服务、不直接发送，按同类滑动十分钟去重。 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

/** 相同事件两次入队至少间隔十分钟。 */
const NOTICE_MS = 600_000;

/** 发件箱只扫描完整.md，临时文件与去重记录不会被发送。 */
export class GuardNotices {
  /** 当前实例成功入队时刻，持久化失败时仍不在本实例重复发送。 */
  private readonly sent = new Map<string, number>();

  /** 保存数据根目录，不建目录或发送消息。 */
  constructor(private readonly root: string) {}

  /** 入队正文；key为同类事件标识，now为调用者的Unix毫秒，失败抛给守卫记录。 */
  send(key: string, text: string, now: number): boolean {
    const digest = crypto.createHash('sha256').update(key).digest('hex');
    const receipts = path.join(this.root, 'data', 'programs', 'guard-notices');
    const receipt = path.join(receipts, `${digest}.json`);
    //M 先查本实例缓存，避免每个采样周期都读去重文件。
    let last = this.sent.get(key);
    if (last === undefined) {
      try {
        //M 从本插件的小记录恢复去重，插件重载后也不立刻重复入队。
        const raw = fs.readFileSync(receipt, 'utf8');
        const value: unknown = JSON.parse(raw);
        if (typeof value === 'number' && Number.isFinite(value)) {
          last = value;
        }
      } catch {
        // 没有记录时按首次处理；发件箱不扫描此记录目录。
      }
    }
    if (last !== undefined && now - last < NOTICE_MS) return false;

    const outbox = path.join(this.root, 'integrations', 'feishu', 'outbox');
    const id = crypto.randomUUID();
    const basename = `${String(now)}_guard_${id}`;
    const pending = path.join(outbox, `${basename}.tmp`);
    const target = path.join(outbox, `${basename}.md`);
    const receiptTemp = path.join(receipts, `${digest}_${id}.tmp`);
    //M 同步写小正文后原子改后缀，既有扫描器不会读到半份消息。
    fs.mkdirSync(outbox, { recursive: true });
    fs.writeFileSync(pending, text, { flag: 'wx' });
    fs.renameSync(pending, target);
    this.sent.set(key, now);
    //M 记录成功入队时刻，后续实例沿用同一滑动窗口；送达与重试由飞书发件箱负责。
    fs.mkdirSync(receipts, { recursive: true });
    fs.writeFileSync(receiptTemp, JSON.stringify(now), { flag: 'wx' });
    fs.renameSync(receiptTemp, receipt);
    return true;
  }
}
