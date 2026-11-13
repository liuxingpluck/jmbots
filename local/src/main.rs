//! jmbots.exe：本地壳子的入口（docs/界面/01_界面设计.md 第 4.1 节）。
//!   不带命令（双击）     开 HTTP 接口、托盘、窗口（窗口装载后端托管的网页）；--tray 只开接口和托盘
//!   check               不开窗口的自检，打印 JSON；后端连上退出码 0，连不上 2
//!   serve               只开 HTTP 接口（记忆搜索、RAG），没有窗口和托盘；--supervise 还守护后端、管更新（没有桌面的机器用）
//!   search / ingest / graph        memorycli 的命令（库在运行时的 local.libs 下）
//!   rag-index / rag-search         RAG：建索引、检索（Tantivy + jieba）
//! 按控制台程序编译：终端里跑命令时 shell 会等它结束、输出正常；双击时不弹黑框靠清单（windows/app.manifest，console.rs 有说明）。

use clap::{Parser, Subcommand};
use jmbots_local::{check, config, console, memory, rag, server, supervisor, window};
use std::path::PathBuf;
use std::process::ExitCode;

/// 命令行。
#[derive(Parser)]
#[command(name = "jmbots", version, about = "jmbots 本地壳子：窗口装载后端网页、托盘；记忆搜索和 RAG 接口（取代 memorycli serve）；memorycli 的命令")]
struct Cli {
    /// 运行时目录（不写用环境变量 JMBOTS_RUNTIME，再不写是程序所在目录）
    #[arg(long, global = true)]
    runtime: Option<PathBuf>,
    /// 后端地址，如 http://192.168.1.5:30086（不写用环境变量 JMBOTS_SERVER、config.yaml 的 local.server，再不写是本机的 server.port）
    #[arg(long, global = true)]
    server: Option<String>,
    /// 壳子 HTTP 接口的端口（不写用 config.yaml 的 local.port）
    #[arg(long, global = true)]
    port: Option<u16>,
    /// 壳子 HTTP 接口听哪个地址（不写是 0.0.0.0；调试时写 127.0.0.1 免得防火墙弹窗）
    #[arg(long, global = true)]
    host: Option<String>,
    /// 只开接口和托盘，不开窗口（开机自启用）
    #[arg(long)]
    tray: bool,
    /// 要做什么；不写就开窗口
    #[command(subcommand)]
    command: Option<Command>,
}

/// 子命令。
#[derive(Subcommand)]
enum Command {
    /// 不开窗口的自检：读配置、连后端、开记忆库，打印一份 JSON
    Check,
    /// 只开 HTTP 接口（记忆搜索、RAG），没有窗口和托盘
    Serve {
        /// 同时守护后端、管更新（和窗口模式一样，只是没有窗口）
        #[arg(long)]
        supervise: bool,
    },
    /// 记忆搜索（全文、声明名、标签、路径几路，用 RRF 合成排名）
    Search {
        /// 搜什么（几个词就是“或”，都命中的排前面）
        #[arg(required = true)]
        query: Vec<String>,
        /// 最多几个文件
        #[arg(long, default_value_t = 10)]
        limit: usize,
        /// 只搜这几个库（逗号隔开的库名）；不写是全部
        #[arg(long)]
        lib: Option<String>,
    },
    /// 摄取：增量更新一个库；新库要写 --root（要索引的目录）
    Ingest {
        /// 库名（记忆库目录下的子目录名）
        #[arg(long)]
        lib: String,
        /// 要索引的目录；老库可以不写（用库里记着的）
        #[arg(long)]
        root: Option<PathBuf>,
        /// 不打 AI 标签
        #[arg(long)]
        no_ai: bool,
    },
    /// 关系图谱
    Graph {
        /// 文件路径（或结尾）、声明名、标签、节点 ID；不写是整张图
        name: Option<String>,
        /// 哪个库；只有一个库时可以不写
        #[arg(long)]
        lib: Option<String>,
        /// 走几步
        #[arg(long, default_value_t = 1)]
        depth: usize,
        /// 另外写一个能在浏览器里看的网页
        #[arg(long)]
        html: Option<PathBuf>,
    },
    /// RAG：给库建索引（增量）；不写 --lib 是全部库
    RagIndex {
        /// 只建这几个库（逗号隔开）
        #[arg(long)]
        lib: Option<String>,
    },
    /// RAG：检索片段（BM25 分数）
    RagSearch {
        /// 搜什么
        #[arg(required = true)]
        query: Vec<String>,
        /// 最多几条
        #[arg(long, default_value_t = 10)]
        limit: usize,
        /// 只搜这几个库（逗号隔开）；不写是全部
        #[arg(long)]
        lib: Option<String>,
    },
}

