/**
 * 积木知识库（knowledge）领域模型、查询参数与 REST API 契约定义。
 * 三大原子：虚拟目录树（kb_dirs）、统一知识文档（kb_docs，可挂载工作决策 topicId）、多对多标签（kb_tags / kb_doc_tags）；
 * 1.1.0 起加上 [[双链]] 关系表 kb_links 和「硬性系统规则」标记（只有本人能改，AI 只读）；
 * 1.2.0 起加上实体别名（aliases，参与搜索、双链和消歧）与本地文件夹只读同步（FolderSync.ts）。
 */


//==========================================================
// 基础枚举与核心实体
//==========================================================

/** 知识文档来源分类：纯笔记、本地文件、网页摘录、音视频转写稿。 */
export type KnowledgeSourceType = 'note' | 'file' | 'url' | 'transcript';

/** 合法文档来源分类列表。 */
export const KNOWLEDGE_SOURCE_TYPES: readonly KnowledgeSourceType[] = [
  'note',
  'file',
  'url',
  'transcript',
];

/** 虚拟目录表（kb_dirs）单行结构。 */
export interface KnowledgeDir {
  /** 目录唯一标识。 */
  id: string;
  /** 父目录 ID；顶层根目录为 null。 */
  parentId: string | null;
  /** 目录显示名称。 */
  name: string;
  /** 同级排序权重（越小越靠前）。 */
  sortOrder: number;
  /** 创建毫秒时间戳。 */
  createdAt: number;
  /** 最近修改毫秒时间戳。 */
  updatedAt: number;
}

/** 目录树节点（带直接挂载文档计数与递归子节点）。 */
export interface KnowledgeDirNode extends KnowledgeDir {
  /** 直接归属该目录的文档数量。 */
  docCount: number;
  /** 已排序的子目录列表。 */
  children: KnowledgeDirNode[];
}

/** 知识文档列表摘要项（不含长正文，遵循「简介索引 → 按需读正文」）。 */
export interface KnowledgeDocSummary {
  /** 文档统一 ID（默认 YYYYMMDDHHmmssSSS + 3 小写字母）。 */
  id: string;
  /** 所在虚拟目录 ID；未归入目录为 null。 */
  dirId: string | null;
  /** 关联的工作决策台（/work-decision/）专题节点 ID；未关联为 null。 */
  topicId: string | null;
  /** 文档标题。 */
  title: string;
  /** 精简摘要（为空时创建阶段自动从正文提取）。 */
  summary: string;
  /** 原始文件或外部 URL 路径。 */
  sourcePath: string;
  /** 来源类型。 */
  sourceType: KnowledgeSourceType;
  /** 已绑定的标签名称列表（按字母序稳定排列）。 */
  tags: string[];
  /** 硬性系统规则：只有本人在网页上能改，AI 的 kb_save 只读不可写（1.1.0）。 */
  isSystemRule: boolean;
  /** 别名：同一实体的别的叫法，参与搜索、[[双链]] 和消歧（1.2.0）。 */
  aliases: string[];
  /** 创建毫秒时间戳。 */
  createdAt: number;
  /** 最近修改毫秒时间戳。 */
  updatedAt: number;
}

/** 完整知识文档（含 Markdown 正文）。 */
export interface KnowledgeDoc extends KnowledgeDocSummary {
  /** 文档完整正文。 */
  content: string;
}


//==========================================================
// 写入入参、筛选与检索返回契约
//==========================================================

/** 新建目录入参。 */
export interface CreateDirInput {
  /** 可选自定义 ID；缺省自动生成。 */
  id?: string;
  /** 父目录 ID；顶层传 null 或省略。 */
  parentId?: string | null;
  /** 目录名称（非空）。 */
  name: string;
  /** 同级排序值（默认 0）。 */
  sortOrder?: number;
}

/** 更新目录入参。 */
export interface UpdateDirInput {
  /** 新父目录 ID（传 null 移回顶层）。 */
  parentId?: string | null;
  /** 新目录名称。 */
  name?: string;
  /** 新排序权重。 */
  sortOrder?: number;
}

