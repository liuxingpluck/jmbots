//! 记忆库：memorycli 融合进壳子（docs/界面/01_界面设计.md 第 4.4 节）。
//!
//! 库目录是 config.yaml 的 local.libs（默认运行时 memorycli/），下面每个子目录一个 index.db，子目录名就是库名。
//! 壳子的命令行 search、ingest、graph 和 HTTP 接口都用这里；接口本身是 memorycli 原来那一套（memorycli::http::respond）。
//! 打 AI 标签的模型来自 config.yaml 的 local.memory_model（没写就不打）；不用嵌入模型（向量检索要先问用户）。

use crate::config::Settings;
use anyhow::{Context, Result, bail};
use memorycli::config::{Config, ModelConfig};
use memorycli::libs::{self, Lib};
use std::path::{Path, PathBuf};

/// memorycli 的配置：打标签的模型从 local.memory_model 来；嵌入模型不配；HTTP 那一段壳子不用（壳子自己听 local.port）。
///
/// 输入：算好的壳子配置。输出：通过 memorycli 入口校验的配置；非法参数返回错误。
pub fn memorycli_config(settings: &Settings) -> Result<Config> {
    let mut config = Config::default();
    if let Some(model) = &settings.memory_model {
        let format = if model.api.starts_with("anthropic") {
            "anthropic".into()
        } else {
            "openai".into()
        };
        config.model = Some(ModelConfig {
            format,
            base_url: model.base_url.clone(),
            api_key: model.api_key.clone(),
            model: model.model.clone(),
            ..ModelConfig::default()
        });
    }
    config.checked()
}

/// 打开库目录下的全部库；目录还没有就建一个空的，没有库时返回空的（不算错）。
///
/// 输入：算好的配置。输出：打开的库（按名字排）。副作用：库目录不存在时建出来。
pub fn open_libs(settings: &Settings) -> Result<Vec<Lib>> {
    std::fs::create_dir_all(&settings.libs_dir).with_context(|| format!("建不了记忆库目录 {}", settings.libs_dir.display()))?;
    let has_any = std::fs::read_dir(&settings.libs_dir)?.flatten().any(|entry| entry.path().join("index.db").is_file());
    if !has_any {
        return Ok(Vec::new());
    }
    libs::open_dir(&settings.libs_dir)
}

/// 一个库的数据库文件在哪。
fn db_of(settings: &Settings, lib: &str) -> Result<PathBuf> {
    //G 库名就是子目录名：不许带路径分隔符、不许是 . 或 ..。
    if lib.is_empty() || lib == "." || lib == ".." || lib.contains(['/', '\\']) {
        bail!("库名 {lib} 不对：只能是一个文件夹名");
    }
    Ok(settings.libs_dir.join(lib).join("index.db"))
}

/// 搜索（命令行 search）。
///
/// 输入：配置、搜什么、最多几个文件、只搜哪几个库（逗号隔开，不写是全部）。输出：memorycli 的搜索结果（每条带 RRF 分数）。
pub fn search(settings: &Settings, query: &str, limit: usize, lib: Option<&str>) -> Result<memorycli::search::SearchOut> {
    let all = open_libs(settings)?;
    if all.is_empty() {
        bail!("{} 下还没有库：先用 jmbots ingest --lib 名字 --root 目录 建一个", settings.libs_dir.display());
    }
    let picked = libs::pick(&all, &libs::parse_names(lib))?;
    libs::search(&picked, query, limit.clamp(1, 100), None)
}

/// 摄取（命令行 ingest）：增量更新一个库；库还没有时要给 root（要索引的目录），建出 <库目录>/<库名>/index.db。
///
/// 输入：配置、库名、要索引的目录（老库可以不写，用库里记着的）、打不打 AI 标签、进度怎么打。
/// 输出：memorycli 的摄取统计（JSON）。副作用：写那个库的数据库。
pub fn ingest(settings: &Settings, lib: &str, root: Option<&Path>, ai: bool, progress: &dyn Fn(&str)) -> Result<serde_json::Value> {
    let db = db_of(settings, lib)?;
    if let Some(dir) = db.parent() {
        std::fs::create_dir_all(dir)?;
    }
    let opened = libs::open_one(&db, root)?;
    let Some(root) = opened.root.clone() else {
        bail!("库 {lib} 还不知道索引哪个目录：第一次要写 --root 目录");
    };
    let mut store = opened.store;
    let config = memorycli_config(settings)?;
    let stats = memorycli::ingest::ingest(&mut store, &root, &config, memorycli::ingest::Options { ai: ai && config.model.is_some() }, progress)?;
    Ok(serde_json::to_value(stats)?)
}

/// 关系图谱（命令行 graph）。
///
/// 输入：配置、哪个库（不写时只有一个库就是它）、从哪个名字出发（不写是整张图）、走几步、要不要另外写一个网页。
/// 输出：图谱的 JSON。副作用：给了 html 时写那个文件。
pub fn graph(settings: &Settings, lib: Option<&str>, name: Option<&str>, depth: usize, html: Option<&Path>) -> Result<serde_json::Value> {
    let all = open_libs(settings)?;
    let chosen = match lib {
        Some(lib) => all.iter().find(|item| item.name == lib).with_context(|| format!("没有叫 {lib} 的库"))?,
        None if all.len() == 1 => &all[0],
        None => bail!("有 {} 个库，要写 --lib 名字", all.len()),
    };
    let out = memorycli::graph::query(&chosen.store, name, depth.clamp(1, 4))?;
    if let Some(file) = html {
        std::fs::write(file, memorycli::graph::to_html(&out)?).with_context(|| format!("写 {} 失败", file.display()))?;
    }
    Ok(serde_json::to_value(out)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Overrides, resolve};
    use crate::test_support::temp_dir;

    #[test]
    fn ingest_then_search_finds_by_rrf() {
        let runtime = temp_dir("memory-ingest");
        let docs = runtime.join("文档");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("飞书发件箱.md"), "# 飞书发件箱\n\n往 outbox 放一份 md，服务每 5 秒取一次，发给最近私聊的人。\n").unwrap();
        std::fs::write(docs.join("别的.md"), "# 别的\n\n和发件箱没关系的一段话。\n").unwrap();
        let settings = resolve(&Overrides { runtime: Some(runtime.clone()), ..Overrides::default() }, &|_| None, &runtime);
        // 还没有库：搜索说清楚怎么建。
        assert!(search(&settings, "发件箱", 5, None).unwrap_err().to_string().contains("ingest"));
        // 新库不给目录：说清楚要 --root。
        assert!(ingest(&settings, "笔记", None, false, &|_| ()).unwrap_err().to_string().contains("--root"));
        let stats = ingest(&settings, "笔记", Some(&docs), false, &|_| ()).expect("摄取");
        assert!(stats.to_string().contains('2'), "{stats}");
        let out = search(&settings, "飞书 发件箱", 5, None).expect("搜索");
        let first = out.hits.first().expect("有结果");
        assert!(first.path.ends_with("飞书发件箱.md"), "{:?}", first.path);
        assert!(first.score > 0.0);
        assert!(!first.matched.is_empty());
        // 第二次摄取（老库）不用再给目录。
        assert!(ingest(&settings, "笔记", None, false, &|_| ()).is_ok());
        // 库名不许带路径。
        assert!(ingest(&settings, "../外面", Some(&docs), false, &|_| ()).is_err());
        assert!(graph(&settings, None, None, 1, None).is_ok());
    }
}
