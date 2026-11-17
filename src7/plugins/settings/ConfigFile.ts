/**
 * config.yaml 的读、遮密钥、改、写回。设置页的接口都走这里。
 *   读：去掉开头的 BOM，yaml 的“文档”方式解析（Document：留着注释和顺序，改完写回时它们都还在）。
 *   遮：只给白名单里的顶层段；键名是密钥的字符串换成代号 ‹已设置:8位›，代号 → 原文只记在内存里。
 *   改：网页发来一串 { path, value } / { path, delete }，代号换回原文，setIn / deleteIn，整份过一遍骨架的校验，先写 .tmp 再改名。
 * 整个读改写都用同步的 fs：一个请求从读到改名中间不让出，两个请求不会互相覆盖。
 * 决策模型：网页设置页写的是 0.4 的 models.decision.model，src7 的 decision 插件读 decision.models（总管 11-14 定）：
 *   读的时候把 decision.models 的第一个放进 models.decision.model 给网页看；改的时候把它换成改 decision.models 的第一个。
 */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as yaml from 'yaml';
import * as checks from '../../utils/Checks.ts';


/** 带状态码的错误：接口照它的状态码回 { error }。 */
export class Failure extends Error {
  /**
   * @param status HTTP 状态码。
   * @param message 回给网页的一句话。
   */
  constructor(readonly status: number, message: string) {
    super(message);
  }
}


/** 网页发来的一步改动：path 是键和序号的列表。 */
export type Edit = { path: (string | number)[]; value?: unknown; delete?: boolean };


/** 网页能看能改的顶层段（照网页设置页 web/src/Settings/Settings.tsx:23-34 读写的段，加上 src7 的 decision）。 */
const SECTIONS = new Set(['providers', 'default_model', 'models', 'bots', 'channels', 'search', 'engine', 'concurrency',
  'server', 'http', 'local', 'ui', 'decision']);

/** 键名是这些的字符串值算密钥。 */
const SECRET_KEYS = new Set(['api_key', 'app_secret', 'token', 'secret', 'password']);

/** 代号的样子。 */
const CODE = /^‹已设置:([0-9a-f]{8})›$/u;


/** config.yaml 这个文件。 */
export class ConfigFile {
  /** 代号 → 密钥原文，只在内存里；同一个原文一直用同一个代号。 */
  private readonly codes = new Map<string, string>();

  /** 原文件开头有没有 BOM，写回时照样加。 */
  private bom = false;

  /** @param file 运行时目录下 config.yaml 的绝对路径。 */
  constructor(private readonly file: string) {}

  /**
   * 读文件，解析成 yaml 文档。
   * @throws Failure(409)：不是合法 YAML，只说第几行（错误里不带原文，原文可能是密钥）。
   */
  read(): yaml.Document {
    const text = fs.readFileSync(this.file, 'utf8');
    this.bom = text.startsWith('\uFEFF');
    const document = yaml.parseDocument(this.bom ? text.slice(1) : text);
    const broken = document.errors[0];
    if (broken !== undefined) {
      throw new Failure(409, `config.yaml 不是合法的 YAML（第 ${String(broken.linePos?.[0].line ?? '?')} 行附近）：先在文件里改好`);
    }
    return document;
  }

  /** @returns 白名单里的段，密钥换成代号；decision.models 的第一个放进 models.decision.model。 */
  masked(): Record<string, unknown> {
    const all = (this.read().toJSON() ?? {}) as Record<string, unknown>;
    const kept = Object.fromEntries(Object.entries(all).filter(([key]) => SECTIONS.has(key)));
    const first = firstDecisionModel(kept['decision']);
    if (first !== undefined) {
      const models = (typeof kept['models'] === 'object' && kept['models'] !== null ? kept['models'] : {}) as Record<string, unknown>;
      kept['models'] = { ...models, decision: { model: first } };
    }
    return this.mask(kept, '') as Record<string, unknown>;
  }

