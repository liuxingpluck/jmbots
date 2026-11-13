/**
 * 回复生成与关联的网页离线检查：只相信保存证据，按明确号补取，不串回复/机器人/旧请求。
 * React 静态渲染检查同色标记范围；fetch 使用本地假响应，不启动浏览器或请求模型。
 */
import * as bunTest from 'bun:test';
import * as react from 'react';
import * as reactDomServer from 'react-dom/server';
import * as zustand from 'zustand';
import * as context from '../web/src/Context.ts';
import * as storeModule from '../web/src/Store.ts';
import * as replyLinkModule from '../web/src/Chat/ReplyLink.ts';
import * as timeline from '../web/src/Chat/Timeline.ts';
import type * as types from '../web/src/Types.ts';


/** Bun 加载 TSX；根测试工程不启用 JSX，网页工程独立核对组件类型。 */
const listPath = '../web/src/Chat/MessageList.tsx';
const listModule = await import(listPath) as Record<string, unknown>;


/** 一次明确生成快照，使用假模型名，不依赖任何当前配置。 */
function generationOf(model = 'example/actual-backup'): types.ReplyGeneration {
  return {
    kind: 'model',
    model,
    thinkingRequested: 'xhigh',
    thinkingSent: 'high',
    thinkingReported: null,
    source: 'snapshot',
    purpose: 'session',
    run: 1,
    step: 3,
    assistantAt: 2000,
    callId: 'reply-call',
  };
}


/** 明确关联输入集合；不会把同会话中的其他用户消息补进来。 */
function evidenceOf(ids: number[] = [1, 2]): Pick<types.ReplyView, 'generation' | 'association'> {
  return {
    generation: generationOf(),
    association: { messageIds: ids, scope: 'turn', source: 'generation-snapshot' },
  };
}


/** 一个内存收件，回复由具体测试补充。 */
function messageOf(id: number, source = 'web'): types.MessageView {
  return {
    id,
    bot: '小测',
    source,
    channel: source === 'web' ? 'http' : 'feishu:example',
    text: `用户消息 ${String(id)}`,
    status: 'taken',
    sessionId: 'same-session',
    file: `F:/example/${String(id)}.md`,
    createdAt: id * 1000,
    updatedAt: id * 1000,
    replies: [],
    attachments: [],
    dispatch: null,
  };
}


