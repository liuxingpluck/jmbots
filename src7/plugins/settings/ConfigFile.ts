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
import * as filesModule from '../../utils/Files.ts';
import * as failureModule from '../../utils/Failure.ts';


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
   * @returns 保留原有注释与键顺序的 YAML 文档对象。
   * @throws Failure(409)：不是合法 YAML，只说第几行（错误里不带原文，原文可能是密钥）。
   * 副作用：记录原文件开头是否带有 UTF-8 BOM。
   */
  read(): yaml.Document {
    const text = fs.readFileSync(this.file, 'utf8');
    this.bom = text.startsWith('\uFEFF');
    let bodyText = text;
    if (this.bom) {
      bodyText = text.slice(1);
    }
    const document = yaml.parseDocument(bodyText);
    const broken = document.errors[0];
    //G 原配置 YAML 语法已损坏时直接拦截回 409，只提示行号以免错误里带出密钥原文。
    if (broken !== undefined) {
      throw new failureModule.Failure(
        409,
        `config.yaml 不是合法的 YAML（第 ${String(broken.linePos?.[0].line ?? '?')} 行附近）：先在文件里改好`,
      );
    }
    return document;
  }

  /**
   * 读取配置并按白名单过滤顶层段，同时把密钥替换为内存代号。
   * @returns 白名单里的段，密钥换成代号；decision.models 的第一个放进 models.decision.model。
   * @throws Failure(409)：config.yaml 不是合法 YAML。
   * 副作用：更新内存中“代号 → 密钥原文”的对照表并刷新 BOM 状态。
   */
  masked(): Record<string, unknown> {
    //M 读取 YAML 并只截取允许设置页读写的安全白名单顶层段。
    const all = (this.read().toJSON() ?? {}) as Record<string, unknown>;
    const kept = Object.fromEntries(Object.entries(all).filter(([key]) => SECTIONS.has(key)));
    //M 将 decision.models 首项同步进 models.decision.model，兼容前端设置页读取结构。
    const first = firstDecisionModel(kept['decision']);
    if (first !== undefined) {
      const models = asRecord(kept['models']);
      kept['models'] = { ...models, decision: { model: first } };
    }
    //M 递归将所有密钥字符串替换为展示代号后再返回前端。
    return this.mask(kept, '') as Record<string, unknown>;
  }

  /**
   * 照顺序改，校验，写回。
   * @param edits 网页发来的改动（外面进来的，这里校验一次）。
   * @returns 改了哪些顶层段（去重）。
   * @throws Failure(400)：步子不对、路径不在白名单、代号认不出、改完通不过骨架校验；Failure(409)：原文件就坏了。
   * 副作用：整份配置校验通过后将结果原子写回磁盘上的 `config.yaml`。
   */
  edit(edits: unknown): string[] {
    //G 入口校验请求必须是非空改动数组，格式不对直接回 400。
    if (!Array.isArray(edits) || edits.length === 0) {
      throw new failureModule.Failure(400, '要发一串改动：[{ path, value } 或 { path, delete: true }]');
    }

    //M 读出保留注释与顺序的 YAML 文档，准备逐条验证并套用改动。
    const document = this.read();
    const touched = new Set<string>();
    for (const [index, raw] of edits.entries()) {
      const step = (raw ?? {}) as Edit;
      const okPath = Array.isArray(step.path) && step.path.length > 0
        && step.path.every((part) => typeof part === 'string'
          || (typeof part === 'number' && Number.isInteger(part) && part >= 0));
      //G 校验本步 path 必须是非空的字符串键或非负整数下标列表。
      if (!okPath) throw new failureModule.Failure(400, `第 ${String(index + 1)} 步的 path 要是非空的键、序号列表`);

      //G 限制只能修改白名单允许的顶层段，越界修改回 400。
      const top = String(step.path[0]);
      if (!SECTIONS.has(top)) throw new failureModule.Failure(400, `第 ${String(index + 1)} 步改的 ${top} 不在设置页能改的范围里`);

      //G 非删除步骤必须带有 value 字段，否则拒绝执行该步改动。
      if (step.delete !== true && !('value' in step)) {
        throw new failureModule.Failure(400, `第 ${String(index + 1)} 步要有 value 或 delete: true`);
      }

      //M 校验通过后在内存文档上应用这一步改动，并记下被改动的顶层段名。
      touched.add(this.apply(document, step));
    }

    //M 改完整份过一遍骨架的校验（和启动时同一个 checkConfig），通不过就不写，文件不变。
    try {
      checks.checkConfig(document.toJSON());
    } catch (error) {
      throw new failureModule.Failure(400, `改完的配置不对：${(error as Error).message}`);
    }
    //M 整份配置通过校验后才原子写回磁盘，确保不落盘无效配置。
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
      let value = step.value;
      if (third === undefined && typeof step.value === 'object' && step.value !== null) {
        value = (step.value as Record<string, unknown>)['model'];
      }
      const list = document.getIn(['decision', 'models']);
      let items = 0;
      if (yaml.isSeq(list)) {
        items = list.items.length;
      }
      if (step.delete === true || value === undefined || value === '' || value === null) {
        if (items > 1) document.deleteIn(['decision', 'models', 0]);
        if (items <= 1) document.deleteIn(['decision', 'models']);
        return 'decision';
      }
      //G 写入决策模型时值必须是字符串 ID，非字符串直接回 400。
      if (typeof value !== 'string') throw new failureModule.Failure(400, '决策模型要写成“供应商名/模型 ID”');

      if (items > 0) {
        document.setIn(['decision', 'models', 0], value);
        return 'decision';
      }
      document.setIn(['decision', 'models'], document.createNode([value]));
      return 'decision';
    }
    if (step.delete === true) {
      document.deleteIn(step.path);
      return String(top);
    }
    //M 先把前端传回的值里的代号还原为原密钥，再转为 YAML 节点写入目标路径。
    document.setIn(step.path, document.createNode(this.unmask(step.value)));
    return String(top);
  }

  /**
   * 遮密钥：对象、列表逐项往下走；键名是密钥、值是非空字符串的换成代号。
   * @param value 值。
   * @param key 它的键名。
   */
  private mask(value: unknown, key: string): unknown {
    //M 数组保持原键名递归遮蔽每一项元素中的敏感字段。
    if (Array.isArray(value)) return value.map((item) => this.mask(item, key));

    //M 对象按各子字段名递归往下遮蔽密钥，不改变结构。
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
    //M 递归把列表各元素中携带的密钥代号还原回原文。
    if (Array.isArray(value)) return value.map((item) => this.unmask(item));

    //M 递归把对象各字段中携带的密钥代号还原回原文。
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, this.unmask(item)]));
    }
    let code: string | undefined;
    if (typeof value === 'string') {
      code = CODE.exec(value)?.[1];
    }
    if (code === undefined) return value;

    //G 从内存对照表找回原密钥；找不见说明服务重启过代号失效，回 400 让前端刷新。
    const secret = this.codes.get(code);
    if (secret === undefined) throw new failureModule.Failure(400, '密钥代号过期了（程序重启过）：刷新设置页再改');
    return secret;
  }

  /**
   * 写回：原来有 BOM 就加回去；先写临时文件再改名（utils/Files.ts 的 writeTextAtomic），写到一半断电也不会留下半份文件。
   * 改名失败就抛错，不退回直接写，免得把配置写坏。
   * @param document yaml 文档。
   * 副作用：按原 BOM 状态将配置原子覆盖写回 `config.yaml`。
   */
  write(document: yaml.Document): void {
    let prefix = '';
    if (this.bom) {
      prefix = '\uFEFF';
    }
    const text = prefix + document.toString({ lineWidth: 0 });
    //M 原子覆盖写回 config.yaml，防止写一半断电破坏配置。
    filesModule.writeTextAtomic(this.file, text);
  }
}


/**
 * 非 null 对象转成键值表，其它给空对象。
 * @param raw 原始值。
 */
function asRecord(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'object' && raw !== null) return raw as Record<string, unknown>;

  return {};
}


/**
 * decision.models 的第一个模型名（写成字符串，或 { model }）。
 * @param decision config 里的 decision 段。
 */
function firstDecisionModel(decision: unknown): string | undefined {
  const models = (decision as { models?: unknown } | undefined)?.models;
  if (!Array.isArray(models)) return undefined;

  const first: unknown = models[0];
  if (typeof first === 'string') return first;

  const named = (first as { model?: unknown } | undefined)?.model;
  if (typeof named === 'string') return named;

  return undefined;
}
