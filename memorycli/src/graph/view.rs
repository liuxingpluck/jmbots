//! 导网页：把查图结果写成单文件网页（模板 view.html 编进程序里），数据嵌在页面里，不联网也能看。

use super::GraphOut;
use anyhow::Result;

/// 网页模板（view.html，编进程序里）。
const VIEW_TEMPLATE: &str = include_str!("view.html");

/// 把查询结果写成单文件网页：数据嵌在页面里，不联网也能看。
pub fn to_html(out: &GraphOut) -> Result<String> {
    // 嵌进 <script> 里：把 </ 转义，免得数据里的文字提前结束脚本。
    let json = serde_json::to_string(out)?.replace("</", "<\\/");
    Ok(VIEW_TEMPLATE.replace("/*GRAPH_JSON*/", &json))
}
