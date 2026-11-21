/**
 * 可信目录与授权目录（用户 11-18 #169），以及 approval/request 事件的各个 action。
 * 跑法：bun test ./src7/plugins/approval/Trusted.test.ts
 * 真的 Cordis + 真的 approval 插件；resources、bots、sessions 是只够它挂上的假服务，审核小会话的回答由假 sessions.ask 给。
 * 不挂 decision：decision/judge 没人答，当场退回拿不准。命令只审不跑。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as cordis from 'cordis';
import * as checks from '../../utils/Checks.ts';
import * as requestEvents from '../../utils/RequestEvent.ts';
import * as approvalModule from './index.ts';


/** 临时目录：数据目录、配置的可信目录、消息授权的目录、外面的目录。 */
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-trusted-'));
const DATA = path.join(base, 'jmbotsData');
const TRUSTED = path.join(base, 'outwork');
const GRANTED = path.join(base, 'granted');
const OUTSIDE = path.join(base, 'elsewhere');
for (const dir of [DATA, path.join(TRUSTED, 'sub'), GRANTED, OUTSIDE]) {
  fs.mkdirSync(dir, { recursive: true });
}

/** 审核小会话回什么（假 sessions.ask 交回），和问了几次。 */
const model = { reply: '{"safe": false, "risk": "看不出来"}', asked: 0 };

/** 授权目录：照入口 checkGrants 规范化过的，和渠道写进回话地址的一样。 */
const granted = checks.checkGrants({ dirs: [GRANTED] });

/** 假会话记录：id → 回话地址。 */
const ADDRESSES: Record<string, unknown> = {
  's-grant': { owner: true, grants: granted },
  's-plain': { owner: true },
  's-guest': { owner: false, role: 'guest', grants: granted },
};


/** 假的 resources：approval 建表、算数据目录用到的几项。 */
class FakeResources extends cordis.Service {
  db = new Database(':memory:');
  root = DATA;
  raw = {};
  config = { providers: {} };
  constructor(ctx: cordis.Context) {
    super(ctx, 'resources');
  }
}

/** 假的 bots：一个机器人。 */
class FakeBots extends cordis.Service {
  constructor(ctx: cordis.Context) {
    super(ctx, 'bots');
  }
  list(): { name: string }[] {
    return [{ name: '周小灵' }];
  }
}

/** 假的 sessions：find 照 ADDRESSES 给地址；open 给一场空会话；ask 照 model.reply 回。 */
class FakeSessions extends cordis.Service {
  constructor(ctx: cordis.Context) {
    super(ctx, 'sessions');
  }
  find(filter: { id?: string }): { id: string; address: unknown }[] {
    if (filter.id === undefined || !(filter.id in ADDRESSES)) return [];

    return [{ id: filter.id, address: ADDRESSES[filter.id] }];
  }
  open(id: string): { id: string; row: { messages: unknown[] } } {
    return { id, row: { messages: [] } };
  }
  ask(): Promise<{ ok: boolean; reply: string }> {
    model.asked += 1;
    return Promise.resolve({ ok: true, reply: model.reply });
  }
}


/** approval/result 回执。 */
type ApprovalReply = requestEvents.EventArg<'approval/result'>;

/** 发给审核的一条命令。 */
type ReviewInput = Extract<requestEvents.EventArg<'approval/request'>, { action: 'review' }>['input'];

/**
 * 没人答时的退回：测试里不该走到，走到了就带个原因让断言看得出。
 * @param reason requestEvent 给的退回原因。
 */
function getMissing(reason: requestEvents.FallbackReason): ApprovalReply {
  return { requestId: '', error: `没人答：${reason}` };
}

/** 等待设置。 */
const options = { prefix: 'apr', timeoutMs: 5000, onFallback: getMissing };


let app: cordis.Context;

beforeAll(async () => {
  app = new cordis.Context();
  await app.plugin(FakeResources);
  await app.plugin(FakeBots);
  await app.plugin(FakeSessions);
  await app.plugin(approvalModule, { trusted_dirs: [TRUSTED, DATA] });
});

afterAll(async () => {
  await app.fiber.dispose();
  fs.rmSync(base, { recursive: true, force: true });
});


/**
 * 经 approval/request 审一条命令。
 * @param input 命令、目录，可加会话、问不问用户。
 * @returns 审的结论。
 */
