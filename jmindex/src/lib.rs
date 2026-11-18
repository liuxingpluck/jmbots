//! jmindex：jmbots 的记忆搜索。把一个目录里的代码和文档摄取成一个 SQLite 索引，
//! 有全文检索（中文也行）、代码和文档的关系图谱、AI 写的摘要和标签，命令行和 HTTP 都能查。
//!
//! 各模块：
//!   config  配置（.jmindex/config.yaml）：模型（OpenAI、Anthropic、Gemini 三种格式）、排除的路径、HTTP
//!   parse   代码解析（tree-sitter）：声明、引用、导入
//!   doc     文档切块、Markdown 标题、文字里提到的文件和代码名
//!   text    全文检索用的文字处理（汉字一个字一个字隔开）
//!   store   数据库
//!   ingest  增量摄取
//!   ai      调模型：打标签、整合标签
//!   graph   算边、查图
//!   search  搜索
//!   http    HTTP 服务

pub mod ai;
pub mod config;
pub mod doc;
pub mod graph;
pub mod http;
pub mod ingest;
pub mod parse;
pub mod search;
pub mod store;
pub mod text;
