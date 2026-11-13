//! 窗口和托盘（docs/界面/01_界面设计.md 第 4.1 节）：
//!   - 起来先在后台线程开 HTTP 接口（记忆搜索、RAG，server.rs）；起不来（比如端口被老的 memorycli 服务占着）记进日志，窗口照开。
//!   - 托盘：“打开界面”“退出 jmbots”；左键点托盘图标也是打开界面。关窗口只是缩到托盘，接口照常在跑。
//!   - 窗口先开壳子自带的一页（ui/index.html），它去连后端，连上就切到后端托管的网页，连不上显示“休假中”并每 3 秒再试。
//!   - 只开一份：已经开着时再双击，只是把窗口叫出来。--tray 起来时不开窗口（开机自启用）。
//!   - 基地拉起并守护后端、扫描新版本（supervisor.rs）；从托盘退出时连它拉起的后端一起停。

use crate::config::Settings;
use crate::{log, server, supervisor};
use anyhow::{Context, Result};
use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

/// 主窗口的标签。
const MAIN_WINDOW: &str = "main";
/// 窗口一开始多大（逻辑像素）。
const INITIAL_SIZE: (f64, f64) = (1360.0, 860.0);
/// 窗口最小多大（三栏放得下的最小宽度）。
const MIN_SIZE: (f64, f64) = (720.0, 480.0);

/// 托盘菜单的文字，跟着界面语言。
///
/// 输入：语言代码（ui.language）。输出：“打开”和“退出”两句；不认识的语言用简体中文。
pub fn tray_labels(language: Option<&str>) -> (&'static str, &'static str) {
    match language {
        Some("zh-TW") => ("開啟介面", "結束 jmbots"),
        Some("en") => ("Open jmbots", "Quit jmbots"),
        Some("fr") => ("Ouvrir jmbots", "Quitter jmbots"),
        _ => ("打开界面", "退出 jmbots"),
    }
}

/// 把主窗口叫出来；还没有就建一个（--tray 起来的、或者被关过的）。
///
/// 输入：应用、页面加载前要跑的脚本（写进后端地址）。副作用：开窗口或把窗口提到前面。
fn show_main(app: &tauri::AppHandle, script: &str) {
    if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        return;
    }
    let built = tauri::WebviewWindowBuilder::new(app, MAIN_WINDOW, tauri::WebviewUrl::App("index.html".into()))
        .title("jmbots")
        .inner_size(INITIAL_SIZE.0, INITIAL_SIZE.1)
        .min_inner_size(MIN_SIZE.0, MIN_SIZE.1)
        .initialization_script(script)
        // 文件拖进窗口交给网页自己处理（HTML5 拖放，输入框收附件）；Tauri 默认会在窗口这一层截走。
        .disable_drag_drop_handler()
        .build();
    if let Err(error) = built {
        log::line(app.state::<Settings>().inner(), &format!("窗口开不出来：{error}"));
    }
}

/// 建托盘图标和菜单。
fn build_tray(app: &tauri::App, script: String, labels: (&str, &str)) -> Result<()> {
    let open = MenuItem::with_id(app, "open", labels.0, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", labels.1, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &quit])?;
    let icon = app.default_window_icon().cloned().context("程序里没有图标")?;
    let for_menu = script.clone();
    TrayIconBuilder::with_id("jmbots")
        .icon(icon)
        .tooltip("jmbots")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(move |app, event| match event.id().as_ref() {
            "open" => show_main(app, &for_menu),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(move |tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle(), &script);
            }
        })
        .build(app)?;
    Ok(())
}

/// 开窗口（或只开托盘），一直跑到用户从托盘退出。
///
/// 输入：算好的配置、是不是只开托盘（--tray）。输出：退出后返回；Tauri 起不来时报错。
/// 副作用：后台开 HTTP 接口；开托盘图标和窗口（WebView2）。
pub fn run(settings: &Settings, tray_only: bool) -> Result<()> {
    let labels = tray_labels(settings.language.as_deref());
    //M 1. 守护后端；HTTP 接口在后台线程跑；起不来不挡窗口。
    let guard = supervisor::Supervisor::start(settings);
    let for_server = std::sync::Arc::clone(&guard);
    let serving = settings.clone();
    std::thread::spawn(move || {
        if let Err(error) = server::serve_with(&serving, Some(for_server)) {
            log::line(&serving, &format!("HTTP 接口起不来：{error:#}"));
        }
    });
    //M 2. 托盘、窗口。后端地址在页面加载前写进 window.__JMBOTS_SERVER__（ui/index.html 用它去连）。
    let script = format!("window.__JMBOTS_SERVER__ = {};", serde_json::to_string(&settings.server)?);
    let for_instance = script.clone();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(move |app, _args, _cwd| show_main(app, &for_instance)))
        .manage(settings.clone())
        .on_window_event(|window, event| {
            //M 关窗口只是藏起来，托盘里还在、接口照跑；要退出走托盘的“退出 jmbots”。
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .setup(move |app| {
            build_tray(app, script.clone(), labels)?;
            if !tray_only {
                show_main(app.handle(), &script);
            }
            Ok(())
        })
        .build(tauri::generate_context!())?;
    app.run(move |_app, event| match event {
        //M 窗口都关了（藏了）也别退；只有从托盘点“退出”（带退出码）才真的退。
        tauri::RunEvent::ExitRequested { api, code, .. } if code.is_none() => api.prevent_exit(),
        tauri::RunEvent::Exit => guard.stop(),
        _ => {}
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tray_labels_follow_language() {
        //M 四种语言各返回对应两句；zh-CN 走默认的简体中文。
        assert_eq!(tray_labels(Some("zh-CN")), ("打开界面", "退出 jmbots"));
        assert_eq!(tray_labels(Some("zh-TW")), ("開啟介面", "結束 jmbots"));
        assert_eq!(tray_labels(Some("en")), ("Open jmbots", "Quit jmbots"));
        assert_eq!(tray_labels(Some("fr")), ("Ouvrir jmbots", "Quitter jmbots"));
        //M 不认识的语言和没写：回简体中文。
        assert_eq!(tray_labels(Some("de")), ("打开界面", "退出 jmbots"));
        assert_eq!(tray_labels(None), ("打开界面", "退出 jmbots"));
    }
}
