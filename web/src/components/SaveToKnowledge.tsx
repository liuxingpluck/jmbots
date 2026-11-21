/**
 * 公共组件「存入知识库」：在记忆页（/memory/，默认标签“记忆沉淀”）、图谱页（/graph/，“图谱沉淀”）看到好内容，一点就存成知识库里的一篇笔记。
 * 页面打开时探一次 GET /api/knowledge/tree：知识库没启用（404）、失败时按钮整块不显示；能用就把目录拿来给下拉选。
 * 存的时候 POST /api/knowledge/docs（sourceType: note），成功给「去知识库查看 ↗」链接，失败照后端的中文原因说。
 * 接口在 src7/plugins/knowledge（只调接口，不 import 那边的代码）。
 */
import { useEffect, useState } from 'react';
import { TOKEN, withToken } from '../Token.ts';
import './SaveToKnowledge.css';


/** 知识库目录（只取用到的两项，字段同 src7/plugins/knowledge/Types.ts 的 KnowledgeDir）。 */
export interface KnowledgeDirOption {
  /** 目录号。 */
  id: string;
  /** 目录名。 */
  name: string;
}

/** 标题默认取多少字。 */
const TITLE_MAX = 40;


/**
 * 探一次知识库能不能用，顺带拿目录。
 * @returns undefined 是还在探或用不了（按钮不显示）；数组是能用，内容是目录（可能为空）。
 */
export function useKnowledgeDirs(): KnowledgeDirOption[] | undefined {
  const [dirs, setDirs] = useState<KnowledgeDirOption[] | undefined>(undefined);

  useEffect(() => {
    const controller = new AbortController();
    const address = withToken('/api/knowledge/tree', TOKEN);

    //M 只探一次：404、网络错、回包不对都当用不了，静默不显示。
    const probe = async (): Promise<void> => {
      try {
        const response = await fetch(address, { signal: controller.signal });
        if (!response.ok) return;

        const body = await response.json() as { ok?: unknown; flatDirs?: unknown };
        if (body.ok !== true) return;

        let flat: KnowledgeDirOption[] = [];
        if (Array.isArray(body.flatDirs)) {
          flat = body.flatDirs as KnowledgeDirOption[];
        }
        setDirs(flat);
      } catch {
        //G 用不了就不显示按钮，什么都不说。
      }
    };
    void probe();
    return () => {
      controller.abort();
    };
  }, []);

  return dirs;
}


/**
 * 默认标题：给的标题；没有就取正文前 40 字。
 * @param title 预填标题。
 * @param content 预填正文。
 */
function getDefaultTitle(title: string, content: string): string {
  const trimmed = title.trim();
  if (trimmed !== '') return trimmed.slice(0, 100);

  const firstLine = content.trim().split(/\r?\n/u)[0] ?? '';
  return firstLine.slice(0, TITLE_MAX);
}


/**
 * 把标签框里的字拆成标签：按空格分，去空、去重。逗号不许用（提交前就拦住）。
 * @param input 标签框里的字。
 */
function getTags(input: string): string[] {
  const parts = input.split(/\s+/u).filter((one) => one !== '');
  return [...new Set(parts)];
}


/**
 * 存进知识库。
 * @param body 标题、正文、目录、标签。
 * @returns 新文档号。
 * @throws 后端的中文原因（403 只读、未核验等）。
 */
async function createNote(body: {
  title: string;
  content: string;
  dirId: string | null;
  tags: string[];
}): Promise<string> {
  const address = withToken('/api/knowledge/docs', TOKEN);
  const payload = JSON.stringify({ ...body, sourceType: 'note' });
  const response = await fetch(address, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: payload,
  });
  const result = await response.json().catch(() => ({})) as { ok?: unknown; doc?: { id?: string }; error?: string };

  //G 没存成：用后端给的原因，没有就写状态码。
  if (!response.ok || result.ok !== true) {
    throw new Error(result.error ?? `存入失败（${String(response.status)}）`);
  }
  return result.doc?.id ?? '';
}


