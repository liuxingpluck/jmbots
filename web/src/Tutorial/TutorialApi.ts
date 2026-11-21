/**
 * 教程页和 tutorial 插件说话（同源相对地址）。令牌用 web/src/Token.ts。
 * 类型照后端 src7/plugins/tutorial/ 交的样子写（Trail.ts、Lanes.ts、Files.ts、Source.ts、index.ts），不 import 后端。
 */
import { TOKEN, withToken } from '../Token.ts';
import type { TraceParams } from '../locales/Trace.ts';


/** 左栏插件列表的一项（GET /api/tutorial/plugins）。 */
export interface PluginItem {
  /** config.yaml 里的名字。 */
  name: string;
  /** 插件导出的 version；还没写是空串。 */
  version: string;
  /** ok 挂上开工了，failed 没挂上，waiting 挂了但缺服务没开工，idle 配置里没挂。 */
  state: string;
  /** 没挂上的原因；缺服务时写缺谁。 */
  error: string;
  /** 它声明要的服务。 */
  inject: string[];
  /** 有没有 说明.md。 */
  hasReadme: boolean;
  /** skeleton 系统自带骨架模块，plugin 普通插件；旧后端没给时按 plugin 处理。 */
  kind?: 'skeleton' | 'plugin';
}


/** GET /api/tutorial/plugins 交的。 */
export interface PluginList {
  /** 插件，挂过的在前。 */
  list: PluginItem[];
  /** 快照关键词，默认 #调试。 */
  keyword: string;
  /** 源码根目录，「在 VS Code 里打开」拼路径用；找不到是空串。 */
  workspace: string;
}


/** 左栏画布的一项（GET /api/tutorial/canvases 的 list）。 */
export interface CanvasItem {
  /** boot，或消息号。 */
  name: string;
  /** 文件最后写的时刻（启动是第一步的时刻），毫秒时间戳。 */
  at: number;
  /** 用户那句话；启动是空串。 */
  preview: string;
  /** 渠道名（例如 feishu / http）；启动或未记到时不填。 */
  channel?: string;
  /** 机器人名；启动或未记到时不填。 */
  bot?: string;
}


/** 「会话」左栏消息列表的一项（GET /api/tutorial/canvases 的 messages，不限 #调试）。 */
export interface MessageCanvasItem {
  /** 消息号（字符串）。 */
  name: string;
  /** 消息收到或文件写的时刻，毫秒时间戳。 */
  at: number;
  /** 用户那句话；没记到是空串。 */
  preview: string;
  /** 渠道名（例如 feishu / http）；未记到时不填。 */
  channel?: string;
  /** 机器人名；未记到时不填。 */
  bot?: string;
  /** 有没有运行时变量快照（磁盘文件或内存还在）。 */
  hasSnapshot: boolean;
}


/** GET /api/tutorial/canvases 交的。 */
export interface CanvasList {
  /** 启动流程 + data/flow/ 里的快照文件。 */
  list: CanvasItem[];
  /** 不限快照关键词的最近全部消息。 */
  messages: MessageCanvasItem[];
  /** 快照关键词，默认 #调试。 */
  keyword: string;
}


/** 一段函数注释，取自代码自己的 JSDoc。 */
export interface CodeDoc {
  /** 名字。 */
  name: string;
  /** 文件:行号。 */
  site: string;
  /** 重要的展开显示，不重要的只显示 summary 第一行。 */
  important: boolean;
  /** 空串是取到了；不然是原因：缺注释、读不到源码、找不到这段代码。 */
  missing: string;
  /** 函数原型，一行；文件开头的注释是空串。 */
  signature: string;
  /** 它干什么。 */
  summary: string;
  /** 参数名和说明。 */
  params: { name: string; text: string }[];
  /** 返回什么。 */
  returns: string;
  /** 什么时候抛错。 */
  throws: string;
  /** 它改了什么。 */
  effects: string;
}


