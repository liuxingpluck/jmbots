/**
 * 记忆库与 VGR（向量 / 关系图 / 本地嵌入模型）管理接口：
 * - GET  /api/memory/vgr-config      读取 memory.yaml 配置（脱敏 api_key）及 Rust 引擎/嵌入模型实时状态
 * - PUT  /api/memory/vgr-config      校验并原子更新 memory.yaml（保留注释与原 api_key）
 * - POST /api/memory/reindex         强制重新同步知识切片并可选重抽失败关系图（POST /graph/retry）
 * - GET  /api/memory/items           列出长期记忆卡片（memory/）与独立知识切片（knowledge/，跳过知识库镜像目录）
 * - GET  /api/memory/items/detail    读取单条长期记忆全文
 * - POST /api/memory/items           新增或修改一条长期记忆
 * - DELETE /api/memory/items         删除一条长期记忆并同步清理索引
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as process from 'node:process';
import type * as cordis from 'cordis';
import * as yaml from 'yaml';
import * as botUtils from '../../utils/Bots.ts';
import * as checksModule from '../../utils/Checks.ts';
import * as failureModule from '../../utils/Failure.ts';
import * as filesModule from '../../utils/Files.ts';
import * as textModule from '../../utils/Text.ts';
import type * as storeModule from './Store.ts';


/** VGR 管理接口所需的记忆服务网关能力。 */
export interface VgrServiceGateway {
  url(): string;
  health(): Promise<Record<string, unknown>>;
  retryGraph(): Promise<{ ok: boolean; retry: number; error?: string }>;
}

/** 检索默认模式（对应 memsvc retrieval.default_mode）。 */
const RETRIEVAL_MODES = ['hybrid', 'graph'] as const;
export type VgrDefaultMode = (typeof RETRIEVAL_MODES)[number];

/** 长期记忆条目的归属类型：card（记忆卡片 memory/）或 knowledge（独立知识切片 knowledge/）。 */
const ITEM_SCOPES = ['card', 'knowledge'] as const;
export type MemoryItemScope = (typeof ITEM_SCOPES)[number];

/** 单文件预览截取字符上限。 */
const PREVIEW_MAX_CHARS = 180;
/** 管理页允许编辑的最大记忆文本字节数（512 KB）。 */
const MAX_ITEM_BYTES = 512 * 1024;


/** memory.yaml 脱敏后的配置视图。 */
export interface VgrConfigView {
  port: number;
  modelDir: string;
  modelDirResolved: string;
  modelDirExists: boolean;
  onnxruntime: string;
  onnxruntimeResolved: string;
  onnxruntimeExists: boolean;
  storeDir: string;
  storeDirResolved: string;
  storeDirExists: boolean;
  retrieval: {
    graph: boolean;
    defaultMode: VgrDefaultMode;
    rerank: boolean;
    entityTopK: number;
    relationTopK: number;
    expansionDegree: number;
    finalTopK: number;
  };
  llm: {
    baseUrl: string;
    hasApiKey: boolean;
    model: string;
    extractModel: string;
    extractConcurrency: number;
    timeoutSecs: number;
  };
}

/** 长期记忆条摘要。 */
export interface MemoryItemSummary {
  scope: MemoryItemScope;
  bot: string;
  path: string;
  title: string;
  preview: string;
  size: number;
  updatedAt: number;
}

/** 长期记忆条完整详情。 */
export interface MemoryItemDetail extends MemoryItemSummary {
  content: string;
}


/** 默认 ONNX Runtime 相对路径（与 memsvc/src/config.rs 一致）。 */
function defaultOnnxPath(): string {
  if (process.platform === 'win32') {
    return 'program/onnxruntime/lib/onnxruntime.dll';
  }
  return 'program/onnxruntime/lib/libonnxruntime.so';
}


/** 安全读取对象字段。 */
function asObj(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}


/** 读取字符串字段并去除首尾空白，缺失或类型不对回默认值。 */
function pickStr(obj: Record<string, unknown>, key: string, fallback: string): string {
  const val = obj[key];
  if (typeof val === 'string' && val.trim() !== '') {
    return val.trim();
  }
  return fallback;
}


/** 读取布尔字段，缺失回默认值。 */
function pickBool(obj: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const val = obj[key];
  if (typeof val === 'boolean') {
    return val;
  }
  return fallback;
}