/** 新建文档入参。 */
export interface CreateDocInput {
  /** 可选自定义 ID；缺省按统一格式生成。 */
  id?: string;
  /** 虚拟目录 ID。 */
  dirId?: string | null;
  /** 关联 /work-decision/ 专题节点 ID。 */
  topicId?: string | null;
  /** 文档标题（必填）。 */
  title: string;
  /** 摘要；省略时从正文自动生成简要导读。 */
  summary?: string;
  /** 正文内容。 */
  content?: string;
  /** 外部文件路径或链接。 */
  sourcePath?: string;
  /** 来源分类（默认 note）。 */
  sourceType?: KnowledgeSourceType;
  /** 标签数组（自动剥离前导 # 并去重）。 */
  tags?: string[];
  /** 设为硬性系统规则（默认 false）；只有 HTTP 写接口会带，kb_save 拒绝。 */
  isSystemRule?: boolean;
  /** 别名（去两头空白、去重、去空，最多 20 个，每个最多 60 字）。 */
  aliases?: string[];
  /** 源文件内容的 sha256；只有本地目录同步（FolderSync.ts）写，HTTP 和 kb_save 不带。 */
  contentHash?: string;
}

/** 更新文档局部补丁入参。 */
export interface UpdateDocInput {
  /** 更新虚拟目录（传 null 清空目录归属）。 */
  dirId?: string | null;
  /** 更新关联专题节点 ID（传 null 取消专题挂载）。 */
  topicId?: string | null;
  /** 新标题。 */
  title?: string;
  /** 新摘要。 */
  summary?: string;
  /** 新正文。 */
  content?: string;
  /** 新来源路径。 */
  sourcePath?: string;
  /** 新来源分类。 */
  sourceType?: KnowledgeSourceType;
  /** 全量替换文档标签列表。 */
  tags?: string[];
  /** 设为或取消硬性系统规则。 */
  isSystemRule?: boolean;
  /** 全量替换别名。 */
  aliases?: string[];
  /** 源文件内容的 sha256；只有本地目录同步写。 */
  contentHash?: string;
  /** 编辑时看到的 updatedAt；传了且和库里的不一样，说明别处改过，回 409 不覆盖。不传不查。 */
  baseUpdatedAt?: number;
}

/** 文档分页与多维筛选条件。 */
export interface DocListFilter {
  /** 限定目录 ID（传 '__unassigned__' 只查未归目录文档）。 */
  dirId?: string;
  /** 限定关联专题节点 ID。 */
  topicId?: string;
  /** 限定包含指定标签名。 */
  tag?: string;
  /** 限定这些标签（和 tag 合并去重，大小写不敏感）；按 tagMode 取交集或并集。 */
  tags?: string[];
  /** 多个标签怎么组合：all 全部满足（交集，默认）、any 任一满足（并集）。 */
  tagMode?: KnowledgeTagMode;
  /** 为 true 时只看硬性系统规则。 */
  systemRule?: boolean;
  /** 标题/摘要/正文/标签关键词。 */
  q?: string;
  /** 每页上限（1..200，默认 50）。 */
  limit?: number;
  /** 分页偏移量（默认 0）。 */
  offset?: number;
  /** 列表项是否附带完整 content（默认 false）。 */
  includeContent?: boolean;
}

/** 多标签筛选的组合方式：all 全部满足（交集）、any 任一满足（并集）。 */
export type KnowledgeTagMode = 'all' | 'any';

/** 标签聚合统计项。 */
export interface KnowledgeTagStat {
  /** 标签 ID。 */
  id: string;
  /** 标签名。 */
  name: string;
  /** 绑定该标签的文档总数。 */
  docCount: number;
}

/** 工作台专题挂载资料统计项。 */
export interface KnowledgeTopicStat {
  /** /work-decision/ 专题节点 ID。 */
  topicId: string;
  /** 挂载到该专题下的文档数量。 */
  docCount: number;
}

/** GET /api/knowledge/tree 响应结构。 */
export interface KnowledgeTreeResponse {
  /** 是否成功。 */
  ok: true;
  /** 树状目录列表。 */
  dirs: KnowledgeDirNode[];
  /** 扁平目录列表。 */
  flatDirs: KnowledgeDir[];
  /** 标签计数统计。 */
  tags: KnowledgeTagStat[];
  /** 各专题挂载资料统计。 */
  topics: KnowledgeTopicStat[];
  /** 库内文档总数。 */
  totalDocs: number;
  /** 未归入任何目录的文档数。 */
  unassignedDocs: number;
  /** 硬性系统规则的篇数（1.1.0）。 */
  systemRuleDocs: number;
}

/** 搜索命中的字段（alias 是 1.2.0 加的别名）。 */
export type KnowledgeMatchField = 'title' | 'alias' | 'summary' | 'content' | 'tag';

