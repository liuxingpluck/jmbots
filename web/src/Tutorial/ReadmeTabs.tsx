/**
 * 教程页「插件」右栏的说明拆标签组件：前端按 说明.md 的二级标题（##）切段，拆成 概要 / 事件 / 对外函数 / 内部函数 / 数据 / 配置 / （可选）补充，
 * 表格用深色 antd.Table 显示，依赖的插件做成可点的小标签（点完在左栏切到那个插件），空段或“无”灰掉标签。
 */
import type { JSX } from 'react';
import * as antd from 'antd';
import * as reactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SiteLink, SourceToggle, VIRTUAL_THRESHOLD, getSiteParts } from './Code.tsx';
import type { PluginItem } from './TutorialApi.ts';
import * as sourceDirModule from '../../../src7/utils/SourceDir.ts';


/** 服务名和插件名不同名时的对照表（同名插件直接按插件名单认）。 */
const SERVICE_TO_PLUGIN: Record<string, string> = {
  modelCatalog: 'model-catalog',
  filesMirror: 'journal',
  base: 'base-bridge',
  flow: 'tutorial',
  frontDesk: 'bots',
};

/** 骨架提供的内置服务：展示为不可点的灰标签。 */
const SKELETON_SERVICES = new Set(['resources', 'sessions', 'tools']);

/** 拆出来的 markdown 段：普通段落或 GFM 管道表格。 */
type MarkdownBlock =
  | { kind: 'md'; text: string }
  | { kind: 'table'; headers: string[]; rows: string[][] };

/** 提取出的一条依赖展示项。 */
interface DepTagItem {
  /** 原始名字（如 modelCatalog、resources）。 */
  label: string;
  /** 对应的插件名；骨架或认不出是 undefined。 */
  pluginName: string | undefined;
  /** 是否可选依赖。 */
  optional: boolean;
}

/** 从一份 说明.md 切出来的各段内容。 */
export interface ParsedReadme {
  /** 文档首行写的主标题和版本号，如 v1.0.0。 */
  docVersion: string;
  /** 第一个 ## 之前的简介。 */
  intro: string;
  /** ## 依赖 */
  dependencies: string;
  /** ## 听的事件 */
  listenedEvents: string;
  /** ## 发的事件 */
  emittedEvents: string;
  /** ## 对外函数 */
  publicFunctions: string;
  /** ## 参数字段明细 */
  paramFields: string;
  /** ## 内部函数 */
  internalFunctions: string;
  /** ## 数据 */
  data: string;
  /** ## 数据字段表 */
  dataFields: string;
  /** ## 配置 */
  config: string;
  /** 任意 ## 补充：… 段落，按原文先后保留。 */
  extras: { title: string; body: string }[];
}


/**
 * 判别一段说明算不算空的或只写了“无”（末尾带源码静态核验快照时间戳也算无实质内容）。
 * @param body 这段正文。
 */
export function isNoneSection(body: string): boolean {
  //M 先剥离末尾静态核验快照时间戳，再匹配常见的“无”类占位文案。
  const withoutSnapshot = body.replace(/\n*源码静态核验快照：[^\n]*。?\s*$/u, '').trim();
  if (withoutSnapshot === '') return true;

  return /^(?:无|无。|无本插件配置。?|不发事件。?|无必需或可选服务。?|不建表。?)$/u.test(withoutSnapshot);
}


/**
 * 把原始依赖/服务名映射成左栏插件名；骨架服务或未知服务回 undefined。
 * @param raw 原始服务名或插件名。
 * @param pluginNames 当前所有已知插件名。
 */
function resolvePluginName(raw: string, pluginNames: Set<string>): string | undefined {
  const cleaned = raw.trim().replace(/^`|`$/gu, '');
  if (cleaned === '') return undefined;
  if (pluginNames.has(cleaned)) return cleaned;
  if (SKELETON_SERVICES.has(cleaned)) return undefined;

  const mapped = SERVICE_TO_PLUGIN[cleaned];
  if (mapped !== undefined && pluginNames.has(mapped)) return mapped;
  if (cleaned === 'wechat-kefu' && pluginNames.has('wechat')) return 'wechat';
  if (cleaned === 'wechat' && pluginNames.has('wechat-kefu')) return 'wechat-kefu';

  return undefined;
}


/**
 * 从一行标题提取二级标题文字；不在代码块里的 ## 才算。
 * @param line 单行文本。
 */
function readHeadingTitle(line: string): string | undefined {
  const match = /^##\s+(.+)$/u.exec(line.trim());
  if (match === null) return undefined;

  return (match[1] ?? '').trim();
}