async function review(input: Pick<ReviewInput, 'command' | 'cwd'> & Partial<ReviewInput>): Promise<ApprovalReply['verdict']> {
  const full: ReviewInput = { kind: 'exec', payload: null, ...input };
  const request = { action: 'review', input: full } as const;
  const result = await requestEvents.requestEvent(app, 'approval/request', 'approval/result', request, options);
  return result.verdict;
}


describe('可信目录（trusted_dirs）', () => {
  test('可信目录里的写命令：程序规则直接放行，不问模型', async () => {
    model.asked = 0;
    //M 写明 Verdict 类型：不写的话 result、by 被推成 string，toEqual 对不上审核结论的类型。
    const passed: approvalModule.Verdict = { result: 'pass', by: 'rule', reason: '可信目录' };
    const inside = path.join(TRUSTED, 'b.txt');

    const relative = await review({ command: 'echo hi > out.txt', cwd: path.join(TRUSTED, 'sub') });
    expect(relative).toEqual(passed);

    const absolute = await review({ command: `echo hi > "${inside}"`, cwd: TRUSTED });
    expect(absolute).toEqual(passed);
    expect(model.asked).toBe(0);
  });

  test('.. 跳出去、写到外面的绝对路径、执行目录本身在外面：不放行，照原来的流程审', async () => {
    model.reply = '{"safe": false, "risk": "出了目录"}';
    const commands = [
      { command: `echo hi > ${path.join('..', 'escape.txt')}`, cwd: TRUSTED },
      { command: `echo hi > ${path.join(OUTSIDE, 'x.txt')}`, cwd: TRUSTED },
      { command: 'echo hi > out.txt', cwd: `${TRUSTED}${path.sep}..${path.sep}elsewhere` },
      { command: 'echo hi > out.txt', cwd: OUTSIDE },
    ];
    for (const item of commands) {
      const verdict = await review({ ...item, ask: false });
      expect(verdict?.result).toBe('reject');
      expect(verdict?.reason).toContain('出了目录');
    }
  });

  test('可信目录里删数据目录：照旧人审（去问用户），不按可信目录放行', async () => {
    model.reply = '{"safe": true, "what": "删掉 data"}';
    const verdict = await review({ command: `rm -rf ${path.join(DATA, 'data')}`, cwd: DATA });
    expect(verdict?.result).toBe('asked');
  });
});


describe('授权目录（回话地址的 grants）', () => {
  test('带 grants 的本人会话：授权目录里的命令放行', async () => {
    const verdict = await review({ command: 'echo hi > out.txt', cwd: GRANTED, session: 's-grant' });
    expect(verdict).toEqual({ result: 'pass', by: 'rule', reason: '可信目录' });
  });

  test('不带 grants 的会话、外人的地址带了 grants：走原来的流程', async () => {
    model.reply = '{"safe": false, "risk": "不在可信目录"}';
    for (const session of ['s-plain', 's-guest']) {
      const verdict = await review({ command: 'echo hi > out.txt', cwd: GRANTED, session, ask: false });
      expect(verdict?.result).toBe('reject');
    }
  });
});


/**
 * 经 approval/request 审一条要问用户的命令，取它登记的待确认卡片（用户 #172：卡片要说清楚）。
 * @param command 命令；执行目录在可信目录里，命令写到外面去。
 * @returns 卡片正文的三行和风险说明。
 */
async function askCard(command: string): Promise<{ lines: string[]; risk: string }> {
  const verdict = await review({ command, cwd: TRUSTED });
  if (verdict?.result !== 'asked') throw new Error(`应该去问用户，实际是 ${JSON.stringify(verdict)}`);

  //M 照号找到刚登记的那件，拆开卡片正文。
  const pending = app.approval.list().find((item) => item.id === verdict.id);
  if (pending === undefined) throw new Error('没找到刚登记的待确认');

  const lines = pending.card.reason.split('\n');
  const risk = pending.card.risk?.text ?? '';
  return { lines, risk };
}