/** 一步里的一行。 */
export interface TrailRow {
  /** 离开始多少毫秒。 */
  t: number;
  /** 到下一行隔了多少毫秒。 */
  gap: number;
  /** 函数还是事件。 */
  kind: string;
  /** 跟踪点是“模块.函数”，事件是事件名。 */
  name: string;
  /** 文案编号或旧行原文。 */
  text: string;
  /** 文案插值。 */
  params?: TraceParams;
  /** 事件行：听的人。 */
  listeners: string[];
  /** 文件:行号。 */
  site: string;
  /** 几个关键值。 */
  facts: Record<string, string | number | boolean>;
  /** 出没出错。 */
  error: boolean;
}


/** 轨迹的一步。 */
export interface TrailStep {
  /** 第几步，从 1 起。 */
  no: number;
  /** 泳道图上的道。 */
  node: string;
  /** 这一步在干什么。 */
  title: string;
  /** 离开始多少毫秒。 */
  t: number;
  /** 这一步用了多少毫秒。 */
  ms: number;
  /** 有没有出错的行。 */
  error: boolean;
  /** 收到通知但没留下跟踪点的插件。 */
  notified: string[];
  /** 这一步的几行。 */
  rows: TrailRow[];
  /** 这一步的函数注释（只有启动有）。 */
  docs: CodeDoc[];
}


/** 一条轨迹（启动的消息号是 0）。 */
export interface Trail {
  /** 消息号；启动是 0。 */
  message: number;
  /** 哪场会话。 */
  session: string | null;
  /** 哪个机器人。 */
  bot: string;
  /** 哪个渠道。 */
  channel: string;
  /** 用户那句话。 */
  preview: string;
  /** 开始时刻。 */
  at: number;
  /** 一共用了多少毫秒。 */
  ms: number;
  /** running、done、failed、stopped、unknown。 */
  state: string;
  /** 有没有出错的步。 */
  error: boolean;
  /** 一步一步。 */
  steps: TrailStep[];
  /** 关键变量的英文键 → 中文解释。 */
  notes: Record<string, string>;
}


/** 泳道图格子里的一项。 */
export interface LaneItem {
  /** 第几步。 */
  step: number;
  /** 一句话。 */
  text: string;
  /** 文案插值。 */
  params?: TraceParams;
}


/** 泳道图的一个格子。 */
export interface LaneCell {
  /** 第几道，从 0 起。 */
  lane: number;
  /** 第几列，从 0 起。 */
  column: number;
  /** 落在这格的步。 */
  items: LaneItem[];
  /** 有没有出错的行。 */
  error: boolean;
}


/** 一张泳道图（Lanes.ts）。 */
export interface Lanes {
  /** 列名。 */
  columns: string[];
  /** 道名。 */
  lanes: string[];
  /** 有东西的格子。 */
  cells: LaneCell[];
  /** 箭头：cells 的下标。 */
  edges: { from: number; to: number }[];
}


/** 一步数据流转里的单个输入字段（实测值或结构契约）。 */
export interface DataField {
  /** 字段英文键名。 */
  key: string;
  /** 字段值摘要。 */
  value: string;
  /** 中文说明。 */
  note: string;
  /** 数据来源：real 实测采样，schema 契约结构。 */
  source: 'real' | 'schema';
}


/** 一步引起的一处数据表或内存对象字段变化（前 → 后）。 */
export interface DataChange {
  /** 目标表名或内存对象名（如 Session.row、ChatRequest、web_messages）。 */
  target: string;
  /** 变化的字段名。 */
  field: string;
  /** 变化前的值。 */
  before: string;
  /** 变化后的值。 */
  after: string;
  /** 一句人话注释。 */
  note: string;
  /** 数据来源：real 实测采样，schema 契约结构。 */
  source: 'real' | 'schema';
}


