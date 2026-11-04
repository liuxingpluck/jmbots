/**
 * 一次 run 一步的纯函数离线测试（src/executors/Steps.ts）：
 * 步号、步数上限、上限回复，以及五种判断结论翻译成 StepResult 的规则。
 * 全部用字面量入参，不联网、不碰数据库、不读配置文件。
 */
import * as bunTest from 'bun:test';
import * as steps from '../src/executors/Steps.ts';
import type * as executorModule from '../src/executors/Executor.ts';


/**
 * 判断结论的默认入参：接着做、一步没走、上限 100、模型这一步回了句话。
 * @param overrides 要换掉的字段。
 * @returns 造好的入参。
 */
function judgment(overrides: Partial<steps.NextFromJudgmentInput> = {}): steps.NextFromJudgmentInput {
  return {
    action: 'continue',
    replyText: '模型这一步的回复',
    sessionId: '20261104050000000001',
    doneSteps: 0,
    maxSteps: 100,
    ...overrides,
  };
}


/**
 * 断言一段回复里没有概率数字（如 0.54）。
 * 11-03 的事故就是飞书用户收到了判断者那串概率，这条断言专门盯死它。
 * @param reply 要检查的回复。
 */
function expectNoProbability(reply: string): void {
  bunTest.expect(reply).not.toMatch(/\d\.\d\d/);
}


/**
 * 取结果里第一条新事件的 payload，并断言它是一条 execution 事件。
 * @param result 一步的结果。
 * @returns payload。
 * @throws 没有新事件时抛错（用例里先断言过数量，这里只是把类型收窄）。
 */
function firstPayload(result: executorModule.StepResult): steps.ExecutionPayload {
  /** 第一条新事件。 */
  const event = result.next[0];
  //G 没有新事件说明用例的前提不成立，早点报出来。
  if (event === undefined) {
    throw new Error('这一步没有产生新事件');
  }
  bunTest.expect(event.type).toBe('execution');
  return event.payload as steps.ExecutionPayload;
}


/**
 * 断言流水里有干活执行器写的一行，说的是这句结论。
 * @param result 一步的结果。
 * @param keyword 结论里该出现的词。
 */
function expectTimeline(result: executorModule.StepResult, keyword: string): void {
  //G 每种情况都要有流水，不能空着。
  bunTest.expect(result.timeline.length).toBeGreaterThan(0);
  bunTest.expect(result.timeline[0]?.who).toBe('干活执行器.run()');
  bunTest.expect(result.timeline[0]?.what).toContain(keyword);
}


bunTest.test('nextStepNumber()：一步没走是第 1 步，走了几步就往后加几步', () => {
  bunTest.expect(steps.nextStepNumber(0)).toBe(1);
  bunTest.expect(steps.nextStepNumber(5)).toBe(6);
  bunTest.expect(steps.nextStepNumber(99)).toBe(100);
});


bunTest.test('overBudget()：没到上限是 false，刚好到和超过都是 true', () => {
  bunTest.expect(steps.overBudget(99, 100)).toBe(false);
  bunTest.expect(steps.overBudget(100, 100)).toBe(true);
  bunTest.expect(steps.overBudget(101, 100)).toBe(true);
  //G 上限是 0 时一步都不许走，也算走够。
  bunTest.expect(steps.overBudget(0, 0)).toBe(true);
});


bunTest.test('budgetReply()：原文照 Engine 里的那句，带上 maxSteps', () => {
  bunTest.expect(steps.budgetReply(100)).toBe('走了 100 步还没做完，先停下（config.yaml 的 engine.max_steps）。回一句“继续”就接着做。');
  bunTest.expect(steps.budgetReply(7)).toContain('走了 7 步');
  expectNoProbability(steps.budgetReply(100));
});


bunTest.test('continue：写下一条新的 execution 事件，payload 带上步号和留给下一步的话', () => {
  /** 一步的结果。 */
  const result = steps.nextFromJudgment(judgment({ action: 'continue', doneSteps: 2, note: '（还没做完，请接着做。）' }));
  bunTest.expect(result.status).toBe('completed');
  //M 接着做没有话要现在回给用户：话在 note 里留给下一步。
  bunTest.expect(result.reply).toBeUndefined();
  bunTest.expect(result.next).toHaveLength(1);
  /** 新事件的 payload。 */
  const payload = firstPayload(result);
  bunTest.expect(payload.sessionId).toBe('20261104050000000001');
  bunTest.expect(payload.step).toBe(3);
  bunTest.expect(payload.note).toBe('（还没做完，请接着做。）');
  bunTest.expect(payload.target).toBeUndefined();
  expectTimeline(result, '接着做');
  expectNoProbability(result.reply ?? '');
});


bunTest.test('continue 且已经走够 maxSteps：不写新事件，回复是 budgetReply', () => {
  /** 一步的结果。 */
  const result = steps.nextFromJudgment(judgment({ action: 'continue', doneSteps: 100, maxSteps: 100, note: '（还要接着做）' }));
  bunTest.expect(result.status).toBe('completed');
  //G 走满了就不再写新的 execution 事件，否则步数会一直涨。
  bunTest.expect(result.next).toHaveLength(0);
  bunTest.expect(result.reply).toBe(steps.budgetReply(100));
  expectTimeline(result, '走满');
  expectNoProbability(result.reply ?? '');
});


