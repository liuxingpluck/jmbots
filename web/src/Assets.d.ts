/** 网页里直接 import 的图片：打包时变成带哈希的文件，import 拿到的是它的地址。 */
declare module '*.webp' {
  /** 图片地址。 */
  const url: string;
  export default url;
}


/** 样式表：打包时打进产物，import 只为副作用。 */
declare module '*.css';