/** 单步端到端数据流转与状态变化描述。 */
export interface StepDataFlow {
  /** 第几步，从 1 起。 */
  step: number;
  /** 所属骨架或插件名。 */
  node: string;
  /** 架构层级：skeleton 骨架，plugin 插件。 */
  layer: 'skeleton' | 'plugin';
  /** 当前所处阶段短名。 */
  stage: string;
  /** 关键入口函数名。 */
  fnName: string;
  /** 函数源码位置（文件:行号）。 */
  fnSite: string;
  /** 骨架模块对应的逐行图文件名（如 Sessions / Tools / Resources / Main）；插件步为空串。 */
  skeletonFile: string;
  /** 节点底部展示的一句话核心状态变化摘要。 */
  summary: string;
  /** 入站数据来源。 */
  incoming: { fromStep: number | null; via: string; dataType: string };
  /** 本步收到的关键输入字段。 */
  inputs: DataField[];
  /** 本步造成的数据与状态变化列表。 */
  changes: DataChange[];
  /** 出站数据去向。 */
  outgoing: { toStep: number | null; toNode: string; via: string; dataType: string; label: string };
}


/** 整条轨迹的数据流转链路与涉及的核心对象清单。 */
export interface TrailDataFlow {
  /** 按步骤顺序排列的数据流转项。 */
  steps: StepDataFlow[];
  /** 本条轨迹读写或流经的数据表、内存对象与事件通道。 */
  objects: { name: string; kind: 'table' | 'memory' | 'event'; role: string }[];
}


/** GET /api/tutorial/canvas 交的。 */
export interface Canvas {
  /** 轨迹。 */
  trail: Trail;
  /** 泳道图。 */
  lanes: Lanes;
  /** 端到端数据流转与状态变化（旧快照或未生成时可选）。 */
  dataFlow?: TrailDataFlow;
}


/** 一个路径上的变化（GET /api/tutorial/payload）。 */
export interface PayloadDiff {
  /** 路径，如 messages[3].content、system[2]。 */
  path: string;
  /** add 新增、change 修改、remove 删除、same 透传（只列顶层键）。 */
  kind: 'add' | 'change' | 'remove' | 'same';
  /** 前值的一句话预览，最多 200 字；add 没有这一项。 */
  before?: string;
  /** 后值的一句话预览，最多 200 字；remove 没有这一项。 */
  after?: string;
}


/** 一个事件参数对象，在这一步的前后两份。 */
export interface PayloadItem {
  /** 本消息内从 1 开始的序号。 */
  seq: number;
  /** 发出时刻，毫秒。 */
  at: number;
  /** 对应 trail.steps[].no：后端按 at 落进哪一步的时间窗来算。 */
  step: number;
  /** 事件名，如 session/before-model。 */
  event: string;
  /** 参数对象的类型名，按事件名查表，如 ChatRequest。 */
  object: string;
  /** 发出位置“文件:行号”，取自对应 journal 行的 site。 */
  site: string;
  /** 听这个事件的插件，取自 dispatch 时的监听者。 */
  listeners: string[];
  /** dispatch 那一刻的深拷贝。 */
  before: unknown;
  /** 同一会话下一个被记录的事件发出时（或一轮结束时）再拷一次；没取到为 null。 */
  after: unknown | null;
  /** before 和 after 的逐路径对比。 */
  diff: PayloadDiff[];
  /** 拷贝时撞了单份上限：before、after 只保留到上限，diff 照常算到能算的部分。 */
  truncated: boolean;
}


/** 整条消息的载荷（GET /api/tutorial/payload?name=<消息号>）。 */
export interface PayloadTrail {
  ok: true;
  /** 消息号，同 canvas 的 name。 */
  message: string;
  /** 为什么没有或不全（没录、被挤掉、超上限）；完整录到时为空字符串。 */
  note: string;
  items: PayloadItem[];
}


/** 运行时变量的一组（全量原样，调试用不打码）。 */
export interface StateGroup {
  /** 组名：服务名，或插件用 ctx.flow.state 登记的名字。 */
  name: string;
  /** 一句人话。 */
  note: string;
  /** 这一刻的值。 */
  value: unknown;
  /** 手写的键的中文解释。 */
  notes?: Record<string, string>;
}