describe('审批卡片三行说清（用户 #172）', () => {
  test('三行都有内容：要做什么、动哪些（命令里的路径）、为什么问你（不在可信目录 + 审核原话）', async () => {
    model.reply = '{"safe": false, "what": "把 a.txt 复制到外面，同名覆盖", "risk": "会覆盖外面的 x.txt", "risk_level": "medium"}';
    const target = path.join(OUTSIDE, 'x.txt');
    const card = await askCard(`copy a.txt "${target}"`);

    expect(card.lines).toHaveLength(3);
    expect(card.lines[0]).toBe('要做什么：把 a.txt 复制到外面，同名覆盖');
    expect(card.lines[1]).toContain('动哪些：');
    expect(card.lines[1]).toContain(target);
    expect(card.lines[2]).toContain('为什么问你：');
    expect(card.lines[2]).toContain('不在可信目录里');
    expect(card.lines[2]).toContain('会覆盖外面的 x.txt');
    expect(card.risk).toBe('会覆盖外面的 x.txt');
    for (const line of card.lines) {
      expect(line.split('：')[1]?.trim()).not.toBe('');
    }
  });

  test('审核小会话没写理由：写“审核没给出理由”，不留空', async () => {
    model.reply = '{"safe": false}';
    const card = await askCard(`copy a.txt "${path.join(OUTSIDE, 'y.txt')}"`);

    expect(card.lines).toHaveLength(3);
    expect(card.lines[0]).toContain('要做什么：说不清会做成什么（命令：copy a.txt');
    expect(card.lines[2]).toContain('审核小会话：审核没给出理由');
    expect(card.risk).toBe('审核没给出理由');
  });
});


describe('入口校验', () => {
  test('trusted_dirs、grants 写错就拒绝；对的规范化', () => {
    expect(() => checks.checkDirs('x', 'approval.trusted_dirs')).toThrow('绝对路径的数组');
    expect(() => checks.checkDirs(['relative/dir'], 'approval.trusted_dirs')).toThrow('绝对路径');
    expect(() => checks.checkGrants([GRANTED])).toThrow('grants');
    expect(checks.checkDirs(undefined, 'approval.trusted_dirs')).toEqual([]);
    expect(checks.checkGrants(undefined)).toBeUndefined();
    const messy = `${GRANTED}${path.sep}..${path.sep}granted${path.sep}`;
    expect(checks.checkDirs([messy], 'grants.dirs')).toEqual(granted?.dirs ?? []);
  });
});


describe('approval/request 各个 action', () => {
  test('ask 登记、list 列出、decide 定了、再 decide 回原因、close 找不到回原因', async () => {
    const input = { kind: 'update', title: '有新版本 9', detail: '', payload: { version: '9' }, bot: '周小灵' };
    const asked = await requestEvents.requestEvent(app, 'approval/request', 'approval/result', { action: 'ask', input } as const, options);
    const id = asked.pending?.id ?? 0;
    expect(id).toBeGreaterThan(0);

    const listed = await requestEvents.requestEvent(app, 'approval/request', 'approval/result', { action: 'list', kind: 'update' } as const, options);
    expect(listed.items?.map((item) => item.id)).toContain(id);

    const decide = { action: 'decide', id, approve: false, by: '测试' } as const;
    const decided = await requestEvents.requestEvent(app, 'approval/request', 'approval/result', decide, options);
    expect(decided.settled?.state).toBe('rejected');

    const again = await requestEvents.requestEvent(app, 'approval/request', 'approval/result', decide, options);
    expect(again.error).toContain('已经定过了');

    const close = { action: 'close', id: 99_999, note: '会话已结束' } as const;
    const closed = await requestEvents.requestEvent(app, 'approval/request', 'approval/result', close, options);
    expect(closed.error).toContain('没有待确认');
  });

  test('作废的卡片再点同意：看卡片状态交回作废原因，不当成普通的“已经定过了”', async () => {
    const input = { kind: 'update', title: '有新版本 10', detail: '', payload: { version: '10' }, bot: '周小灵' };
    const asked = await requestEvents.requestEvent(app, 'approval/request', 'approval/result', { action: 'ask', input } as const, options);
    const id = asked.pending?.id ?? 0;
    const close = { action: 'close', id, note: '会话已结束' } as const;
    const closed = await requestEvents.requestEvent(app, 'approval/request', 'approval/result', close, options);
    expect(closed.settled?.card.state).toBe('ended');

    const decide = { action: 'decide', id, approve: true, by: '测试' } as const;
    const again = await requestEvents.requestEvent(app, 'approval/request', 'approval/result', decide, options);
    expect(again.error).toBe(`待确认 #${String(id)} 会话已结束`);
  });
});