/** 读取正整数字段，缺失或非法回默认值。 */
function pickInt(obj: Record<string, unknown>, key: string, fallback: number): number {
  const val = obj[key];
  if (typeof val === 'number' && Number.isInteger(val) && val > 0) {
    return val;
  }
  return fallback;
}


/**
 * 读取并解析 `<root>/memory.yaml`（不存在时用 memsvc 默认值），严禁返回明文 api_key。
 */
export function readVgrConfig(root: string): { filePath: string; fileExists: boolean; config: VgrConfigView } {
  const filePath = path.join(root, 'memory.yaml');
  const fileExists = fs.existsSync(filePath);
  let parsed: Record<string, unknown> = {};
  if (fileExists) {
    try {
      const text = fs.readFileSync(filePath, 'utf8');
      parsed = asObj(yaml.parse(text));
    } catch (error) {
      throw new failureModule.Failure(400, `memory.yaml 解析失败：${textModule.getErrorMessage(error)}`);
    }
  }

  const modelDir = pickStr(parsed, 'model_dir', 'program/models/bge-m3-int8');
  const onnxruntime = pickStr(parsed, 'onnxruntime', defaultOnnxPath());
  const storeDir = pickStr(parsed, 'store_dir', 'data/memory');
  const modelDirResolved = path.resolve(root, modelDir);
  const onnxruntimeResolved = path.resolve(root, onnxruntime);
  const storeDirResolved = path.resolve(root, storeDir);

  const retrievalRaw = asObj(parsed['retrieval']);
  let defaultMode: VgrDefaultMode = 'hybrid';
  if (retrievalRaw['default_mode'] === 'graph') {
    defaultMode = 'graph';
  }

  const llmRaw = asObj(parsed['llm']);
  const rawApiKey = typeof llmRaw['api_key'] === 'string' ? llmRaw['api_key'].trim() : '';

  return {
    filePath,
    fileExists,
    config: {
      port: pickInt(parsed, 'port', 30091),
      modelDir,
      modelDirResolved,
      modelDirExists: fs.existsSync(modelDirResolved),
      onnxruntime,
      onnxruntimeResolved,
      onnxruntimeExists: fs.existsSync(onnxruntimeResolved),
      storeDir,
      storeDirResolved,
      storeDirExists: fs.existsSync(storeDirResolved),
      retrieval: {
        graph: pickBool(retrievalRaw, 'graph', true),
        defaultMode,
        rerank: pickBool(retrievalRaw, 'rerank', true),
        entityTopK: pickInt(retrievalRaw, 'entity_top_k', 10),
        relationTopK: pickInt(retrievalRaw, 'relation_top_k', 10),
        expansionDegree: pickInt(retrievalRaw, 'expansion_degree', 2),
        finalTopK: pickInt(retrievalRaw, 'final_top_k', 20),
      },
      llm: {
        baseUrl: pickStr(llmRaw, 'base_url', ''),
        hasApiKey: rawApiKey !== '',
        model: pickStr(llmRaw, 'model', ''),
        extractModel: pickStr(llmRaw, 'extract_model', ''),
        extractConcurrency: pickInt(llmRaw, 'extract_concurrency', 2),
        timeoutSecs: pickInt(llmRaw, 'timeout_secs', 180),
      },
    },
  };
}


/** 校验一段配置路径字符串（非空、不含空字节与换行）。 */
function checkConfigPathText(raw: unknown, label: string): string {
  const val = checksModule.checkNonEmptyText(raw, label).trim();
  if (val === '' || /[\0\r\n]/u.test(val)) {
    throw new failureModule.Failure(400, `${label} 不能是空白或包含换行符`);
  }
  return val;
}


/** 校验可为空的普通配置字符串（不含换行或 NUL）。 */
function checkOptionalInlineText(raw: unknown, label: string): string {
  if (typeof raw !== 'string') {
    throw new failureModule.Failure(400, `${label} 要写成字符串`);
  }
  const val = raw.trim();
  if (/[\0\r\n]/u.test(val)) {
    throw new failureModule.Failure(400, `${label} 不能包含换行符`);
  }
  return val;
}


/**
 * 校验并原子更新 `<root>/memory.yaml`：保留原有注释和未改动的字段（尤其是 `llm.api_key`）。
 */
