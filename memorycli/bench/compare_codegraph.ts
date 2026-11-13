/**
 * 准确度对比：memorycli（tree-sitter + 按导入猜）和 jmbots 的 codegraph 工具（src/capabilities/tools/CodeGraph.ts，用 TypeScript 语言服务，
 * 当标准答案）查“谁用到了它”，算召回和准确。
 *
 * 用法（在 jmbots 根目录）：
 *   memorycli ingest --no-ai --db memorycli/demo/jmbots.db
 *   bun memorycli/bench/compare_codegraph.ts memorycli/demo/jmbots.db
 *
 * 比的范围：src/ 下 TypeScript 文件里的函数、方法、类。对比按“文件:行号”。
 * 标准答案里“实现接口的方法、接口里的函数型属性”那几行是声明（实现关系），不是调用，不算。
 */
import { Database } from 'bun:sqlite';
import * as path from 'node:path';
import { queryGraph } from '../../src/capabilities/tools/CodeGraph.ts';


/** jmbots 根目录。 */
const ROOT = path.resolve(import.meta.dir, '..', '..').replaceAll('\\', '/');
/** 数据库。 */
const db = new Database(process.argv[2] ?? path.join(ROOT, 'memorycli', 'demo', 'jmbots.db'), { readonly: true });
/** 要比的声明。 */
const symbols = db
  .query(
    `SELECT f.path, s.qname FROM symbols s JOIN files f ON f.id = s.file_id
     WHERE f.lang = 'typescript' AND f.path LIKE 'src/%' AND s.kind IN ('function', 'method', 'class')`,
  )
  .all() as { path: string; qname: string }[];

let truePositive = 0;
let falseNegative = 0;
let falsePositive = 0;
/** 漏掉的、多出来的（各留一些看）。 */
const misses: string[] = [];
const extras: string[] = [];
for (const symbol of symbols) {
  //M 标准答案。
  const output = queryGraph({ action: 'callers', start: `${ROOT}/src`, name: symbol.qname, file: `${ROOT}/${symbol.path}` });
  const truth = new Set<string>();
  for (const match of output.matchAll(/^ {2}([^\s:]+\.tsx?):(\d+)（[^）]*） {2}(.*)$/gm)) {
    const isDeclaration =
      db.query('SELECT 1 FROM symbols s JOIN files f ON f.id = s.file_id WHERE f.path = ? AND s.line = ?').get(match[1]!, Number(match[2])) !== null ||
      /^\s*(readonly\s+)?[\w$]+\??\s*:\s*\(/.test(match[3]!);
    if (!isDeclaration) {
      truth.add(`${match[1]}:${match[2]}`);
    }
  }
  //M memorycli 的边：calls、refs、types 指向这个声明的，每个行号算一处。
  const rows = db.query("SELECT src, lines FROM edges WHERE dst = ? AND kind IN ('calls', 'refs', 'types')").all(`sym:${symbol.path}#${symbol.qname}`) as {
    src: string;
    lines: string;
  }[];
  const mine = new Set<string>();
  for (const row of rows) {
    const file = row.src.replace(/^(file|sym):/, '').split('#')[0];
    for (const line of row.lines.split(',').filter(Boolean)) {
      mine.add(`${file}:${line}`);
    }
  }
  for (const item of truth) {
    if (mine.has(item)) {
      truePositive += 1;
    } else {
      falseNegative += 1;
      misses.push(`${symbol.qname} ← ${item}`);
    }
  }
  for (const item of mine) {
    if (!truth.has(item)) {
      falsePositive += 1;
      extras.push(`${symbol.qname} ← ${item}`);
    }
  }
}

console.log(`声明 ${symbols.length} 个；标准答案里的引用处 ${truePositive + falseNegative} 个`);
console.log(`召回 ${((100 * truePositive) / (truePositive + falseNegative)).toFixed(1)}%（漏 ${falseNegative}）`);
console.log(`准确 ${((100 * truePositive) / (truePositive + falsePositive)).toFixed(1)}%（多 ${falsePositive}，多数是同一个文件里同名的接口和实现分不清）`);
console.log(`漏的（前 15）：\n  ${misses.slice(0, 15).join('\n  ')}`);
console.log(`多的（前 15）：\n  ${extras.slice(0, 15).join('\n  ')}`);