/**
 * 把某一个 ## 标题下的正文放进对应字段。
 * @param parsed 解析结果对象。
 * @param title 二级标题文字（不含 ##）。
 * @param body 该段正文。
 */
function assignSection(parsed: ParsedReadme, title: string, body: string): void {
  if (title === '依赖') {
    parsed.dependencies = body;
    return;
  }
  if (title === '听的事件') {
    parsed.listenedEvents = body;
    return;
  }
  if (title === '发的事件') {
    parsed.emittedEvents = body;
    return;
  }
  if (title === '对外函数') {
    parsed.publicFunctions = body;
    return;
  }
  if (title === '参数字段明细') {
    parsed.paramFields = body;
    return;
  }
  if (title === '内部函数') {
    parsed.internalFunctions = body;
    return;
  }
  if (title === '数据') {
    parsed.data = body;
    return;
  }
  if (title === '数据字段表') {
    parsed.dataFields = body;
    return;
  }
  if (title === '配置') {
    parsed.config = body;
    return;
  }
  //M 所有未落入标准分类的二级标题（如「补充：…」「挂载先后」「给外部 AI 的打分接口」）全部保留在概要页尾，避免裁掉文档。
  parsed.extras.push({ title, body });
}


/**
 * 按 ## 标题把 说明.md 切成结构化段落（跳过围栏代码块里的 ##）。
 * @param text 说明.md 原文。
 */
export function parseReadme(text: string): ParsedReadme {
  const parsed: ParsedReadme = {
    docVersion: '',
    intro: '',
    dependencies: '',
    listenedEvents: '',
    emittedEvents: '',
    publicFunctions: '',
    paramFields: '',
    internalFunctions: '',
    data: '',
    dataFields: '',
    config: '',
    extras: [],
  };
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  let currentTitle = '';
  let buffer: string[] = [];
  let inFence = false;
  let seenFirstHeading = false;

  //M 遍历每一行：首行如果是 # 标题取版本号，其余按代码围栏外出现的 ## 分段。
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      buffer.push(line);
      continue;
    }

    if (!inFence && index === 0 && trimmed.startsWith('# ')) {
      const versionMatch = /\b(v\d+(?:\.\d+)*)\s*$/iu.exec(trimmed);
      if (versionMatch !== null) {
        parsed.docVersion = versionMatch[1] ?? '';
      }
      continue;
    }

    let heading: string | undefined;
    if (!inFence) {
      //M 仅在围栏代码块外部识别二级标题（## ），免误切代码示例里的注释。
      heading = readHeadingTitle(line);
    }
    if (heading === undefined) {
      buffer.push(line);
      continue;
    }

    const body = buffer.join('\n').trim();
    if (!seenFirstHeading) {
      parsed.intro = body;
      seenFirstHeading = true;
    }
    if (seenFirstHeading && currentTitle !== '') {
      //M 切到下一个二级标题前，把刚积累完的正文归进上一标题对应的结构化字段。
      assignSection(parsed, currentTitle, body);
    }
    currentTitle = heading;
    buffer = [];
  }

  const tail = buffer.join('\n').trim();
  if (!seenFirstHeading) {
    parsed.intro = tail;
    return parsed;
  }
  if (currentTitle !== '') {
    //M 文档结尾将最后一块未封口的二级标题正文写入结果对象。
    assignSection(parsed, currentTitle, tail);
  }
  return parsed;
}


/**
 * 判断一行是不是 GFM 表格分隔行（例如 |---|---|）。
 * @param line 候选行。
 */
function isTableSeparator(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.includes('|') || !trimmed.includes('-')) return false;

  let inner = trimmed;
  if (inner.startsWith('|')) {
    inner = inner.slice(1);
  }
  if (inner.endsWith('|')) {
    inner = inner.slice(0, -1);
  }
  const parts = inner.split('|');
  if (parts.length === 0) return false;

  return parts.every((cell) => /^:?-{3,}:?$/u.test(cell.trim()));
}


/**
 * 把一行 Markdown 管道表格切成单元格数组，保留 \| 转义的竖线。
 * @param line 表格行。
 */
function splitTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith('|')) {
    trimmed = trimmed.slice(1);
  }
  if (trimmed.endsWith('|') && !trimmed.endsWith('\\|')) {
    trimmed = trimmed.slice(0, -1);
  }
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < trimmed.length; index += 1) {
    const ch = trimmed[index] ?? '';
    const next = trimmed[index + 1] ?? '';
    if (ch === '\\' && next === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}


/**
 * 把 Markdown 正文拆成普通文本块与 GFM 表格块（只处理代码块之外的标准管道表格）。
 * @param text Markdown 文本。
 */
function splitMarkdownBlocks(text: string): MarkdownBlock[] {
  const lines = text.replaceAll('\r\n', '\n').split('\n');
  const blocks: MarkdownBlock[] = [];
  let mdLines: string[] = [];
  let inFence = false;

  const flushMd = (): void => {
    const joined = mdLines.join('\n').trim();
    if (joined !== '') {
      blocks.push({ kind: 'md', text: joined });
    }
    mdLines = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    const trimmed = line.trim();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      mdLines.push(line);
      continue;
    }

    const nextLine = lines[index + 1] ?? '';
    //M 围栏外部当“本行含竖线且下一行满足 GFM 分隔行格式”时判定表格起始。
    const startsTable = !inFence && trimmed.includes('|') && index + 1 < lines.length && isTableSeparator(nextLine);
    if (!startsTable) {
      mdLines.push(line);
      continue;
    }

    //M 遇到表格：先把之前的普通段落吐出，再吃掉表头、分隔线与连续数据行。
    flushMd();
    const headers = splitTableRow(line);
    const rows: string[][] = [];
    index += 2;
    while (index < lines.length) {
      const rowLine = lines[index] ?? '';
      const rowTrimmed = rowLine.trim();
      if (rowTrimmed === '' || !rowTrimmed.includes('|') || rowTrimmed.startsWith('#') || rowTrimmed.startsWith('```')) {
        index -= 1;
        break;
      }
      //M 切分单行表格单元格并补齐缺列或截断多余列，保证与表头列数对齐。
      const parsedRow = splitTableRow(rowLine);
      while (parsedRow.length < headers.length) {
        parsedRow.push('');
      }
      rows.push(parsedRow.slice(0, headers.length));
      index += 1;
    }
    blocks.push({ kind: 'table', headers, rows });
  }

  //M 扫描至文档末行后冲刷末尾累积的 Markdown 文本段落。
  flushMd();
  return blocks;
}


/**
 * 从说明表格的事件列文字中提取标准 Cordis 事件名（例如 `channel/message`、`bot/receive`、`ready`、`trace`）。
 * 非 Cordis 内部事件（如飞书 SDK 原生事件、WSClient 回调）返回 undefined。
 * @param cell 事件列单元格原文。
 */
function extractEventName(cell: string): string | undefined {
  const cleaned = cell.trim().replaceAll('`', '');
  if (cleaned === '' || cleaned.includes('非Cordis事件')) return undefined;

  const match = /^([a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)+|ready|trace)(?:$|[\s（(])/u.exec(cleaned);
  if (match === null) return undefined;

  return match[1];
}


/** 从说明中提取思维导图所需的事件和函数，沿用说明页的表格、事件名解析。 */
export function getMindReadme(text: string) {
  //M 与右栏共用说明章节规则。
  const sections = parseReadme(text);

  /** 只读表格里标明名称的列，忽略普通说明和其它表格。 */
  const getNames = (
    body: string,
    headings: readonly string[],
    parse: (cell: string) => string | undefined,
  ): string[] => {
    //M 一张表可能重复提到同一个事件，导图中只保留一次。
    const names = new Set<string>();
    const blocks = splitMarkdownBlocks(body);
    for (const block of blocks) {
      if (block.kind !== 'table') continue;

      const column = block.headers.findIndex((header) => headings.includes(header));
      if (column < 0) continue;

      for (const row of block.rows) {
        const cell = row[column] ?? '';
        //M 只从当前列提取有效的函数或事件名。
        const name = parse(cell);
        if (name) names.add(name);
      }
    }
    return Array.from(names);
  };

  const eventHeadings = ['事件', '事件名'];
  const functionHeadings = ['名字', '名称', '函数', '方法', '对外函数'];
  const getFunctionName = (cell: string): string | undefined => {
    const matched = /^`([^`]+)`/u.exec(cell);
    return matched?.[1] ?? cell;
  };
  //M 仅提取导图需要的三张表。
  return {
    listened: getNames(sections.listenedEvents, eventHeadings, extractEventName),
    emitted: getNames(sections.emittedEvents, eventHeadings, extractEventName),
    functions: getNames(sections.publicFunctions, functionHeadings, getFunctionName),
  };
}


/**
 * 从说明表格的位置/源码列文字中提取第一处可用的 `文件:行号`（简写文件会自动补上所属插件目录）。
 * @param cell 单元格原文。
 * @param pluginFolder 当前插件目录（如 src7/plugins/bots）。
 */
function extractCodeSite(cell: string, pluginFolder?: string): string | undefined {
  const tokens = cell.replaceAll('`', '').replaceAll('\\', '/').split(/[、，,\s]+/u);
  for (const token of tokens) {
    const trimmed = token.trim();
    if (trimmed === '') continue;

    //M 尝试按“文件:行号”拆解片段，仅接受 .ts/.tsx 源码定位。
    const parts = getSiteParts(trimmed);
    if (parts === undefined || !/\.(?:ts|tsx)$/u.test(parts.file)) continue;

    //M 已经从后端源码根或 web/ 写起的，原样用。
    const rooted = parts.file.startsWith(sourceDirModule.SOURCE_PREFIX) || parts.file.startsWith('web/');
    if (rooted) return `${parts.file}:${String(parts.line)}`;

    if (pluginFolder !== undefined && pluginFolder !== '') {
      //M 简写文件名缺少目录前缀时，自动拼接当前插件源码根目录。
      const cleanRel = parts.file.replace(/^\/+/u, '');
      return `${pluginFolder}/${cleanRel}:${String(parts.line)}`;
    }
  }
  return undefined;
}