/** GET /api/tutorial/snapshot：点中一步时那一刻的运行时变量。 */
export interface StepShot {
  /** 拍的时刻。 */
  at: number;
  /** 第几步。 */
  no: number;
  /** 这一步的道。 */
  node: string;
  /** 各组。 */
  groups: StateGroup[];
  /** 和上一步比变了的地方，每处一串键名（第一个是组名）；第一步是 null。 */
  changed: string[][] | null;
}


/** 一个函数的完整源码（GET /api/tutorial/source，Source.ts 的 FunctionSource）。 */
export interface FunctionSource {
  /** 相对代码目录的文件。 */
  file: string;
  /** 起行号。 */
  start: number;
  /** 止行号（含）。 */
  end: number;
  /** 没找到函数结尾、只给了前几行时是 true。 */
  cut: boolean;
  /** start 到 end 那几行原文。 */
  lines: string[];
  /** 里面调到的、找得到定义的函数。 */
  calls: { name: string; site: string }[];
  /** 这个函数的名字；不在函数里是空串。 */
  name: string;
  /** 谁调它。 */
  callers: { site: string; code: string; why: string }[];
}


/** 「代码」标签里的一个对外函数（GET /api/tutorial/code，后端 Code.ts 的 FunctionItem）。 */
export interface CodeFunction {
  /** 名字。 */
  name: string;
  /** function 或 class。 */
  kind: string;
  /** 文件:行号。 */
  site: string;
  /** 上方注释第一句；没写是空串。 */
  summary: string;
}


/** src7 里写了某条接口路径的一处（调它的代码）。 */
export interface CodeUrlCaller {
  /** 文件:行号。 */
  site: string;
  /** 那一行代码。 */
  code: string;
  /** 上方 //M 注释；没写是空串。 */
  why: string;
}


/** 一个 HTTP 接口。 */
export interface CodeRoute {
  /** 方法，大写。 */
  method: string;
  /** 路径，可能带 :参数。 */
  url: string;
  /** 登记那一句的位置：文件:行号；认不出是空串。 */
  site: string;
  /** 登记它的插件文件夹；认不出是空串。 */
  owner: string;
  /** src7 里谁写了这条路径。 */
  callers: CodeUrlCaller[];
}


/** 一个模型工具。 */
export interface CodeTool {
  /** 工具名。 */
  name: string;
  /** 说明第一句。 */
  summary: string;
  /** 实现位置：文件:行号；找不到是空串。 */
  site: string;
  /** 给哪几种会话用。 */
  kinds: string[];
}


/** GET /api/tutorial/code 交的。 */
export interface PluginCodeInfo {
  /** 对外函数。 */
  functions: CodeFunction[];
  /** 这个插件登记的接口。 */
  routes: CodeRoute[];
  /** 这个插件登记的工具。 */
  tools: CodeTool[];
  /** 认不出是哪个插件登记的接口，归在“其他”。 */
  others: CodeRoute[];
}


/** 「试一试」发出一个请求后的结果：状态码和返回正文原文。 */
export interface TryResult {
  /** HTTP 状态码。 */
  status: number;
  /** 返回的正文，原样不动。 */
  text: string;
}


/** /api/programs 里一个进程插件（programs 托管的外部程序）的公开状态，只列教程要显示的几项。 */
export interface ProgramItem {
  /** config 里的程序名。 */
  name: string;
  /** 显示名，没写是 name。 */
  title: string;
  /** starting、ready、unhealthy、stopped、failed、blocked。 */
  state: string;
  /** 现在在干什么或上次失败的原因。 */
  note: string;
  /** 程序就绪行报的端口；没就绪是 null。 */
  port: number | null;
  /** 程序就绪行报的版本；没就绪是 null。 */
  version: string | null;
  /** 自动重启了几次。 */
  restarts: number;
  /** 授权标签：已授权、过期、不需要、未授权、未知。 */
  licenseLabel: string;
  /** 同源界面地址；没报界面或没就绪是 null。 */
  ui: string | null;
  /** 登记给它的渠道名。 */
  channels: string[];
}