/** 本地知识库命中项。 */
export interface KnowledgeSearchHit extends KnowledgeDocSummary {
  /** 命中上下文片段。 */
  snippet: string;
  /** 相关性综合得分。 */
  score: number;
  /** 命中的字段列表。 */
  matchedIn: KnowledgeMatchField[];
}

/** 从 memory 服务桥接融合的记忆命中片段。 */
export interface KnowledgeMemoryHit {
  /** 记忆来源（如 knowledge、card、channel）。 */
  source: string;
  /** 记忆条目编号。 */
  id: string;
  /** 片段标题。 */
  title: string;
  /** 命中文本摘要。 */
  snippet: string;
  /** 归一化得分。 */
  score: number;
  /** 时间戳（毫秒）。 */
  at: number;
  /** 原文引用定位符。 */
  ref: string;
}

/** GET /api/knowledge/search 响应结构。 */
export interface KnowledgeSearchResponse {
  /** 是否成功。 */
  ok: true;
  /** 查询词。 */
  query: string;
  /** 本地知识库命中列表。 */
  hits: KnowledgeSearchHit[];
  /** memory 插件与服务本次是否成功响应。 */
  memoryAvailable: boolean;
  /** 来自 memory 桥接的相关记忆命中（未挂载时为空数组）。 */
  memoryHits: KnowledgeMemoryHit[];
  /** memory 部分不可用时的温和说明（不阻塞主响应）。 */
  memoryWarning?: string;
}

//==========================================================
// 标签治理与相关文档推荐（1.0.2）
//==========================================================

/** PUT /api/knowledge/tags/:name 响应：改名或并进已有标签。 */
export interface KnowledgeTagRenameResult {
  /** 是否成功。 */
  ok: true;
  /** 原标签名（库里存的写法）。 */
  oldName: string;
  /** 新标签名。 */
  newName: string;
  /** 新名字已存在、并进去了为 true；只是改名为 false。 */
  merged: boolean;
  /** 受影响的文档数。 */
  affectedDocs: number;
}

/** DELETE /api/knowledge/tags/:name 响应。 */
export interface KnowledgeTagDeleteResult {
  /** 是否成功。 */
  ok: true;
  /** 删掉的标签名（库里存的写法）。 */
  name: string;
  /** 解除了关联的文档数。 */
  affectedDocs: number;
}

/** 相关文档推荐的一项。 */
export interface KnowledgeRelatedItem {
  /** 文档 ID。 */
  id: string;
  /** 标题。 */
  title: string;
  /** 摘要。 */
  summary: string;
  /** 所在目录 ID。 */
  dirId: string | null;
  /** 关联专题 ID。 */
  topicId: string | null;
  /** 标签。 */
  tags: string[];
  /** 相关分：同专题 +3、每个共同标签 +2、同目录 +1。 */
  score: number;
  /** 为什么相关，如 ['同专题', '共同标签: AOBB']。 */
  reasons: string[];
  /** 最近修改毫秒时间戳。 */
  updatedAt: number;
}

/** GET /api/knowledge/docs/:id/related 响应。 */
export interface KnowledgeRelatedResponse {
  /** 是否成功。 */
  ok: true;
  /** 查的是哪篇。 */
  docId: string;
  /** 相关文档，分高的在前，同分新的在前。 */
  items: KnowledgeRelatedItem[];
}


//==========================================================
// [[双链]] 与图谱（1.1.0）
//==========================================================

/** 一篇文档正文里写的一条 [[双链]]（引出链接）。 */
export interface KnowledgeOutlink {
  /** [[ ]] 里写的目标标题（| 后面的显示文字不算）。 */
  targetTitle: string;
  /** 按标题（大小写不敏感）找到的文档 ID；还没有这篇是 null。 */
  targetId: string | null;
  /** 目标文档在不在。 */
  exists: boolean;
  /** 没有同名标题、却有两篇以上用了这个别名：不知道指哪篇，没连（1.2.0）。 */
  ambiguous: boolean;
}

/** 引用了本篇的一篇文档（反向链接）。 */
export interface KnowledgeBacklink {
  /** 文档 ID。 */
  id: string;
  /** 标题。 */
  title: string;
  /** 摘要。 */
  summary: string;
  /** 最近修改毫秒时间戳。 */
  updatedAt: number;
}

