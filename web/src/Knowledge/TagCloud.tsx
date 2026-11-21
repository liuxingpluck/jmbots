/**
 * 知识库左栏的标签云：点标签多选筛选（交集）；「管理标签」打开后每个标签旁出现「改名」「删除」。
 * 改名时输入已有的标签名就是合并；名字里不许有逗号（多标签筛选用逗号分隔）。
 * 增删改的接口调用和刷新都在 KnowledgePage（renameTag、removeTag），这里只管界面。
 * 从 DirTree.tsx 拆出来（云端 29 之后的标签治理，Phase 3）。
 */
import * as react from 'react';
import type * as api from './KnowledgeApi.ts';


/** 标签云的入参。 */
export interface TagCloudProps {
  /** 全部标签和各自的文档数（目录树接口给的）。 */
  tags: api.KnowledgeTreeResponse['tags'];
  /** 现在选中的标签。 */
  selected: string[];
  /** 只读：不显示「管理标签」。 */
  readOnly: boolean;
  /** 点一个标签：没选的加上、选了的去掉。实现在 KnowledgePage 的 pickTag。 */
  pickTag: (tag: string) => void;
  /** 改名（新名字已有就合并）。实现在 KnowledgePage 的 renameTag。 */
  renameTag: (name: string, newName: string) => void;
  /** 删除（只从文档上摘掉）。实现在 KnowledgePage 的 removeTag。 */
  removeTag: (name: string) => void;
}


/** 改名框里的提示：空的、带逗号、和原名一样、和别的标签同名（会合并）。 */
function getRenameHint(name: string, input: string, all: string[]): string {
  const next = input.trim();
  if (next === '') return '输入新名字';

  if (next.includes(',') || next.includes('，')) return '名字里不能有逗号';

  if (next === name) return '和原来一样';

  //M 和后端 findTag 一样大小写不敏感：只改大小写是原地改名；撞上别的标签（不管大小写）才是合并。
  const lower = next.toLowerCase();
  if (lower === name.toLowerCase()) return '';

  const existing = all.find((one) => one.toLowerCase() === lower);
  if (existing !== undefined) return `已有「${existing}」，确定后两个标签自动合并`;

  return '';
}


/**
 * 一个标签的改名框：回车或「确定」提交，Esc 或「取消」收起。
 * @param props 原名、全部标签名、提交和收起。
 */
function RenameBox(props: {
  name: string;
  all: string[];
  submit: (newName: string) => void;
  cancel: () => void;
}) {
  const [input, setInput] = react.useState(props.name);
  const hint = getRenameHint(props.name, input, props.all);

  //M 只有“会合并”的提示还能提交，别的提示（空、逗号、没改）都不能。
  const canSubmit = hint === '' || hint.startsWith('已有');

  const submit = (): void => {
    if (!canSubmit) return;

    props.submit(input.trim());
  };

  const onKeyDown = (event: react.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'Enter') {
      event.preventDefault();
      submit();
      return;
    }
    if (event.key === 'Escape') {
      props.cancel();
    }
  };

  return (
    <div className="kb-tag-rename">
      <input
        value={input}
        autoFocus
        aria-label={`把标签 ${props.name} 改名为`}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={onKeyDown}
      />
      <button type="button" className="kb-link-btn" disabled={!canSubmit} onClick={submit}>确定</button>
      <button type="button" className="kb-link-btn" onClick={props.cancel}>取消</button>
      {hint !== '' && <span className="kb-tag-hint" data-merge={hint.startsWith('已有')}>{hint}</span>}
    </div>
  );
}


/**
 * 左栏标签云。
 * @param props 标签、选中、只读和三个操作。
 * @returns 一个标签都没有时是 null。
 */
export function TagCloud(props: TagCloudProps) {
  /** 「管理标签」开没开：默认关，保持整洁。 */
  const [managing, setManaging] = react.useState(false);

  /** 正在改名的是哪个标签；没有是 undefined。 */
  const [renaming, setRenaming] = react.useState<string | undefined>(undefined);

  if (props.tags.length === 0) return null;

  const all = props.tags.map((item) => item.name);

  /** 开关「管理标签」：关的时候顺手收起改名框。 */
  const toggleManaging = (): void => {
    setManaging((current) => !current);
    setRenaming(undefined);
  };

  /** 删一个标签：先问一句。 */
  const askRemove = (name: string, count: number): void => {
    const ok = window.confirm(`删除标签「${name}」？会从 ${String(count)} 篇文档上摘掉，文档本身不删。`);
    if (!ok) return;

    props.removeTag(name);
  };

  /** 改名提交：交给页面，收起改名框。 */
  const submitRename = (name: string, newName: string): void => {
    setRenaming(undefined);
    props.renameTag(name, newName);
  };

  return (
    <>
      <div className="kb-tree-head">
        <span>标签</span>
        {!props.readOnly && (
          <button type="button" className="kb-link-btn" aria-pressed={managing} onClick={toggleManaging}>
            {managing && '完成'}
            {!managing && '管理标签'}
          </button>
        )}
      </div>
      <div className="kb-tags" data-managing={managing}>
        {props.tags.map((item) => {
          //M 多选：已选的再点一次就去掉，KnowledgePage 的 pickTag 负责增删。
          const isActive = props.selected.includes(item.name);
          return (
            <span key={item.id} className="kb-tag-item">
              <button
                type="button"
                className="kb-tag"
                data-active={isActive}
                aria-pressed={isActive}
                onClick={() => props.pickTag(item.name)}
              >
                #{item.name}<span className="kb-count">{item.docCount}</span>
              </button>
              {managing && renaming !== item.name && (
                <span className="kb-tag-actions">
                  <button type="button" className="kb-link-btn" onClick={() => setRenaming(item.name)}>改名</button>
                  <button
                    type="button"
                    className="kb-link-btn kb-tag-delete"
                    onClick={() => askRemove(item.name, item.docCount)}
                  >
                    删除
                  </button>
                </span>
              )}
              {managing && renaming === item.name && (
                <RenameBox
                  name={item.name}
                  all={all}
                  submit={(newName) => submitRename(item.name, newName)}
                  cancel={() => setRenaming(undefined)}
                />
              )}
            </span>
          );
        })}
      </div>
    </>
  );
}
