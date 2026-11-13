/**
 * 待确认（src/capabilities/Approvals.ts）的离线测试：用户打字回答的识别（parseApprovalText）和内存里的待确认登记表。
 * 测 docs/10 5.7、6.9：同意/放行/拒绝、带号、全部、四种语言、不明确的说法、再发一次；hold 的号跟着决定走、onDecided、监听抛错不挡决定。
 */
import * as bunTest from 'bun:test';
import * as approvalsModule from '../src/capabilities/Approvals.ts';


/** 一条待确认的请求（ask 的输入）。 */
const REQUEST: Omit<approvalsModule.PendingApproval, 'id' | 'createdAt'> = {
  bot: '周小灵',
  sessionId: 'session-1',
  command: 'echo hi',
  workDir: 'C:\\work',
  review: { what: '打印一句话', risk: '无', advice: '同意' },
};


bunTest.describe('parseApprovalText：明确的回答', () => {
  bunTest.test('同意、放行、拒绝', () => {
    bunTest.expect(approvalsModule.parseApprovalText('同意')).toEqual({ kind: 'decide', approve: true });
    bunTest.expect(approvalsModule.parseApprovalText('放行')).toEqual({ kind: 'decide', approve: true });
    bunTest.expect(approvalsModule.parseApprovalText('拒绝')).toEqual({ kind: 'decide', approve: false });
  });

  bunTest.test('带号：同意 3、同意#3、3 同意', () => {
    bunTest.expect(approvalsModule.parseApprovalText('同意 3')).toEqual({ kind: 'decide', approve: true, id: 3 });
    bunTest.expect(approvalsModule.parseApprovalText('同意#3')).toEqual({ kind: 'decide', approve: true, id: 3 });
    bunTest.expect(approvalsModule.parseApprovalText('3 同意')).toEqual({ kind: 'decide', approve: true, id: 3 });
  });

  bunTest.test('全部：全部同意、approve all', () => {
    bunTest.expect(approvalsModule.parseApprovalText('全部同意')).toEqual({ kind: 'decide', approve: true, all: true });
    bunTest.expect(approvalsModule.parseApprovalText('approve all')).toEqual({ kind: 'decide', approve: true, all: true });
  });

  bunTest.test('四种语言：简体中文、繁体中文、英文、法文', () => {
    bunTest.expect(approvalsModule.parseApprovalText('同意')).toEqual({ kind: 'decide', approve: true });
    bunTest.expect(approvalsModule.parseApprovalText('同意執行')).toEqual({ kind: 'decide', approve: true });
    bunTest.expect(approvalsModule.parseApprovalText('approve')).toEqual({ kind: 'decide', approve: true });
    bunTest.expect(approvalsModule.parseApprovalText('approuver')).toEqual({ kind: 'decide', approve: true });
    bunTest.expect(approvalsModule.parseApprovalText('拒絕')).toEqual({ kind: 'decide', approve: false });
    bunTest.expect(approvalsModule.parseApprovalText('reject')).toEqual({ kind: 'decide', approve: false });
    bunTest.expect(approvalsModule.parseApprovalText('refuser')).toEqual({ kind: 'decide', approve: false });
  });
});


bunTest.describe('parseApprovalText：不明确的不算', () => {
  bunTest.test('好、yes、带 @ 的、很长的都不算', () => {
    bunTest.expect(approvalsModule.parseApprovalText('好')).toBeUndefined();
    bunTest.expect(approvalsModule.parseApprovalText('yes')).toBeUndefined();
    bunTest.expect(approvalsModule.parseApprovalText('@周小灵 同意')).toBeUndefined();
    /** 去掉句号以后仍然超过 60 个字。 */
    const long = `同意${'，没有问题。'.repeat(10)}`;
    bunTest.expect(long.length).toBeGreaterThan(approvalsModule.MAX_REPLY_CHARS);
    bunTest.expect(approvalsModule.parseApprovalText(long)).toBeUndefined();
  });

  bunTest.test('再发一次审核卡片、待审核是 resend', () => {
    bunTest.expect(approvalsModule.parseApprovalText('再发一次审核卡片')).toEqual({ kind: 'resend' });
    bunTest.expect(approvalsModule.parseApprovalText('待审核')).toEqual({ kind: 'resend' });
  });

  bunTest.test('审批流程是什么不是回答', () => {
    bunTest.expect(approvalsModule.parseApprovalText('审批流程是什么')).toBeUndefined();
  });
});