  /**
   * 照顺序改，校验，写回。
   * @param edits 网页发来的改动（外面进来的，这里校验一次）。
   * @returns 改了哪些顶层段（去重）。
   * @throws Failure(400)：步子不对、路径不在白名单、代号认不出、改完通不过骨架校验；Failure(409)：原文件就坏了。
   */
  edit(edits: unknown): string[] {
    if (!Array.isArray(edits) || edits.length === 0) throw new Failure(400, '要发一串改动：[{ path, value } 或 { path, delete: true }]');

    const document = this.read();
    const touched = new Set<string>();
    for (const [index, raw] of edits.entries()) {
      const step = (raw ?? {}) as Edit;
      const okPath = Array.isArray(step.path) && step.path.length > 0
        && step.path.every((part) => typeof part === 'string' || (typeof part === 'number' && Number.isInteger(part) && part >= 0));
      if (!okPath) throw new Failure(400, `第 ${String(index + 1)} 步的 path 要是非空的键、序号列表`);

      const top = String(step.path[0]);
      if (!SECTIONS.has(top)) throw new Failure(400, `第 ${String(index + 1)} 步改的 ${top} 不在设置页能改的范围里`);

      if (step.delete !== true && !('value' in step)) throw new Failure(400, `第 ${String(index + 1)} 步要有 value 或 delete: true`);

      touched.add(this.apply(document, step));
    }

    //M 改完整份过一遍骨架的校验（和启动时同一个 checkConfig），通不过就不写，文件不变。
    try {
      checks.checkConfig(document.toJSON());
    } catch (error) {
      throw new Failure(400, `改完的配置不对：${(error as Error).message}`);
    }
    this.write(document);
    return [...touched];
  }

  /**
   * 改一步。网页的 models.decision 换成改 decision.models 的第一个。
   * @param document yaml 文档。
   * @param step 一步改动，path 已经校验过。
   * @returns 改的是哪个顶层段。
   */
  private apply(document: yaml.Document, step: Edit): string {
    const [top, second, third] = step.path;
    if (top === 'models' && second === 'decision' && (third === undefined || third === 'model')) {
      const value = third === undefined && typeof step.value === 'object' && step.value !== null
        ? (step.value as Record<string, unknown>)['model'] : step.value;
      const list = document.getIn(['decision', 'models']);
      const items = yaml.isSeq(list) ? list.items.length : 0;
      if (step.delete === true || value === undefined || value === '' || value === null) {
        if (items > 1) document.deleteIn(['decision', 'models', 0]);
        if (items <= 1) document.deleteIn(['decision', 'models']);
        return 'decision';
      }
      if (typeof value !== 'string') throw new Failure(400, '决策模型要写成“供应商名/模型 ID”');
      document.setIn(items > 0 ? ['decision', 'models', 0] : ['decision', 'models'], items > 0 ? value : document.createNode([value]));
      return 'decision';
    }
    if (step.delete === true) {
      document.deleteIn(step.path);
    } else {
      document.setIn(step.path, document.createNode(this.unmask(step.value)));
    }
    return String(top);
  }

  /**
   * 遮密钥：对象、列表逐项往下走；键名是密钥、值是非空字符串的换成代号。
   * @param value 值。
   * @param key 它的键名。
   */
  private mask(value: unknown, key: string): unknown {
    if (Array.isArray(value)) return value.map((item) => this.mask(item, key));

    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, this.mask(item, name)]));
    }
    if (!SECRET_KEYS.has(key) || typeof value !== 'string' || value === '') return value;

    //M 同一个原文一直用同一个代号：网页把整张表带着代号写回来时认得出。
    for (const [code, secret] of this.codes) {
      if (secret === value) return `‹已设置:${code}›`;
    }
    const code = crypto.randomBytes(4).toString('hex');
    this.codes.set(code, value);
    return `‹已设置:${code}›`;
  }

  /**
   * 代号换回原文：改动里每个字符串都走一遍（网页可能把整张飞书应用表带着代号写回来）。
   * @param value 网页发来的值。
   * @throws Failure(400)：代号认不出（程序重启过，内存里的对照没了）。
   */
  private unmask(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.unmask(item));

    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, this.unmask(item)]));
    }
    const code = typeof value === 'string' ? CODE.exec(value)?.[1] : undefined;
    if (code === undefined) return value;

    const secret = this.codes.get(code);
    if (secret === undefined) throw new Failure(400, '密钥代号过期了（程序重启过）：刷新设置页再改');
    return secret;
  }

  /**
   * 写回：原来有 BOM 就加回去；先写 config.yaml.tmp 再改名，写到一半断电也不会留下半份文件。
   * @param document yaml 文档。
   */
  write(document: yaml.Document): void {
    const text = (this.bom ? '\uFEFF' : '') + document.toString({ lineWidth: 0 });
    fs.writeFileSync(`${this.file}.tmp`, text, 'utf8');
    fs.renameSync(`${this.file}.tmp`, this.file);
  }
}


/**
 * decision.models 的第一个模型名（写成字符串，或 { model }）。
 * @param decision config 里的 decision 段。
 */
function firstDecisionModel(decision: unknown): string | undefined {
  const models = (decision as { models?: unknown } | undefined)?.models;
  const first: unknown = Array.isArray(models) ? models[0] : undefined;
  if (typeof first === 'string') return first;

  const named = (first as { model?: unknown } | undefined)?.model;
  return typeof named === 'string' ? named : undefined;
}
