//! jmbots.exe：本地壳子的入口（docs/界面/01_界面设计.md 第 4.1 节）。
//!   不带命令（双击）     开 HTTP 接口、托盘、窗口（窗口装载后端托管的网页）；--tray 只开接口和托盘
//!   check               不开窗口的自检，打印 JSON；后端连上退出码 0，连不上 2
//!   serve               只开 HTTP 接口（更新、重启、托管服务；记忆接口转给记忆服务），没有窗口和托盘；--supervise 还守护后端和托管服务、管更新
//!   （2026-11-14：search / ingest / graph / rag-index / rag-search 搬进记忆服务 jmbots-memory 自己的命令行，基地只承载）
//! 按控制台程序编译：终端里跑命令时 shell 会等它结束、输出正常；双击时不弹黑框靠清单（windows/app.manifest，console.rs 有说明）。

use clap::{Parser, Subcommand};
use jmbots_local::{check, config, console, server, supervisor, window};
use std::path::PathBuf;
use std::process::ExitCode;

/// 命令行。
#[derive(Parser)]
#[command(name = "jmbots", version, about = "jmbots 本地壳子（基地）：窗口装载后端网页、托盘；守护后端和托管服务（记忆服务等）、更新、重启")]
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
    /// 不开窗口的自检：读配置、连后端、看各托管服务健康，打印一份 JSON
    Check,
    /// 只开 HTTP 接口（更新、重启、托管服务；记忆接口转给记忆服务），没有窗口和托盘
    Serve {
        /// 同时守护后端和托管服务、管更新（和窗口模式一样，只是没有窗口）
        #[arg(long)]
        supervise: bool,
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
            let (guard, hosted) = if supervise { (Some(supervisor::Supervisor::start(settings)), None) } else { (None, None) };
            server::serve_with(settings, guard, hosted)?;
            Ok(ExitCode::SUCCESS)
        }
    }
}

fn main() -> ExitCode {
    // 在任何子进程/线程启动之前加入 Job；后续子孙自动继承，不存在 spawn 后绑定的竞态。
    let _job = match jmbots_local::process_job::ProcessJob::new() {
        Ok(job) => job,
        Err(error) => { eprintln!("进程生命周期保护初始化失败：{error:#}"); return ExitCode::FAILURE; }
    };
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
