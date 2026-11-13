//! 关系图谱：摄取完从数据库的原始记录（声明、引用、导入、提及、标签）算出边，再按名字查邻居。
//!
//! 边的种类（weight 是置信度，0～1）：
//!   contains  文件 → 它的声明（1.0）
//!   imports   文件 → 文件，或文件 → pkg:外部包（1.0）
//!   calls     声明（或文件顶层）→ 被调用的声明；refs 是当值传出去（回调、{ handleMessage }）；types 是当类型用
//!   uses      文件 → 文件：calls/refs 汇总到文件这一层，看文件之间谁依赖谁
//!   mentions  文件 → 文件或声明：文字里提到了它（注释、文档、反引号）
//!   links     Markdown 链接 → 文件（1.0）
//!   tagged    文件 → tag:标签（AI 打的，按整合后的标准名）
//!
//! 调用怎么对上声明（只看语法，所以要猜，猜得越没把握权重越低）：
//!   同一个文件里有这个名字            0.9
//!   导入了的文件里有（Go：同一个包）   0.8
//!   全局只有 1～3 个同名的            0.4（ref 不走这一级，太乱）
//!   再多就不连（push、get、map 这种名字到处都是）
//!   同一级对上好几个（接口和实现同名的方法），权重按个数平分，最低 0.2
//!
//! 分成三个文件（2026-11-04 框架设计第 8 节第 2 步，原来都挤在一个 graph.rs 里）：
//!   build  算边：摄取完从原始记录重新算整张图（ingest 调）
//!   query  查图：按名字找起点、沿边走几步、补全节点信息（search、HTTP、命令行调）
//!   view   导网页：把查图结果写成能拖、缩放、点节点的单文件网页
//! 对外的函数都从这里转出去，调用方照旧写 graph::query、graph::rebuild。

mod build;
mod query;
mod view;

pub use build::rebuild;
pub use query::{EdgeOut, GraphOut, NodeOut, describe, find_start, parse_lines, query};
pub use view::to_html;

/// 文件节点 ID。
pub fn file_node(path: &str) -> String {
    format!("file:{path}")
}

/// 声明节点 ID。
pub fn sym_node(path: &str, qname: &str) -> String {
    format!("sym:{path}#{qname}")
}