bunTest.describe('每句回复的生成与关联元信息', () => {
  bunTest.test('只显示这句成功调用的模型和请求/发送设置，实际执行未回报不冒充实测', () => {
    const presentation = new replyLinkModule.ReplyLink();
    const generation = generationOf();
    const label = presentation.generation(generation);
    bunTest.expect(label).toBe('actual-backup · 请求 xhigh · 发送 high');
    bunTest.expect(presentation.generationTitle(generation)).toContain('example/actual-backup');
    bunTest.expect(presentation.generationTitle(generation)).toContain('供应商实际执行档位：未回报');
    bunTest.expect(presentation.generation({ ...generation, kind: 'program' })).toBe('程序生成');
    bunTest.expect(presentation.generation({ ...generation, kind: 'unknown' })).toBe('生成模型未确认');
    bunTest.expect(presentation.generation({ ...generation, thinkingRequested: 'high' }))
      .toBe('actual-backup · 请求／发送 high');
  });

  bunTest.test('来源去重计数；运行/批次/单目标范围不冒充本轮，也不把新程序通知叫历史', () => {
    const presentation = new replyLinkModule.ReplyLink();
    const association = evidenceOf([1, 1, 2]).association;
    bunTest.expect(presentation.association(association)).toBe('关联 2 条用户消息');
    bunTest.expect(presentation.association({ ...association, scope: 'run' })).toContain('未确认本轮');
    bunTest.expect(presentation.association({ ...association, scope: 'batch' })).toContain('分派批次范围');
    bunTest.expect(presentation.association({ ...association, scope: 'target' })).toContain('仅确定目标消息');
    bunTest.expect(presentation.association({ ...association, scope: 'target' })).not.toContain('历史');
  });

  bunTest.test('只给所选回答与两条真实来源同色，其他用户消息及同消息的另一句回复不高亮', () => {
    const store = storeModule.createUiStore('dark');
    const target = { bot: '小测', messageId: 2, replyIndex: 0 };
    const evidence = evidenceOf();
    store.getState().openTrace(target, evidence);
    /** SSR 读取初始快照；另建以已选中状态起步的内存仓库，不启动客户端水合。 */
    const renderedStore = zustand.create<storeModule.UiState>(() => store.getState());
    const first = messageOf(1);
    const second = messageOf(2);
    second.replies = [0, 1].map((index) => ({
      at: 6000 + index,
      text: '同消息的回复',
      session: { id: 'same-session', title: '同一件事', file: '' },
      attachments: [],
      ...evidence,
    }));
    const third = messageOf(3);
    const props = {
      state: {
        origin: 'web' as const,
        messages: new Map([first, second, third].map((row) => [row.id, row])),
        hasMore: false,
        loaded: true,
        loadingOlder: false,
        loadOlder: () => Promise.resolve(),
        refresh: () => undefined,
        ensureMessages: () => Promise.resolve({ visible: [], foreignIds: [], missingIds: [] }),
      },
      bot: '小测',
      traceTarget: target,
      onOpen: () => undefined,
      onTrace: store.getState().openTrace,
    };
    const candidate = listModule.MessageList;
    if (typeof candidate !== 'function') {
      throw new Error('本地时间线模块缺少 MessageList 组件');
    }
    const component = candidate as react.ComponentType<typeof props>;
    const list = react.createElement(component, props);
    const wrapped = react.createElement(context.UiContext.Provider, { value: renderedStore }, list);
    const html = reactDomServer.renderToStaticMarkup(wrapped);
    const classFor = (key: string): string | undefined => {
      const pattern = new RegExp(`<div class="([^"]*)"[^>]*data-timeline-key="${key}"`);
      return pattern.exec(html)?.[1];
    };

    bunTest.expect(classFor('m1')).toContain('jm-msg-linked');
    bunTest.expect(classFor('m2')).toContain('jm-msg-linked');
    bunTest.expect(classFor('m3')).not.toContain('jm-msg-linked');
    bunTest.expect(classFor('r2_0')).toContain('jm-msg-linked');
    bunTest.expect(classFor('r2_1')).not.toContain('jm-msg-linked');
    bunTest.expect(html).toContain('↔ 2/1');
    bunTest.expect(html).toContain('actual-backup · 请求 xhigh · 发送 high');
    bunTest.expect(timeline.locateKey(second, 1)).toBe('r2_1');
  });
});


