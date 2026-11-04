/**
 * Resources 的离线测试：在临时运行时目录里自己写 config.yaml，验证 load 建目录骨架和模板、
 * problems 报缺配置、各读取函数按 config.yaml 取设置、listRoles 列角色并返回副本、
 * getSecretValues 找密钥、工作区和会话目录的默认值。
 * 全部在临时目录里做，不读真实的 F:\aidata\AIJMBots\config.yaml，不联网、不调模型。
 */
import * as bunTest from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as resourcesModule from '../src/resources/Resources.ts';


/**
 * 建一个空的临时运行时目录。
 * @returns 目录；用完调用 removeRuntime 删掉。
 */
function tempRuntimeDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'jmbots-resources-'));
}


/**
 * 先在临时目录里写好 config.yaml，再用 Resources 打开。
 * @param yaml config.yaml 的内容。
 * @returns 打开的运行时和临时目录；调用方负责删目录。
 */
async function openRuntime(yaml: string): Promise<{ runtime: resourcesModule.Resources; dir: string }> {
  /** 临时运行时目录。 */
  const dir = tempRuntimeDir();
  fs.writeFileSync(path.join(dir, 'config.yaml'), yaml);
  return { runtime: await resourcesModule.Resources.load(dir), dir };
}


/**
 * 删掉临时运行时目录。
 * @param dir 目录。
 */
function removeRuntime(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}


