/**
 * 网页（web/src）的纯逻辑测试：三栏宽度怎么算、状态框显示什么、主题、状态仓库。
 * 组件长什么样靠 AOBB 截图核对（docs/界面/01_界面设计.md 第 14 节），这里不起浏览器。
 */
import * as bunTest from 'bun:test';
import * as statusModule from '../web/src/Bots/Status.ts';
import * as hashModule from '../web/src/Hash.ts';
import * as poll from '../web/src/Poll.ts';
import * as settingsEdits from '../web/src/Settings/Edits.ts';
import * as widths from '../web/src/Layout/Widths.ts';
import * as storeModule from '../web/src/Store.ts';
import * as theme from '../web/src/Theme.ts';
import type * as types from '../web/src/Types.ts';


/**
 * 造一个机器人。
 * @param patch 要改的字段。
 */
function botOf(patch: Partial<types.BotView> = {}): types.BotView {
  return { name: '小测', language: 'zh', status: 'idle', running: 0, queued: 0, approvals: 0, ...patch };
}


/**
 * 假的浏览器本地存储。
 */
function memoryStorage(): Storage {
  /** 存的东西。 */
  const items = new Map<string, string>();
  return {
    get length() {
      return items.size;
    },
    clear: () => items.clear(),
    getItem: (key) => items.get(key) ?? null,
    key: (index) => [...items.keys()][index] ?? null,
    removeItem: (key) => {
      items.delete(key);
    },
    setItem: (key, value) => {
      items.set(key, value);
    },
  };
}


bunTest.describe('三栏宽度', () => {
  bunTest.test('三种窗口宽度：宽的照用户的、中等的先压右栏、窄的一次一栏', () => {
    const wanted = { left: 300, right: 500 };
    //M 1600 宽：放得下，照用户的。
    bunTest.expect(widths.clampWidths(1600, wanted, true)).toEqual(wanted);
    //M 1500 宽、右栏想要 700：中栏不到最窄，先压右栏，右栏不窄于最小值。
    const medium = widths.clampWidths(1500, { left: 300, right: 700 }, true);
    bunTest.expect(medium.right).toBe(1500 - 12 - 300 - widths.MIN_WIDTHS.center);
    bunTest.expect(1500 - 12 - medium.left - medium.right).toBeGreaterThanOrEqual(widths.MIN_WIDTHS.center);
    //M 右栏收起时中栏占满，只算一条分隔线。
    bunTest.expect(widths.clampWidths(1100, wanted, false)).toEqual({ left: 300, right: 500 });
    //M 800 宽：一次一栏。
    bunTest.expect(widths.isNarrow(800)).toBe(true);
    bunTest.expect(widths.isNarrow(1100)).toBe(false);
  });

  bunTest.test('isNarrow：右栏开着按三栏最小宽度加两条分隔线，收起时还是 900；右栏最少 500', () => {
    /** 右栏开着时一次一栏的临界宽度：三栏最小宽度加两条分隔线。 */
    const openLimit = widths.MIN_WIDTHS.left + widths.MIN_WIDTHS.center + widths.MIN_WIDTHS.right + widths.SPLITTER_WIDTH * 2;
    //M 右栏最少 500，展开时的临界宽度比收起时的 900 大。
    bunTest.expect(widths.MIN_WIDTHS.right).toBe(500);
    bunTest.expect(openLimit).toBeGreaterThan(widths.NARROW_WIDTH);
    //M 右栏开着：窄于临界宽度一次一栏，到临界宽度就放得下三栏。
    bunTest.expect(widths.isNarrow(openLimit - 1, true)).toBe(true);
    bunTest.expect(widths.isNarrow(openLimit, true)).toBe(false);
    bunTest.expect(widths.isNarrow(widths.NARROW_WIDTH, true)).toBe(true);
    //M 右栏收起：还是 900 这个临界，不受右栏最小宽度影响。
    bunTest.expect(widths.isNarrow(widths.NARROW_WIDTH - 1, false)).toBe(true);
    bunTest.expect(widths.isNarrow(widths.NARROW_WIDTH, false)).toBe(false);
    bunTest.expect(widths.isNarrow(openLimit - 1, false)).toBe(false);
    //M 不写 rightOpen 时按右栏收起算。
    bunTest.expect(widths.isNarrow(widths.NARROW_WIDTH - 1)).toBe(true);
    bunTest.expect(widths.isNarrow(widths.NARROW_WIDTH)).toBe(false);
    //M 右栏再怎么挤也不窄于 500。
    bunTest.expect(widths.clampWidths(1600, { left: 300, right: 1 }, true).right).toBeGreaterThanOrEqual(widths.MIN_WIDTHS.right);
  });

  bunTest.test('拖分隔线：左边那条往右拖左栏变宽，右边那条往右拖右栏变窄；都不窄于最小值', () => {
    const start = { left: 260, right: 620 };
    bunTest.expect(widths.dragWidths(start, 'left', 40, 1800, true).left).toBe(300);
    bunTest.expect(widths.dragWidths(start, 'right', 40, 1800, true).right).toBe(580);
    bunTest.expect(widths.dragWidths(start, 'left', -500, 1600, true).left).toBe(widths.MIN_WIDTHS.left);
    bunTest.expect(widths.dragWidths(start, 'right', 900, 1600, true).right).toBe(widths.MIN_WIDTHS.right);
  });

  bunTest.test('记下的宽度能读回来；坏了用默认', () => {
    const storage = memoryStorage();
    bunTest.expect(widths.loadWidths(storage)).toEqual(widths.DEFAULT_WIDTHS);
    widths.saveWidths(storage, { left: 333, right: 444 });
    bunTest.expect(widths.loadWidths(storage)).toEqual({ left: 333, right: 444 });
    storage.setItem('jmbots.columns', '{坏的');
    bunTest.expect(widths.loadWidths(storage)).toEqual(widths.DEFAULT_WIDTHS);
  });
});