/// 打印一个 JSON。
fn print(value: &impl serde::Serialize) {
    println!("{}", serde_json::to_string_pretty(value).unwrap_or_default());
}

/// 跑命令行的子命令。
fn run_command(command: Command, settings: &config::Settings) -> anyhow::Result<ExitCode> {
    match command {
        Command::Check => {
            let (value, ok) = check::report(settings);
            print(&value);
            Ok(if ok { ExitCode::SUCCESS } else { ExitCode::from(2) })
        }
        Command::Serve { supervise } => {
            server::serve_with(settings, supervise.then(|| supervisor::Supervisor::start(settings)))?;
            Ok(ExitCode::SUCCESS)
        }
        Command::Search { query, limit, lib } => {
            print(&memory::search(settings, &query.join(" "), limit, lib.as_deref())?);
            Ok(ExitCode::SUCCESS)
        }
        Command::Ingest { lib, root, no_ai } => {
            print(&memory::ingest(settings, &lib, root.as_deref(), !no_ai, &|line| eprintln!("{line}"))?);
            Ok(ExitCode::SUCCESS)
        }
        Command::Graph { name, lib, depth, html } => {
            print(&memory::graph(settings, lib.as_deref(), name.as_deref(), depth, html.as_deref())?);
            Ok(ExitCode::SUCCESS)
        }
        Command::RagIndex { lib } => {
            let all = memory::open_libs(settings)?;
            let mut results = serde_json::Map::new();
            for chosen in memorycli::libs::pick(&all, &memorycli::libs::parse_names(lib.as_deref()))? {
                let stats = rag::index_lib(&settings.rag_dir, &chosen.name, &chosen.db, &|line| eprintln!("{line}"))?;
                results.insert(chosen.name.clone(), serde_json::to_value(stats)?);
            }
            print(&results);
            Ok(ExitCode::SUCCESS)
        }
        Command::RagSearch { query, limit, lib } => {
            let all = memory::open_libs(settings)?;
            let chosen: Vec<(String, Option<PathBuf>)> = memorycli::libs::pick(&all, &memorycli::libs::parse_names(lib.as_deref()))?.iter().map(|item| (item.name.clone(), item.root.clone())).collect();
            print(&rag::search(&settings.rag_dir, &chosen, &query.join(" "), limit.clamp(1, 100))?);
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn main() -> ExitCode {
    let cli = Cli::parse();
    let overrides = config::Overrides { runtime: cli.runtime, server: cli.server, port: cli.port, host: cli.host };
    let settings = config::resolve(&overrides, &|name| std::env::var(name).ok(), &config::exe_dir());
    //M 运行时目录不存在就创建（用户 11-05）；建不了的话后面用到时会写明原因。
    let _ = std::fs::create_dir_all(&settings.runtime);
    match cli.command {
        Some(command) => run_command(command, &settings).unwrap_or_else(|error| {
            eprintln!("出错了：{error:#}");
            ExitCode::FAILURE
        }),
        None => {
            console::release_if_alone();
            match window::run(&settings, cli.tray) {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    jmbots_local::log::line(&settings, &format!("窗口起不来：{error:#}"));
                    ExitCode::FAILURE
                }
            }
        }
    }
}