/**
 * 从说明表格的位置/源码列提取用于 VS Code 跳转的位置（先认带行号的，再认只有 .ts/.tsx 相对路径的并补 :1）。
 * @param cell 单元格原文。
 * @param pluginFolder 当前插件目录。
 */
function getTableVscodeSite(cell: string, pluginFolder?: string): string | undefined {
  //M 优先提取表格中已经自带精确行号的源码位置。
  const explicit = extractCodeSite(cell, pluginFolder);
  if (explicit !== undefined) return explicit;

  const tokens = cell.replaceAll('`', '').replaceAll('\\', '/').split(/[、，,\s()（）]+/u);
  for (const token of tokens) {
    const trimmed = token.trim();
    if (trimmed === '' || !/\.(?:ts|tsx)$/u.test(trimmed)) continue;

    if (trimmed.startsWith(sourceDirModule.SOURCE_PREFIX) || trimmed.startsWith('web/')) return `${trimmed}:1`;

    if (pluginFolder !== undefined && pluginFolder !== '') {
      //M 无行号的简写 .ts/.tsx 文件名补全所属插件目录与第 1 行，供 VS Code 跳转打开。
      const cleanRel = trimmed.replace(/^\/+/u, '');
      return `${pluginFolder}/${cleanRel}:1`;
    }
  }
  return undefined;
}


/**
 * 渲染一段 Markdown 单元格行内内容（去掉多余段落外边距）。
 * @param props.text Markdown 原文。
 */
function InlineMarkdown(props: { text: string }): JSX.Element {
  return (
    <span className="tu-cell-md">
      <reactMarkdown.default remarkPlugins={[remarkGfm]}>{props.text}</reactMarkdown.default>
    </span>
  );
}


/**
 * 渲染正文：普通 Markdown 交由 react-markdown，GFM 表格用深色 antd.Table 渲染；
 * 依赖表首列支持跳插件，事件表首列支持点事件在画布高亮，位置列支持 VS Code 直开与就地展开看实现，长表开启虚拟滚动。
 * @param props.body 正文。
 * @param props.pluginNames 已知插件名。
 * @param props.onSelectPlugin 点击跳转到某插件的回调。
 * @param props.pluginFolder 当前插件所在目录（如 src7/plugins/bots），补全相对路径用。
 * @param props.activeEvent 当前画布高亮的事件名。
 * @param props.onSelectEvent 点击事件名在画布高亮的回调。
 */
