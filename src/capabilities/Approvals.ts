/**
 * 待确认（docs/10 5.7、6.9）：exec 审核放不了行时，记一条待确认、发审核卡片。命令先挂起，会话接着跑；用户决定了才执行，结果再告诉会话。
 * 决定的办法：卡片按钮、HTTP、打字回一句（parseApprovalText 认，BotLoop 接）。谁先决定算谁，别的地方的卡片跟着变（onDecided）。
 * 只在内存里，不进数据库：程序重启就没了，要再提一次。
 */


/** 一条还在等的待确认。 */
export interface PendingApproval {
  /** 号，从 1 数（进程内递增）。 */
  id: number;
  /** 哪个机器人的。 */
  bot: string;
  /** 哪个会话在等；空字符串是没有会话在等（更新版本的卡片）。 */
  sessionId: string;
  /** 卡片标题；不写就是“要执行一条命令”。 */
  title?: string;
  /** 要执行的命令；更新版本时是一句说明。 */
  command: string;
  /** 在哪个目录执行。 */
  workDir: string;
  /** 小循环写的：这条命令做什么、风险、建议；没走到小循环时只有命令本身的说明。 */
  review: { what: string; risk: string; advice: string };
  /** 记下的时间，毫秒。 */
  createdAt: number;
}


/** 用户的决定。 */
export interface ApprovalDecision {
  /** true 同意执行，false 拒绝。 */
  approve: boolean;
  /** 谁、从哪决定的，如“飞书卡片 ou_xxx”“HTTP”“会话被打断”。 */
  by: string;
  /** 决定的时间，毫秒。 */
  at: number;
  /** 在等这条待确认有结果的消息号：决定以后它们重新分派。 */
  held: number[];
}


/** 用户打字说的、关于待确认的话。 */
export type ApprovalText =
  | {
      /** 同意或拒绝。 */
      kind: 'decide';
      /** true 同意，false 拒绝。 */
      approve: boolean;
      /** 点名的那一条；没点名是 undefined。 */
      id?: number;
      /** 说的是全部。 */
      all?: boolean;
    }
  | {
      /** 把待确认的卡片再发一次。 */
      kind: 'resend';
    };


/** 算“同意”的说法：只收说得明确的；“好”“可以”“yes”这种可能在答别的，交给决策模型看上下文。 */
const APPROVE_WORDS = new Set(['同意', '同意执行', '同意執行', '放行', '批准', '执行', '執行', '确认执行', '確認執行', 'approve', 'approved', 'allow', 'approuver', 'autoriser']);

/** 算“拒绝”的说法：拒绝错了只是多问一句，可以宽一点。 */
const REJECT_WORDS = new Set(['拒绝', '拒絕', '不同意', '不行', '不要', '别执行', '別執行', '不要执行', '不要執行', '取消', 'reject', 'rejected', 'deny', 'no', 'refuser', 'non']);

/** 说的是待确认的卡片。 */
const CARD_WORDS = /待审核|待審核|待确认|待確認|审核卡|審核卡|审批|審批|确认卡|確認卡|approvals?|validations?/;

/** 要再看一次。 */
const RESEND_WORDS = /再发|再發|重发|重發|再来|再來|发一下|發一下|发一次|發一次|发我|發我|看看|有哪些|resend|again|show|renvoyer|renvoie/;

/** 比这长的话不当成在回答待确认。 */
export const MAX_REPLY_CHARS = 60;


/**
 * 认出用户打字说的是不是在回答待确认：同意（放行）、拒绝，可以带号（同意 3）或说全部；或者要把卡片再发一次。
 * @param text 用户的原话。
 * @returns 认出来的；不是就是 undefined。
 */
