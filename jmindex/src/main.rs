//! jmindex 命令行。输出都是 JSON（AI 和程序好读）；进度打到 stderr。
//!
//! 用户 11-03：“AI 呢，它应该二进制，然后摄取去更新一下……不摄取就是查找……具体要有几个命令你自己去看，尽量精简。
//! 思路就是去提供 HTTP 服务，HTTP 服务也是很精简的。”
//!
//! 用法（--root 不写是当前目录；索引在 <root>/.jmindex/index.db，配置在 <root>/.jmindex/config.yaml）：
//!   jmindex ingest [--no-ai]                摄取：第一次全量，之后只处理变了的文件（就是更新）；配了模型就打标签
//!   jmindex search 词 [词...] [--limit 10]  搜：返回相关文件，以及每个文件的摘要、标签、命中的声明、片段、相关文件
//!   jmindex graph [名字] [--depth 1] [--html 图.html]
//!                                           关系图谱：从文件、声明、标签出发走几步；不写名字导出整张图（文件这一层）；
//!                                           --html 另外写一个单文件网页，浏览器打开就能拖、缩放、点节点看关系
//!   jmindex serve [--host] [--port]         HTTP 服务：/health、/ingest、/search、/graph

use anyhow::Result;
use clap::{Parser, Subcommand};
use jmindex::{config, graph, http, ingest, search, store::Store};
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "jmindex", version, about = "jmbots 的记忆搜索：代码和文档的全文检索 + 关系图谱 + AI 标签")]
struct Cli {
    /// 要索引的目录。
    #[arg(long, global = true, default_value = ".")]
    root: PathBuf,

    /// 数据库文件；不写是 <root>/.jmindex/index.db。
    #[arg(long, global = true)]
    db: Option<PathBuf>,

    /// 配置文件；不写是 <root>/.jmindex/config.yaml（没有就写一份模板）。
    #[arg(long, global = true)]
    config: Option<PathBuf>,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// 摄取（增量更新）。
    Ingest {
        /// 不打 AI 标签。
        #[arg(long)]
        no_ai: bool,
    },
    /// 搜索。
    Search {
        /// 搜什么（几个词就是“或”，都命中的排前面）。
        #[arg(required = true)]
        query: Vec<String>,
        /// 最多几个文件。
        #[arg(long, default_value_t = 10)]
        limit: usize,
    },
    /// 关系图谱。
    Graph {
        /// 文件路径（或结尾）、声明名（或 外层.名字）、标签、节点 ID；不写导出整张图。
        name: Option<String>,
        /// 走几步。
        #[arg(long, default_value_t = 1)]
        depth: usize,
        /// 另外写一个能在浏览器里看的网页（单个文件，不联网）。
        #[arg(long)]
        html: Option<PathBuf>,
    },
    /// HTTP 服务。
    Serve {
        #[arg(long)]
        host: Option<String>,
        #[arg(long)]
        port: Option<u16>,
    },
}

fn print(value: &impl serde::Serialize) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn run(cli: Cli) -> Result<()> {
    // 用 absolute 不用 canonicalize：Windows 上 canonicalize 会加 \\?\ 前缀。
    let root = std::path::absolute(&cli.root).map_err(|error| anyhow::anyhow!("目录 {} 打不开：{error}", cli.root.display()))?;
    if !root.is_dir() {
        anyhow::bail!("目录 {} 不存在", root.display());
    }
    let db = cli.db.clone().unwrap_or_else(|| root.join(".jmindex").join("index.db"));
    let config = config::load(&root, cli.config.as_deref())?;
    match cli.command {
        Command::Ingest { no_ai } => {
            let mut store = Store::open(&db)?;
            if config.model.is_none() && !no_ai {
                eprintln!("（{} 里没配模型，这次不打 AI 标签）", cli.config.clone().unwrap_or_else(|| config::default_path(&root)).display());
            }
            let stats = ingest::ingest(&mut store, &root, &config, ingest::Options { ai: !no_ai }, &|line| eprintln!("{line}"))?;
            print(&stats)
        }
        Command::Search { query, limit } => {
            let store = Store::open(&db)?;
            print(&search::search(&store, &query.join(" "), limit.clamp(1, 100))?)
        }
        Command::Graph { name, depth, html } => {
            let store = Store::open(&db)?;
            let out = graph::query(&store, name.as_deref(), depth.clamp(1, 4))?;
            if let Some(file) = html {
                std::fs::write(&file, graph::to_html(&out)?).map_err(|error| anyhow::anyhow!("写 {} 失败：{error}", file.display()))?;
                eprintln!("网页写好了：{}（{} 个节点，{} 条边）", file.display(), out.nodes.len(), out.edges.len());
            }
            print(&out)
        }
        Command::Serve { host, port } => {
            let host = host.unwrap_or_else(|| config.http.host.clone());
            let port = port.unwrap_or(config.http.port);
            http::serve(root, db, config, &host, port)
        }
    }
}

fn main() {
    if let Err(error) = run(Cli::parse()) {
        eprintln!("出错了：{error:#}");
        std::process::exit(1);
    }
}