bunTest.describe('状态框', () => {
  bunTest.test('后端给什么显示什么；连不上一律休假中；小字说清为什么', () => {
    bunTest.expect(statusModule.shownStatus(true, botOf({ status: 'working', running: 2 }))).toBe('working');
    bunTest.expect(statusModule.shownStatus(false, botOf({ status: 'working' }))).toBe('off');
    bunTest.expect(statusModule.shownStatus(true, undefined)).toBe('off');
    bunTest.expect(statusModule.statusDetail('waiting', botOf({ status: 'waiting', approvals: 1, running: 1 }))).toBe('1 条命令等你确认');
    bunTest.expect(statusModule.statusDetail('working', botOf({ status: 'working', running: 2 }))).toBe('2 个会话在跑');
    bunTest.expect(statusModule.statusDetail('waiting', botOf({ status: 'waiting', queued: 3 }))).toBe('3 条消息在排队');
    bunTest.expect(statusModule.statusDetail('off', undefined)).toBe('连不上后端');
  });

  bunTest.test('状态框后面的短说明：要确认、会话、排队、等你吩咐、连不上', () => {
    bunTest.expect(statusModule.statusShort('waiting', botOf({ status: 'waiting', approvals: 1 }))).toBe('1 条要确认');
    bunTest.expect(statusModule.statusShort('working', botOf({ status: 'working', running: 2 }))).toBe('2 个会话');
    bunTest.expect(statusModule.statusShort('waiting', botOf({ status: 'waiting', queued: 3 }))).toBe('3 条排队');
    bunTest.expect(statusModule.statusShort('idle', botOf())).toBe('等你吩咐');
    bunTest.expect(statusModule.statusShort('off', undefined)).toBe('连不上');
    bunTest.expect(statusModule.statusShort('idle', undefined)).toBe('连不上');
  });

  bunTest.test('四种状态的文字和颜文字；正在干活有两帧', () => {
    bunTest.expect(Object.values(statusModule.STATUS_LOOKS).map((look) => look.label)).toEqual(['等待中', '正在干活', '休闲中', '休假中']);
    bunTest.expect(statusModule.STATUS_LOOKS.working.frames).toHaveLength(2);
    bunTest.expect(statusModule.STATUS_LOOKS.off.frames[0]).toContain('zzZ');
  });
});


bunTest.describe('主题', () => {
  bunTest.test('四套主题键一样齐；深色是默认、调完整了；CSS 变量名', () => {
    const keys = Object.keys(theme.THEMES.dark.colors).sort();
    for (const spec of Object.values(theme.THEMES)) {
      bunTest.expect(Object.keys(spec.colors).sort()).toEqual(keys);
      bunTest.expect(spec.avatars.length).toBeGreaterThan(0);
    }
    bunTest.expect(theme.DEFAULT_THEME).toBe('dark');
    bunTest.expect(theme.THEMES.dark.ready).toBe(true);
    const variables = theme.cssVariables(theme.THEMES.dark);
    bunTest.expect(variables['--jm-user-bubble']).toBe(theme.THEMES.dark.colors.userBubble);
    bunTest.expect(variables['--jm-radius']).toBe('12px');
  });

  bunTest.test('主题名存取；认不出的用默认；头像颜色同名同色', () => {
    const storage = memoryStorage();
    bunTest.expect(theme.loadThemeName(storage)).toBe('dark');
    theme.saveThemeName(storage, 'eyecare');
    bunTest.expect(theme.loadThemeName(storage)).toBe('eyecare');
    storage.setItem('jmbots.theme', 'neon');
    bunTest.expect(theme.loadThemeName(storage)).toBe('dark');
    const palette = theme.THEMES.dark.avatars;
    bunTest.expect(theme.avatarColor('周小灵', palette)).toBe(theme.avatarColor('周小灵', palette));
    bunTest.expect(palette).toContain(theme.avatarColor('小测', palette));
  });
});