export function updateVgrConfig(root: string, payload: unknown): { filePath: string; fileExists: boolean; config: VgrConfigView } {
  const body = checksModule.checkRecord(payload, '请求体');
  const filePath = path.join(root, 'memory.yaml');

  let doc: yaml.Document;
  if (fs.existsSync(filePath)) {
    doc = yaml.parseDocument(fs.readFileSync(filePath, 'utf8'));
    if (doc.contents === null || !yaml.isMap(doc.contents)) {
      doc = new yaml.Document({});
    }
  } else {
    doc = new yaml.Document({});
  }

  if ('modelDir' in body) {
    doc.set('model_dir', checkConfigPathText(body['modelDir'], 'modelDir'));
  }
  if ('onnxruntime' in body) {
    doc.set('onnxruntime', checkConfigPathText(body['onnxruntime'], 'onnxruntime'));
  }
  if ('storeDir' in body) {
    doc.set('store_dir', checkConfigPathText(body['storeDir'], 'storeDir'));
  }

  if ('retrieval' in body && body['retrieval'] !== undefined) {
    const ret = checksModule.checkRecord(body['retrieval'], 'retrieval');
    if ('graph' in ret) {
      doc.setIn(['retrieval', 'graph'], checksModule.checkFlag(ret['graph'], 'retrieval.graph'));
    }
    if ('defaultMode' in ret) {
      const mode = checksModule.checkAllowedValue(ret['defaultMode'], RETRIEVAL_MODES, 'retrieval.defaultMode');
      doc.setIn(['retrieval', 'default_mode'], mode);
    }
    if ('rerank' in ret) {
      doc.setIn(['retrieval', 'rerank'], checksModule.checkFlag(ret['rerank'], 'retrieval.rerank'));
    }
    if ('entityTopK' in ret) {
      const val = checksModule.checkNumber(ret['entityTopK'], 'retrieval.entityTopK', { integer: true, min: 1, max: 100 });
      doc.setIn(['retrieval', 'entity_top_k'], val);
    }
    if ('relationTopK' in ret) {
      const val = checksModule.checkNumber(ret['relationTopK'], 'retrieval.relationTopK', { integer: true, min: 1, max: 100 });
      doc.setIn(['retrieval', 'relation_top_k'], val);
    }
    if ('expansionDegree' in ret) {
      const val = checksModule.checkNumber(ret['expansionDegree'], 'retrieval.expansionDegree', { integer: true, min: 1, max: 4 });
      doc.setIn(['retrieval', 'expansion_degree'], val);
    }
    if ('finalTopK' in ret) {
      const val = checksModule.checkNumber(ret['finalTopK'], 'retrieval.finalTopK', { integer: true, min: 1, max: 100 });
      doc.setIn(['retrieval', 'final_top_k'], val);
    }
  }

  if ('llm' in body && body['llm'] !== undefined) {
    const llm = checksModule.checkRecord(body['llm'], 'llm');
    if ('baseUrl' in llm) {
      const baseUrl = checkOptionalInlineText(llm['baseUrl'], 'llm.baseUrl').replace(/\/+$/u, '');
      if (baseUrl !== '' && !/^https?:\/\//iu.test(baseUrl)) {
        throw new failureModule.Failure(400, 'llm.baseUrl 要以 http:// 或 https:// 开头');
      }
      doc.setIn(['llm', 'base_url'], baseUrl);
    }
    if ('model' in llm) {
      doc.setIn(['llm', 'model'], checkOptionalInlineText(llm['model'], 'llm.model'));
    }
    if ('extractModel' in llm) {
      doc.setIn(['llm', 'extract_model'], checkOptionalInlineText(llm['extractModel'], 'llm.extractModel'));
    }
    if ('extractConcurrency' in llm) {
      const val = checksModule.checkNumber(llm['extractConcurrency'], 'llm.extractConcurrency', { integer: true, min: 1, max: 16 });
      doc.setIn(['llm', 'extract_concurrency'], val);
    }
    if ('timeoutSecs' in llm) {
      const val = checksModule.checkNumber(llm['timeoutSecs'], 'llm.timeoutSecs', { integer: true, min: 5, max: 600 });
      doc.setIn(['llm', 'timeout_secs'], val);
    }
    //M apiKey 仅在显式提供非空新密钥时更新，留空或不传一律保留原值，绝不抹掉已有密钥。
    if (typeof llm['apiKey'] === 'string' && llm['apiKey'].trim() !== '') {
      doc.setIn(['llm', 'api_key'], checkOptionalInlineText(llm['apiKey'], 'llm.apiKey'));
    }
  }

  filesModule.writeTextAtomic(filePath, doc.toString(), true);
  return readVgrConfig(root);
}