bunTest.describe('Approvals：内存里的登记表', () => {
  bunTest.test('ask 递增编号；hold 的号在 decision.held 里；决定过的再决定返回空', async () => {
    /** 登记表。 */
    const approvals = new approvalsModule.Approvals();
    /** 第一条。 */
    const first = approvals.ask(REQUEST);
    /** 第二条。 */
    const second = approvals.ask({ ...REQUEST, command: 'dir' });
    bunTest.expect(first.id).toBe(1);
    bunTest.expect(second.id).toBe(2);
    bunTest.expect(approvals.list().map((item) => item.id)).toEqual([1, 2]);
    bunTest.expect(approvals.list()[0]).toMatchObject({ ...REQUEST, id: 1 });
    bunTest.expect(typeof approvals.list()[0]!.createdAt).toBe('number');
    bunTest.expect(approvals.hold(first.id, [11, 12])).toBe(true);
    /** 决定后的那条。 */
    const decided = approvals.decide(first.id, true, 'HTTP');
    bunTest.expect(decided?.id).toBe(1);
    bunTest.expect(decided?.command).toBe('echo hi');
    /** 等结果兑现的决定。 */
    const decision = await first.wait;
    bunTest.expect(decision.approve).toBe(true);
    bunTest.expect(decision.by).toBe('HTTP');
    bunTest.expect(decision.held).toEqual([11, 12]);
    bunTest.expect(typeof decision.at).toBe('number');
    bunTest.expect(approvals.list().map((item) => item.id)).toEqual([2]);
    bunTest.expect(approvals.decide(first.id, false, '再点一次')).toBeUndefined();
    bunTest.expect(approvals.hold(first.id, [13])).toBe(false);
  });

  bunTest.test('决定后叫 onDecided；监听抛错不挡决定，也不挡后面的监听', async () => {
    /** 登记表。 */
    const approvals = new approvalsModule.Approvals();
    /** 监听收到的。 */
    const calls: { pending: approvalsModule.PendingApproval; decision: approvalsModule.ApprovalDecision }[] = [];
    /** console.error 收到的。 */
    const errors: unknown[][] = [];
    /** 原来的 console.error。 */
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      approvals.onDecided(() => {
        throw new Error('更新卡片失败');
      });
      approvals.onDecided((pending, decision) => {
        calls.push({ pending, decision });
      });
      /** 有待确认的那条。 */
      const asked = approvals.ask(REQUEST);
      /** 决定后的那条。 */
      const decided = approvals.decide(asked.id, false, '飞书卡片');
      bunTest.expect(decided?.id).toBe(asked.id);
      bunTest.expect(calls).toHaveLength(1);
      bunTest.expect(calls[0]!.pending.id).toBe(asked.id);
      bunTest.expect(calls[0]!.pending.command).toBe('echo hi');
      bunTest.expect(calls[0]!.decision.approve).toBe(false);
      bunTest.expect(calls[0]!.decision.by).toBe('飞书卡片');
      bunTest.expect(errors).toHaveLength(1);
      bunTest.expect(String(errors[0]![0])).toContain('待确认 #1 决定后通知出错');
      /** 等结果兑现的决定。 */
      const decision = await asked.wait;
      bunTest.expect(decision.approve).toBe(false);
    } finally {
      console.error = originalError;
    }
  });
});
