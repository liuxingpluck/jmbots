/** Bun 将迁移 SQL 文件作为文本编入可执行文件。 */
declare module '*.sql' {
  const sqlText: string;
  export default sqlText;
}