/**
 * 判断一个文件是否位于 `knowledge` 插件导出的 `DiskMirror` 镜像目录（同目录有带 id 的 meta.json）。
 * 镜像文件由 SQLite `kb_docs` 托管，长期记忆面板不列出也不允许误删。
 */
function isDiskMirrorFile(absFile: string): boolean {
  const metaPath = path.join(path.dirname(absFile), 'meta.json');
  if (!fs.existsSync(metaPath)) return false;

  try {
    const meta = asObj(JSON.parse(fs.readFileSync(metaPath, 'utf8')));
    return typeof meta['id'] === 'string' && meta['id'] !== '';
  } catch {
    return false;
  }
}


/** 提取 Markdown 首行标题或文件名，以及简短正文预览。 */
function summarizeMarkdown(relPath: string, content: string): { title: string; preview: string } {
  const fallbackTitle = path.basename(relPath).replace(/\.(md|txt)$/iu, '');
  let title = fallbackTitle;
  const previewLines: string[] = [];

  for (const rawLine of content.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (line === '') {
      continue;
    }

    if (title === fallbackTitle && /^#{1,3}\s+/u.test(line)) {
      title = line.replace(/^#{1,3}\s+/u, '').trim() || fallbackTitle;
      continue;
    }
    previewLines.push(line);
    if (previewLines.join(' ').length >= PREVIEW_MAX_CHARS) {
      break;
    }
  }

  const joined = previewLines.join(' ').replace(/\s+/gu, ' ').trim();
  const chars = [...joined];
  let preview = joined;
  if (chars.length > PREVIEW_MAX_CHARS) {
    preview = `${chars.slice(0, PREVIEW_MAX_CHARS).join('')}…`;
  }
  return { title, preview };
}


/** 解析 scope + bot 对应的根目录绝对路径；bot 非空时校验机器人存在。 */
function resolveScopeDir(ctx: cordis.Context, scope: MemoryItemScope, bot: string): string {
  const root = ctx.resources.root;
  if (bot !== '') {
    const found = botUtils.getBotConfig(ctx.resources.raw, bot);
    if (found === undefined) {
      throw new failureModule.Failure(400, `没有这个机器人：${bot}`);
    }
    if (scope === 'card') {
      return botUtils.getBotDir(ctx.resources, found.name, 'memory');
    }
    return path.join(root, 'bots', found.name, 'knowledge');
  }
  if (scope === 'card') {
    return path.join(root, 'memory');
  }
  return path.join(root, 'knowledge');
}


/** 校验相对路径在目标目录内，且是 .md 或 .txt 文件（禁止操作 DiskMirror 镜像目录）。 */
function resolveSafeItemFile(baseDir: string, rawPath: string): { absFile: string; relPath: string } {
  const cleaned = rawPath.trim().replace(/^[/\\]+/u, '');
  if (cleaned === '' || /[\0\r\n]/u.test(cleaned)) {
    throw new failureModule.Failure(400, '文件路径不能为空');
  }
  const absFile = path.resolve(baseDir, cleaned);
  const rel = path.relative(baseDir, absFile);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new failureModule.Failure(400, '文件路径不能越出记忆目录');
  }
  if (!/\.(md|txt)$/iu.test(absFile)) {
    throw new failureModule.Failure(400, '长期记忆文件只支持 .md 或 .txt');
  }
  if (isDiskMirrorFile(absFile)) {
    throw new failureModule.Failure(400, '该文件属于知识库文档镜像，请在「📄 文档」页编辑或删除');
  }
  return { absFile, relPath: rel.replace(/\\/gu, '/') };
}


/** 扫描单个目录下的全部长期记忆 .md / .txt 条目。 */
function scanScopeDir(scope: MemoryItemScope, bot: string, dir: string): MemoryItemSummary[] {
  if (!fs.existsSync(dir)) return [];

  const items: MemoryItemSummary[] = [];
  const names = [...new Bun.Glob('**/*.{md,txt}').scanSync({ cwd: dir, onlyFiles: true })];
  for (const name of names) {
    const absFile = path.join(dir, name);
    if (scope === 'knowledge' && isDiskMirrorFile(absFile)) {
      continue;
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(absFile);
    } catch {
      continue;
    }
    if (!stat.isFile() || stat.size > MAX_ITEM_BYTES) {
      continue;
    }

    let content: string;
    try {
      content = fs.readFileSync(absFile, 'utf8');
    } catch {
      continue;
    }
    const relPath = name.replace(/\\/gu, '/');
    const { title, preview } = summarizeMarkdown(relPath, content);
    items.push({
      scope,
      bot,
      path: relPath,
      title,
      preview,
      size: stat.size,
      updatedAt: Math.floor(stat.mtimeMs),
    });
  }
  return items;
}