bunTest.describe('状态仓库', () => {
  bunTest.test('轮询结果：选中的机器人还在就留着，不在了换第一个；离线时留着旧列表', () => {
    const store = storeModule.createUiStore('dark');
    store.getState().setPolled({ online: true, bots: [botOf({ name: '甲' }), botOf({ name: '乙' })], approvals: [] });
    bunTest.expect(store.getState().currentBot).toBe('甲');
    store.getState().selectBot('乙');
    store.getState().setPolled({ online: true, bots: [botOf({ name: '甲' }), botOf({ name: '乙' })] });
    bunTest.expect(store.getState().currentBot).toBe('乙');
    store.getState().setPolled({ online: false });
    bunTest.expect(store.getState().online).toBe(false);
    bunTest.expect(store.getState().bots).toHaveLength(2);
    store.getState().setPolled({ online: true, bots: [botOf({ name: '丙' })] });
    bunTest.expect(store.getState().currentBot).toBe('丙');
  });

  bunTest.test('右栏：打开某个标签、带上要看的东西；收起', () => {
    const store = storeModule.createUiStore('dark');
    store.getState().openPanel('preview', { path: 'F:/x/1.png', name: '1.png' });
    bunTest.expect(store.getState()).toMatchObject({ panelOpen: true, panelTab: 'preview', panelTarget: { name: '1.png' } });
    store.getState().openPanel('memory');
    bunTest.expect(store.getState()).toMatchObject({ panelTab: 'memory', panelTarget: { name: '1.png' } });
    store.getState().closePanel();
    bunTest.expect(store.getState().panelOpen).toBe(false);
  });

  bunTest.test('工作区标签：按路径去重、能删能清；openSession 打开会话页；换机器人清掉', () => {
    const store = storeModule.createUiStore('dark');
    store.getState().setPolled({ online: true, bots: [botOf({ name: '甲' }), botOf({ name: '乙' })] });
    bunTest.expect(store.getState().currentBot).toBe('甲');
    //M 同一个绝对路径只留一个。
    store.getState().addWorkspaceTag({ path: 'F:\\a\\b.md', label: 'b.md', kind: 'file' });
    store.getState().addWorkspaceTag({ path: 'F:\\a\\b.md', label: 'b.md', kind: 'file' });
    store.getState().addWorkspaceTag({ path: 'F:\\a\\素材', label: '素材', kind: 'dir' });
    bunTest.expect(store.getState().workspaceTags.map((tag) => tag.path)).toEqual(['F:\\a\\b.md', 'F:\\a\\素材']);
    store.getState().removeWorkspaceTag('F:\\a\\素材');
    bunTest.expect(store.getState().workspaceTags.map((tag) => tag.path)).toEqual(['F:\\a\\b.md']);
    //M openSession：记下会话号并打开“会话”标签。
    store.getState().openSession('s-1');
    bunTest.expect(store.getState()).toMatchObject({ panelOpen: true, panelTab: 'session', panelSessionId: 's-1' });
    store.getState().clearWorkspaceTags();
    bunTest.expect(store.getState().workspaceTags).toEqual([]);
    //M 换机器人：标签和会话号都清掉。
    store.getState().addWorkspaceTag({ path: 'F:\\a\\b.md', label: 'b.md', kind: 'file' });
    store.getState().selectBot('乙');
    bunTest.expect(store.getState().workspaceTags).toEqual([]);
    bunTest.expect(store.getState().panelSessionId).toBeNull();
  });
});