export function parseApprovalText(text: string): ApprovalText | undefined {
  /** 去掉结尾的标点、转小写。 */
  const plain = text.trim().toLowerCase().replace(/[\s。．.!！~～,，、;；]+$/u, '');
  //G 太长的、带附件的都不算。
  if (!plain || plain.length > MAX_REPLY_CHARS || plain.includes('@')) {
    return undefined;
  }
  if (CARD_WORDS.test(plain) && (RESEND_WORDS.test(plain) || plain.length <= 6 || plain === 'approvals')) {
    return { kind: 'resend' };
  }
  /** 号在后面（同意 3、同意#3）或前面（3 同意）。 */
  const tail = /^(.+?)[\s#＃]*(\d+)$/u.exec(plain);
  const head = /^[#＃]?(\d+)\s*(.+)$/u.exec(plain);
  /** 号。 */
  const idText = tail?.[2] ?? head?.[1];
  /** 去掉号以后的话。 */
  const words = tail?.[1] ?? head?.[2] ?? plain;
  /** 再去掉“全部”。 */
  const core = words.replace(/^(全部|全都|都|所有)/u, '').replace(/^all\s+|\s+all$/u, '').trim();
  if (!APPROVE_WORDS.has(core) && !REJECT_WORDS.has(core)) {
    return undefined;
  }
  return { kind: 'decide', approve: APPROVE_WORDS.has(core), ...(idText ? { id: Number(idText) } : {}), ...(core !== words ? { all: true } : {}) };
}


/**
 * 这条待确认有没有卡着会话。更新版本的卡片可能放很久：不算机器人在等人，也不算进没点名的打字回答，不然用户随口一句“不行”就被吞了。
 * @param item 待确认。
 * @returns 有会话在等。
 */
export function holdsSession(item: PendingApproval): boolean {
  return item.sessionId !== '';
}


/** 决定了要叫的函数：输入那条待确认和用户的决定。 */
type DecidedListener = (pending: PendingApproval, decision: ApprovalDecision) => void;


/** 一条待确认和兑现它用的函数、在等它的消息号。 */
interface PendingEntry {
  /** 待确认本身。 */
  approval: PendingApproval;
  /** 兑现等结果的 Promise。 */
  resolve: (decision: ApprovalDecision) => void;
  /** 在等这条待确认有结果的消息号。 */
  held: number[];
}


/**
 * 待确认的登记表：只在内存里，没有依赖。入口 src/entries/App.ts 建一个。
 * 副作用：无（只在内存里）。
 */
export class Approvals {
  /** 下一个号。 */
  private nextId = 1;

  /** 号 → 待确认和兑现用的函数。 */
  private readonly pending = new Map<number, PendingEntry>();

  /** 决定了要叫的。 */
  private readonly listeners: DecidedListener[] = [];

  /** 记一条待确认：输入要等的东西，输出号和一个等结果的 Promise（用户决定或 cancel 时兑现）；只改内存。 */
  ask(
    request: Omit<PendingApproval, 'id' | 'createdAt'>,
  ): { id: number; wait: Promise<ApprovalDecision> } {
    /** 号。 */
    const id = this.nextId;
    this.nextId += 1;
    /** 兑现函数（Promise 构造时同步拿到）。 */
    let resolve: (decision: ApprovalDecision) => void = () => undefined;
    /** 等结果的 Promise。 */
    const wait = new Promise<ApprovalDecision>((done) => {
      resolve = done;
    });
    /** 登记的这一条。 */
    const entry: PendingEntry = {
      approval: { ...request, id, createdAt: Date.now() },
      resolve,
      held: [],
    };
    this.pending.set(id, entry);
    return { id, wait };
  }

  /** 用户点了按钮、或 HTTP 来确认：输入号和决定，输出那条待确认；不存在或已经决定过时返回 undefined。只改内存。 */
  decide(id: number, approve: boolean, by: string): PendingApproval | undefined {
    return this.settle(id, approve, by);
  }

  /** 这几条消息要等这条待确认有结果才能做。输入号和消息号；这条已经决定过时返回 false。只改内存。 */
  hold(id: number, messageIds: number[]): boolean {
    /** 那一条。 */
    const item = this.pending.get(id);
    item?.held.push(...messageIds);
    return item !== undefined;
  }

  /** 有一条被决定了就叫它（渠道用来更新自己发出去的卡片）。只改内存。 */
  onDecided(listener: DecidedListener): void {
    this.listeners.push(listener);
  }

  /** 还在等的，按号排。 */
  list(): PendingApproval[] {
    /** 复制一份，免得调用方改了登记表里的。 */
    const copies = [...this.pending.values()].map((item) => ({ ...item.approval }));
    return copies.sort((left, right) => left.id - right.id);
  }

  /**
   * 兑现并删掉一条。
   * @param id 号。
   * @param approve 同意吗。
   * @param by 谁决定的。
   * @returns 那条待确认；不存在时 undefined。
   */
  private settle(id: number, approve: boolean, by: string): PendingApproval | undefined {
    /** 那一条。 */
    const item = this.pending.get(id);
    if (!item) {
      return undefined;
    }
    this.pending.delete(id);
    /** 决定。 */
    const decision: ApprovalDecision = { approve, by, at: Date.now(), held: item.held };
    item.resolve(decision);
    for (const listener of this.listeners) {
      //G 更新卡片失败不能挡住决定。
      try {
        listener(item.approval, decision);
      } catch (error) {
        console.error(`待确认 #${id} 决定后通知出错：${String(error)}`);
      }
    }
    return item.approval;
  }
}