/** 列出符合筛选条件的长期记忆条（按最近修改时间倒序）。 */
function listMemoryItems(ctx: cordis.Context, scopeFilter: string, botFilter: string): { bots: string[]; items: MemoryItemSummary[] } {
  const bots = botUtils.getBotConfigs(ctx.resources.raw).map((item) => item.name);
  if (botFilter !== '' && !bots.includes(botFilter)) {
    throw new failureModule.Failure(400, `没有这个机器人：${botFilter}`);
  }

  let scopes: readonly MemoryItemScope[] = ITEM_SCOPES;
  if (scopeFilter !== '' && scopeFilter !== 'all') {
    scopes = [checksModule.checkAllowedValue(scopeFilter, ITEM_SCOPES, 'scope')];
  }

  const botTargets = botFilter !== '' ? [botFilter] : ['', ...bots];
  const seenFiles = new Set<string>();
  const items: MemoryItemSummary[] = [];

  for (const scope of scopes) {
    for (const bot of botTargets) {
      const dir = resolveScopeDir(ctx, scope, bot);
      for (const item of scanScopeDir(scope, bot, dir)) {
        const dedupKey = `${scope}:${path.resolve(dir, item.path)}`;
        if (seenFiles.has(dedupKey)) {
          continue;
        }

        seenFiles.add(dedupKey);
        items.push(item);
      }
    }
  }

  items.sort((a, b) => b.updatedAt - a.updatedAt || a.path.localeCompare(b.path, 'zh-Hans-CN'));
  return { bots, items };
}


/**
 * 在 http.app 上挂载 VGR 配置、重建索引与长期记忆条目管理接口。
 */
