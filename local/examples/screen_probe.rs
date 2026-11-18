//! 本机六十秒录屏探针，只打印点击摘要与帧环统计。

#[cfg(windows)]
#[path = "screen_probe/fixture.rs"]
mod fixture;

#[cfg(windows)]
fn main() -> anyhow::Result<()> {
    use std::io::{self, Read};
    use std::time::{Duration, Instant};

    use clap::Parser;
    use jmbots_local::config;
    use jmbots_local::screen::{ScreenConfig, ScreenController};

    #[derive(Parser)]
    struct Args {
        /// 测试运行时目录，读取其中的 config.yaml。
        #[arg(long, conflicts_with = "config_stdin")]
        runtime: Option<std::path::PathBuf>,
        /// 从标准输入读一份临时 YAML，读完即开始。
        #[arg(long)]
        config_stdin: bool,
        /// 走讲解链路，后端缺挂时在副屏显示固定模拟讲解。
        #[arg(long)]
        explain: bool,
        /// 仅查询讲解后端，控制台输出结果。
        #[arg(long, requires = "explain")]
        check_backend: bool,
        /// 后端地址覆盖，仍需是本机地址。
        #[arg(long, requires = "explain")]
        server: Option<String>,
        /// 用副屏的空白测试窗验证真实采集、讲解和隐私门。
        #[arg(long, requires = "explain", conflicts_with = "check_backend")]
        fixture: bool,
    }

    let args = Args::parse();
    let screen = load_config(args.runtime.clone(), args.config_stdin)?;
    if args.explain {
        let overrides = config::Overrides { runtime: args.runtime, server: args.server, ..Default::default() };
        let env = |name: &str| std::env::var(name).ok();
        let settings = config::resolve(&overrides, &env, &config::exe_dir());
        if args.check_backend {
            if !ScreenController::explanation_available(&settings) {
                println!("后端没开录屏");
                return Ok(());
            }
            println!("录屏后端可用");
            return Ok(());
        }
        return explain(screen, settings, args.fixture);
    }
    let Some(probe) = ScreenController::start(&screen)? else {
        println!("录屏关闭，帧数 0，内存 0 字节");
        return Ok(());
    };

    println!("录屏探针已开启 60 秒，请点击测试窗口。");
    let end = Instant::now() + Duration::from_secs(60);
    let mut last_stats = (0, 0);
    let mut last_pause = None;
    while let Some(remaining) = end.checked_duration_since(Instant::now()) {
        let timeout = remaining.min(Duration::from_secs(2));
        let Some(report) = probe.next_report(timeout) else {
            let status = probe.status();
            let stats = (status.frames, status.bytes);
            if stats != last_stats || status.paused != last_pause {
                println!("帧数={} 内存={} 字节", stats.0, stats.1);
                if let Some(reason) = status.paused {
                    println!("隐私门=暂停（{}）", reason.reason());
                }
                last_stats = stats;
                last_pause = status.paused;
            }
            continue;
        };
        let process = report.process.as_deref().unwrap_or("未知");
        let control = report.control.as_ref()
            .map(|control| format!("{:?}", control.kind))
            .unwrap_or_else(|| "未知".into());
        let reason = report.denial.map(|denial| denial.reason()).unwrap_or("窗口及控件已通过本机检查");
        let verdict = report.denial.map(|_| "拒绝").unwrap_or("放行");
        println!(
            "{}ms ({}, {}) {:?} 进程={} 控件={} 隐私门={}（{}） 帧数={} 内存={} 字节",
            report.unix_ms, report.x, report.y, report.button, process, control, verdict, reason,
            report.frames, report.bytes,
        );
    }

    //M 离开作用域先停钩子和采集，再打印清理后的计数。
    probe.stop();
    println!("录屏探针已停止，帧数 0，内存 0 字节");
    return Ok(());

    fn load_config(runtime: Option<std::path::PathBuf>, stdin: bool) -> anyhow::Result<ScreenConfig> {
        if stdin {
            let mut yaml = String::new();
            io::stdin().take(8_193).read_to_string(&mut yaml)?;
            if yaml.len() > 8_192 { anyhow::bail!("录屏探针配置超过 8192 字节"); }
            return ScreenConfig::parse(&yaml);
        }

        let exe_dir = config::exe_dir();
        let from_env = std::env::var(config::RUNTIME_ENV).ok()
            .filter(|value| !value.trim().is_empty())
            .map(std::path::PathBuf::from);
        let runtime = runtime.or(from_env).unwrap_or_else(|| exe_dir.join(config::RUNTIME_DIR_NAME));
        ScreenConfig::load(&runtime.join(config::CONFIG_FILE))
    }
}

/// 仅探针入口创建 Tauri 事件循环，HTTP 与探针生命周期交给后台线程。
#[cfg(windows)]
fn explain(
    config: jmbots_local::screen::ScreenConfig, settings: jmbots_local::config::Settings,
    use_fixture: bool,
) -> anyhow::Result<()> {
    use jmbots_local::screen::{Overlay, ScreenController, ScreenStart};
    use std::time::{Duration, Instant};

    let app = tauri::Builder::default()
        .setup(move |app| {
            let app = app.handle().clone();
            let mut fixture = None;
            if use_fixture {
                //M 在 Tauri 消息线程创建原生控件，UIA 调用由探针线程发起。
                fixture = Some(fixture::Fixture::open(&app)?);
            }
            let work = move || {
                let overlay = Overlay::new(app.clone());
                if let Some(fixture) = fixture {
                    let result = fixture.run(&config, &settings, &overlay, &app);
                    let code = match result {
                        Ok(()) => 0,
                        Err(error) => {
                            eprintln!("副屏探针失败：{error}");
                            1
                        }
                    };
                    let exit = app.clone();
                    //M 在窗口所属线程销毁控件，然后退出探针。
                    let _ = app.run_on_main_thread(move || {
                        fixture.close();
                        exit.exit(code);
                    });
                    return;
                }
                let started = ScreenController::start_explaining(&config, &settings, overlay.clone());
                match started {
                    Ok(ScreenStart::Disabled) => println!("录屏关闭，帧数 0，内存 0 字节"),
                    Ok(ScreenStart::BackendUnavailable) => {
                        println!("后端没开录屏");
                        let duration = config.overlay_duration();
                        if overlay.demo_secondary(duration) { std::thread::sleep(duration); }
                    }
                    Ok(ScreenStart::Active(probe)) => {
                        let end = Instant::now() + Duration::from_secs(60);
                        while let Some(left) = end.checked_duration_since(Instant::now()) {
                            let timeout = left.min(Duration::from_millis(250));
                            let _ = probe.next_report(timeout);
                        }
                        probe.stop();
                    }
                    Err(_) => eprintln!("录屏讲解启动失败"),
                }
                overlay.hide();
                app.exit(0);
            };
            std::thread::Builder::new().name("screen-probe".into()).spawn(work)?;
            Ok(())
        })
        .build(tauri::generate_context!())?;
    app.run(|_, event| {
        if let tauri::RunEvent::ExitRequested { api, code: None, .. } = event {
            api.prevent_exit();
        }
    });
    Ok(())
}

#[cfg(not(windows))]
fn main() {
    eprintln!("录屏探针仅供 Windows 基地使用");
}
