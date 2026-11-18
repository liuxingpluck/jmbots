/** 从模型 JSON 的文本字段取出可提前呈现的完整短句。调用方仍须验证最终回执与当前租约。 */

const TEXT_FIELD = /^\s*\{\s*"text"\s*:\s*"((?:[^"\\\u0000-\u001F]|\\["\\/bfnrt]|\\u[\dA-Fa-f]{4})*)/u;
const BOUNDARY = /[。！？!?，]/gu;
const MAX_PREFIX = 4096;

/**
 * 读取从开头累计的模型文本，输出已经出现完整停顿的第一句话或分句。
 * 只解释 JSON 字符串中的文字，尚未完成的转义和协议外文本不会进浮窗。
 */
export function getFirstPhrase(prefix: string): string | undefined {
  //G 限定可检查的模型输出范围，跳过非预期的首字段。
  if (prefix.length > MAX_PREFIX) return undefined;

  const matched = TEXT_FIELD.exec(prefix);
  const encoded = matched?.[1];
  if (encoded === undefined) return undefined;

  //M 复用 JSON 解码转义，避免 Unicode 或双引号在流传输中显示错字。
  const json = '"' + encoded + '"';
  const text = (JSON.parse(json) as string).trimStart();
  if (/[\u0000-\u001F\u007F]/u.test(text)) return undefined;

  //M 等足够长的完整分句，逗号可让较长解释先说出控件名称。
  const boundaries = text.matchAll(BOUNDARY);
  for (const boundary of boundaries) {
    const end = boundary.index + boundary[0].length;
    if (end >= 5 && end <= 160) return text.slice(0, end);
  }

  return undefined;
}