/** 和后端说话：get 出错抛后端给的 error；send 给「试一试」用，什么状态码都原样交回。 */
export class TutorialApi {
  /**
   * GET 一个接口。
   * @param path 以 /api/ 开头的地址，带查询参数。
   * @returns 后端交的 JSON。
   * @throws 后端回 4xx、5xx 时抛它给的 error。
   */
  static async get<T>(path: string): Promise<T> {
    //M 给同源请求地址附带管理员令牌，避免后端鉴权拦截。
    const url = withToken(path, TOKEN);
    const response = await fetch(url);
    const body = await response.json() as T & { error?: string };
    if (!response.ok) {
      const reason = body.error ?? String(response.status);
      throw new Error(reason);
    }
    return body;
  }

  /** 取左栏组块清单，文件名顺序由后端确定。 */
  static async getReadings(): Promise<{ files: string[] }> {
    const route = '/api/tutorial/readings';
    //M 复用教程接口的令牌和错误处理。
    return TutorialApi.get<{ files: string[] }>(route);
  }

  /**
   * 读所选组块的 Markdown 原文。
   * @param name 清单中的完整文件名。
   */
  static async getReading(name: string): Promise<{ text: string }> {
    const encoded = encodeURIComponent(name);
    const route = `/api/tutorial/reading?name=${encoded}`;
    //M 用查询参数传文件名，文件是否可读由后端的清单校验。
    return TutorialApi.get<{ text: string }>(route);
  }

  /** Cordis 用法：和组块阅读分组列出，文件名仍从后端清单取。 */
  static async getCordisDocs(): Promise<{ files: string[] }> {
    //M 共用教程的令牌与错误处理。
    return TutorialApi.get<{ files: string[] }>('/api/tutorial/cordis');
  }

  /** 读取 Cordis 用法的一篇文档，name 必须在后端清单里。 */
  static async getCordisReading(name: string): Promise<{ text: string }> {
    const route = `/api/tutorial/cordis-reading?name=${encodeURIComponent(name)}`;
    //M 名称的边界校验由后端清单完成。
    return TutorialApi.get<{ text: string }>(route);
  }

  /** 左栏「骨架工具（utils）」：src7/utils/ 下现有的工具文件名，后端动态列。 */
  static async getUtils(): Promise<{ files: string[] }> {
    const route = '/api/tutorial/utils';
    //M 复用教程接口的令牌和错误处理。
    return TutorialApi.get<{ files: string[] }>(route);
  }

  /**
   * 读一个工具文件的说明（文件头注释和函数表，后端从源码实时提取）。
   * @param name 清单中的文件名，如 Checks.ts。
   */
  static async getUtilReadme(name: string): Promise<{ text: string }> {
    const encoded = encodeURIComponent(name);
    const route = `/api/tutorial/util-readme?name=${encoded}`;
    //M 文件名是否在清单里由后端校验。
    return TutorialApi.get<{ text: string }>(route);
  }

  /** 取 programs 托管的进程插件和运行状态；没挂 programs 时接口不存在，交给调用方当空清单。 */
  static async getPrograms(): Promise<{ programs: ProgramItem[] }> {
    const route = '/api/programs';
    //M 直接读 programs 插件的只读状态接口，教程不另存一份。
    return TutorialApi.get<{ programs: ProgramItem[] }>(route);
  }

  /**
   * 读进程插件程序目录下的 说明.md。
   * @param name config 里的程序名。
   */
  static async getProgramReadme(name: string): Promise<{ file: string; text: string }> {
    const encoded = encodeURIComponent(name);
    const route = `/api/tutorial/program-readme?name=${encoded}`;
    //M 程序目录由后端从 config 推出来，这里只传名字。
    return TutorialApi.get<{ file: string; text: string }>(route);
  }

