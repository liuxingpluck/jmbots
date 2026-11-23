/**
 * 积木AI工作台（v1.4.4）自定义动态筛选视图、统一规则匹配引擎、去滴答品牌化与 Markdown vscode://file/ 直跳单测。
 * 跑法：bun test src7/plugins/work-decision/FilterViews.test.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as sqlite from 'bun:sqlite';
import * as bunTest from 'bun:test';
import * as cordis from 'cordis';
import * as fastify from 'fastify';
import * as react from 'react';
import * as reactDomServer from 'react-dom/server';
import * as workbenchFilter from '../../../web/src/DecisionMap/WorkbenchFilter.ts';
import type { ToolSpec } from '../../Tools.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as textModule from '../../utils/Text.ts';
import * as dbModule from '../db/index.ts';
import * as filterViewsModule from './FilterViews.ts';
import * as plugin from './index.ts';
import type * as types from './Types.ts';


const { afterEach, describe, expect, test } = bunTest;
const PREFIX = '/api/work-decision';
const WEB_ROOT_DIR = path.resolve(import.meta.dirname, '../../../web');
const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  for (const fn of cleanups.splice(0).reverse()) {
    await fn();
  }
});

async function createHarness(existingRoot?: string) {
  const root = existingRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), 'jm-filter-views-'));
  if (existingRoot === undefined) {
    cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  }
  const ctx = new cordis.Context();
  const app = fastify.default({ logger: false });
  app.setErrorHandler((error, _req, reply) => {
    let status = 500;
    if (error instanceof failureModule.Failure) {
      status = error.status;
    }
    return reply.code(status).send({ error: textModule.getErrorMessage(error) });
  });
  const db = new sqlite.Database(':memory:');
  const tools = new Map<string, ToolSpec>();
  cleanups.push(() => db.close());
  cleanups.push(async () => {
    await app.close();
  });
  cleanups.push(async () => {
    await ctx.fiber.dispose();
  });

  ctx.provide('http', { app });
  ctx.provide('resources', { db, root, raw: {} });
  ctx.provide('tools', { register: (tool: ToolSpec) => tools.set(tool.definition.name, tool) });
  ctx.provide('db', new dbModule.Db(new cordis.Context(), db));
  await ctx.plugin(plugin, {});
  await app.ready();
  return { root, app, ctx };
}

function buildSampleTask(overrides: Partial<types.ControlTask> & { id: string; title: string }): types.ControlTask {
  return {
    summary: '',
    status: 'ready',
    priority: 'P1',
    lockTags: [],
    owner: '',
    doneCriteria: '',
    lastHeartbeatAt: null,
    events: [],
    createdAt: 1760000000000,
    updatedAt: 1760000000000,
    ...overrides,
  };
}


describe('自定义动态筛选视图（/api/work-decision/views*）与统一筛选引擎', () => {
  test('动态视图 CRUD、排序、重启恢复与老无 views JSON 向后兼容', async () => {
    const legacyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jm-legacy-noviews-'));
    cleanups.push(() => fs.rmSync(legacyRoot, { recursive: true, force: true }));

    const legacyTask = buildSampleTask({
      id: 'legacy-node-1',
      title: '存量商业沟通节点',
      list: '商业沟通',
      tags: ['报价', 'AOBB'],
      priority: 'P0',
      status: 'pending_decision',
    });
    const diskPath = path.join(legacyRoot, 'control-plane-tasks.json');
    fs.writeFileSync(
      diskPath,
      `${JSON.stringify({ version: 1, revision: 5, tasks: [legacyTask] }, null, 2)}\n`,
      'utf8',
    );

    //M 1. 老版本无 views 字段 JSON 启动后，GET /tasks 默认返回 views: [] 且原任务毫发无损。
    const h = await createHarness(legacyRoot);
    const initSnap = (await h.app.inject({ method: 'GET', url: `${PREFIX}/tasks` }))
      .json<types.ControlPlaneSnapshot>();
    expect(initSnap.revision).toBe(5);
    expect(initSnap.views).toEqual([]);
    expect(initSnap.tasks).toHaveLength(1);
    expect(initSnap.tasks[0]?.title).toBe('存量商业沟通节点');

    //M 2. POST /views 创建自定义动态筛选视图（含多标签 AND、状态、优先级、来源渠道与去重清洗）。
    const createRes1 = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/views`,
      payload: {
        id: 'view-p0-feishu',
        name: '  飞书急件待拍板  ',
        icon: '🔥',
        color: '#ef4444',
        sortOrder: 10,
        rule: {
          tags: [' AOBB ', '报价', 'AOBB', ''],
          tagMode: 'and',
          statuses: ['pending_decision', 'running', 'pending_decision'],
          priorities: ['P0'],
          dueScope: 'today',
          sourceChannels: ['feishu', 'workbench'],
        },
      },
    });
    expect(createRes1.statusCode).toBe(200);
    const body1 = createRes1.json<{
      ok: true;
      revision: number;
      view: types.TaskFilterViewDef;
      views: types.TaskFilterViewDef[];
    }>();
    expect(body1.revision).toBe(6);
    expect(body1.view).toEqual({
      id: 'view-p0-feishu',
      name: '飞书急件待拍板',
      icon: '🔥',
      color: '#ef4444',
      sortOrder: 10,
      rule: {
        tags: ['AOBB', '报价'],
        tagMode: 'and',
        statuses: ['pending_decision', 'running'],
        priorities: ['P0'],
        dueScope: 'today',
        sourceChannels: ['feishu', 'workbench'],
      },
    });

    //M 3. 再建第 2 个 sortOrder 更小的视图，验证按 sortOrder 升序排列。
    const createRes2 = await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/views`,
      payload: {
        name: '多标签或模式视图',
        icon: '🔖',
        sortOrder: 1,
        rule: {
          tags: ['微信', '客服'],
          tagMode: 'or',
          keyword: '  授权  ',
          includeDone: true,
        },
      },
    });
    expect(createRes2.statusCode).toBe(200);
    const view2Id = createRes2.json<{ view: types.TaskFilterViewDef }>().view.id;
    expect(view2Id.startsWith('view-')).toBe(true);

    //M 4. PATCH /views/:id 更新名称、清空颜色并修改规则。
    const patchRes = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/views/view-p0-feishu`,
      payload: {
        name: 'P0 核心拍板池',
        color: null,
        sortOrder: 0,
        rule: {
          tags: ['AOBB'],
          priorities: ['P0', 'P1'],
          quadrants: ['q1', 'q2'],
          hasSource: false,
        },
      },
    });
    expect(patchRes.statusCode).toBe(200);
    const patchedBody = patchRes.json<{
      view: types.TaskFilterViewDef;
      views: types.TaskFilterViewDef[];
    }>();
    expect(patchedBody.view.name).toBe('P0 核心拍板池');
    expect(patchedBody.view.color).toBeUndefined();
    expect(patchedBody.view.rule.quadrants).toEqual(['q1', 'q2']);
    expect(patchedBody.views.map((v) => v.id)).toEqual(['view-p0-feishu', view2Id]);

    //M 5. 用同一目录重启新实例，验证 views 跨重启完整恢复。
    const h2 = await createHarness(legacyRoot);
    const reloaded = (await h2.app.inject({ method: 'GET', url: `${PREFIX}/tasks` }))
      .json<types.ControlPlaneSnapshot>();
    expect(reloaded.views).toHaveLength(2);
    expect(reloaded.views?.[0]?.name).toBe('P0 核心拍板池');
    expect(reloaded.views?.[1]?.id).toBe(view2Id);
    expect(reloaded.tasks).toHaveLength(1);

    //M 6. DELETE /views/:id 删除自定义视图并持久化，底层任务不受影响；重复删除返回 404。
    const delRes = await h2.app.inject({
      method: 'DELETE',
      url: `${PREFIX}/views/${view2Id}`,
    });
    expect(delRes.statusCode).toBe(200);
    expect(delRes.json<{ views: types.TaskFilterViewDef[] }>().views).toHaveLength(1);

    const delAgain = await h2.app.inject({
      method: 'DELETE',
      url: `${PREFIX}/views/${view2Id}`,
    });
    expect(delAgain.statusCode).toBe(404);

    const patchMissing = await h2.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/views/not-exist`,
      payload: { name: '不存在' },
    });
    expect(patchMissing.statusCode).toBe(404);
  });

  test('非法动态视图与非法规则参数在入口全部返回 400 且不写盘', async () => {
    const h = await createHarness();
    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/views`,
      payload: {
        id: 'existing-view',
        name: '已有视图',
        rule: { tags: ['base'] },
      },
    });
    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/views`,
      payload: {
        id: 'second-view',
        name: '第二个视图',
        rule: { priorities: ['P1'] },
      },
    });

    const beforeSnap = (await h.app.inject({ method: 'GET', url: `${PREFIX}/tasks` }))
      .json<types.ControlPlaneSnapshot>();

    const badCreateBodies: unknown[] = [
      null,
      'not-object',
      { name: '', rule: {} },
      { name: '   ', rule: {} },
      { id: '../bad', name: '非法ID', rule: {} },
      { id: 'existing-view', name: '撞ID', rule: {} },
      { name: '已有视图', rule: {} },
      { name: '缺规则' },
      { name: '空规则为null', rule: null },
      { name: '数组规则', rule: [] },
      { name: '未知规则键', rule: { unknownKey: true } },
      { name: '坏tagMode', rule: { tagMode: 'xor' } },
      { name: '坏tags类型', rule: { tags: [123] } },
      { name: '坏statuses', rule: { statuses: ['not_a_status'] } },
      { name: '坏priorities', rule: { priorities: ['P9'] } },
      { name: '坏quadrants', rule: { quadrants: ['q5'] } },
      { name: '坏dueScope', rule: { dueScope: 'tomorrow' } },
      { name: '坏hasSource', rule: { hasSource: 'yes' } },
      { name: '坏includeDone', rule: { includeDone: 1 } },
      { name: '坏sourceChannels', rule: { sourceChannels: [false] } },
      { name: '坏sortOrder', rule: { tags: ['ok'] }, sortOrder: 'first' },
    ];

    for (const payload of badCreateBodies) {
      const res = await h.app.inject({
        method: 'POST',
        url: `${PREFIX}/views`,
        headers: { 'content-type': 'application/json' },
        payload: JSON.stringify(payload),
      });
      expect(res.statusCode).toBe(400);
    }

    const badPatchBodies: Array<Record<string, unknown>> = [
      { name: '   ' },
      { name: '已有视图' },
      { rule: null },
      { rule: { dueScope: 'bad' } },
      { rule: { extra: 1 } },
    ];
    for (const payload of badPatchBodies) {
      const res = await h.app.inject({
        method: 'PATCH',
        url: `${PREFIX}/views/second-view`,
        payload,
      });
      expect(res.statusCode).toBe(400);
    }

    const afterSnap = (await h.app.inject({ method: 'GET', url: `${PREFIX}/tasks` }))
      .json<types.ControlPlaneSnapshot>();
    expect(afterSnap.revision).toBe(beforeSnap.revision);
    expect(afterSnap.views).toEqual(beforeSnap.views);
  });

  test('前后端动态筛选引擎 100% 同构：多标签 AND/OR、状态、优先级、日期、来源渠道与组合合并', () => {
    const backendHelper = new filterViewsModule.FilterViewHelper();
    const today = '2026-11-23';

    const fixtures: types.ControlTask[] = [
      buildSampleTask({
        id: 'n-feishu-p0',
        title: '飞书客户合同审批',
        summary: '需要法务确认付款条款',
        status: 'pending_decision',
        priority: 'P0',
        list: '商业沟通',
        dueDate: '2026-11-23',
        tags: ['飞书', '合同', '紧急'],
        sourceRef: { channel: 'feishu', relayId: 10 },
      }),
      buildSampleTask({
        id: 'n-wechat-next7',
        title: '微信客服报价单整理',
        summary: '跟进代理商续费',
        status: 'running',
        priority: 'P1',
        list: '商业沟通',
        dueDate: '2026-11-27',
        tags: ['微信', '报价'],
        owner: 'HanXin',
        sourceRef: { channel: 'wechat-kefu', messageId: 'wx-1' },
      }),
      buildSampleTask({
        id: 'n-wb-overdue',
        title: '工作台重构遗留检查',
        status: 'ready',
        priority: 'P2',
        quadrant: 'q4',
        list: '工作任务',
        dueDate: '2026-11-20',
        tags: ['AOBB', '紧急'],
      }),
      buildSampleTask({
        id: 'n-inbox-nodate',
        title: '灵感速记：标签组合器',
        status: 'blocked',
        priority: 'P1',
        list: '收集箱',
        dueDate: null,
        tags: ['架构'],
      }),
      buildSampleTask({
        id: 'n-done',
        title: '已归档历史节点',
        status: 'done',
        priority: 'P0',
        list: '工作任务',
        dueDate: '2026-11-23',
        tags: ['紧急', '合同'],
      }),
      buildSampleTask({
        id: 'n-trashed',
        title: '垃圾桶节点',
        status: 'pending_decision',
        priority: 'P0',
        trashedAt: 1760000099000,
        tags: ['紧急'],
      }),
      buildSampleTask({
        id: 'n-habit',
        title: '每日复盘',
        kind: 'habit',
        status: 'ready',
        tags: ['紧急'],
      }),
    ];

    const assertEngineMatch = (rule: types.TaskFilterRule, expectedIds: string[]): void => {
      const frontIds = fixtures
        .filter((item) => workbenchFilter.matchesTaskFilterRule(item, rule, today))
        .map((item) => item.id);
      const backIds = fixtures
        .filter((item) => backendHelper.matchesRule(item, rule, today))
        .map((item) => item.id);
      expect(frontIds).toEqual(expectedIds);
      expect(backIds).toEqual(expectedIds);
    };

    //M 1. 空规则：匹配全部未完成、未入垃圾桶的普通任务节点（跳过 done、trashed、habit）。
    assertEngineMatch({}, ['n-feishu-p0', 'n-wechat-next7', 'n-wb-overdue', 'n-inbox-nodate']);

    //M 2. 多标签 AND vs OR。
    assertEngineMatch({ tags: ['紧急', '合同'], tagMode: 'and' }, ['n-feishu-p0']);
    assertEngineMatch({ tags: ['合同', '报价'], tagMode: 'or' }, [
      'n-feishu-p0',
      'n-wechat-next7',
    ]);

    //M 3. 日期范围：今天 / 最近7天 / 已过期 / 无日期。
    assertEngineMatch({ dueScope: 'today' }, ['n-feishu-p0']);
    assertEngineMatch({ dueScope: 'next7' }, ['n-feishu-p0', 'n-wechat-next7']);
    assertEngineMatch({ dueScope: 'overdue' }, ['n-wb-overdue']);
    assertEngineMatch({ dueScope: 'nodate' }, ['n-inbox-nodate']);

    //M 4. 来源渠道归一：feishu / wechat（含 wechat-kefu） / workbench（无 sourceRef 节点）。
    assertEngineMatch({ sourceChannels: ['feishu'] }, ['n-feishu-p0']);
    assertEngineMatch({ sourceChannels: ['wechat'] }, ['n-wechat-next7']);
    assertEngineMatch({ sourceChannels: ['workbench'] }, ['n-wb-overdue', 'n-inbox-nodate']);

    //M 5. 显式筛 done 状态或开启 includeDone。
    assertEngineMatch({ statuses: ['done'] }, ['n-done']);
    assertEngineMatch({ tags: ['紧急', '合同'], includeDone: true }, ['n-feishu-p0', 'n-done']);

    //M 6. 关键词与合并规则（左侧分组 + 顶部筛选条 -> 存为视图规则）。
    assertEngineMatch({ keyword: '法务' }, ['n-feishu-p0']);
    const merged = workbenchFilter.mergeFilterRules(
      { lists: ['商业沟通'] },
      { priorities: ['P0'], tags: ['紧急'] },
    );
    expect(merged).toEqual({
      lists: ['商业沟通'],
      priorities: ['P0'],
      tags: ['紧急'],
    });
    assertEngineMatch(merged, ['n-feishu-p0']);
  });
});


describe('Markdown vscode://file/ 安全白名单直跳与全站去滴答品牌守卫', () => {
  test('vscode://file/ 与 vscode-insiders://file/ 原样放行且不加 target="_blank"，危险协议照旧拦截', async () => {
    void bunTest.mock.module('@ant-design/icons', () => ({
      CopyOutlined: () => null,
      CheckOutlined: () => null,
    }));
    const mdEntry = path.join(WEB_ROOT_DIR, 'src/Chat/Markdown.tsx');
    const markdownModule = (await import(mdEntry)) as {
      Markdown: (props: {
        text: string;
        onOpen: (target: { path: string; name: string }) => void;
      }) => react.JSX.Element;
    };
    const mdText = [
      '[跳源码](vscode://file/workspace/jmbots/src7/Main.ts:42:5)',
      '[跳Insiders](vscode-insiders://file/workspace/jmbots/web/Build.ts:1)',
      '[危险设置](vscode://settings/editor.fontSize)',
      '[危险脚本](javascript:alert(1))',
      '[外链网页](https://example.com/docs)',
    ].join('\n\n');

    const html = reactDomServer.renderToStaticMarkup(
      react.createElement(markdownModule.Markdown, {
        text: mdText,
        onOpen: () => undefined,
      }),
    );

    //M 1. vscode://file/ 与 vscode-insiders://file/ 保留完整 href，且不含 target="_blank" / rel="noreferrer"
    expect(html).toContain(
      '<a href="vscode://file/workspace/jmbots/src7/Main.ts:42:5">跳源码</a>',
    );
    expect(html).toContain(
      '<a href="vscode-insiders://file/workspace/jmbots/web/Build.ts:1">跳Insiders</a>',
    );

    //G 2. 非 file 路径的 vscode://settings 与 javascript: 协议必须被清洗拦截
    expect(html).not.toContain('vscode://settings');
    expect(html).not.toContain('javascript:alert');

    //M 3. 普通 https 外链继续保留 target="_blank" 与 rel="noreferrer"
    expect(html).toContain(
      '<a href="https://example.com/docs" target="_blank" rel="noreferrer">外链网页</a>',
    );
  });

  test('DecisionMap 与 work-decision.html 彻底去滴答化且同时兼容 ?tab=tick 与 ?tab=workbench', () => {
    const htmlRaw = fs.readFileSync(path.join(WEB_ROOT_DIR, 'work-decision.html'), 'utf8');
    expect(htmlRaw).toContain('<title>积木AI工作台 · jmbots</title>');
    expect(htmlRaw).not.toContain('滴答');

    const pageRaw = fs.readFileSync(
      path.join(WEB_ROOT_DIR, 'src/DecisionMap/DecisionMapPage.tsx'),
      'utf8',
    );
    expect(pageRaw).toContain("tab === 'workbench'");
    expect(pageRaw).toContain("tab === 'tick'");

    const dir = path.join(WEB_ROOT_DIR, 'src/DecisionMap');
    for (const file of fs.readdirSync(dir)) {
      if (!/\.(ts|tsx)$/u.test(file)) {
        continue;
      }
      const raw = fs.readFileSync(path.join(dir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//gu, '')
        .replace(/(^|[^:])\/\/.*$/gmu, '$1');
      expect(raw.includes('滴答')).toBe(false);
    }
  });

  test('PATCH/PUT /lists/:id 支持重名 409 防冲突、存量虚拟分组转正及原子级联更新 tasks 与 views.rule.lists', async () => {
    const h = await createHarness();

    //M 1. 新建自定义分组 biz 与一条仅存在于任务 list 字段的存量虚拟分组「商业沟通」
    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/lists`,
      payload: { id: 'list-client', name: '客户线索', icon: '🤝', color: '#3b82f6' },
    });
    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { id: 'task-c1', title: '跟进甲方首付款', list: '客户线索' },
    });
    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/tasks`,
      payload: { id: 'task-v1', title: '报价方案敲定', list: '商业沟通' },
    });
    await h.app.inject({
      method: 'POST',
      url: `${PREFIX}/views`,
      payload: {
        id: 'view-combo',
        name: '商务重点视图',
        rule: { lists: ['客户线索', '商业沟通', '工作任务'], priorities: ['P0', 'P1'] },
      },
    });

    //G 2. 改名撞上已有分组「工作任务」必须回 409 且不脏写
    const conflictRes = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/lists/list-client`,
      payload: { name: '工作任务' },
    });
    expect(conflictRes.statusCode).toBe(409);

    //M 3. 合法改名「客户线索 -> 核心客户」并更新图标/颜色：task.list 与 views[].rule.lists 原子级联同步
    const patchRes = await h.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/lists/list-client`,
      payload: { name: '核心客户', icon: '💎', color: '#f59e0b' },
    });
    expect(patchRes.statusCode).toBe(200);
    const patchedBody = patchRes.json<{
      ok: true;
      list: types.TaskListDef;
      lists: types.TaskListDef[];
      views: types.TaskFilterViewDef[];
    }>();
    expect(patchedBody.list.name).toBe('核心客户');
    expect(patchedBody.list.icon).toBe('💎');
    expect(patchedBody.list.color).toBe('#f59e0b');
    expect(patchedBody.views[0]?.rule.lists).toEqual(['核心客户', '商业沟通', '工作任务']);

    //M 4. 编辑虚拟分组 virtual-商业沟通（PUT 同样兼容）：自动转正落盘并同步级联任务与视图规则
    const virtualPatch = await h.app.inject({
      method: 'PUT',
      url: `${PREFIX}/lists/${encodeURIComponent('virtual-商业沟通')}`,
      payload: { name: '商务谈判', icon: '💼', color: '#10b981' },
    });
    expect(virtualPatch.statusCode).toBe(200);
    const vBody = virtualPatch.json<{
      list: types.TaskListDef;
      lists: types.TaskListDef[];
      views: types.TaskFilterViewDef[];
    }>();
    expect(vBody.list.id.startsWith('list-')).toBe(true);
    expect(vBody.list.name).toBe('商务谈判');
    expect(vBody.views[0]?.rule.lists).toEqual(['核心客户', '商务谈判', '工作任务']);

    //M 5. 重启实例验证 tasks、lists、views 三者持久化一致且零孤儿任务
    const h2 = await createHarness(h.root);
    const snap = (await h2.app.inject({ method: 'GET', url: `${PREFIX}/tasks` }))
      .json<types.ControlPlaneSnapshot>();
    expect(snap.tasks.find((t) => t.id === 'task-c1')?.list).toBe('核心客户');
    expect(snap.tasks.find((t) => t.id === 'task-v1')?.list).toBe('商务谈判');
    expect(snap.lists.some((l) => l.name === '核心客户' && l.icon === '💎')).toBe(true);
    expect(snap.lists.some((l) => l.name === '商务谈判' && l.icon === '💼')).toBe(true);
    expect(snap.views?.[0]?.rule.lists).toEqual(['核心客户', '商务谈判', '工作任务']);

    //G 6. 不存在的分组 ID 返回 404
    const notFound = await h2.app.inject({
      method: 'PATCH',
      url: `${PREFIX}/lists/not-found-id`,
      payload: { name: '新名' },
    });
    expect(notFound.statusCode).toBe(404);
  });
});