bunTest.describe('深链接', () => {
  bunTest.test('#preview=路径、#tab=、#settings=；认不出的什么也不做', () => {
    bunTest.expect(hashModule.parseHash(`#preview=${encodeURIComponent('F:\\a b\\1.png')}`)).toEqual({ kind: 'preview', target: { path: 'F:\\a b\\1.png', name: '1.png' } });
    bunTest.expect(hashModule.parseHash('#tab=workspace')).toEqual({ kind: 'tab', tab: 'workspace' });
    bunTest.expect(hashModule.parseHash('#tab=session')).toEqual({ kind: 'tab', tab: 'session' });
    bunTest.expect(hashModule.parseHash('#tab=messages')).toEqual({ kind: 'tab', tab: 'messages' });
    bunTest.expect(hashModule.parseHash('#tab=approvals')).toEqual({ kind: 'tab', tab: 'approvals' });
    bunTest.expect(hashModule.parseHash('#tab=nope')).toEqual({ kind: 'none' });
    bunTest.expect(hashModule.parseHash('#settings=engine')).toEqual({ kind: 'settings', category: 'engine' });
    bunTest.expect(hashModule.parseHash('')).toEqual({ kind: 'none' });
  });
});


bunTest.describe('设置的改动', () => {
  bunTest.test('一步一步做到草稿上，不改原来的；同一个值连着改合成一步', () => {
    const config = { engine: { merge_ms: 2000 }, bots: [{ name: '甲', language: 'zh' }], providers: { a: { api_key: 'sk-real-1234' } } };
    let edits: settingsEdits.Edit[] = [];
    edits = settingsEdits.addEdit(edits, { path: ['engine', 'merge_ms'], value: 2 });
    edits = settingsEdits.addEdit(edits, { path: ['engine', 'merge_ms'], value: 2500 });
    edits = settingsEdits.addEdit(edits, { path: ['bots', 1], value: { name: '乙', language: 'en' } });
    edits = settingsEdits.addEdit(edits, { path: ['bots', 0], delete: true });
    edits = settingsEdits.addEdit(edits, { path: ['local', 'port'], value: 31000 });
    bunTest.expect(edits).toHaveLength(4);
    const draft = settingsEdits.draftOf(config, edits);
    bunTest.expect(settingsEdits.getAt(draft, ['engine', 'merge_ms'])).toBe(2500);
    bunTest.expect(settingsEdits.getAt(draft, ['bots'])).toEqual([{ name: '乙', language: 'en' }]);
    bunTest.expect(settingsEdits.getAt(draft, ['local', 'port'])).toBe(31000);
    bunTest.expect(settingsEdits.getAt(draft, ['providers', 'a', 'api_key'])).toBe('sk-real-1234');
    bunTest.expect(config.engine.merge_ms).toBe(2000);
    bunTest.expect(config.bots).toHaveLength(1);
  });

  bunTest.test('改过的项：改值 true，改回原值 false，数组/对象按 JSON 比较，不存在的路径 false', () => {
    const config = { engine: { merge_ms: 2000, retry_delays_ms: [2000, 5000] }, providers: { a: { models: { m: { vision: true } } } } };
    bunTest.expect(settingsEdits.changedAt(config, settingsEdits.draftOf(config, [{ path: ['engine', 'merge_ms'], value: 2500 }]), ['engine', 'merge_ms'])).toBe(true);
    bunTest.expect(settingsEdits.changedAt(config, settingsEdits.draftOf(config, [{ path: ['engine', 'merge_ms'], value: 2500 }, { path: ['engine', 'merge_ms'], value: 2000 }]), ['engine', 'merge_ms'])).toBe(false);
    bunTest.expect(settingsEdits.changedAt(config, settingsEdits.draftOf(config, [{ path: ['engine', 'retry_delays_ms'], value: [2000, 5000] }]), ['engine', 'retry_delays_ms'])).toBe(false);
    bunTest.expect(settingsEdits.changedAt(config, settingsEdits.draftOf(config, [{ path: ['engine', 'retry_delays_ms'], value: [2000, 8000] }]), ['engine', 'retry_delays_ms'])).toBe(true);
    bunTest.expect(settingsEdits.changedAt(config, settingsEdits.draftOf(config, [{ path: ['providers', 'a', 'models'], value: { m: { vision: true } } }]), ['providers', 'a', 'models'])).toBe(false);
    bunTest.expect(settingsEdits.changedAt(config, settingsEdits.draftOf(config, [{ path: ['providers', 'a', 'models'], value: { m: { vision: false } } }]), ['providers', 'a', 'models'])).toBe(true);
    bunTest.expect(settingsEdits.changedAt(config, config, ['providers', 'none', 'x'])).toBe(false);
  });

  bunTest.test('逗号隔开的数字', () => {
    bunTest.expect(settingsEdits.parseNumberList('2000, 5000，8000')).toEqual([2000, 5000, 8000]);
    bunTest.expect(settingsEdits.parseNumberList('2000, 很久')).toBeUndefined();
  });
});