export function MarkdownContent(props: {
  body: string;
  pluginNames?: Set<string>;
  onSelectPlugin?: (name: string) => void;
  pluginFolder?: string;
  activeEvent?: string;
  onSelectEvent?: (eventName: string) => void;
}): JSX.Element {
  //M 把 Markdown 正文切成普通文本段与 GFM 表格块列表，分别套用对应渲染组件。
  const blocks = splitMarkdownBlocks(props.body);
  return (
    <div className="tu-md-content">
      {blocks.map((block, blockIndex) => {
        if (block.kind === 'md') {
          return (
            <div key={`md-${String(blockIndex)}`} className="tu-markdown">
              <reactMarkdown.default remarkPlugins={[remarkGfm]}>{block.text}</reactMarkdown.default>
            </div>
          );
        }

        const firstHeader = (block.headers[0] ?? '').trim();
        const isDepTable = firstHeader === '服务' || firstHeader === '服务名';
        const isEventTable = firstHeader === '事件';
        const useVirtual = block.rows.length >= VIRTUAL_THRESHOLD;
        let colWidth: number | undefined;
        if (useVirtual) {
          colWidth = Math.max(160, Math.floor(680 / Math.max(1, block.headers.length)));
        }

        const columns = block.headers.map((header, colIndex) => {
          const cleanHeader = header.trim();
          const isSiteCol = cleanHeader.includes('位置') || cleanHeader.includes('源码') || cleanHeader.includes('在哪') || cleanHeader.includes('谁在调') || cleanHeader.includes('文件');
          return {
            title: <InlineMarkdown text={header} />,
            dataIndex: `c${String(colIndex)}`,
            key: `c${String(colIndex)}`,
            width: colWidth,
            render: (value: string) => {
              if (isDepTable && colIndex === 0 && props.pluginNames !== undefined && props.onSelectPlugin !== undefined) {
                //M 解析依赖表首列的服务名为左栏可跳插件名，非骨架服务才做成按钮。
                const target = resolvePluginName(value, props.pluginNames);
                if (target !== undefined) {
                  const selectPlugin = props.onSelectPlugin;
                  return (
                    <button type="button" className="tu-dep-inline" onClick={() => selectPlugin(target)}>
                      <InlineMarkdown text={value} />
                    </button>
                  );
                }
              }
              if (isEventTable && colIndex === 0 && props.onSelectEvent !== undefined) {
                //M 识别首列里的标准 Cordis 事件名，支持点击联动右侧/左侧泳道高亮。
                const eventName = extractEventName(value);
                if (eventName !== undefined) {
                  const selectEvent = props.onSelectEvent;
                  let pillClass = 'tu-event-pill';
                  if (props.activeEvent === eventName) {
                    pillClass = 'tu-event-pill active';
                  }
                  return (
                    <div className="tu-event-cell">
                      <button
                        type="button"
                        className={pillClass}
                        title={`点击在画布上高亮事件 ${eventName}`}
                        onClick={() => selectEvent(eventName)}
                      >
                        {eventName}
                      </button>
                      {value.replaceAll('`', '').trim() !== eventName && (
                        <span className="tu-muted">{value.replaceAll('`', '').trim().slice(eventName.length)}</span>
                      )}
                    </div>
                  );
                }
              }
              if (isSiteCol) {
                //M 区分精确行号源码预览（codeSite）与兜底文件入口（vscodeSite），渲染弹窗按钮与跳转链接。
                const codeSite = extractCodeSite(value, props.pluginFolder);
                const vscodeSite = getTableVscodeSite(value, props.pluginFolder);
                if (vscodeSite !== undefined) {
                  const cleaned = value.replaceAll('`', '').trim();
                  const isPureSite = cleaned !== '' && !/\s/u.test(cleaned);
                  return (
                    <div className="tu-site-cell">
                      {isPureSite && <SiteLink site={vscodeSite} label={cleaned} />}
                      {!isPureSite && (
                        <>
                          <InlineMarkdown text={value} />
                          <SiteLink site={vscodeSite} />
                        </>
                      )}
                      {codeSite !== undefined && <SourceToggle site={codeSite} label="看实现" />}
                    </div>
                  );
                }
              }
              return <InlineMarkdown text={value} />;
            },
          };
        });
        const dataSource = block.rows.map((row, rowIndex) => {
          const record: Record<string, string> = { key: `r-${String(rowIndex)}` };
          for (let colIndex = 0; colIndex < block.headers.length; colIndex += 1) {
            record[`c${String(colIndex)}`] = row[colIndex] ?? '';
          }
          return record;
        });
        if (useVirtual && colWidth !== undefined) {
          return (
            <div key={`tbl-${String(blockIndex)}`} className="tu-table-wrap">
              <antd.Table
                size="small"
                bordered
                pagination={false}
                virtual
                scroll={{ x: block.headers.length * colWidth, y: 420 }}
                columns={columns}
                dataSource={dataSource}
                className="tu-md-table"
              />
            </div>
          );
        }
        return (
          <div key={`tbl-${String(blockIndex)}`} className="tu-table-wrap">
            <antd.Table
              size="small"
              bordered
              pagination={false}
              scroll={{ x: 'max-content' }}
              columns={columns}
              dataSource={dataSource}
              className="tu-md-table"
            />
          </div>
        );
      })}
    </div>
  );
}


/**
 * 从 plugin.inject 和 ## 依赖 文本里抽出依赖标签清单（去重），区分插件可点标签与骨架服务标签。
 * @param injectList 运行时声明的必需服务。
 * @param depBody 说明.md 的 ## 依赖 正文。
 * @param pluginNames 全部已知插件名。
 */