/** GET /api/knowledge/docs/:id/links 响应。 */
export interface KnowledgeLinksResponse {
  /** 是否成功。 */
  ok: true;
  /** 本篇写出去的链接，按正文里出现的先后。 */
  outgoing: KnowledgeOutlink[];
  /** 引用了本篇的文档（不含自己），新的在前。 */
  backlinks: KnowledgeBacklink[];
}

/** 图谱里的一个节点（一篇文档）。 */
export interface KnowledgeGraphNode {
  /** 文档 ID。 */
  id: string;
  /** 标题。 */
  title: string;
  /** 所在虚拟目录 ID；未归目录为 null。 */
  dirId?: string | null;
  /** 精简摘要，供图谱画布侧栏轻预览使用。 */
  summary?: string;
  /** 实体别名（1.2.0），供前端 [[ 联想和预览识别别名双链。 */
  aliases?: string[];
  /** 标签。 */
  tags: string[];
  /** 是不是硬性系统规则。 */
  isSystemRule: boolean;
  /** 这张图里连着它的边数（进出都算）。 */
  degree: number;
}

/** 图谱里的一条边：source 正文里写了 [[target 的标题]]。 */
export interface KnowledgeGraphEdge {
  /** 写链接的文档 ID。 */
  source: string;
  /** 被链接的文档 ID。 */
  target: string;
  /** [[ ]] 里写的标题。 */
  targetTitle: string;
}

/** GET /api/knowledge/graph 响应。 */
export interface KnowledgeGraphResponse {
  /** 是否成功。 */
  ok: true;
  /** 节点：不带 centerId 是全部文档；带了是中心和它的一跳邻居。 */
  nodes: KnowledgeGraphNode[];
  /** 边：只含两头都在的链接，不含指向自己的。 */
  edges: KnowledgeGraphEdge[];
}


//==========================================================
// 实体别名消歧与本地文件夹同步（1.2.0）
//==========================================================

/** 消歧时的一篇候选。 */
export interface KnowledgeDisambiguateCandidate {
  /** 文档 ID。 */
  id: string;
  /** 标题。 */
  title: string;
  /** 分类：所在虚拟目录的名字，未归目录是空串。 */
  category: string;
  /** 别名。 */
  aliases: string[];
  /** 摘要。 */
  summary: string;
  /** 是标题对上的（title），还是别名对上的（alias）。 */
  matchedBy: 'title' | 'alias';
}

/** GET /api/knowledge/disambiguate 响应。 */
export interface KnowledgeDisambiguateResponse {
  /** 是否成功。 */
  ok: true;
  /** 查的词（去了两头空白）。 */
  query: string;
  /** 标题和这个词一样（大小写不敏感）的文档，早建的在前。 */
  exact: KnowledgeDisambiguateCandidate[];
  /** 别名里有这个词、标题不是它的文档，早建的在前。 */
  aliasMatches: KnowledgeDisambiguateCandidate[];
  /** exact 加 aliasMatches，标题对上的在前。 */
  candidates: KnowledgeDisambiguateCandidate[];
  /** 候选有两篇以上：写引用、查资料前要先选定是哪篇。 */
  ambiguous: boolean;
}

/** 同步时没处理的一个文件或目录。 */
export interface KnowledgeSyncError {
  /** 文件或目录路径。 */
  path: string;
  /** 为什么没处理。 */
  reason: string;
}

/** 一次本地目录同步的结果。 */
export interface KnowledgeSyncResult {
  /** 扫到的 .md、.txt 文件数。 */
  scanned: number;
  /** 新建了几篇。 */
  created: number;
  /** 内容变了、原位更新了几篇。 */
  updated: number;
  /** 内容没变、跳过了几篇。 */
  skipped: number;
  /** 没处理的文件和目录（太大、读不了、硬性系统规则不覆盖、超过文件数上限）。 */
  errors: KnowledgeSyncError[];
  /** 这次同步完成的毫秒时间戳。 */
  lastSyncedAt: number;
}

/** POST /api/knowledge/sync-folders 响应。 */
export interface KnowledgeSyncResponse extends KnowledgeSyncResult {
  /** 是否成功。 */
  ok: true;
}

/** GET /api/knowledge/sync-status 响应。 */
export interface KnowledgeSyncStatusResponse {
  /** 是否成功。 */
  ok: true;
  /** 插件配置里的 localWatchDirs（规范化后的绝对路径）。 */
  localWatchDirs: string[];
  /** 这次启动以来最近一次同步的结果；还没同步过是 null。 */
  lastSync: KnowledgeSyncResult | null;
}