  /**
   * 读取整条消息的事件参数载荷与前后对比（GET /api/tutorial/payload?name=<消息号>）。
   * 名字是 boot、后端回 404 或网络异常时静默返回空 items，不抛错影响原有胶囊面板。
   * @param name 消息号，或 boot。
   */
  static async getPayload(name: string): Promise<PayloadTrail> {
    if (name === '' || name === 'boot') {
      return { ok: true, message: name || 'boot', note: '', items: [] };
    }
    //M 附带统一鉴权令牌请求单消息全量载荷；404 或异常温和降级为空列表。
    const url = withToken(`/api/tutorial/payload?name=${encodeURIComponent(name)}`, TOKEN);
    try {
      const response = await fetch(url);
      if (!response.ok) {
        return { ok: true, message: name, note: '', items: [] };
      }
      const body = (await response.json()) as Partial<PayloadTrail>;
      let items: PayloadItem[] = [];
      if (Array.isArray(body.items)) {
        items = body.items;
      }
      return {
        ok: true,
        message: String(body.message ?? name),
        note: String(body.note ?? ''),
        items,
      };
    } catch {
      //G 接口未挂载或网络瞬断时回退空清单，保持页面零报错。
      return { ok: true, message: name, note: '', items: [] };
    }
  }

  /**
   * 「试一试」发一个请求：不管状态码是多少，都原样交回（不当错误抛）。
   * @param method 方法。
   * @param path 以 /api/ 开头的地址，可带查询串。
   * @param body 正文原文；没有是空串（GET 不发正文）。
   * @returns 状态码和返回正文。
   * @throws 网络不通时抛 fetch 的错。
   */
  static async send(method: string, path: string, body: string): Promise<TryResult> {
    //M 给「试一试」请求路径追加鉴权令牌，以管理员身份转发接口调试。
    const url = withToken(path, TOKEN);
    const init: RequestInit = { method };
    if (body !== '' && method !== 'GET') {
      init.body = body;
      init.headers = { 'Content-Type': 'application/json' };
    }
    const response = await fetch(url, init);
    //M 原样读取响应体文本，供调试面板直接展示非 JSON 或出错原文。
    const text = await response.text();
    return { status: response.status, text };
  }
}


/** 事件目录里一个类型的字段（GET /api/tutorial/events，Check_Event_Docs.ts 扫出来的）。 */
export interface EventField {
  /** 字段名。 */
  name: string;
  /** 能不能不带。 */
  optional: boolean;
  /** TS 类型。 */
  type: string;
  /** 注释。 */
  doc: string;
  /** 文件:行号。 */
  site: string;
}


/** 事件目录里事件参数用到的一个类型。 */
export interface EventType {
  /** 类型名。 */
  name: string;
  /** interface、type 等。 */
  kind: string;
  /** 文件:行号。 */
  site: string;
  /** 注释。 */
  doc: string;
  /** 不是对象形状的类型写在这里。 */
  definition: string;
  /** 字段。 */
  fields: EventField[];
}


/** 事件目录里发或听的一处。 */
export interface EventSite {
  /** 插件名。 */
  plugin: string;
  /** 函数名。 */
  function: string;
  /** 文件:行号。 */
  site: string;
}


/** 事件目录的一项。 */
export interface EventCatalogItem {
  /** 事件名。 */
  name: string;
  /** 挨个问、通知、请求-回执。 */
  mode: string;
  /** 一问一答的另一半。 */
  pair: string;
  /** 声明处。 */
  declaredAt: string;
  /** 函数签名。 */
  signature: string;
  /** 注释。 */
  doc: string;
  /** 参数。 */
  params: { name: string; optional: boolean; type: string; doc: string }[];
  /** 参数用到的类型。 */
  types: EventType[];
  /** 谁发。 */
  senders: EventSite[];
  /** 谁听。 */
  listeners: EventSite[];
}
