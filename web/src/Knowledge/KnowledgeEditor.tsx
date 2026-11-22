/**
 * 知识库右栏（懒加载）：标题、摘要、目录、标签、专题、来源的编辑，正文源码编辑 / 富文本（RichEditor.tsx，再懒加载一层）/ 预览 / 分屏。
 * [[双链]]（1.1.0）：源码框敲 [[ 弹标题联想（WikiTextarea.tsx），预览里双链渲染成芯片（已有的点了打开，没有的可一键创建），
 * 底部「🔗 双向链接」卡片（LinksPanel.tsx）；「🔒 硬性系统规则」开关，开了标题栏挂锁，AI 只能读不能改。
 * Ctrl+S 保存，保存带 baseUpdatedAt：别处先改过时后端回 409，这里把自己的改动存成草稿、换成最新的再提示。
 * 没保存的改动随手存进 localStorage（按文档号），关页、崩溃后再打开能恢复。
 * KnowledgePage 用 key 区分文档，换文档就重新挂一个编辑器，这里不处理“换文档”。
 */
import * as react from 'react';
import * as markdown from '../Chat/Markdown.tsx';
import * as docList from './DocList.tsx';
import * as dialogs from './KbDialogs.tsx';
import * as api from './KnowledgeApi.ts';
import * as linksPanel from './LinksPanel.tsx';
import * as relatedDocs from './RelatedDocs.tsx';
import * as wiki from './WikiLinks.ts';
import * as wikiTextarea from './WikiTextarea.tsx';

/** 富文本编辑器（Tiptap）：只有切到「富文本」才拉这一块，不拉高首屏。 */
const LazyRichEditor = react.lazy(async () => {
  const loaded = await import('./RichEditor.tsx');
  return { default: loaded.RichEditor };
});

/** 编辑器入参；实现都在 KnowledgePage。 */
export interface EditorProps {
  /** 要编辑的文档；undefined 是新建。 */
  doc: api.KnowledgeDoc | undefined;
  /** 新建时预填的标题、专题、目录（从工作决策“记一篇”或当前所在目录来）。 */
  preset: Preset;
  /** 全部目录（扁平），给目录下拉用。 */
  dirs: api.KnowledgeDir[];
  /** 只读：不能改、不能存、不能删。 */
  readOnly: boolean;
  /** 手机窄屏：顶栏换成返回、保存，默认只看预览。 */
  isMobile: boolean;
  /** 这个编辑器是哪一次打开（KnowledgePage 的 opened.key），存好时原样带回。 */
  editKey: string;
  /** 存好了；created 为 true 是新建出来的；editKey 是发起保存的那个编辑器。 */
  onSaved: (doc: api.KnowledgeDoc, created: boolean, editKey: string) => void;
  /** 删掉了。 */
  onDeleted: (id: string) => void;
  /** 关掉编辑器（手机返回、新建时放弃）。 */
  onClose: () => void;
  /** 有没有没保存的改动，页面换文档、关页前据此确认。 */
  onDirty: (dirty: boolean) => void;
  /** 接口出错，页面统一处理（403 切只读）。 */
  onError: (error: unknown) => void;
  /** 给用户一句提示。 */
  onNotice: (text: string) => void;
  /** 打开另一篇（底部「相关文档」、双链芯片点进去）。实现在 KnowledgePage 的 openDoc。 */
  onOpenDoc: (id: string) => void;
  /** 新建一篇预填好标题的词条（点了还没创建的双链）。实现在 KnowledgePage 的 newDoc。 */
  onCreateDoc: (title: string) => void;
  /** 打开双链图谱抽屉。实现在 KnowledgePage（setGraphOpen）。 */
  onShowGraph: () => void;
  /** 标题索引（小写标题 → 文档号），[[ 联想和预览判断词条在不在都用它。KnowledgePage 用整库图谱建。 */
  titles: wiki.TitleIndex;
  /** 左栏改名、删了标签后库里最新的这篇（KnowledgePage 的 syncOpenedTag 拿的）；没有是 undefined。 */
  tagChange?: TagChange;
}