bunTest.describe('界面语言跟配置走', () => {
  /**
   * 装一个假浏览器：地址栏、本地存储；轮询还要 document 判断后台和输入框。
   * @param search 地址栏的查询参数（?lang=…）。
   * @returns 本地存储和还原函数。
   */
  function shimBrowser(search: string): { storage: Storage; restore: () => void } {
    /** 假本地存储。 */
    const storage = memoryStorage();
    /** 全局对象，测完还原。 */
    const globals = globalThis as { window?: unknown; document?: unknown };
    /** 原来的 window。 */
    const originalWindow = globals.window;
    /** 原来的 document。 */
    const originalDocument = globals.document;
    globals.window = {
      location: { search, href: `http://example.test/${search}`, reload: () => undefined },
      localStorage: storage,
      history: { replaceState: () => undefined },
      dispatchEvent: () => true,
    };
    globals.document = { hidden: false, querySelector: () => null };
    return {
      storage,
      restore: () => {
        globals.window = originalWindow;
        globals.document = originalDocument;
      },
    };
  }

  /**
   * 假后端：/api/ui/info 回指定的进程信息，别的接口回空表。
   * @param info 进程信息；language 不写就是没配界面语言。
   * @returns 假的 fetch。
   */
  function backendOf(info: { startedAt: number; version: string; language?: string }): typeof fetch {
    return Object.assign((input: URL | RequestInfo) => {
      /** 请求的地址。 */
      const url = new URL(input instanceof Request ? input.url : input.toString(), 'http://example.test');
      /** 回的 JSON。 */
      const body = url.pathname === '/api/ui/info' ? info : [];
      return Promise.resolve(new Response(JSON.stringify(body)));
    }, { preconnect: () => undefined });
  }

  /**
   * 等仓库里的语言变成想要的，超时就继续（断言会失败）。
   * @param store 状态仓库。
   * @param wanted 想要的语言。
   */
  async function waitLanguage(store: { getState: () => { language: string } }, wanted: string): Promise<void> {
    /** 最晚等到什么时候。 */
    const deadline = Date.now() + 3000;
    while (store.getState().language !== wanted && Date.now() < deadline) {
      await Bun.sleep(20);
    }
  }

  bunTest.test('配置写了 zh-CN：浏览器记的 en 让位，还记一份新的', async () => {
    /** 假浏览器。 */
    const browser = shimBrowser('');
    /** 假后端。 */
    const fetchSpy = bunTest.spyOn(globalThis, 'fetch').mockImplementation(backendOf({ startedAt: 1000, version: 'test', language: 'zh-CN' }));
    /** 浏览器记着 en 的状态仓库。 */
    const store = storeModule.createUiStore('dark', 'en');
    try {
      /** 停轮询的函数。 */
      const stop = poll.startPolling(store);
      await waitLanguage(store, 'zh-CN');
      stop();
      bunTest.expect(store.getState().language).toBe('zh-CN');
      bunTest.expect(browser.storage.getItem('jmbots.language')).toBe('zh-CN');
    } finally {
      fetchSpy.mockRestore();
      browser.restore();
    }
  });

  bunTest.test('网址带 ?lang=en：以网址为准，不跟配置', async () => {
    /** 假浏览器。 */
    const browser = shimBrowser('?lang=en');
    /** 假后端。 */
    const fetchSpy = bunTest.spyOn(globalThis, 'fetch').mockImplementation(backendOf({ startedAt: 1000, version: 'test', language: 'zh-CN' }));
    /** 状态仓库。 */
    const store = storeModule.createUiStore('dark', 'en');
    try {
      /** 停轮询的函数。 */
      const stop = poll.startPolling(store);
      //M 等一轮问完。
      await Bun.sleep(150);
      stop();
      bunTest.expect(store.getState().language).toBe('en');
      bunTest.expect(browser.storage.getItem('jmbots.language')).toBeNull();
    } finally {
      fetchSpy.mockRestore();
      browser.restore();
    }
  });

  bunTest.test('配置没写语言：保持浏览器记的，不乱写', async () => {
    /** 假浏览器。 */
    const browser = shimBrowser('');
    /** 假后端。 */
    const fetchSpy = bunTest.spyOn(globalThis, 'fetch').mockImplementation(backendOf({ startedAt: 1000, version: 'test' }));
    /** 状态仓库。 */
    const store = storeModule.createUiStore('dark', 'en');
    try {
      /** 停轮询的函数。 */
      const stop = poll.startPolling(store);
      //M 等一轮问完。
      await Bun.sleep(150);
      stop();
      bunTest.expect(store.getState().language).toBe('en');
      bunTest.expect(browser.storage.getItem('jmbots.language')).toBeNull();
    } finally {
      fetchSpy.mockRestore();
      browser.restore();
    }
  });
});