bunTest.test('空目录首次 load：建好目录骨架，写一份模板 config.yaml 和默认分派智能体', async () => {
  /** 临时运行时目录，故意什么都不放。 */
  const dir = tempRuntimeDir();
  try {
    /** 打开的运行时。 */
    const runtime = await resourcesModule.Resources.load(dir);
    //M 第一次启动时运行时目录可能完全不存在，不能因此报错。
    for (const folder of ['bots', 'agents', 'workspaces', 'knowledge', 'logs', 'data', 'integrations/feishu/outbox', 'integrations/claude/inbox']) {
      bunTest.expect(fs.existsSync(path.join(dir, folder))).toBe(true);
    }
    //M 用户照着模板填供应商和模型，所以模板必须落在运行时目录里。
    bunTest.expect(fs.existsSync(runtime.configFile)).toBe(true);
    /** 模板原文。 */
    const template = fs.readFileSync(runtime.configFile, 'utf8');
    bunTest.expect(template).toContain('providers: {}');
    bunTest.expect(template).toContain('models: {}');
    //M 分派智能体也要有默认的，否则第一次启动没东西可分派。
    bunTest.expect(fs.existsSync(path.join(dir, 'agents', '分派', 'config.yaml'))).toBe(true);
    bunTest.expect(runtime.listRoles('agent').map((item) => item.name)).toContain('分派');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('已经有 config.yaml 时 load 不覆盖，用户填的供应商和密钥还在', async () => {
  /** 临时运行时目录。 */
  const dir = tempRuntimeDir();
  try {
    /** 用户自己写的配置。 */
    const ownConfig = 'providers:\n  magpie:\n    base_url: http://127.0.0.1:3425/v1\n    api_key: fake-key-12345678\n';
    fs.writeFileSync(path.join(dir, 'config.yaml'), ownConfig);
    /** 打开的运行时。 */
    const runtime = await resourcesModule.Resources.load(dir);
    //G 模板用 wx 只新建不覆盖，用户填好的密钥不能被冲掉。
    bunTest.expect(fs.readFileSync(runtime.configFile, 'utf8')).toBe(ownConfig);
    bunTest.expect(runtime.getProviders().magpie?.api_key).toBe('fake-key-12345678');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('problems()：没有供应商、没有默认模型时两条都报出来', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('{}\n');
  try {
    //M 启动时用户要一眼看到缺哪一样，所以两条句子都要带上配置文件的路径。
    bunTest.expect(runtime.problems()).toEqual([
      `${runtime.configFile} 里没有模型供应商（providers），无法执行。`,
      `${runtime.configFile} 里没有默认模型（default_model），机器人和智能体没写模型时无法执行。`,
    ]);
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('problems()：只缺默认模型时只报这一条', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('providers:\n  magpie:\n    base_url: http://127.0.0.1:3425/v1\n    api_key: fake-key-12345678\n');
  try {
    /** 报出的问题。 */
    const problems = runtime.problems();
    bunTest.expect(problems).toHaveLength(1);
    bunTest.expect(problems[0]).toContain('没有默认模型');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('problems()：只缺供应商时只报这一条', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('default_model: magpie/workbuddy/deepseek-v4.1-flash\n');
  try {
    /** 报出的问题。 */
    const problems = runtime.problems();
    bunTest.expect(problems).toHaveLength(1);
    bunTest.expect(problems[0]).toContain('没有模型供应商');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('problems()：供应商和默认模型都配了就返回空数组', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime(
    'providers:\n  magpie:\n    base_url: http://127.0.0.1:3425/v1\n    api_key: fake-key-12345678\ndefault_model: magpie/workbuddy/deepseek-v4.1-flash\n',
  );
  try {
    //M 都配齐时启动要静默通过，不能误报。
    bunTest.expect(runtime.problems()).toEqual([]);
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getDefaultModel()：写了 default_model 就用它，旧写法 models.work.model 不抢', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('default_model: magpie/workbuddy/deepseek-v4.1-flash\nmodels:\n  work:\n    model: 旧网关/旧模型\n');
  try {
    //M 新配置升级后不能被旧写法覆盖，否则会调到旧模型。
    bunTest.expect(runtime.getDefaultModel()).toBe('magpie/workbuddy/deepseek-v4.1-flash');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getDefaultModel()：没写 default_model 时认旧写法 models.work.model', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('models:\n  work:\n    model: 旧网关/旧模型\n');
  try {
    //M 没写模型的机器人和智能体靠它执行，老配置升级时要能继续跑。
    bunTest.expect(runtime.getDefaultModel()).toBe('旧网关/旧模型');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getDefaultModel()：两种都没写时是 undefined', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('{}\n');
  try {
    //G 不能瞎给一个默认模型，要由 problems() 报“没有默认模型”。
    bunTest.expect(runtime.getDefaultModel()).toBeUndefined();
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getSetting()：config.yaml 没写的项拿到默认值', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('{}\n');
  try {
    //M 默认值决定没配置时怎么跑，改了等于改了执行行为。
    bunTest.expect(runtime.getSetting('maxSteps')).toBe(100);
    bunTest.expect(runtime.getSetting('dispatcher')).toBe('分派');
    bunTest.expect(runtime.getSetting('execReview')).toBe('decision');
    bunTest.expect(runtime.getSetting('passProbability')).toBe(0.2);
    bunTest.expect(runtime.getSetting('routeModel')).toBe('magpie/workbuddy/deepseek-v4.1-flash');
    bunTest.expect(runtime.getSetting('routeThinking')).toBe('off');
    bunTest.expect(runtime.getSetting('watchdogMinutes')).toBe(15);
    bunTest.expect(runtime.getSetting('questions')).toEqual({});
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getSetting()：config.yaml 写了的项就用写的值', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime(
    'engine:\n  max_steps: 7\n  dispatcher: 小助手\n  exec_review: human\n  route_model: magpie/workbuddy/deepseek-v4.1-pro\n  route_thinking: high\n  watchdog_minutes: 0\ndecision:\n  pass_probability: 0.5\n',
  );
  try {
    //M 用户改配置要立刻生效，默认值只在没写时兜底。
    bunTest.expect(runtime.getSetting('maxSteps')).toBe(7);
    bunTest.expect(runtime.getSetting('dispatcher')).toBe('小助手');
    bunTest.expect(runtime.getSetting('execReview')).toBe('human');
    bunTest.expect(runtime.getSetting('passProbability')).toBe(0.5);
    bunTest.expect(runtime.getSetting('routeModel')).toBe('magpie/workbuddy/deepseek-v4.1-pro');
    bunTest.expect(runtime.getSetting('routeThinking')).toBe('high');
    bunTest.expect(runtime.getSetting('watchdogMinutes')).toBe(0);
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getSetting()：旧写法 agent.max_steps 也认', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('agent:\n  max_steps: 12\n');
  try {
    //M 旧配置文件升级后步数上限不能悄悄变回默认值。
    bunTest.expect(runtime.getSetting('maxSteps')).toBe(12);
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getQuestion()：decision.questions 里的题按名字取，没写是 undefined', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('decision:\n  questions:\n    next_step: 继续还是结束\n    tool_safe:\n      说明: 这条命令安全吗\n');
  try {
    //M 决策模型的问题由用户在 config.yaml 里写，按名字取错了就会答非所问。
    bunTest.expect(runtime.getQuestion('next_step')).toBe('继续还是结束');
    bunTest.expect(runtime.getQuestion('tool_safe')).toEqual({ 说明: '这条命令安全吗' });
    //G 没写这道题时不能编一个，交由调用方判断。
    bunTest.expect(runtime.getQuestion('不存在')).toBeUndefined();
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getChannel()：配了的渠道能取到，没配是 undefined', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('channels:\n  feishu:\n    app_id: cli_fake\n    app_secret: fake-app-secret-abcdefgh\n');
  try {
    //M 渠道没开时不能给空对象，否则服务会以为配置好了去连。
    bunTest.expect(runtime.getChannel('feishu')).toEqual({ app_id: 'cli_fake', app_secret: 'fake-app-secret-abcdefgh' });
    bunTest.expect(runtime.getChannel('http')).toBeUndefined();
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('listChannels()：列出开了的渠道，数组写法逐个收，enabled: false 的不算', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime(
    'channels:\n  feishu:\n    enabled: true\n    app_id: cli_fake\n  http:\n    - enabled: true\n      port: 30086\n    - enabled: false\n      port: 30087\n  webpage:\n    enabled: false\n',
  );
  try {
    //M 同一种渠道可以配多个号（对象数组），关掉的不能混进来。
    bunTest.expect(runtime.listChannels()).toEqual([
      { name: 'feishu', settings: { enabled: true, app_id: 'cli_fake' } },
      { name: 'http', settings: { enabled: true, port: 30086 } },
    ]);
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getHttp() 和 getSearch()：没写时分别是空对象和 undefined', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('{}\n');
  try {
    //M http 没写时按空设置处理，search 没写时 web_search 工具要报没配。
    bunTest.expect(runtime.getHttp()).toEqual({});
    bunTest.expect(runtime.getSearch()).toBeUndefined();
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getHttp() 和 getSearch()：写了的原样读出来', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('http:\n  port: 30086\n  host: 127.0.0.1\nsearch:\n  provider: exa\n  api_key: fake-key-12345678\n');
  try {
    //M 服务监听和搜索都按这两段配置走，读漏了就跑默认值。
    bunTest.expect(runtime.getHttp()).toEqual({ port: 30086, host: '127.0.0.1' });
    bunTest.expect(runtime.getSearch()).toEqual({ provider: 'exa', api_key: 'fake-key-12345678' });
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('listRoles()：bots 和 agents 下的角色都列出来，没有 config.yaml 的文件夹不算', async () => {
  /** 临时运行时目录。 */
  const dir = tempRuntimeDir();
  try {
    fs.mkdirSync(path.join(dir, 'bots', '小助手'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bots', '小助手', 'config.yaml'), 'description: 本地助手\n');
    fs.mkdirSync(path.join(dir, 'bots', '空壳'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'agents', '评审'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'agents', '评审', 'config.yaml'), 'description: 评审代码\n');
    fs.writeFileSync(path.join(dir, 'config.yaml'), '{}\n');
    /** 打开的运行时。 */
    const runtime = await resourcesModule.Resources.load(dir);
    //M 一个带 config.yaml 的文件夹就是一个角色，机器人只列 bots 下的。
    bunTest.expect(runtime.listRoles('bot').map((item) => item.name)).toEqual(['小助手']);
    /** 智能体名字。 */
    const agentNames = runtime.listRoles('agent').map((item) => item.name);
    //M load 会建默认分派智能体，所以 agents 下有两个。
    bunTest.expect(agentNames).toHaveLength(2);
    bunTest.expect(agentNames).toContain('分派');
    bunTest.expect(agentNames).toContain('评审');
    //G 只有文件夹、没有 config.yaml 的是半成品，不能当角色列出去。
    bunTest.expect(runtime.listRoles('bot').map((item) => item.name)).not.toContain('空壳');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('listRoles()：角色字段按 config.yaml 读，system.md 优先于 config.yaml 的 system 积木', async () => {
  /** 临时运行时目录。 */
  const dir = tempRuntimeDir();
  try {
    fs.mkdirSync(path.join(dir, 'bots', '写手'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'bots', '写手', 'config.yaml'),
      'description: 写文案\nmodel: magpie/workbuddy/deepseek-v4.1-flash\nthinking: high\ntools:\n  - read\n  - edit\njudge: decision\nroutes:\n  - 评审\nsystem:\n  身份: config.yaml 里的身份\n',
    );
    fs.writeFileSync(path.join(dir, 'bots', '写手', 'system.md'), '你是写手，用 system.md 里的提示词\n');
    fs.mkdirSync(path.join(dir, 'bots', '最简'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bots', '最简', 'config.yaml'), 'description: 最简角色\n');
    fs.writeFileSync(path.join(dir, 'config.yaml'), '{}\n');
    /** 打开的运行时。 */
    const runtime = await resourcesModule.Resources.load(dir);
    /** 写手。 */
    const writer = runtime.getRole('bot', '写手');
    bunTest.expect(writer.kind).toBe('bot');
    bunTest.expect(writer.name).toBe('写手');
    bunTest.expect(writer.description).toBe('写文案');
    bunTest.expect(writer.model).toBe('magpie/workbuddy/deepseek-v4.1-flash');
    bunTest.expect(writer.thinking).toBe('high');
    bunTest.expect(writer.tools).toEqual(['read', 'edit']);
    bunTest.expect(writer.judge).toBe('decision');
    bunTest.expect(writer.routes).toEqual(['评审']);
    //M 有 system.md 时它优先，config.yaml 里的积木不再拼进去。
    bunTest.expect(writer.system).toEqual({ 系统: '你是写手，用 system.md 里的提示词\n' });
    /** 最简角色：没写的字段用默认值。 */
    const minimal = runtime.getRole('bot', '最简');
    bunTest.expect(minimal.judge).toBe('rule');
    bunTest.expect(minimal.routes).toEqual([]);
    bunTest.expect(minimal.model).toBeUndefined();
    bunTest.expect(minimal.thinking).toBeUndefined();
    bunTest.expect(minimal.tools).toBeUndefined();
    bunTest.expect(minimal.system).toEqual({});
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('listRoles()：返回的是副本，外面清空不影响下一次调用', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('{}\n');
  try {
    /** 第一次拿到的列表。 */
    const copy = runtime.listRoles('agent');
    bunTest.expect(copy).toHaveLength(1);
    copy.length = 0;
    //G 调用方误改列表不能把 Resources 里的清单搞乱。
    bunTest.expect(runtime.listRoles('agent')).toHaveLength(1);
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getSecretValues()：键名像密钥且够长的值才收集，短的和键名不像的不算', async () => {
  //G 测试里只用假密钥，真实密钥不碰。
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime(
    'providers:\n  magpie:\n    base_url: http://127.0.0.1:3425/v1\n    api_key: fake-secret-abcdefgh\nhttp:\n  auth_token: fake-token-12345678\n  password: short\n  note: 这不是密钥\nchannels:\n  feishu:\n    app_secret: fake-app-secret-abcdefgh\nsearch:\n  apiKey: fake-camel-key-abcdefgh\n  tokens:\n    - fake-token-list-abcdefgh\n    - 短\n',
  );
  try {
    /** 找到的密钥。 */
    const secrets = runtime.getSecretValues().sort();
    //M 工具结果里出现这些值要换成 {{secret:N}} 替身，漏一个就泄漏，多一个会误伤正常文字。
    bunTest.expect(secrets).toEqual([
      'fake-app-secret-abcdefgh',
      'fake-camel-key-abcdefgh',
      'fake-secret-abcdefgh',
      'fake-token-12345678',
      'fake-token-list-abcdefgh',
    ]);
    bunTest.expect(secrets).not.toContain('short');
    bunTest.expect(secrets).not.toContain('这不是密钥');
    bunTest.expect(secrets).not.toContain('http://127.0.0.1:3425/v1');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getProviders()、listModelChoices()、getModelChoice()：读 config.yaml 对应段', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime(
    'providers:\n  magpie:\n    base_url: http://127.0.0.1:3425/v1\n    api_key: fake-key-12345678\nmodels:\n  dispatch:\n    model: magpie/workbuddy/deepseek-v4.1-flash\n    thinking: low\n  decision:\n    model: magpie/workbuddy/deepseek-v4.1-pro\n',
  );
  try {
    //M 分派和执行都从这两段拿供应商和模型，读错就会调错模型。
    bunTest.expect(runtime.getProviders()).toEqual({ magpie: { base_url: 'http://127.0.0.1:3425/v1', api_key: 'fake-key-12345678' } });
    bunTest.expect(runtime.listModelChoices()).toEqual({
      dispatch: { model: 'magpie/workbuddy/deepseek-v4.1-flash', thinking: 'low' },
      decision: { model: 'magpie/workbuddy/deepseek-v4.1-pro' },
    });
    bunTest.expect(runtime.getModelChoice('dispatch')).toEqual({ model: 'magpie/workbuddy/deepseek-v4.1-flash', thinking: 'low' });
    //G 没配的用途是 undefined，调用方好回退到默认模型。
    bunTest.expect(runtime.getModelChoice('work')).toBeUndefined();
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getConcurrency()：没写时每个模型默认 3 个，模型和供应商都不单独限', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('{}\n');
  try {
    //M 默认 3 个是用户定的，改了就影响同时能跑几个调用。
    bunTest.expect(runtime.getConcurrency()).toEqual({ perModel: 3, models: {}, providers: {} });
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getConcurrency()：写了的配额按写的来', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('concurrency:\n  default: 5\n  models:\n    magpie/workbuddy/deepseek-v4.1-flash: 2\n  providers:\n    magpie: 4\n');
  try {
    //M 单模型、供应商合计的配额要分别读到，排队才按配置走。
    bunTest.expect(runtime.getConcurrency()).toEqual({
      perModel: 5,
      models: { 'magpie/workbuddy/deepseek-v4.1-flash': 2 },
      providers: { magpie: 4 },
    });
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getConcurrency()：配额不是正整数时报错', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('concurrency:\n  default: 0\n');
  try {
    //G 写错了要启动时就报出来，不能当成 0 个并发把执行卡死。
    bunTest.expect(() => runtime.getConcurrency()).toThrow('concurrency.default 要是正整数');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('listWorkspaces()：config.yaml 的和 AI 登记的都在，同名以 config.yaml 为准', async () => {
  /** 临时运行时目录。 */
  const dir = tempRuntimeDir();
  try {
    fs.mkdirSync(path.join(dir, 'workspaces', '同名'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspaces', '同名', '工作区.yaml'), 'description: AI 登记的同名工作区\n');
    fs.mkdirSync(path.join(dir, 'workspaces', 'AI登记'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'workspaces', 'AI登记', '工作区.yaml'), 'description: AI 起的工作区\n');
    fs.mkdirSync(path.join(dir, 'workspaces', '空目录'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'config.yaml'),
      'workspaces:\n  同名:\n    description: 配置里的同名工作区\n  项目甲:\n    description: 配置里的项目\n    dir: 项目目录\n',
    );
    /** 打开的运行时。 */
    const runtime = await resourcesModule.Resources.load(dir);
    /** 列出来的工作区，按名字索引，断言不依赖顺序。 */
    const byName = new Map<string, resourcesModule.WorkspaceInfo>();
    for (const item of await runtime.listWorkspaces()) {
      byName.set(item.name, item);
    }
    //M 分派靠工作区说明和目录挑地方干活。
    bunTest.expect(byName.size).toBe(3);
    bunTest.expect(byName.get('项目甲')?.from).toBe('config');
    bunTest.expect(byName.get('项目甲')?.description).toBe('配置里的项目');
    bunTest.expect(byName.get('项目甲')?.dir).toBe(path.resolve(dir, '项目目录'));
    //M 人在 config.yaml 里写的优先，AI 登记的同名项被忽略。
    bunTest.expect(byName.get('同名')?.from).toBe('config');
    bunTest.expect(byName.get('同名')?.description).toBe('配置里的同名工作区');
    bunTest.expect(byName.get('同名')?.dir).toBe(path.join(dir, 'workspaces', '同名', 'files'));
    //M AI 登记的工作区算 registered，没写 dir 也用默认目录。
    bunTest.expect(byName.get('AI登记')?.from).toBe('registered');
    bunTest.expect(byName.get('AI登记')?.dir).toBe(path.join(dir, 'workspaces', 'AI登记', 'files'));
    //G 只有文件夹、没有 工作区.yaml 的不算登记过。
    bunTest.expect(byName.has('空目录')).toBe(false);
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('ensureWorkspace()：没有就登记并建目录，已经有了就原样返回', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('{}\n');
  try {
    //M 分派智能体可以起新工作区，登记后下次启动还能用。
    /** 新登记的工作区。 */
    const created = await runtime.ensureWorkspace('新项目', undefined, '一句话说明');
    bunTest.expect(created.name).toBe('新项目');
    bunTest.expect(created.from).toBe('registered');
    bunTest.expect(created.description).toBe('一句话说明');
    bunTest.expect(created.dir).toBe(path.join(dir, 'workspaces', '新项目', 'files'));
    bunTest.expect(fs.existsSync(created.dir)).toBe(true);
    //M 登记文件写了，下次 listWorkspaces 才认。
    bunTest.expect(fs.existsSync(path.join(dir, 'workspaces', '新项目', '工作区.yaml'))).toBe(true);
    /** 再要一次同一个工作区。 */
    const again = await runtime.ensureWorkspace('新项目');
    bunTest.expect(again.dir).toBe(created.dir);
    //M 指定外部目录时按指定的建，目录可以在运行时目录外面。
    /** 外部目录。 */
    const externalDir = path.join(dir, '外部', '干活');
    /** 指定目录的工作区。 */
    const external = await runtime.ensureWorkspace('外部项目', externalDir, '在运行时目录外面');
    bunTest.expect(external.dir).toBe(path.resolve(externalDir));
    bunTest.expect(fs.existsSync(external.dir)).toBe(true);
    //G 名字只能是一层文件夹名，带斜杠要拒绝。
    /** 被拒绝的错误；没报错时是 undefined。 */
    let failure: unknown = undefined;
    try {
      await runtime.ensureWorkspace('a/b');
    } catch (error) {
      failure = error;
    }
    bunTest.expect(failure).toBeInstanceOf(Error);
    bunTest.expect((failure as Error).message).toContain('只能是一层文件夹名');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('defaultWorkspaceDir()：工作区的默认目录是 workspaces/<名字>/files', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('{}\n');
  try {
    //M 没写 dir 的工作区，工具都在这个目录里干活。
    bunTest.expect(runtime.defaultWorkspaceDir('测试')).toBe(path.join(dir, 'workspaces', '测试', 'files'));
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('getRole()：按名字找到角色，找不到时报出现有的名字', async () => {
  /** 临时运行时目录。 */
  const dir = tempRuntimeDir();
  try {
    fs.mkdirSync(path.join(dir, 'bots', '小助手'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bots', '小助手', 'config.yaml'), 'description: 本地助手\n');
    fs.mkdirSync(path.join(dir, 'bots', '写手'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bots', '写手', 'config.yaml'), 'description: 写文案\n');
    fs.writeFileSync(path.join(dir, 'config.yaml'), '{}\n');
    /** 打开的运行时。 */
    const runtime = await resourcesModule.Resources.load(dir);
    bunTest.expect(runtime.getRole('bot', '小助手').name).toBe('小助手');
    bunTest.expect(runtime.getRole('bot', '写手').description).toBe('写文案');
    //M load 建的默认分派智能体也能按种类找到。
    bunTest.expect(runtime.getRole('agent', '分派').kind).toBe('agent');
    //G 找不到时要报清楚现有名字，分派时不用猜有哪些角色。
    bunTest.expect(() => runtime.getRole('bot', '不存在')).toThrow('没有机器人 不存在');
    bunTest.expect(() => runtime.getRole('bot', '不存在')).toThrow('小助手');
    bunTest.expect(() => runtime.getRole('agent', '不存在')).toThrow('没有智能体 不存在');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('sessionDir()：机器人的日志放 logs/bots/<机器人>，不走的放 logs/general，标题里的非法字符被清掉', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('{}\n');
  try {
    //M 会话目录在会话建好时就定死，之后所有日志都往这里写。
    bunTest.expect(runtime.sessionDir({ id: 'S100', bot: '小助手', title: '写/测试:标题|带?号' })).toBe(
      path.join(dir, 'logs', 'bots', '小助手', 'S100_写测试标题带号'),
    );
    bunTest.expect(runtime.sessionDir({ id: 'S200', bot: null, title: '直接做' })).toBe(path.join(dir, 'logs', 'general', 'S200_直接做'));
    //G 标题里的 Windows 非法字符不滤掉，建日志目录时会失败。
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('readMemory()：有 记忆.md 就读出来，没有是空字符串', async () => {
  /** 临时运行时目录。 */
  const dir = tempRuntimeDir();
  try {
    fs.mkdirSync(path.join(dir, 'bots', '有记忆'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bots', '有记忆', 'config.yaml'), 'description: 记得住\n');
    fs.writeFileSync(path.join(dir, 'bots', '有记忆', '记忆.md'), '用户喜欢简洁。\n');
    fs.mkdirSync(path.join(dir, 'bots', '没记忆'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'bots', '没记忆', 'config.yaml'), 'description: 记不住\n');
    fs.writeFileSync(path.join(dir, 'config.yaml'), '{}\n');
    /** 打开的运行时。 */
    const runtime = await resourcesModule.Resources.load(dir);
    //M 机器人每次执行都要拼长期记忆，没有记忆文件时不能报错。
    bunTest.expect(await runtime.readMemory(runtime.getRole('bot', '有记忆'))).toBe('用户喜欢简洁。\n');
    bunTest.expect(await runtime.readMemory(runtime.getRole('bot', '没记忆'))).toBe('');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('readModelReview()：knowledge/模型评价.md 有就读，没有是空字符串', async () => {
  /** 打开的运行时。 */
  const { runtime, dir } = await openRuntime('{}\n');
  try {
    //G 还没评测过时是空字符串，分派提示词里不能拼出 undefined。
    bunTest.expect(await runtime.readModelReview()).toBe('');
    bunTest.expect(runtime.modelReviewFile).toBe(path.join(dir, 'knowledge', '模型评价.md'));
    fs.writeFileSync(runtime.modelReviewFile, '分派模型评价\n');
    bunTest.expect(await runtime.readModelReview()).toBe('分派模型评价\n');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('load()：老的中文结构目录自动改成 ASCII 名字，里面的东西跟着搬', async () => {
  /** 临时运行时目录。 */
  const dir = tempRuntimeDir();
  try {
    //M 升级前用户已经有这些目录和内容，load 要原地改名，不能丢东西。
    /** 老目录 → 新目录，以及各自要放的标记文件。 */
    const cases: { oldDir: string; newDir: string; file: string }[] = [
      { oldDir: '知识库', newDir: 'knowledge', file: '模型评价.md' },
      { oldDir: 'logs/常规', newDir: 'logs/general', file: '流水.log' },
      { oldDir: 'logs/评测', newDir: 'logs/eval', file: '评测.md' },
      { oldDir: 'integrations/feishu/发件箱', newDir: 'integrations/feishu/outbox', file: '待发.md' },
      { oldDir: 'integrations/feishu/收件箱', newDir: 'integrations/feishu/inbox', file: '来信.md' },
      { oldDir: 'integrations/claude/给Claude', newDir: 'integrations/claude/inbox', file: '留言.md' },
    ];
    for (const item of cases) {
      fs.mkdirSync(path.join(dir, item.oldDir), { recursive: true });
      fs.writeFileSync(path.join(dir, item.oldDir, item.file), `来自 ${item.oldDir}\n`);
    }
    //M 已发是发件箱的子目录，单独一条映射，父子两个都要能搬对。
    fs.mkdirSync(path.join(dir, 'integrations/feishu/发件箱/已发'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'integrations/feishu/发件箱/已发', '旧信.md'), '已发出去的信\n');

    /** 打开的运行时。 */
    const runtime = await resourcesModule.Resources.load(dir);
    for (const item of cases) {
      //M 新目录里有原文，老目录不在了——这才叫改名搬走，不是复制一份。
      bunTest.expect(fs.readFileSync(path.join(dir, item.newDir, item.file), 'utf8')).toBe(`来自 ${item.oldDir}\n`);
      bunTest.expect(fs.existsSync(path.join(dir, item.oldDir))).toBe(false);
    }
    bunTest.expect(fs.readFileSync(path.join(dir, 'integrations/feishu/sent', '旧信.md'), 'utf8')).toBe('已发出去的信\n');
    //M 改名之后模型能力评价仍能从新目录读到，升级对用户无感。
    bunTest.expect(await runtime.readModelReview()).toBe('来自 知识库\n');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('load()：新名字已经存在时不动老的，免得把两边内容搅在一起', async () => {
  /** 临时运行时目录。 */
  const dir = tempRuntimeDir();
  try {
    //G 新旧目录同时存在多半是用户手建过新目录：此时再改名会覆盖或混淆两份内容，所以老的必须原样留着。
    fs.mkdirSync(path.join(dir, '知识库'), { recursive: true });
    fs.writeFileSync(path.join(dir, '知识库', '老评价.md'), '老的内容\n');
    fs.mkdirSync(path.join(dir, 'knowledge'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'knowledge', '模型评价.md'), '新的内容\n');
    fs.mkdirSync(path.join(dir, 'logs/常规'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs/常规', '老流水.log'), '老流水\n');
    fs.mkdirSync(path.join(dir, 'logs/general'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'logs/general', '新流水.log'), '新流水\n');

    /** 打开的运行时。 */
    const runtime = await resourcesModule.Resources.load(dir);
    //M 新目录里的内容没被动过。
    bunTest.expect(await runtime.readModelReview()).toBe('新的内容\n');
    //M 老目录也还在，内容没丢；用户自己决定怎么合并。
    bunTest.expect(fs.readFileSync(path.join(dir, '知识库', '老评价.md'), 'utf8')).toBe('老的内容\n');
    bunTest.expect(fs.readFileSync(path.join(dir, 'logs/常规', '老流水.log'), 'utf8')).toBe('老流水\n');
    bunTest.expect(fs.readFileSync(path.join(dir, 'logs/general', '新流水.log'), 'utf8')).toBe('新流水\n');
  } finally {
    removeRuntime(dir);
  }
});


bunTest.test('load(..., { setup: false })：只读打开，不建目录也不写模板', async () => {
  /** 临时运行时目录。 */
  const dir = tempRuntimeDir();
  try {
    //M 有些入口只读配置（list、logs 这类），不该因为读一下就动了运行时目录。
    const runtime = await resourcesModule.Resources.load(dir, { setup: false });
    bunTest.expect(fs.readdirSync(dir)).toEqual([]);
    bunTest.expect(runtime.problems()).toHaveLength(2);
    bunTest.expect(runtime.getProviders()).toEqual({});
    bunTest.expect(runtime.getDefaultModel()).toBeUndefined();
  } finally {
    removeRuntime(dir);
  }
});