bunTest.test('route：写下一条换了执行者的 execution 事件，payload 带 target', () => {
  /** 一步的结果。 */
  const result = steps.nextFromJudgment(judgment({ action: 'route', target: '周小灵', doneSteps: 1, note: '（转交给周小灵接着做）' }));
  bunTest.expect(result.status).toBe('completed');
  bunTest.expect(result.reply).toBeUndefined();
  bunTest.expect(result.next).toHaveLength(1);
  /** 新事件的 payload。 */
  const payload = firstPayload(result);
  bunTest.expect(payload.target).toBe('周小灵');
  bunTest.expect(payload.step).toBe(2);
  bunTest.expect(payload.note).toBe('（转交给周小灵接着做）');
  expectTimeline(result, '转交给 周小灵');
  expectNoProbability(result.reply ?? '');
});


bunTest.test('route 没有 target：报错，不写一条没人认的事件', () => {
  //G 不知道该转交给谁时不能猜一个，也不能写一条空的 execution 事件。
  bunTest.expect(() => steps.nextFromJudgment(judgment({ action: 'route' }))).toThrow('route 没有 target：不知道要转交给谁');
});


bunTest.test('done：不写新事件，判断者给了话就用它回用户', () => {
  /** 一步的结果。 */
  const result = steps.nextFromJudgment(judgment({ action: 'done', message: '都做完了，文档也发好了。' }));
  bunTest.expect(result.status).toBe('completed');
  bunTest.expect(result.next).toHaveLength(0);
  bunTest.expect(result.reply).toBe('都做完了，文档也发好了。');
  expectTimeline(result, '做完');
  expectNoProbability(result.reply ?? '');
});


bunTest.test('done：判断者没给话就用模型这一步的回复', () => {
  /** 一步的结果。 */
  const result = steps.nextFromJudgment(judgment({ action: 'done', replyText: '模型说做完了。' }));
  bunTest.expect(result.reply).toBe('模型说做完了。');
  expectNoProbability(result.reply ?? '');
});


bunTest.test('ask_user：不写新事件，判断者的问题优先，否则用模型回复', () => {
  /** 判断者给了问题。 */
  const asked = steps.nextFromJudgment(judgment({ action: 'ask_user', message: '你要发到哪个群？' }));
  bunTest.expect(asked.next).toHaveLength(0);
  bunTest.expect(asked.reply).toBe('你要发到哪个群？');
  expectTimeline(asked, '先问用户');
  expectNoProbability(asked.reply ?? '');
  /** 判断者没给问题，用模型回复。 */
  const fallback = steps.nextFromJudgment(judgment({ action: 'ask_user', replyText: '要发到哪个群？' }));
  bunTest.expect(fallback.reply).toBe('要发到哪个群？');
  expectNoProbability(fallback.reply ?? '');
});


bunTest.test('block：不写新事件，判断者给了话就用它回用户', () => {
  /** 一步的结果。 */
  const result = steps.nextFromJudgment(judgment({ action: 'block', message: '这件事我先停在这里。' }));
  bunTest.expect(result.status).toBe('completed');
  bunTest.expect(result.next).toHaveLength(0);
  bunTest.expect(result.reply).toBe('这件事我先停在这里。');
  expectTimeline(result, '叫停');
  expectNoProbability(result.reply ?? '');
});


bunTest.test('block 且判断者和模型都没给话：回复兜底那句，不带判断理由', () => {
  /** 一步的结果。 */
  const result = steps.nextFromJudgment(judgment({ action: 'block', message: '', replyText: '' }));
  bunTest.expect(result.next).toHaveLength(0);
  bunTest.expect(result.reply).toBe('（这件事我先停在这里）');
  expectNoProbability(result.reply ?? '');
});


bunTest.test('block：调用方硬塞判断理由（概率串）也进不了回复', () => {
  /** 故意多塞一个 reason：入参类型里没有这个字段，用 as unknown as 硬转进来，模拟调用方传错。 */
  const withReason = {
    ...judgment({ action: 'block', message: '', replyText: '' }),
    reason: 'block 0.54，done 0.30，continue 0.11，ask_user 0.05',
  } as unknown as steps.NextFromJudgmentInput;
  /** 一步的结果。 */
  const result = steps.nextFromJudgment(withReason);
  bunTest.expect(result.reply).toBe('（这件事我先停在这里）');
  expectNoProbability(result.reply ?? '');
  bunTest.expect(result.reply ?? '').not.toContain('block 0.54');
});


bunTest.test('五种结论：每种都写一条流水，who 都是 干活执行器.run()', () => {
  /** 五种结论各造一份入参。 */
  const cases: steps.NextFromJudgmentInput[] = [
    judgment({ action: 'continue' }),
    judgment({ action: 'route', target: '周小灵' }),
    judgment({ action: 'done' }),
    judgment({ action: 'ask_user' }),
    judgment({ action: 'block' }),
  ];
  for (const input of cases) {
    /** 一步的结果。 */
    const result = steps.nextFromJudgment(input);
    bunTest.expect(result.timeline.length).toBeGreaterThan(0);
    bunTest.expect(result.timeline[0]?.who).toBe('干活执行器.run()');
    bunTest.expect((result.timeline[0]?.what ?? '').length).toBeGreaterThan(0);
  }
});