bunTest.describe('关联补取和快速切换', () => {
  bunTest.test('超过100条按明确号分批，跨渠道和缺失分别返回，不靠逐页遍历', async () => {
    const requested: number[][] = [];
    const mockFetch = Object.assign((input: URL | RequestInfo) => {
      const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://example.test');
      const ids = (url.searchParams.get('ids') || '').split(',').map(Number);
      requested.push(ids);
      const messages = ids.filter((id) => id !== 5).map((id) => messageOf(id, id === 2 ? 'feishu' : 'web'));
      return Promise.resolve(new Response(JSON.stringify({ messages, missingIds: ids.includes(5) ? [5] : [] })));
    }, { preconnect: () => undefined });
    const fetchSpy = bunTest.spyOn(globalThis, 'fetch').mockImplementation(mockFetch);
    try {
      const ids = Array.from({ length: 102 }, (_, index) => index + 1);
      const resolved = await replyLinkModule.ReplyLink.resolve('小测', ids, 'web');
      bunTest.expect(requested.map((batch) => batch.length)).toEqual([100, 2]);
      bunTest.expect(requested.flat()).toEqual(ids);
      bunTest.expect(resolved.foreignIds).toEqual([2]);
      bunTest.expect(resolved.missingIds).toEqual([5]);
      bunTest.expect(resolved.visible).toHaveLength(100);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  bunTest.test('A→B→A只接受最后一次读取，旧响应不能重设高亮或生成模型', async () => {
    const requests: ((response: Response) => void)[] = [];
    const mockFetch = Object.assign(() => {
      return new Promise<Response>((resolve) => requests.push(resolve));
    }, { preconnect: () => undefined });
    const fetchSpy = bunTest.spyOn(globalThis, 'fetch').mockImplementation(mockFetch);
    const store = storeModule.createUiStore('dark');
    const loader = new replyLinkModule.ReplyEvidenceLoader(store);
    const first = { bot: '小测', messageId: 1, replyIndex: 0 };
    const second = { bot: '小测', messageId: 2, replyIndex: 0 };
    try {
      store.getState().openTrace(first);
      const oldFirst = loader.load(first);
      store.getState().openTrace(second);
      const oldSecond = loader.load(second);
      store.getState().openTrace(first);
      const newFirst = loader.load(first);
      const responseOf = (model: string): Response => {
        const evidence = { generation: generationOf(model), association: evidenceOf([1]).association };
        return new Response(JSON.stringify({ target: evidence }));
      };
      requests[0]!(responseOf('example/stale-a'));
      requests[1]!(responseOf('example/stale-b'));
      await Promise.all([oldFirst, oldSecond]);
      bunTest.expect(store.getState().replySelection).toBeNull();
      requests[2]!(responseOf('example/latest-a'));
      await newFirst;
      bunTest.expect(store.getState().replySelection?.generation.model).toBe('example/latest-a');
    } finally {
      loader.cancel();
      fetchSpy.mockRestore();
    }
  });

  bunTest.test('历史返回保留原导航语义，缺证据待重新读取；换机器人清空高亮与定位', () => {
    const store = storeModule.createUiStore('dark');
    const first = { bot: '小测', messageId: 1, replyIndex: 0 };
    const second = { bot: '小测', messageId: 2, replyIndex: 0 };
    store.getState().openTrace(first, evidenceOf([1]));
    store.getState().openTrace(second, evidenceOf([2]));
    store.getState().setReplyEvidence(first, evidenceOf([3]));
    bunTest.expect(store.getState().replySelection?.association.messageIds).toEqual([2]);
    store.getState().panelBack();
    bunTest.expect(store.getState().traceTarget).toEqual(first);
    bunTest.expect(store.getState().replySelection).toBeNull();
    store.getState().setReplyEvidence(first, evidenceOf([1]));
    store.getState().locateMessage({ bot: '小测', origin: 'other', messageId: 1, replyIndex: null });
    const oldSerial = store.getState().chatLocation!.serial;
    store.getState().locateMessage({ bot: '小测', origin: 'web', messageId: 2, replyIndex: 0 });
    store.getState().finishLocation(oldSerial, 'failed', '旧错误');
    bunTest.expect(store.getState().chatLocation?.error).toBeNull();
    store.getState().selectBot('另一个');
    bunTest.expect(store.getState().replySelection).toBeNull();
    bunTest.expect(store.getState().chatLocation).toBeNull();
  });

  bunTest.test('来自完整回复或trace目标的额外正文不会被扩散保存到轻量关联状态', () => {
    const store = storeModule.createUiStore('dark');
    const target = { bot: '小测', messageId: 2, replyIndex: 0 };
    const fullReply: types.ReplyView = {
      ...evidenceOf(),
      at: 2000,
      text: 'UNSTORED_REPLY_BODY',
      attachments: [],
      session: { id: 'session', title: 'UNSTORED_SESSION_TITLE', file: 'F:/example/session.md' },
    };
    store.getState().openTrace(target, fullReply);
    const selected = store.getState().replySelection;
    bunTest.expect(Object.keys(selected!).sort()).toEqual(['association', 'generation', 'target']);
    bunTest.expect(JSON.stringify(selected)).not.toContain('UNSTORED_REPLY_BODY');
    store.getState().setReplyEvidence(target, fullReply);
    bunTest.expect(JSON.stringify(store.getState().replySelection)).not.toContain('UNSTORED_SESSION_TITLE');
  });
});
