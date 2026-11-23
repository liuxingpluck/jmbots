/**
 * 教程页 10 秒自测页内直答工具（QuizSubmit.ts）纯逻辑单测：
 * 验证动态机器人列表解析与拉取容错、偏好机器人选择、消息拼装、占位回复过滤、
 * 过关判定、轮询三态分支（reply / pending / fatal）及本地存储超时降级容错。
 */
import * as bunTest from 'bun:test';
import * as meta from './CompactMetaData.ts';
import * as quiz from './QuizSubmit.ts';


/** 构造用于单测的内存 Storage 替身。 */
function createMemoryStorage(): Pick<Storage, 'getItem' | 'setItem'> {
  const map = new Map<string, string>();
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => {
      map.set(key, value);
    },
  };
}


/** 构造用于单测的最小 fetch 替身。 */
function createMockFetch(handler: () => Promise<Response>): typeof fetch {
  return (() => handler()) as unknown as typeof fetch;
}


bunTest.describe('QuizSubmit 教程页内自测直答逻辑', () => {
  const firstChunk = meta.STAGES[0]?.chunks[0];

  bunTest.test('parseBotNames 与 resolveSelectedBot 动态解析机器人且零硬编码', () => {
    const names = quiz.parseBotNames([
      { name: '机器人甲', status: 'idle' },
      { name: '机器人乙', status: 'waiting' },
      { name: '机器人甲', status: 'idle' },
      { name: '' },
      null,
    ]);
    bunTest.expect(names).toEqual(['机器人甲', '机器人乙']);
    bunTest.expect(quiz.resolveSelectedBot(names, '机器人乙')).toBe('机器人乙');
    bunTest.expect(quiz.resolveSelectedBot(names, '不存在的机器人')).toBe('机器人甲');
    bunTest.expect(quiz.resolveSelectedBot([], '机器人甲')).toBe('');

    const storage = createMemoryStorage();
    quiz.savePreferredBot('机器人乙', storage);
    bunTest.expect(quiz.loadPreferredBot(storage)).toBe('机器人乙');
  });

  bunTest.test('fetchAvailableBots 显式区分成功、HTTP 失败与网络异常', async () => {
    const okFetch = createMockFetch(() =>
      Promise.resolve(
        new Response(JSON.stringify([{ name: '机器人甲' }, { name: '机器人乙' }]), { status: 200 }),
      ),
    );
    const okResult = await quiz.fetchAvailableBots(okFetch);
    bunTest.expect(okResult).toEqual({ bots: ['机器人甲', '机器人乙'], error: '' });

    const errFetch = createMockFetch(() =>
      Promise.resolve(new Response(JSON.stringify({ error: '缺少访问令牌' }), { status: 401 })),
    );
    const errResult = await quiz.fetchAvailableBots(errFetch);
    bunTest.expect(errResult.bots).toEqual([]);
    bunTest.expect(errResult.error).toContain('缺少访问令牌');

    const netFetch = createMockFetch(() => Promise.reject(new Error('offline')));
    const netResult = await quiz.fetchAvailableBots(netFetch);
    bunTest.expect(netResult.bots).toEqual([]);
    bunTest.expect(netResult.error).toContain('网络异常');
  });

  bunTest.test('buildQuizPrompt 正确拼装块号、原题、回答与可选飞书同步提示', () => {
    bunTest.expect(firstChunk).toBeDefined();
    if (firstChunk === undefined) return;

    const plain = quiz.buildQuizPrompt(firstChunk, '  serial 能改，emit 只通知  ', false);
    bunTest.expect(plain).toContain(`【教程自测·${firstChunk.title}】`);
    bunTest.expect(plain).toContain(`问题：${firstChunk.quiz}`);
    bunTest.expect(plain).toContain('我的回答：serial 能改，emit 只通知');
    bunTest.expect(plain).not.toContain('飞书');

    const withFeishu = quiz.buildQuizPrompt(firstChunk, 'serial 能改流程', true);
    bunTest.expect(withFeishu).toContain('以你的机器人身份顺手发我一条飞书私聊');
  });

  bunTest.test('extractFinalReply 过滤 relay 占位提示并返回最新真实批改回信', () => {
    const onlyAck = quiz.extractFinalReply([
      { text: '已转给 某助手（#652），等回复' },
    ]);
    bunTest.expect(onlyAck).toBeUndefined();

    const withReal = quiz.extractFinalReply([
      { text: '已转给 某助手（#652），等回复' },
      { text: '【过关】答得非常准确！下一步看 1.2 进与出。' },
    ]);
    bunTest.expect(withReal).toBe('【过关】答得非常准确！下一步看 1.2 进与出。');
  });

  bunTest.test('detectQuizPassed 准确区分过关与未过关评语', () => {
    bunTest.expect(quiz.detectQuizPassed('【过关】一针见血！')).toBe(true);
    bunTest.expect(quiz.detectQuizPassed('✅ 答对了，进入下一块')).toBe(true);
    bunTest.expect(quiz.detectQuizPassed('【未过关】再对比下 serial 和 emit')).toBe(false);
    bunTest.expect(quiz.detectQuizPassed('差一点点，提示你看一下 01_第一块')).toBe(false);
  });

  bunTest.test('classifyPollResponse 与 pollQuizReply 精确区分 reply / pending / fatal 三态', async () => {
    //M 200 仅含占位提示应保持 pending。
    const waiting = quiz.classifyPollResponse(200, {
      replies: [{ text: '已转给 某助手（#700），等回复。' }],
    });
    bunTest.expect(waiting).toEqual({ kind: 'pending' });

    //M 200 含真实回复应返回 reply。
    const replied = quiz.classifyPollResponse(200, {
      replies: [
        { text: '已转给 某助手（#700），等回复。' },
        { text: '某助手：【过关】回答清晰！' },
      ],
    });
    bunTest.expect(replied).toEqual({ kind: 'reply', text: '某助手：【过关】回答清晰！' });

    //G 401/403 鉴权失效立刻进入 fatal 停表且保留 messageId。
    const unauthorized = await quiz.pollQuizReply(
      701,
      createMockFetch(() => Promise.resolve(new Response('', { status: 401 }))),
    );
    bunTest.expect(unauthorized.kind).toBe('fatal');
    if (unauthorized.kind === 'fatal') {
      bunTest.expect(unauthorized.clearMessageId).toBe(false);
      bunTest.expect(unauthorized.reason).toContain('令牌');
    }

    //G 404/410 消息不存在立刻进入 fatal 停表并清空失效 messageId。
    const missing = await quiz.pollQuizReply(
      702,
      createMockFetch(() => Promise.resolve(new Response('', { status: 404 }))),
    );
    bunTest.expect(missing.kind).toBe('fatal');
    if (missing.kind === 'fatal') {
      bunTest.expect(missing.clearMessageId).toBe(true);
      bunTest.expect(missing.reason).toContain('不存在');
    }

    //G 503 与网络抖动返回 pending，由调用方轮询上限兜底。
    const badGateway = await quiz.pollQuizReply(
      703,
      createMockFetch(() => Promise.resolve(new Response('', { status: 503 }))),
    );
    bunTest.expect(badGateway).toEqual({ kind: 'pending' });

    const networkErr = await quiz.pollQuizReply(
      704,
      createMockFetch(() => Promise.reject(new Error('ECONNRESET'))),
    );
    bunTest.expect(networkErr).toEqual({ kind: 'pending' });
  });

  bunTest.test('loadQuizStore 支持读写往返、过期 pending 自动降级与损坏数据容错', () => {
    const storage = createMemoryStorage();
    const now = 1700001000000;
    const sample: quiz.QuizStore = {
      '1.1': {
        chunkId: '1.1',
        bot: '机器人乙',
        answer: 'serial 串行能改流程，emit 只通知',
        messageId: 701,
        status: 'replied',
        replyText: '【过关】准确！',
        passed: true,
        error: '',
        syncFeishu: true,
        updatedAt: now - 10000,
      },
      '1.2': {
        chunkId: '1.2',
        bot: '机器人甲',
        answer: '正在发送中的瞬态测试',
        messageId: null,
        status: 'sending',
        replyText: '',
        passed: false,
        error: '',
        syncFeishu: false,
        updatedAt: now - 5000,
      },
      '1.3': {
        chunkId: '1.3',
        bot: '机器人甲',
        answer: '仍在 5 分钟有效期内的 pending',
        messageId: 702,
        status: 'pending',
        replyText: '',
        passed: false,
        error: '',
        syncFeishu: false,
        updatedAt: now - 60000,
      },
      '1.4': {
        chunkId: '1.4',
        bot: '机器人甲',
        answer: '超过 5 分钟未回的陈旧 pending',
        messageId: 703,
        status: 'pending',
        replyText: '',
        passed: false,
        error: '',
        syncFeishu: false,
        updatedAt: now - quiz.MAX_POLL_MS - 1000,
      },
      '2.1': {
        chunkId: '2.1',
        bot: '机器人甲',
        answer: '缺失合法时间戳的 pending',
        messageId: 704,
        status: 'pending',
        replyText: '',
        passed: false,
        error: '',
        syncFeishu: false,
        updatedAt: 0,
      },
      '2.2': {
        chunkId: '2.2',
        bot: '机器人甲',
        answer: '缺失消息号的异常 pending',
        messageId: null,
        status: 'pending',
        replyText: '',
        passed: false,
        error: '',
        syncFeishu: false,
        updatedAt: now - 1000,
      },
    };
    quiz.saveQuizStore(sample, storage);

    const loaded = quiz.loadQuizStore(storage, now);
    bunTest.expect(loaded['1.1']?.passed).toBe(true);
    bunTest.expect(loaded['1.1']?.bot).toBe('机器人乙');
    bunTest.expect(loaded['1.1']?.messageId).toBe(701);
    //M 刷新前停留在 sending 的瞬态应恢复成 idle，避免永久禁用按钮。
    bunTest.expect(loaded['1.2']?.status).toBe('idle');
    bunTest.expect(loaded['1.2']?.syncFeishu).toBe(false);
    //M 有效期内且有消息号的 pending 可正常续轮询。
    bunTest.expect(loaded['1.3']?.status).toBe('pending');
    bunTest.expect(loaded['1.3']?.messageId).toBe(702);
    //G 超过 MAX_POLL_MS 或缺时间戳的 pending 必须降级为超时提示态，防刷新复活死循环。
    bunTest.expect(loaded['1.4']?.status).toBe('error');
    bunTest.expect(loaded['1.4']?.error).toBe(quiz.PENDING_TIMEOUT_ERROR);
    bunTest.expect(loaded['1.4']?.messageId).toBe(703);
    bunTest.expect(loaded['2.1']?.status).toBe('error');
    bunTest.expect(loaded['2.1']?.error).toBe(quiz.PENDING_TIMEOUT_ERROR);
    //G 缺消息号的 pending 直接回落 idle。
    bunTest.expect(loaded['2.2']?.status).toBe('idle');

    storage.setItem(quiz.QUIZ_STORAGE_KEY, '{broken-json');
    bunTest.expect(quiz.loadQuizStore(storage, now)).toEqual({});
  });
});
