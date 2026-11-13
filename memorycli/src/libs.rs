//! 多个库：一个服务、一次搜索同时用好几个库（记忆库、技能库、jmbots 代码……）。
//!
//! 为什么要有（框架设计第 8 节第 3 步）：一个库只索引一个目录。2026-11-04 批量建了 28 个库，
//! 可原来 serve 只能挂一个，jmbots 的 engine.index_url 也只认一个地址——记忆库、技能库、代码没法一次搜到。
//!
//! 两种给法：
//!   --libs 目录   目录下每个子目录里有 index.db 就算一个库，子目录名就是库名（运行时 memorycli/ 就是这样摆的）
//!   --db 文件     只挂这一个库（老用法），库名取它所在目录的名字
//!
//! 多库搜索：每个库各搜一遍，按每条命中自己的分数合起来。各库的分数是同一套 RRF 算的（配了嵌入模型是五路），可以直接比。
//! 每条命中带上库名，库里记着根目录（摄取时写的 meta.root）的还带上绝对路径。

use crate::ai;
use crate::config::ModelConfig;
use crate::search::{self, SearchOut};
use crate::store::Store;
use anyhow::{Result, bail};
use std::path::{Path, PathBuf};

/// 一个库。
pub struct Lib {
    /// 库名。
    pub name: String,
    /// 数据库文件。
    pub db: PathBuf,
    /// 被索引的目录：库里记着的（meta.root），没记就用调用方给的；都没有是 None（这时摄取不了，也给不出绝对路径）。
    pub root: Option<PathBuf>,
    /// 打开的数据库。
    pub store: Store,
}

/// 打开一个库。
/// root_hint 是调用方知道的根目录（老用法 --root）；库里记着根目录时以库里的为准。
pub fn open_one(db: &Path, root_hint: Option<&Path>) -> Result<Lib> {
    let store = Store::open(db)?;
    let root = store.meta("root")?.map(PathBuf::from).or_else(|| root_hint.map(Path::to_path_buf));
    let name = db.parent().and_then(|dir| dir.file_name()).map(|name| name.to_string_lossy().into_owned()).unwrap_or_else(|| "index".to_string());
    Ok(Lib { name, db: db.to_path_buf(), root, store })
}

/// 打开一个目录下的全部库：每个子目录里有 index.db 就算一个，按库名排好。
/// 一个库打不开（比如文件写不进去）不挡别的库：写明哪个库、什么原因打到 stderr，接着开别的；一个都开不了才报错。
pub fn open_dir(dir: &Path) -> Result<Vec<Lib>> {
    let entries = std::fs::read_dir(dir).map_err(|error| anyhow::anyhow!("读不了库目录 {}：{error}", dir.display()))?;
    let mut libs = Vec::new();
    let mut failed = Vec::new();
    for entry in entries.flatten() {
        let db = entry.path().join("index.db");
        if entry.path().is_dir() && db.is_file() {
            match open_one(&db, None) {
                Ok(lib) => libs.push(lib),
                Err(error) => failed.push(format!("{}：{error:#}", db.display())),
            }
        }
    }
    if libs.is_empty() {
        if !failed.is_empty() {
            bail!("{} 下的库都打不开：{}", dir.display(), failed.join("；"));
        }
        bail!("{} 下没有库（每个库是一个子目录，里面有 index.db）", dir.display());
    }
    for line in &failed {
        eprintln!("这个库打不开，先跳过：{line}");
    }
    libs.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(libs)
}

/// 挑库：names 为空就是全部；有不认识的名字就报错，并列出有哪些。
pub fn pick<'a>(libs: &'a [Lib], names: &[String]) -> Result<Vec<&'a Lib>> {
    if names.is_empty() {
        return Ok(libs.iter().collect());
    }
    let mut picked = Vec::new();
    for name in names {
        match libs.iter().find(|lib| &lib.name == name) {
            Some(lib) => picked.push(lib),
            None => bail!("没有叫 {name} 的库；有：{}", libs.iter().map(|lib| lib.name.as_str()).collect::<Vec<_>>().join("、")),
        }
    }
    Ok(picked)
}

/// 把逗号隔开的库名拆开（空的去掉）。
pub fn parse_names(text: Option<&str>) -> Vec<String> {
    text.unwrap_or("").split(',').map(str::trim).filter(|name| !name.is_empty()).map(str::to_string).collect()
}

/// 多库搜索：每个库各搜 limit 个，按分数合起来取前 limit 个；每条带上库名和绝对路径。
pub fn search(libs: &[&Lib], query: &str, limit: usize, embedding: Option<&ModelConfig>) -> Result<SearchOut> {
    //M 配了嵌入模型：问句的向量只算一次，几个库共用；算不出来（服务没起等）就只走四路。
    let query_vector = embedding.and_then(|model| ai::embed(model, &[query.to_string()]).ok()).and_then(|mut vectors| vectors.pop());
    let vector = embedding.zip(query_vector.as_deref()).map(|(model, vector)| (model.model.as_str(), vector));
    let mut hits = Vec::new();
    for lib in libs {
        for mut hit in search::search_with(&lib.store, query, limit, vector)?.hits {
            //M 库里的路径都用 /；拼绝对路径时换成本机的分隔符（Windows 上是 \\），免得一半斜杠一半反斜杠。
            hit.abs_path = lib.root.as_ref().map(|root| root.join(hit.path.replace('/', std::path::MAIN_SEPARATOR_STR)).display().to_string());
            hit.lib = Some(lib.name.clone());
            hits.push(hit);
        }
    }
    hits.sort_by(|a, b| b.score.total_cmp(&a.score));
    hits.truncate(limit);
    Ok(SearchOut { query: query.to_string(), hits })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_are_split_and_trimmed() {
        assert_eq!(parse_names(Some(" memory, jmbots ,,")), vec!["memory".to_string(), "jmbots".to_string()]);
        assert!(parse_names(None).is_empty());
    }
}