function extractDeps(injectList: string[], depBody: string, pluginNames: Set<string>): DepTagItem[] {
  const byKey = new Map<string, DepTagItem>();

  const addItem = (raw: string, optional: boolean): void => {
    const cleaned = raw.trim().replace(/^`|`$/gu, '').split(/\s|（|\(/u)[0] ?? '';
    if (cleaned === '' || cleaned === '无') return;

    //M 将标准化后的服务名称解析成已知插件名，仅识别已知插件与骨架内置服务。
    const pluginName = resolvePluginName(cleaned, pluginNames);
    if (pluginName === undefined && !SKELETON_SERVICES.has(cleaned)) return;

    const key = pluginName ?? cleaned;
    const prev = byKey.get(key);
    if (prev !== undefined) {
      if (!optional) {
        prev.optional = false;
      }
      return;
    }
    byKey.set(key, { label: cleaned, pluginName, optional });
  };

  for (const dep of injectList) {
    //M 先收录硬编码 inject 声明中的必选依赖。
    addItem(dep, false);
  }

  //M 扫依赖表格和 bullet 行，补全可选依赖（例如 journal、approval、modelCatalog）。
  for (const block of splitMarkdownBlocks(depBody)) {
    if (block.kind === 'table') {
      const firstHeader = (block.headers[0] ?? '').trim();
      if (firstHeader !== '服务' && firstHeader !== '服务名') continue;

      for (const row of block.rows) {
        const nameCell = row[0] ?? '';
        const typeCell = row[1] ?? '';
        //M 从 Markdown 依赖表格逐行提取服务名与“可选”标记合并进标签表。
        addItem(nameCell, typeCell.includes('可选'));
      }
      continue;
    }

    for (const line of block.text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('-')) continue;

      const backticked = /`([a-zA-Z0-9_-]+)`/u.exec(trimmed);
      if (backticked === null) continue;

      //M 从无序列表依赖项提取反引号服务名，附带行内“可选”标注。
      const token = backticked[1] ?? '';
      addItem(token, trimmed.includes('可选'));
    }
  }
  return [...byKey.values()];
}


/**
 * 「概要」标签：版本号徽标 + 一句话简介 + 依赖插件可点小标签与依赖说明。
 * @param props.plugin 插件信息。
 * @param props.parsed 解析后的说明。
 * @param props.rawText 说明.md 原文。
 * @param props.loadError 读取说明时的报错。
 * @param props.pluginNames 已知插件名。
 * @param props.onSelectPlugin 切到目标插件。
 */
function OverviewTab(props: {
  plugin: PluginItem;
  parsed: ParsedReadme | null;
  rawText: string | null;
  loadError: string;
  pluginNames: Set<string>;
  onSelectPlugin: (name: string) => void;
}): JSX.Element {
  const { plugin, parsed } = props;
  let versionLabel = plugin.version;
  if (versionLabel !== '') {
    versionLabel = `v${versionLabel}`;
  }
  if (versionLabel === '' && parsed !== null) {
    versionLabel = parsed.docVersion;
  }
  if (versionLabel === '') {
    versionLabel = '未标版本号';
  }
  const hasDocMismatch = parsed !== null && parsed.docVersion !== '' && plugin.version !== '' && parsed.docVersion !== `v${plugin.version}`;

  let depBody = '';
  if (parsed !== null) {
    depBody = parsed.dependencies;
  }
  //M 合并代码声明的 inject 与说明文档中提取的必选/可选依赖清单，准备生成顶部标签云。
  const deps = extractDeps(plugin.inject, depBody, props.pluginNames);

  return (
    <div className="tu-overview">
      <div className="tu-overview-badges">
        <antd.Tag className="tu-version-badge">当前版本 {versionLabel}</antd.Tag>
        {hasDocMismatch && parsed !== null && (
          <antd.Tag className="tu-version-note">说明标注 {parsed.docVersion}</antd.Tag>
        )}
      </div>

      {props.loadError !== '' && <p className="tu-error">读不到说明：{props.loadError}</p>}
      {props.loadError === '' && props.rawText === null && <p className="tu-muted">正在读说明…</p>}

      {parsed !== null && props.rawText !== null && props.rawText.trim() === '' && (
        <antd.Empty description="还没有写 说明.md" />
      )}

      {parsed !== null && parsed.intro !== '' && (
        <div className="tu-overview-intro">
          <MarkdownContent body={parsed.intro} />
        </div>
      )}

      <div className="tu-dep-box">
        <h4>依赖</h4>
        {deps.length === 0 && <p className="tu-muted">不依赖其他插件或骨架服务。</p>}
        {deps.length > 0 && (
          <div className="tu-dep-tags">
            {deps.map((item) => {
              let suffix = '';
              if (item.optional) {
                suffix = '（可选）';
              }
              if (item.pluginName !== undefined) {
                const target = item.pluginName;
                let display = target;
                if (item.label !== target) {
                  display = `${item.label} → ${target}`;
                }
                return (
                  <button
                    key={target}
                    type="button"
                    className="tu-dep-tag clickable"
                    title={`点击跳到 ${target} 插件`}
                    onClick={
                      //M 点击依赖插件标签时将右栏与左栏焦点切换过去。
                      () => props.onSelectPlugin(target)
                    }
                  >
                    {display}{suffix}
                  </button>
                );
              }
              return (
                <span key={item.label} className="tu-dep-tag skeleton" title="骨架内置服务">
                  {item.label}{suffix}
                </span>
              );
            })}
          </div>
        )}
      </div>

      {
        //M 仅当依赖正文非空且非“无”时，渲染下方的依赖明细表格或文字块。
        parsed !== null && !isNoneSection(parsed.dependencies) && (
          <div className="tu-dep-detail">
            <MarkdownContent
              body={parsed.dependencies}
              pluginNames={props.pluginNames}
              onSelectPlugin={props.onSelectPlugin}
              pluginFolder={
                //M 解析该插件真实源码目录，供依赖说明表格解析简写源码路径。
                getPluginFolder(plugin.name)
              }
            />
          </div>
        )
      }
    </div>
  );
}


