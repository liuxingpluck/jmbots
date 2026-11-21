/** approval 配置入口：thinking、decision_pass 交给 Checks.ts 校验，写错挂载时就报。 */
import * as bunTest from 'bun:test';
import type * as cordis from 'cordis';
import * as approvalModule from './index.ts';


/** 只给配置入口用的假上下文：model 不写时 apply 在校验阶段只读到 providers。 */
const fakeCtx = { resources: { config: { providers: {} } } } as unknown as cordis.Context;


bunTest.test('thinking 要是思考档、decision_pass 要在 0.8～1，写错在入口就报', () => {
  //M 思考档写错：不再等到问审核模型时才出错。
  bunTest.expect(() => approvalModule.apply(fakeCtx, { thinking: 'ultra' })).toThrow('approval.thinking');
  bunTest.expect(() => approvalModule.apply(fakeCtx, { thinking: 3 })).toThrow('approval.thinking');

  //M 放行门槛低于 0.8、高于 1、不是数，都拒绝；报错说法由 checkNumber 统一拼。
  const low = () => approvalModule.apply(fakeCtx, { decision_pass: 0.5 });
  bunTest.expect(low).toThrow('approval.decision_pass 要写成不小于 0.8 且不大于 1 的数');
  bunTest.expect(() => approvalModule.apply(fakeCtx, { decision_pass: 1.5 })).toThrow('approval.decision_pass');
  bunTest.expect(() => approvalModule.apply(fakeCtx, { decision_pass: '0.9' })).toThrow('approval.decision_pass');
});