/** 左栏改名、删了标签：交给编辑器换底稿用（后端改标签会刷新文档的 updatedAt，不换下次保存会误报 409）。 */
export interface TagChange {
  /** 发给哪一次打开的编辑器（opened.key），别的编辑器不认。 */
  editKey: string;
  /** 原标签名。 */
  from: string;
  /** 新标签名（合并时是已有那个的写法）；删除是 null。 */
  to: string | null;
  /** 改完以后库里的这篇。 */
  doc: api.KnowledgeDoc;
}

/** Windows 不让当文件名的设备名（不分大小写，带扩展名也不行）。 */
const RESERVED_FILE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/iu;

/**
 * 导出文件名：Windows 不认的 \ / : * ? " < > | 和控制字符换成下划线，去掉首尾空白和点，最长 100 字。
 * @param title 文档标题。
 * @returns 不带扩展名的文件名；清完是空的叫“未命名”。
 */
function getSafeFileName(title: string): string {
  const replaced = title.replace(/[\\/:*?"<>|\u0000-\u001f]/gu, '_');
  const cleaned = replaced.trim().replace(/^\.+|\.+$/gu, '');
  if (cleaned === '') return '未命名';

  //G CON、NUL、COM1 这类设备名 Windows 存不下：前面加个下划线。
  const clipped = cleaned.slice(0, 100);
  if (RESERVED_FILE_NAME.test(clipped)) return `_${clipped}`;

  return clipped;
}


/**
 * 拼一份带 YAML 头（title、tags、topicId、updatedAt）的 Markdown。字符串都用 JSON 写法，YAML 照样认。
 * @param fields 标题、标签、专题、正文。
 * @param updatedAt 最近修改的毫秒时间戳；新建还没存过是 undefined，不写这一行。
 */
function getExportMarkdown(
  fields: { title: string; tags: string[]; topicId: string | null; content: string },
  updatedAt: number | undefined,
): string {
  const lines = [
    '---',
    `title: ${JSON.stringify(fields.title)}`,
    `tags: ${JSON.stringify(fields.tags)}`,
    `topicId: ${JSON.stringify(fields.topicId)}`,
  ];
  if (updatedAt !== undefined) {
    lines.push(`updatedAt: ${JSON.stringify(new Date(updatedAt).toISOString())}`);
  }
  lines.push('---', '', fields.content);
  return lines.join('\n');
}


/**
 * 让浏览器下载一份 UTF-8 文本：Blob 加一个临时的 <a download>，点完就拿掉，下一拍撤销地址。
 * @param fileName 文件名（带扩展名）。
 * @param text 全文。
 */
function downloadText(fileName: string, text: string): void {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();

  //M 下一拍再撤销：有的浏览器点完还没开始下载，马上撤会下不到。
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}


/** 新建时预填的内容。 */
export interface Preset {
  /** 标题。 */
  title: string;
  /** 工作决策节点号。 */
  topicId: string | null;
  /** 目录号。 */
  dirId: string | null;
}

/** 表单里能改的全部字段。 */
interface Form {
  /** 标题。 */
  title: string;
  /** 摘要；留空时后端从正文提。 */
  summary: string;
  /** Markdown 正文。 */
  content: string;
  /** 所在目录；null 是未归类。 */
  dirId: string | null;
  /** 挂的工作决策节点；null 是没挂。 */
  topicId: string | null;
  /** 标签。 */
  tags: string[];
  /** 别名：用于 [[双链]] 和消歧。 */
  aliases: string[];
  /** 来源分类。 */
  sourceType: api.KnowledgeSourceType;
  /** 来源路径或网址。 */
  sourcePath: string;
  /** 硬性系统规则：只有本人能改，AI 只读。 */
  isSystemRule: boolean;
}

/** 表单的全部字段名，getPatch 逐个比。 */
const FORM_KEYS: readonly (keyof Form)[] = [
  'title',
  'summary',
  'content',
  'dirId',
  'topicId',
  'tags',
  'aliases',
  'sourceType',
  'sourcePath',
  'isSystemRule',
];

/** 正文区怎么显示。 */
type ViewMode = 'edit' | 'rich' | 'preview' | 'split';

/** 来源分类的中文名。 */
const SOURCE_LABELS: Record<api.KnowledgeSourceType, string> = {
  note: '笔记',
  file: '本地文件',
  url: '网页摘录',
  transcript: '转写稿',
};

/** 正文显示方式的中文名。 */
const MODE_LABELS: Record<ViewMode, string> = {
  edit: '源码',
  rich: '富文本',
  preview: '预览',
  split: '分屏',
};


/**
 * 从文档（或新建预填）得到表单。
 * @param doc 文档；undefined 是新建。
 * @param preset 新建预填。
 */
function getForm(doc: api.KnowledgeDoc | undefined, preset: Preset): Form {
  if (doc === undefined) {
    return {
      title: preset.title,
      summary: '',
      content: '',
      dirId: preset.dirId,
      topicId: preset.topicId,
      tags: [],
      aliases: [],
      sourceType: 'note',
      sourcePath: '',
      isSystemRule: false,
    };
  }
  return {
    title: doc.title,
    summary: doc.summary,
    content: doc.content,
    dirId: doc.dirId,
    topicId: doc.topicId,
    tags: doc.tags,
    aliases: doc.aliases,
    sourceType: doc.sourceType,
    sourcePath: doc.sourcePath,
    isSystemRule: doc.isSystemRule === true,
  };
}


/**
 * 只挑出改过的字段，保存时发 PUT 用。
 * @param base 打开时的表单。
 * @param form 现在的表单。
 */
function getPatch(base: Form, form: Form): Partial<Form> {
  const patch: Record<string, unknown> = {};
  for (const key of FORM_KEYS) {
    //M 按 JSON 比，标签数组也能比出变没变。
    const changed = JSON.stringify(form[key]) !== JSON.stringify(base[key]);
    if (changed) {
      patch[key] = form[key];
    }
  }
  return patch as Partial<Form>;
}


/**
 * 表单里的标签照左栏的改名、删除换掉：大小写不敏感找原名，改名换成新名，删除去掉，换完按小写去重。
 * @param tags 表单里的标签。
 * @param from 原标签名。
 * @param to 新标签名；删除是 null。
 * @returns 换好的标签。
 */
function getRenamedTags(tags: string[], from: string, to: string | null): string[] {
  const lowerFrom = from.toLowerCase();
  const result: string[] = [];
  for (const tag of tags) {
    let name = tag;
    if (tag.toLowerCase() === lowerFrom && to === null) continue;

    if (tag.toLowerCase() === lowerFrom && to !== null) {
      name = to;
    }
    const lower = name.toLowerCase();
    if (result.some((one) => one.toLowerCase() === lower)) continue;

    result.push(name);
  }
  return result;
}


/**
 * 草稿在 localStorage 里的键：按文档号分开，新建共用一个。
 * @param doc 文档；undefined 是新建。
 */
function getDraftKey(doc: api.KnowledgeDoc | undefined): string {
  return `jmbots:kb-draft:${doc?.id ?? 'new'}`;
}


/**
 * 读草稿：草稿只存相对底稿改过的字段（云端 29 #4），恢复时套到当时的底稿上。
 * 隐私模式、存储被禁、内容坏了，都当没有草稿（云端 29 #1）。
 * @param key 草稿键。
 * @param base 打开时的表单。
 */
function loadDraft(key: string, base: Form): Partial<Form> | undefined {
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return undefined;

    //G 套上去和底稿一样的不算草稿。
    const fields = JSON.parse(raw) as Partial<Form>;
    const merged = { ...base, ...fields };
    if (JSON.stringify(merged) === JSON.stringify(base)) return undefined;

    return fields;
  } catch {
    return undefined;
  }
}


/**
 * 写草稿；存不进去（隐私模式、超额）交回 false，不抛。
 * @param key 草稿键。
 * @param fields 改过的字段。
 */
function saveDraft(key: string, fields: Partial<Form>): boolean {
  try {
    window.localStorage.setItem(key, JSON.stringify(fields));
    return true;
  } catch {
    return false;
  }
}


/**
 * 删草稿；删不掉也不抛，不能挡住保存、删除之后的流程。
 * @param key 草稿键。
 */
function removeDraft(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    return;
  }
}


