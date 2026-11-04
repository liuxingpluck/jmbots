/**
 * 执行器登记表的离线测试：登记两个假执行器、按 canHandle 选对、先登记的优先、
 * 没有执行器认时报错（带事件类型和事件号）、listExecutors() 返回副本、clearExecutors() 之后报错。
 * 假事件、假执行器都是字面量对象，不联网、不碰数据库文件。
 */
import * as bunTest from 'bun:test';
import * as executorModule from '../src/executors/Executor.ts';
import type * as eventsModule from '../src/events/Events.ts';


/**
 * 造一个最小的假事件。
 * 为什么用 as unknown as 硬转：EventRow 是数据库表整行的类型，真行还有 sessionId、status、claimedBy 等栏目；
 * 这里只测“按类型找执行器”，不需要真数据行，所以用字面量补最小几栏再断言过去。不连数据库、不读文件。
 * @param id 事件号。
 * @param type 事件类型。
 * @returns 假事件。
 */
function fakeEvent(id: number, type: executorModule.EventKind): eventsModule.EventRow {
  return { id, type, payload: {} } as unknown as eventsModule.EventRow;
}


/**
 * 造一个最小的假执行器。
 * @param name 执行器名。
 * @param handles 认哪些事件类型。
 * @returns 假执行器；run 只返回一个空结果，不做事、不联网、不碰数据库。
 */
function fakeExecutor(name: string, handles: executorModule.EventKind[]): executorModule.Executor {
  /** 空的一步结果：登记表只调 name() 和 canHandle()，不会调 run。 */
  const emptyResult: executorModule.StepResult = { status: 'completed', next: [], timeline: [] };
  return {
    name: () => name,
    canHandle: (event) => handles.some((kind) => kind === event.type),
    run: () => Promise.resolve(emptyResult),
  };
}


//M 每个用例先清空登记表，测试之间互不影响；clearExecutors 本来就是给测试用的。
bunTest.beforeEach(() => {
  executorModule.clearExecutors();
});


bunTest.test('findExecutor()：按 canHandle 选，接话的管 message、干活的管 execution', () => {
  /** 接话执行器：只认 message。 */
  const reception = fakeExecutor('接话执行器', ['message']);
  /** 干活执行器：只认 execution。 */
  const worker = fakeExecutor('干活执行器', ['execution']);
  executorModule.registerExecutor(reception);
  executorModule.registerExecutor(worker);
  bunTest.expect(executorModule.findExecutor(fakeEvent(101, 'message'))).toBe(reception);
  bunTest.expect(executorModule.findExecutor(fakeEvent(103, 'execution'))).toBe(worker);
});


bunTest.test('findExecutor()：两个都认时取先登记的那个，顺序确定不是随机', () => {
  /** 先登记的。 */
  const first = fakeExecutor('先登记的', ['review']);
  /** 后登记的：也认 review。 */
  const second = fakeExecutor('后登记的', ['review']);
  executorModule.registerExecutor(first);
  executorModule.registerExecutor(second);
  //M 两个都认 review，问两次都该是先登记的那个；顺序由登记顺序决定，不是碰运气。
  bunTest.expect(executorModule.findExecutor(fakeEvent(12, 'review'))).toBe(first);
  bunTest.expect(executorModule.findExecutor(fakeEvent(13, 'review'))).toBe(first);
});


bunTest.test('findExecutor()：谁也不认的事件报错，错误里带事件类型和事件号', () => {
  executorModule.registerExecutor(fakeExecutor('接话执行器', ['message']));
  executorModule.registerExecutor(fakeExecutor('干活执行器', ['execution']));
  //G 不许返回 undefined：错误里要一眼看出是事件 #12、类型 review。
  bunTest.expect(() => executorModule.findExecutor(fakeEvent(12, 'review'))).toThrow('没有执行器能处理事件 #12（类型 review）');
});


bunTest.test('listExecutors()：返回副本，外面改了不影响登记表', () => {
  /** 先登记的。 */
  const reception = fakeExecutor('接话执行器', ['message']);
  /** 后登记的。 */
  const worker = fakeExecutor('干活执行器', ['execution']);
  executorModule.registerExecutor(reception);
  executorModule.registerExecutor(worker);
  /** 取出来的列表。 */
  const list = executorModule.listExecutors();
  bunTest.expect(list).toHaveLength(2);
  bunTest.expect(list[0]).toBe(reception);
  bunTest.expect(list[1]).toBe(worker);
  //M 外面往列表里加、把列表清空，都不该动到登记表。
  list.push(fakeExecutor('外面加的', ['review']));
  list.length = 0;
  /** 再取一次登记表。 */
  const again = executorModule.listExecutors();
  bunTest.expect(again).toHaveLength(2);
  bunTest.expect(again[0]).toBe(reception);
  bunTest.expect(again[1]).toBe(worker);
});


bunTest.test('clearExecutors()：清空之后 findExecutor 报错', () => {
  executorModule.registerExecutor(fakeExecutor('接话执行器', ['message']));
  executorModule.clearExecutors();
  bunTest.expect(executorModule.listExecutors()).toHaveLength(0);
  //G 空表时要有清楚的报错，而不是返回 undefined 或者悄悄什么都不做。
  bunTest.expect(() => executorModule.findExecutor(fakeEvent(101, 'message'))).toThrow('没有执行器能处理事件 #101（类型 message）');
});


bunTest.test('registerExecutor()：同一个名字登记两次报错', () => {
  executorModule.registerExecutor(fakeExecutor('接话执行器', ['message']));
  bunTest.expect(() => executorModule.registerExecutor(fakeExecutor('接话执行器', ['execution']))).toThrow('执行器 接话执行器 已经登记过了');
});
