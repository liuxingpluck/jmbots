//! jmbots 的本地壳子（docs/界面/01_界面设计.md 第 4 节）。
//!
//! 各模块：
//!   config   配置：运行时目录、config.yaml 里壳子读的几项（和 Bun 后端同一份、同一套键名）
//!   backend  连 Bun 后端（HTTP）：健康检查、机器人
//!   check    不开窗口的自检：打印一份 JSON，DSH 验证靠它
//!   console  控制台：按控制台程序编译，双击时不弹黑框（清单 + 老系统上放掉控制台）
//!   memory   记忆库：memorycli 融合进来（命令行 search、ingest、graph）
//!   rag      RAG：Tantivy + jieba，索引 memorycli 切好的正文块，BM25 检索
//!   server   壳子的 HTTP 接口：memorycli 原来那套 + /rag/*，取代独立的 memorycli 服务
//!   window   窗口和托盘：先开自带的一页，连上后端就切到后端托管的网页
//!   supervisor  守护后端、扫描新版本、换版本（先试运行，失败退回）
//!   log      窗口模式的日志（运行时 data/local.log）

pub mod autostart;
pub mod backend;
pub mod check;
pub mod config;
pub mod console;
pub mod log;
pub mod memory;
pub mod rag;
pub mod server;
pub mod supervisor;
pub mod window;

/// 测试用的小工具。
#[cfg(test)]
pub(crate) mod test_support {
    use std::path::{Path, PathBuf};

    /// 测试用的临时目录：默认放在 local/target/test-tmp 下（有的环境在缓存目录下建不了子目录），JMBOTS_TEST_DIR 能改。
    pub fn temp_dir(name: &str) -> PathBuf {
        let base = std::env::var_os("JMBOTS_TEST_DIR").map(PathBuf::from).unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join("test-tmp"));
        let stamp = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|time| time.as_nanos()).unwrap_or(0);
        let dir = base.join(format!("{name}-{}-{stamp}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("建临时目录");
        dir
    }
}