/** 胶囊输入框的参数：标签和别名共用。 */
interface ChipInputProps {
  /** 现有的项。 */
  items: string[];
  /** 胶囊前面显示的符号：标签是 #（输入时也去掉开头的 #），别名是空串。 */
  prefix: string;
  /** 输入框的提示字。 */
  placeholder: string;
  /** 只读时不显示 × 和输入框。 */
  disabled: boolean;
  /** 改了以后交回新的一组。 */
  change: (items: string[]) => void;
}


/** 胶囊输入（标签、别名）：回车或逗号变成胶囊，× 去掉，空着按退格删最后一个。 */
function ChipInput(props: ChipInputProps): react.JSX.Element {
  const [text, setText] = react.useState('');

  //M 把输入框里的字收成一项：去掉两头空白（标签还去掉开头的 #），重复的不加。
  const commit = (): void => {
    let name = text.trim();
    if (props.prefix === '#') {
      name = name.replace(/^#+/u, '').trim();
    }
    setText('');
    //G 和后端一样大小写不敏感：已有 AOBB 再敲 aobb 不加。
    const lower = name.toLowerCase();
    if (name === '' || props.items.some((item) => item.toLowerCase() === lower)) return;

    props.change([...props.items, name]);
  };
  const onKeyDown = (event: react.KeyboardEvent<HTMLInputElement>): void => {
    //G 中文输入法还在选字时的回车不算（云端 29 #5）。
    if (event.nativeEvent.isComposing || event.keyCode === 229) return;

    if (event.key === 'Enter' || event.key === ',' || event.key === '，') {
      event.preventDefault();
      commit();
      return;
    }
    if (event.key === 'Backspace' && text === '' && props.items.length > 0) {
      props.change(props.items.slice(0, -1));
    }
  };

  return (
    <div className="kb-tag-input">
      {props.items.map((chip) => (
        <span key={chip} className="kb-chip">
          {props.prefix}{chip}
          {!props.disabled && (
            <button type="button" onClick={() => props.change(props.items.filter((item) => item !== chip))}>×</button>
          )}
        </span>
      ))}
      {!props.disabled && (
        <input
          value={text}
          placeholder={props.placeholder}
          onChange={(event) => setText(event.target.value)}
          onKeyDown={onKeyDown}
          onBlur={commit}
        />
      )}
    </div>
  );
}


/** 知识库编辑器。 */
export function KnowledgeEditor(props: EditorProps): react.JSX.Element {
  const { readOnly, isMobile, onDirty, onNotice, titles } = props;
  const kbDialog = dialogs.useKbDialog();
  const draftKey = getDraftKey(props.doc);

  //M 打开时的文档和表单：保存成功、冲突换新都会更新，判断“改没改”跟它比。
  const [base, setBase] = react.useState(props.doc);
  const [baseForm, setBaseForm] = react.useState(() => getForm(props.doc, props.preset));
  const [form, setForm] = react.useState(baseForm);
  const [draft, setDraft] = react.useState(() => loadDraft(draftKey, baseForm));
  const [saving, setSaving] = react.useState(false);

  //M savingRef 同步上锁：按住 Ctrl+S 连发时，state 还没更新也拦得住（云端 29 #11）。
  //M formRef 拿最新的表单：保存回来时比一比用户有没有接着改（云端 29 #2）。
  //M warnedRef：草稿存不进去只提示一次。
  const savingRef = react.useRef(false);
  const formRef = react.useRef(form);
  formRef.current = form;
  const warnedRef = react.useRef(false);

  //M 手机上打开已有文档默认只看预览（不弹键盘），新建直接编辑；桌面默认分屏。
  let firstMode: ViewMode = 'split';
  if (isMobile) {
    firstMode = 'edit';
  }
  if (isMobile && props.doc !== undefined) {
    firstMode = 'preview';
  }
  const [mode, setMode] = react.useState<ViewMode>(firstMode);

  const dirty = JSON.stringify(form) !== JSON.stringify(baseForm);
  const isNew = base === undefined;

  //M 改动告诉页面；有改动时随手存草稿（冲突、保存成功、丢弃时再明确删）。
  react.useEffect(() => onDirty(dirty), [dirty, onDirty]);
  react.useEffect(() => {
    if (!dirty || readOnly) return;

    //M 草稿只存改过的字段；存不进去提示一次，不打断编辑。
    const ok = saveDraft(draftKey, getPatch(baseForm, form));
    if (ok || warnedRef.current) return;

    warnedRef.current = true;
    onNotice('浏览器不让存草稿（隐私模式或空间满了），记得手动保存');
  }, [baseForm, dirty, draftKey, form, onNotice, readOnly]);

  /** 改一个字段。 */
  const setField = <K extends keyof Form>(key: K, value: Form[K]): void => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  /** 换成一篇新的底稿（保存成功、冲突时库里最新的）。 */
  const rebase = (doc: api.KnowledgeDoc): void => {
    const next = getForm(doc, props.preset);
    setBase(doc);
    setBaseForm(next);
    setForm(next);
  };

  //M 左栏改名、删了标签：库里这篇的 updatedAt 跟着变了，换成最新底稿，免得下次保存误报 409。
  //M 自己没动过的字段取库里最新的，动过的留着；标签动过的照新名字换，不把旧标签写回去。
  const tagChange = props.tagChange;
  react.useEffect(() => {
    if (tagChange === undefined || tagChange.editKey !== props.editKey) return;

    //G 不是这篇、或库里没变（这篇没挂那个标签）：不动。
    const latest = tagChange.doc;
    if (base === undefined || latest.id !== base.id || latest.updatedAt === base.updatedAt) return;

    const nextBaseForm = getForm(latest, props.preset);
    const mine = getPatch(baseForm, formRef.current);
    const next = { ...nextBaseForm, ...mine };
    if (mine.tags !== undefined) {
      next.tags = getRenamedTags(mine.tags, tagChange.from, tagChange.to);
    }
    setBase(latest);
    setBaseForm(nextBaseForm);
    setForm(next);
  }, [tagChange]);

  //==========================================================
  //M 保存：新建走 POST；已有的只发改过的字段，带 baseUpdatedAt 防覆盖
  //==========================================================
  const save = async (): Promise<void> => {
    //G 只读、正在存、没改过的已有文档：不存。
    if (readOnly || savingRef.current) return;
    if (!dirty && !isNew) return;

    //G 标题不能空（后端也拦，这里先说清楚）。
    if (form.title.trim() === '') {
      onNotice('标题不能为空');
      return;
    }

    //M 上锁，记下发出去的是哪一版表单。
    savingRef.current = true;
    setSaving(true);
    const sent = JSON.stringify(form);
    try {
      //M 新建：先告诉页面（页面会换成这篇），再删草稿；删草稿出错也不会让新建重发（云端 29 #1）。
      if (base === undefined) {
        const created = await api.createDoc({ ...form, title: form.title.trim() });
        props.onSaved(created, true, props.editKey);
        removeDraft(draftKey);
        return;
      }

      //M 已有：只发改过的字段，带上打开时的 updatedAt。
      const patch = { ...getPatch(baseForm, form), baseUpdatedAt: base.updatedAt };
      if (patch.title !== undefined) {
        patch.title = patch.title.trim();
      }
      const result = await api.updateDoc(base.id, patch);

      //G 别处先改过：只把自己改过的字段存成草稿，换成库里最新的；恢复时只套这几项，别人改的别的字段不被改回去。
      if (result.conflict) {
        const mine = getPatch(baseForm, formRef.current);
        saveDraft(draftKey, mine);
        setDraft(mine);
        rebase(result.doc);
        onNotice('这篇在别处改过，已换成最新的；你刚才的改动存成了草稿，点“恢复草稿”可以拿回来');
        return;
      }

      //M 存好：告诉页面刷新列表。保存期间用户没再改，整份换成回来的；接着改了的，只换底稿，留着新敲的字。
      props.onSaved(result.doc, false, props.editKey);
      setDraft(undefined);
      const unchanged = JSON.stringify(formRef.current) === sent;
      if (unchanged) {
        removeDraft(draftKey);
        rebase(result.doc);
        return;
      }
      setBase(result.doc);
      setBaseForm(getForm(result.doc, props.preset));
    } catch (error) {
      props.onError(error);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  //M Ctrl+S（Mac 上 Cmd+S）保存；用 ref 拿到最新的 save，监听只挂一次。
  const saveRef = react.useRef(save);
  saveRef.current = save;
  react.useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      const isSave = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's';
      if (!isSave) return;

      event.preventDefault();
      void saveRef.current();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  //M 删除：应用内确认框二次确认；新建还没存的直接关掉。
  const remove = async (): Promise<void> => {
    if (base === undefined) {
      removeDraft(draftKey);
      props.onClose();
      return;
    }
    const ok = await kbDialog.confirm({
      title: `删除文档「${base.title}」`,
      message: '删除后无法恢复，确定永久删除这篇知识文档吗？',
      confirmText: '永久删除',
      danger: true,
    });
    if (!ok) return;

    try {
      await api.deleteDoc(base.id);
      props.onDeleted(base.id);
      removeDraft(draftKey);
    } catch (error) {
      props.onError(error);
    }
  };

  //M 草稿条：恢复就把草稿里改过的字段套到现在的底稿上，丢弃就删掉。
  const restoreDraft = (): void => {
    if (draft === undefined) return;

    setForm({ ...baseForm, ...draft });
    setDraft(undefined);
  };
  const dropDraft = (): void => {
    removeDraft(draftKey);
    setDraft(undefined);
  };

  //M 手机上不给分屏。
  let modes: ViewMode[] = ['edit', 'rich', 'preview', 'split'];
  if (isMobile) {
    modes = ['edit', 'rich', 'preview'];
  }
  let saveText = '保存';
  if (saving) {
    saveText = '正在保存…';
  }
  //M 导出 .md：用表单里现在的内容（没保存的改动也导出），文件名按标题清洗。
  const exportMarkdown = (): void => {
    const text = getExportMarkdown(form, base?.updatedAt);
    const fileName = `${getSafeFileName(form.title)}.md`;
    downloadText(fileName, text);
  };

  const showSource = mode === 'edit' || mode === 'split';
  const showPreview = mode === 'preview' || mode === 'split';
  const canSave = !readOnly && !saving && (dirty || isNew);

  //M 预览前把 [[双链]] 换成页内锚点链接，地址里标着词条在不在（WikiLinks.ts）。
  const previewText = react.useMemo(() => wiki.toWikiMarkdown(form.content, titles), [form.content, titles]);

  /** 预览里点了链接：是双链就接管，已有的打开，没有的问一句再新建；别的链接照常。 */
  const onPreviewLink = (href: string): boolean => {
    const title = wiki.getWikiTitle(href);
    if (title === undefined) return false;

    const found = titles.get(title.toLowerCase());
    if (found !== undefined) {
      props.onOpenDoc(found.id);
      return true;
    }
    if (readOnly) {
      onNotice(`还没有「${title}」这篇`);
      return true;
    }
    void kbDialog.confirm({
      title: '创建新双链词条',
      message: `知识库还没有「${title}」这篇文档，是否现在新建？`,
      confirmText: '立即创建',
    }).then((ok) => {
      if (ok) {
        props.onCreateDoc(title);
      }
    });
    return true;
  };

  //M 双向链接卡片里的「创建该词条」：只读时不给。
  let createTitled: ((title: string) => void) | undefined;
  if (!readOnly) {
    createTitled = props.onCreateDoc;
  }

  return (
    <article className="kb-editor" data-mode={mode}>
      <header className="kb-editor-bar">
        {isMobile && <button type="button" className="kb-icon-btn" onClick={props.onClose} aria-label="返回">←</button>}
        <div className="kb-modes" role="tablist">
          {modes.map((item) => (
            <button key={item} type="button" data-active={mode === item} onClick={() => setMode(item)}>
              {MODE_LABELS[item]}
            </button>
          ))}
        </div>
        {form.isSystemRule && (
          <span className="kb-rule-badge" title="硬性系统规则：只有你本人能在这里改，AI 只能读">🔒 硬性系统规则</span>
        )}
        <span className="kb-grow" />
        {dirty && <span className="kb-dirty" title="有没保存的改动">●</span>}
        {!isNew && <span className="kb-muted kb-small">{docList.getShortTime(base.updatedAt)}</span>}
        <button type="button" className="kb-link-btn" onClick={props.onShowGraph} title="看这篇和它的双链邻居">
          🕸️ 图谱
        </button>
        <button type="button" className="kb-link-btn" onClick={exportMarkdown} title="下载成带 YAML 头的 Markdown 文件">
          导出 .md
        </button>
        {!readOnly && <button type="button" className="kb-danger-btn" onClick={() => void remove()}>删除</button>}
        {!readOnly && (
          <button type="button" className="kb-primary-btn" disabled={!canSave} onClick={() => void save()}>
            {saveText}
          </button>
        )}
      </header>
      {readOnly && <p className="kb-notice">只读：需要先登录才能修改</p>}
      {draft !== undefined && (
        <p className="kb-notice">
          有一份没保存的草稿
          <button type="button" className="kb-link-btn" onClick={restoreDraft}>恢复草稿</button>
          <button type="button" className="kb-link-btn" onClick={dropDraft}>丢弃</button>
        </p>
      )}
      <input
        className="kb-title-input"
        value={form.title}
        placeholder="标题"
        readOnly={readOnly}
        onChange={(event) => setField('title', event.target.value)}
      />
      <div className="kb-meta-grid">
        <label>
          <span>目录</span>
          <select
            value={form.dirId ?? ''}
            disabled={readOnly}
            onChange={(event) => setField('dirId', event.target.value || null)}
          >
            <option value="">未归类</option>
            {props.dirs.map((dir) => <option key={dir.id} value={dir.id}>{dir.name}</option>)}
          </select>
        </label>
        <label>
          <span>来源</span>
          <select
            value={form.sourceType}
            disabled={readOnly}
            onChange={(event) => setField('sourceType', event.target.value as api.KnowledgeSourceType)}
          >
            {Object.entries(SOURCE_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
          </select>
        </label>
        <label className="kb-meta-wide">
          <span>标签</span>
          <ChipInput
            items={form.tags}
            prefix="#"
            placeholder="加标签，回车确定"
            disabled={readOnly}
            change={(tags) => setField('tags', tags)}
          />
        </label>
        <label className="kb-meta-wide" title="同一实体的别的叫法：[[别名]] 也能连到这篇，同名时用来消歧">
          <span>别名</span>
          <ChipInput
            items={form.aliases}
            prefix=""
            placeholder="用于 [[双链]] 与消歧，逗号或回车添加"
            disabled={readOnly}
            change={(aliases) => setField('aliases', aliases)}
          />
        </label>
        {form.sourceType !== 'note' && (
          <label className="kb-meta-wide">
            <span>路径</span>
            <input
              value={form.sourcePath}
              placeholder="文件路径或网址"
              readOnly={readOnly}
              onChange={(event) => setField('sourcePath', event.target.value)}
            />
          </label>
        )}
        {form.topicId !== null && (
          <div className="kb-meta-wide kb-topic-line">
            <span>专题</span>
            <a className="kb-topic" href={docList.getTopicHref(form.topicId)}>在工作决策里打开 {form.topicId}</a>
            {!readOnly && (
              <button type="button" className="kb-link-btn" onClick={() => setField('topicId', null)}>解除</button>
            )}
          </div>
        )}
        <label className="kb-meta-wide kb-rule-toggle" data-on={form.isSystemRule}>
          <input
            type="checkbox"
            checked={form.isSystemRule}
            disabled={readOnly}
            onChange={(event) => setField('isSystemRule', event.target.checked)}
          />
          <b>🔒 设为硬性系统规则</b>
          <em>（AI 仅只读不可修改，只有你本人能在这里改）</em>
        </label>
        <label className="kb-meta-wide">
          <span>摘要</span>
          <input
            value={form.summary}
            placeholder="留空就从正文自动提"
            readOnly={readOnly}
            onChange={(event) => setField('summary', event.target.value)}
          />
        </label>
      </div>
      <div className="kb-body">
        {showSource && (
          <wikiTextarea.WikiTextarea
            value={form.content}
            readOnly={readOnly}
            titles={titles}
            onChange={(text) => setField('content', text)}
          />
        )}
        {mode === 'rich' && (
          <react.Suspense fallback={<p className="kb-muted kb-center">正在加载富文本编辑器…</p>}>
            <LazyRichEditor
              value={form.content}
              readOnly={readOnly}
              onChange={(markdown) => setField('content', markdown)}
            />
          </react.Suspense>
        )}
        {showPreview && (
          <div className="kb-preview">
            {form.content.trim() === '' && <p className="kb-muted">还没有正文</p>}
            <markdown.Markdown text={previewText} onOpen={() => undefined} onLink={onPreviewLink} />
          </div>
        )}
      </div>
      {base !== undefined && (
        <linksPanel.LinksPanel docId={base.id} version={base.updatedAt} open={props.onOpenDoc} create={createTitled} />
      )}
      {base !== undefined && <relatedDocs.RelatedDocs docId={base.id} open={props.onOpenDoc} />}
      {kbDialog.modalElement}
    </article>
  );
}
