/** 核对状态接口的外部数据，只生成当前就绪程序的同源界面入口。 */
export interface ProgramEntry {
  /** 程序唯一名字，也用于稳定的React键。 */
  name: string;
  /** 用户可读名称。 */
  title: string;
  /** 与程序名对应的主站代理路径，不接受任意URL。 */
  ui: string;
  /** 程序自报商业授权的中文标签，不是用户批准。 */
  licenseLabel: string;
}

/** 输入接口原始JSON；非法、离线或无界面的项不显示，不修改原数据。 */
export function getEntries(value: unknown): ProgramEntry[] {
  if (typeof value !== 'object' || value === null || !('programs' in value)) return [];
  if (!Array.isArray(value.programs)) return [];

  const entries: ProgramEntry[] = [];
  const rows: unknown[] = value.programs;
  const names = new Set<string>();
  const labels = new Set(['已授权', '过期', '不需要', '未授权', '未知']);
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    if (!('state' in row) || row.state !== 'ready') continue;
    if (!('name' in row) || typeof row.name !== 'string' || row.name === '') continue;
    if (names.has(row.name)) continue;

    //G 入口只能指向本程序的代理（/programs/<名字>/ 接程序自报的界面路径），防止坏数据生成脚本、其它主机或别的程序的链接。
    const name = row.name;
    const escapedName = encodeURIComponent(name);
    const prefix = `/programs/${escapedName}/`;
    if (!('ui' in row) || typeof row.ui !== 'string' || !row.ui.startsWith(prefix)) continue;
    if (/\/\.\.?(?:\/|$)|\\|\/\//u.test(row.ui)) continue;
    const ui = row.ui;

    let title = name;
    if ('title' in row && typeof row.title === 'string' && row.title.trim() !== '') {
      title = row.title;
    }
    let licenseLabel = '未知';
    if ('licenseLabel' in row && typeof row.licenseLabel === 'string' && labels.has(row.licenseLabel)) {
      licenseLabel = row.licenseLabel;
    }
    names.add(name);
    //M 前面的边界校验已完成，只把本项界面需要的字段交给渲染层。
    const entry = { name, title, ui, licenseLabel };
    entries.push(entry);
  }
  return entries;
}