/**
 * 组合两个可选子段，用于「对外函数（+ 参数字段明细）」和「数据（+ 数据字段表）」。
 * @param primary 主段正文。
 * @param secondaryTitle 次段小标题。
 * @param secondary 次段正文。
 * @param pluginFolder 当前插件目录（供位置列直接展开看实现）。
 */
function CombinedSection(props: { primary: string; secondaryTitle: string; secondary: string; pluginFolder?: string }): JSX.Element {
  //M 分别检测主段与次段是否实质内容为空（或标为“无”），决定展示内容还是统一显示“无”。
  const hasPrimary = !isNoneSection(props.primary);
  const hasSecondary = !isNoneSection(props.secondary);
  return (
    <div className="tu-combined-section">
      {hasPrimary && <MarkdownContent body={props.primary} pluginFolder={props.pluginFolder} />}
      {!hasPrimary && !hasSecondary && <p className="tu-muted">无</p>}
      {hasSecondary && (
        <div className="tu-sub-section">
          <h3>{props.secondaryTitle}</h3>
          <MarkdownContent body={props.secondary} pluginFolder={props.pluginFolder} />
        </div>
      )}
    </div>
  );
}


/**
 * 「事件」标签：听的事件、发的事件左右（窄屏上下）两块，每个事件一行，事件名支持点击并在画布高亮。
 * @param props.listened 听的事件正文。
 * @param props.emitted 发的事件正文。
 * @param props.pluginFolder 当前插件目录。
 * @param props.activeEvent 当前画布高亮的事件名。
 * @param props.onSelectEvent 点击事件名回调。
 */
function EventsTab(props: {
  listened: string;
  emitted: string;
  pluginFolder?: string;
  activeEvent?: string;
  onSelectEvent?: (eventName: string) => void;
}): JSX.Element {
  //M 分别判定听的事件与发的事件段是否非空，缺省空段显示占位字样。
  const hasListened = !isNoneSection(props.listened);
  const hasEmitted = !isNoneSection(props.emitted);
  return (
    <div className="tu-events-grid">
      <section className="tu-event-card">
        <h3>听的事件</h3>
        {!hasListened && <p className="tu-muted">无</p>}
        {hasListened && (
          <MarkdownContent
            body={props.listened}
            pluginFolder={props.pluginFolder}
            activeEvent={props.activeEvent}
            onSelectEvent={props.onSelectEvent}
          />
        )}
      </section>
      <section className="tu-event-card">
        <h3>发的事件</h3>
        {!hasEmitted && <p className="tu-muted">无</p>}
        {hasEmitted && (
          <MarkdownContent
            body={props.emitted}
            pluginFolder={props.pluginFolder}
            activeEvent={props.activeEvent}
            onSelectEvent={props.onSelectEvent}
          />
        )}
      </section>
    </div>
  );
}


/**
 * 「补充」标签：显示所有 ## 补充：… 段。
 * @param props.extras 补充段列表。
 */
function ExtrasTab(props: { extras: { title: string; body: string }[]; pluginFolder?: string }): JSX.Element {
  return (
    <div className="tu-extras-tab">
      {props.extras.map((item) => (
        <section key={item.title} className="tu-sub-section">
          <h3>{item.title}</h3>
          <MarkdownContent body={item.body} pluginFolder={props.pluginFolder} />
        </section>
      ))}
    </div>
  );
}


