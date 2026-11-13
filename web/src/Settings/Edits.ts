/**
 * 设置页的改动（docs/界面/01_界面设计.md 第 10 节），纯函数好测：
 * 拿到的配置 + 用户一步一步的改动 = 草稿；保存时把改动按顺序发给后端（PUT /api/settings），后端照同样的顺序做到 config.yaml 上，
 * 只改动过的那几项，注释和没见过的键都留着。路径里字符串是键、数字是列表的第几项。
 */


/** 路径。 */
export type Path = (string | number)[];


/** 一步改动：设一个值，或删掉一项。 */
export type Edit = { path: Path; value: unknown } | { path: Path; delete: true };


/**
 * 取一个路径上的值。
 * @param root 配置。
 * @param path 路径。
 * @returns 没有是 undefined。
 */
export function getAt(root: unknown, path: Path): unknown {
  /** 走到哪了。 */
  let current = root;
  for (const key of path) {
    if (current === null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string | number, unknown>)[key];
  }
  return current;
}


/**
 * 复制一层（对象或列表）。
 * @param value 这一层。
 * @param nextKey 下一步要进的键（这一层不存在时，按它是不是数字决定建列表还是对象）。
 */
function cloneLevel(value: unknown, nextKey: string | number): Record<string | number, unknown> | unknown[] {
  if (Array.isArray(value)) {
    return [...(value as unknown[])];
  }
  if (value && typeof value === 'object') {
    return { ...(value as Record<string, unknown>) };
  }
  return typeof nextKey === 'number' ? [] : {};
}


/**
 * 做一步改动（不改原来的，返回新的）。
 * @param root 配置。
 * @param edit 改动。
 */
export function applyEdit(root: unknown, edit: Edit): unknown {
  if (edit.path.length === 0) {
    return 'delete' in edit ? undefined : edit.value;
  }
  /** 新的根。 */
  const top = cloneLevel(root, edit.path[0]!);
  /** 一层一层往下复制。 */
  let parent: Record<string | number, unknown> | unknown[] = top;
  for (let index = 0; index < edit.path.length - 1; index += 1) {
    /** 这一层的键。 */
    const key = edit.path[index]!;
    /** 下一层（复制一份）。 */
    const child = cloneLevel((parent as Record<string | number, unknown>)[key], edit.path[index + 1]!);
    (parent as Record<string | number, unknown>)[key] = child;
    parent = child;
  }
  /** 最后一层的键。 */
  const last = edit.path.at(-1)!;
  if ('delete' in edit) {
    if (Array.isArray(parent) && typeof last === 'number') {
      parent.splice(last, 1);
    } else {
      delete (parent as Record<string | number, unknown>)[last];
    }
  } else {
    (parent as Record<string | number, unknown>)[last] = edit.value;
  }
  return top;
}


/**
 * 把一步改动加进改动表：和上一步改的是同一个值（都是设值）时合成一步，免得打一个字记一步。
 * @param edits 已有的改动。
 * @param edit 新的一步。
 */
export function addEdit(edits: Edit[], edit: Edit): Edit[] {
  /** 上一步。 */
  const last = edits.at(-1);
  if (last && !('delete' in last) && !('delete' in edit) && JSON.stringify(last.path) === JSON.stringify(edit.path)) {
    return [...edits.slice(0, -1), edit];
  }
  return [...edits, edit];
}


/**
 * 草稿：配置做完所有改动以后的样子。
 * @param config 拿到的配置。
 * @param edits 改动。
 */
export function draftOf(config: unknown, edits: Edit[]): unknown {
  return edits.reduce(applyEdit, config);
}


/**
 * 这个路径上的值改过没有（和拿到的配置比；改回原值就不算）。
 * @param config 拿到的配置。
 * @param draft 草稿。
 * @param path 路径。
 */
export function changedAt(config: unknown, draft: unknown, path: Path): boolean {
  return JSON.stringify(getAt(config, path)) !== JSON.stringify(getAt(draft, path));
}


/**
 * 逗号隔开的数字（如 retry_delays_ms：2000, 5000）。
 * @param text 输入的文字。
 * @returns 数字列表；有不是数字的就是 undefined。
 */
export function parseNumberList(text: string): number[] | undefined {
  /** 一个一个。 */
  const parts = text.split(/[,，\s]+/).filter(Boolean);
  /** 换成数字。 */
  const numbers = parts.map(Number);
  return numbers.every((number) => Number.isFinite(number)) ? numbers : undefined;
}