export function mountVgrAdminRoutes(
  ctx: cordis.Context,
  store: storeModule.Store,
  service: VgrServiceGateway,
): void {
  const app = ctx.http.app;
  const root = ctx.resources.root;

  //M 1. 读取 memory.yaml（脱敏）及 Rust / SQLite 索引实时状态。
  app.get('/api/memory/vgr-config', async () => {
    const info = readVgrConfig(root);
    const [health, backend] = await Promise.all([
      service.health(),
      store.health(),
    ]);
    return {
      ok: true,
      serviceUrl: service.url(),
      ...info,
      health,
      backend,
    };
  });

  //M 2. 更新 memory.yaml 配置（要求已核验身份，保留注释与既有 api_key）。
  app.put('/api/memory/vgr-config', async (request) => {
    ctx.http.requireVerified(request, '记忆与 VGR 配置修改');
    const info = updateVgrConfig(root, request.body);
    const [health, backend] = await Promise.all([
      service.health(),
      store.health(),
    ]);
    return {
      ok: true,
      restartHint: '配置已保存到 memory.yaml；本地嵌入模型与默认检索项在重启 jmbots-memory 服务后生效。',
      serviceUrl: service.url(),
      ...info,
      health,
      backend,
    };
  });

  //M 3. 强制刷新知识库向量切片索引，可选重抽失败关系图。
  app.post('/api/memory/reindex', async (request) => {
    ctx.http.requireVerified(request, '刷新与重建记忆索引');
    const body = asObj(request.body);
    const wantRetryGraph = body['retryGraph'] === true;

    let syncError: string | undefined;
    try {
      await store.syncKnowledge(true);
    } catch (error) {
      syncError = textModule.getErrorMessage(error);
    }

    let graphRetry: { ok: boolean; retry: number; error?: string } | undefined;
    if (wantRetryGraph) {
      graphRetry = await service.retryGraph();
    }

    const [health, backend] = await Promise.all([
      service.health(),
      store.health(),
    ]);
    return {
      ok: syncError === undefined && (graphRetry === undefined || graphRetry.ok),
      syncError,
      graphRetry,
      health,
      backend,
    };
  });

  //M 4. 列出长期记忆卡片与独立知识切片。
  app.get('/api/memory/items', (request) => {
    const query = asObj(request.query);
    const scope = typeof query['scope'] === 'string' ? query['scope'].trim() : 'all';
    const bot = typeof query['bot'] === 'string' ? query['bot'].trim() : '';
    const result = listMemoryItems(ctx, scope, bot);
    return { ok: true, ...result };
  });

  //M 5. 读取单条长期记忆全文。
  app.get('/api/memory/items/detail', (request) => {
    const query = asObj(request.query);
    const scope = checksModule.checkAllowedValue(query['scope'], ITEM_SCOPES, 'scope');
    const bot = typeof query['bot'] === 'string' ? query['bot'].trim() : '';
    const rawPath = checksModule.checkNonEmptyText(query['path'], 'path');
    const baseDir = resolveScopeDir(ctx, scope, bot);
    const { absFile, relPath } = resolveSafeItemFile(baseDir, rawPath);
    if (!fs.existsSync(absFile)) {
      throw new failureModule.Failure(404, `记忆条目不存在：${relPath}`);
    }
    const stat = fs.statSync(absFile);
    if (!stat.isFile() || stat.size > MAX_ITEM_BYTES) {
      throw new failureModule.Failure(400, '文件不可读或超过 512KB 限制');
    }
    const content = fs.readFileSync(absFile, 'utf8');
    const { title, preview } = summarizeMarkdown(relPath, content);
    const item: MemoryItemDetail = {
      scope,
      bot,
      path: relPath,
      title,
      preview,
      content,
      size: stat.size,
      updatedAt: Math.floor(stat.mtimeMs),
    };
    return { ok: true, item };
  });

  //M 6. 新增或保存长期记忆条（knowledge 同步入向量库，服务离线时保留磁盘文件并返回温和提示）。
  app.post('/api/memory/items', async (request) => {
    ctx.http.requireVerified(request, '写入长期记忆条');
    const body = checksModule.checkRecord(request.body, '请求体');
    const scope = checksModule.checkAllowedValue(body['scope'], ITEM_SCOPES, 'scope');
    const bot = typeof body['bot'] === 'string' ? body['bot'].trim() : '';
    const rawPath = checksModule.checkNonEmptyText(body['path'], 'path');
    if (typeof body['content'] !== 'string') {
      throw new failureModule.Failure(400, 'content 要写成字符串');
    }
    const content = body['content'];
    if (Buffer.byteLength(content, 'utf8') > MAX_ITEM_BYTES) {
      throw new failureModule.Failure(400, '长期记忆条内容不能超过 512KB');
    }

    const baseDir = resolveScopeDir(ctx, scope, bot);
    const { absFile, relPath } = resolveSafeItemFile(baseDir, rawPath);

    let indexWarning: string | undefined;
    if (scope === 'knowledge') {
      try {
        await store.writeKnowledge(bot, relPath, content);
      } catch (error) {
        //M store.writeKnowledge 先落盘后建索引；若 Rust 记忆服务暂未在线，文件已写好，返回温和提示供后续重建。
        if (!fs.existsSync(absFile)) {
          throw new failureModule.Failure(400, textModule.getErrorMessage(error));
        }
        indexWarning = textModule.getErrorMessage(error);
      }
    } else {
      filesModule.writeTextAtomic(absFile, content, true);
    }

    const stat = fs.statSync(absFile);
    const { title, preview } = summarizeMarkdown(relPath, content);
    const item: MemoryItemDetail = {
      scope,
      bot,
      path: relPath,
      title,
      preview,
      content,
      size: stat.size,
      updatedAt: Math.floor(stat.mtimeMs),
    };
    return { ok: true, item, indexed: indexWarning === undefined, indexWarning };
  });

  //M 7. 删除一条长期记忆条（knowledge 删除后触发增量清理）。
  app.delete('/api/memory/items', async (request) => {
    ctx.http.requireVerified(request, '删除长期记忆条');
    const source = { ...asObj(request.query), ...asObj(request.body) };
    const scope = checksModule.checkAllowedValue(source['scope'], ITEM_SCOPES, 'scope');
    const bot = typeof source['bot'] === 'string' ? source['bot'].trim() : '';
    const rawPath = checksModule.checkNonEmptyText(source['path'], 'path');
    const baseDir = resolveScopeDir(ctx, scope, bot);
    const { absFile, relPath } = resolveSafeItemFile(baseDir, rawPath);
    if (!fs.existsSync(absFile)) {
      throw new failureModule.Failure(404, `记忆条目不存在：${relPath}`);
    }
    fs.rmSync(absFile, { force: true });

    let syncWarning: string | undefined;
    if (scope === 'knowledge') {
      try {
        await store.syncKnowledge(true);
      } catch (error) {
        syncWarning = textModule.getErrorMessage(error);
      }
    }
    return { ok: true, deleted: relPath, syncWarning };
  });
}