/** SaveToKnowledge 的入参。 */
export interface SaveToKnowledgeProps {
  /** 预填标题。 */
  title: string;
  /** 预填正文（Markdown）。 */
  content: string;
  /** 默认标签，比如“记忆沉淀”“图谱沉淀”。 */
  defaultTag: string;
  /** 额外的类名，挂在按钮、面板、完成提示的最外层，给页面微调位置用。 */
  className?: string;
  /** 知识库的目录（useKnowledgeDirs 拿到的）。 */
  dirs: KnowledgeDirOption[];
}


/**
 * 「存入知识库」按钮和内联面板。整块阻止点击冒泡，免得点到外面的卡片。
 * @param props 预填内容和目录。
 */
export function SaveToKnowledgeButton(props: SaveToKnowledgeProps) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(() => getDefaultTitle(props.title, props.content));
  const [content, setContent] = useState(props.content);
  const [dirId, setDirId] = useState('');
  const [tagInput, setTagInput] = useState(props.defaultTag);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [savedId, setSavedId] = useState<string | undefined>(undefined);

  /** 拼上页面给的额外类名。 */
  const withExtra = (base: string): string => {
    if (props.className === undefined || props.className === '') return base;

    return `${base} ${props.className}`;
  };

  //G 标签里不许有逗号（知识库多标签筛选用逗号分隔）。
  const hasComma = tagInput.includes(',') || tagInput.includes('，');
  const canSave = !saving && title.trim() !== '' && !hasComma;

  /** 存：防连点，成功记下新文档号，失败写原因。 */
  const save = async (): Promise<void> => {
    if (!canSave) return;

    setSaving(true);
    setError('');
    try {
      let dir: string | null = null;
      if (dirId !== '') {
        dir = dirId;
      }
      const id = await createNote({ title: title.trim(), content, dirId: dir, tags: getTags(tagInput) });
      setSavedId(id);
    } catch (caught) {
      let message = String(caught);
      if (caught instanceof Error) {
        message = caught.message;
      }
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  //M 存好了：一行提示加链接，不再显示面板。
  if (savedId !== undefined) {
    let href = withToken('/knowledge/', TOKEN);
    if (savedId !== '') {
      href = withToken(`/knowledge/?doc=${encodeURIComponent(savedId)}`, TOKEN);
    }
    return (
      <div className={withExtra('kb-save-done')} onClick={(event) => event.stopPropagation()}>
        已存入知识库 <a href={href} target="_blank" rel="noreferrer">去知识库查看 ↗</a>
      </div>
    );
  }

  //M 没展开：只有一个小按钮。
  if (!open) {
    return (
      <button
        type="button"
        className={withExtra('kb-save-btn')}
        onClick={(event) => {
          event.stopPropagation();
          setOpen(true);
        }}
      >
        存入知识库
      </button>
    );
  }

  return (
    <div className={withExtra('kb-save-panel')} onClick={(event) => event.stopPropagation()}>
      <label>
        <span>标题</span>
        <input value={title} maxLength={200} onChange={(event) => setTitle(event.target.value)} />
      </label>
      <label>
        <span>正文</span>
        <textarea value={content} rows={6} onChange={(event) => setContent(event.target.value)} />
      </label>
      <div className="kb-save-row">
        <label>
          <span>目录</span>
          <select value={dirId} onChange={(event) => setDirId(event.target.value)}>
            <option value="">未归类</option>
            {props.dirs.map((dir) => <option key={dir.id} value={dir.id}>{dir.name}</option>)}
          </select>
        </label>
        <label>
          <span>标签（空格分开）</span>
          <input value={tagInput} onChange={(event) => setTagInput(event.target.value)} />
        </label>
      </div>
      {hasComma && <p className="kb-save-error">标签里不能有逗号，用空格分开</p>}
      {error !== '' && <p className="kb-save-error" role="alert">{error}</p>}
      <div className="kb-save-actions">
        <button type="button" className="kb-save-save" disabled={!canSave} onClick={() => void save()}>
          {saving && '正在存…'}
          {!saving && '存入'}
        </button>
        <button type="button" className="kb-save-cancel" disabled={saving} onClick={() => setOpen(false)}>取消</button>
      </div>
    </div>
  );
}