/** 插件或骨架名 → 源码所在目录，兼容 wechat-kefu 别名与系统骨架模块。 */
function getPluginFolder(pluginName: string): string {
  if (pluginName === 'main' || pluginName === 'resources' || pluginName === 'tools' || pluginName === 'sessions') {
    return sourceDirModule.SOURCE_DIR;
  }
  if (pluginName === 'wechat-kefu') return `${sourceDirModule.SOURCE_PREFIX}plugins/wechat`;

  return `${sourceDirModule.SOURCE_PREFIX}plugins/${pluginName}`;
}


/**
 * 按规定顺序把 说明.md 拆成一组 antd.Tabs 项（不含后面的 状态 / 代码 / 试一试）。
 * @param params.plugin 当前插件。
 * @param params.text 说明.md 原文（加载中是 null）。
 * @param params.error 加载报错。
 * @param params.pluginNames 全部已知插件名。
 * @param params.onSelectPlugin 点击依赖标签切到对应插件。
 * @param params.activeEvent 当前画布高亮的事件名。
 * @param params.onSelectEvent 点击事件名高亮画布对应步骤。
 */
export function buildReadmeTabItems(params: {
  plugin: PluginItem;
  text: string | null;
  error: string;
  pluginNames: Set<string>;
  onSelectPlugin: (name: string) => void;
  activeEvent?: string;
  onSelectEvent?: (eventName: string) => void;
}): NonNullable<antd.TabsProps['items']> {
  let parsed: ParsedReadme | null = null;
  if (params.error === '' && params.text !== null) {
    //M 将 说明.md 原文按二级标题切分为结构化子分栏内容。
    parsed = parseReadme(params.text);
  }
  //M 解析当前插件实际源码目录，供代码跳转列补全前缀。
  const pluginFolder = getPluginFolder(params.plugin.name);

  //M 按各分栏对应正文的实质内容判定为空或“无”，统一将空页签置灰禁用。
  const eventsDisabled = parsed === null || (isNoneSection(parsed.listenedEvents) && isNoneSection(parsed.emittedEvents));
  const publicDisabled = parsed === null || (isNoneSection(parsed.publicFunctions) && isNoneSection(parsed.paramFields));
  const internalDisabled = parsed === null || isNoneSection(parsed.internalFunctions);
  const dataDisabled = parsed === null || (isNoneSection(parsed.data) && isNoneSection(parsed.dataFields));
  const configDisabled = parsed === null || isNoneSection(parsed.config);

  const items: NonNullable<antd.TabsProps['items']> = [
    {
      key: 'overview',
      label: '概要',
      children: (
        <OverviewTab
          plugin={params.plugin}
          parsed={parsed}
          rawText={params.text}
          loadError={params.error}
          pluginNames={params.pluginNames}
          onSelectPlugin={params.onSelectPlugin}
        />
      ),
    },
    {
      key: 'events',
      label: '事件',
      disabled: eventsDisabled,
      children: parsed !== null && (
        <EventsTab
          listened={parsed.listenedEvents}
          emitted={parsed.emittedEvents}
          pluginFolder={pluginFolder}
          activeEvent={params.activeEvent}
          onSelectEvent={params.onSelectEvent}
        />
      ),
    },
    {
      key: 'public-fns',
      label: '对外函数',
      disabled: publicDisabled,
      children: parsed !== null && (
        <CombinedSection primary={parsed.publicFunctions} secondaryTitle="参数字段明细" secondary={parsed.paramFields} pluginFolder={pluginFolder} />
      ),
    },
    {
      key: 'internal-fns',
      label: '内部函数',
      disabled: internalDisabled,
      children: parsed !== null && <MarkdownContent body={parsed.internalFunctions} pluginFolder={pluginFolder} />,
    },
    {
      key: 'data',
      label: '数据',
      disabled: dataDisabled,
      children: parsed !== null && (
        <CombinedSection primary={parsed.data} secondaryTitle="数据字段表" secondary={parsed.dataFields} pluginFolder={pluginFolder} />
      ),
    },
    {
      key: 'config',
      label: '配置',
      disabled: configDisabled,
      children: parsed !== null && <MarkdownContent body={parsed.config} pluginFolder={pluginFolder} />,
    },
  ];

  //M 只有存在至少一段非空 ## 补充：… 时才显示「补充」标签。
  if (parsed !== null && parsed.extras.length > 0) {
    const nonEmptyExtras = parsed.extras.filter((item) => !isNoneSection(item.body));
    if (nonEmptyExtras.length > 0) {
      items.push({
        key: 'extra',
        label: '补充',
        children: <ExtrasTab extras={nonEmptyExtras} pluginFolder={pluginFolder} />,
      });
    }
  }
  return items;
}
