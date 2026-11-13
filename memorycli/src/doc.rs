//! 文档和通用文字：切块（全文检索按块搜、按块返回片段），以及找出文字里提到的文件和代码名字。
//!
//!   Markdown  按标题切块，标题本身记成声明（kind = heading，全名是“上级标题 > 标题”）；
//!             取出 [文字](链接) 和 `反引号里的代码名`
//!   其他文字  按固定行数切块（前后重叠几行，跨块的句子也搜得到）
//!   所有文件  找出提到的文件路径（如 src/core/Engine.ts、Feishu.ts、记忆.md），graph/build.rs 接成 mentions 边

use crate::parse::Symbol;
use regex::Regex;
use std::sync::OnceLock;

/// 一块正文。
#[derive(Debug, Clone)]
pub struct Chunk {
    pub start_line: i64,
    pub end_line: i64,
    /// 标题：Markdown 是所在的标题，代码是这块里的声明名。
    pub title: String,
    pub text: String,
}

/// 一处提及。
#[derive(Debug, Clone)]
pub struct Mention {
    /// path：提到文件路径；ident：反引号里的代码名；link：Markdown 链接。
    pub kind: &'static str,
    pub target: String,
    pub line: i64,
}

/// 每块最多几行。
const WINDOW: usize = 40;

/// 相邻两块重叠几行。
const OVERLAP: usize = 8;

/// 按固定行数切块。titles 给出每一行开始的声明名（代码用；文字传空）。
pub fn window_chunks(text: &str, titles: &[(i64, String)]) -> Vec<Chunk> {
    let lines: Vec<&str> = text.lines().collect();
    let mut chunks = Vec::new();
    let mut start = 0;
    while start < lines.len() {
        let end = (start + WINDOW).min(lines.len());
        let body = lines[start..end].join("\n");
        if !body.trim().is_empty() {
            let names: Vec<&str> =
                titles.iter().filter(|(line, _)| *line as usize > start && *line as usize <= end).map(|(_, name)| name.as_str()).take(4).collect();
            chunks.push(Chunk { start_line: start as i64 + 1, end_line: end as i64, title: names.join("、"), text: body });
        }
        if end == lines.len() {
            break;
        }
        start = end - OVERLAP;
    }
    chunks
}

/// Markdown：标题、按标题切的块、链接和反引号里的名字。
pub fn markdown(text: &str) -> (Vec<Symbol>, Vec<Chunk>, Vec<Mention>) {
    let lines: Vec<&str> = text.lines().collect();
    let mut headings: Vec<Symbol> = Vec::new();
    let mut mentions = Vec::new();
    let mut stack: Vec<(usize, String)> = Vec::new();
    let mut in_fence = false;
    // 每节开始的行（下标）和标题全名。
    let mut sections: Vec<(usize, String)> = vec![(0, String::new())];

    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_fence = !in_fence;
            continue;
        }
        let line_no = index as i64 + 1;
        if !in_fence {
            if let Some((level, title)) = heading(trimmed) {
                while stack.last().is_some_and(|(top, _)| *top >= level) {
                    stack.pop();
                }
                stack.push((level, title.clone()));
                let qname = stack.iter().map(|(_, name)| name.as_str()).collect::<Vec<_>>().join(" > ");
                headings.push(Symbol { name: title, qname: qname.clone(), kind: "heading".into(), line: line_no, end_line: line_no });
                sections.push((index, qname));
                continue;
            }
            for capture in link_regex().captures_iter(line) {
                let target = capture[1].to_string();
                if !target.contains("://") && !target.starts_with("mailto:") {
                    mentions.push(Mention { kind: "link", target, line: line_no });
                }
            }
        }
        for capture in ident_regex().captures_iter(line) {
            mentions.push(Mention { kind: "ident", target: capture[1].to_string(), line: line_no });
        }
    }

    //M 标题的结束行：下一个同级或更高级标题之前。
    for i in 0..headings.len() {
        let level = headings[i].qname.matches(" > ").count();
        let next = headings[i + 1..].iter().find(|next| next.qname.matches(" > ").count() <= level);
        headings[i].end_line = next.map(|next| next.line - 1).unwrap_or(lines.len() as i64);
    }

    //M 每节一块；太长的节再按行数切。
    let mut chunks = Vec::new();
    for (position, (start, title)) in sections.iter().enumerate() {
        let end = sections.get(position + 1).map(|(next, _)| *next).unwrap_or(lines.len());
        if end <= *start {
            continue;
        }
        let body = lines[*start..end].join("\n");
        if body.trim().is_empty() {
            continue;
        }
        for mut chunk in window_chunks(&body, &[]) {
            chunk.start_line += *start as i64;
            chunk.end_line += *start as i64;
            chunk.title = title.clone();
            chunks.push(chunk);
        }
    }
    (headings, chunks, mentions)
}

/// 一行是不是标题：返回级别和标题文字。
fn heading(line: &str) -> Option<(usize, String)> {
    let level = line.chars().take_while(|c| *c == '#').count();
    if level == 0 || level > 6 {
        return None;
    }
    let rest = &line[level..];
    if !rest.starts_with(' ') {
        return None;
    }
    let title = rest.trim().trim_end_matches('#').trim().to_string();
    (!title.is_empty()).then_some((level, title))
}

/// 找出文字里提到的文件路径。
pub fn path_mentions(text: &str) -> Vec<Mention> {
    let mut mentions = Vec::new();
    for (index, line) in text.lines().enumerate() {
        for found in path_regex().find_iter(line) {
            // 后面紧跟着字母数字的不算（如 Engine.tsx 里的 Engine.ts 前缀已经被正则吃全，这里防 a.json5 之类）。
            let next = line[found.end()..].chars().next();
            if next.is_some_and(|c| c.is_ascii_alphanumeric()) {
                continue;
            }
            let target = found.as_str().replace('\\', "/");
            let target = target.trim_start_matches("./").to_string();
            if !target.contains('.') || target.starts_with('.') {
                continue;
            }
            mentions.push(Mention { kind: "path", target, line: index as i64 + 1 });
        }
    }
    mentions
}

fn link_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"\]\(([^)\s#]+)(?:#[^)]*)?\)").unwrap())
}

fn ident_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| Regex::new(r"`([A-Za-z_$][A-Za-z0-9_$.]{2,80})(?:\(\))?`").unwrap())
}

fn path_regex() -> &'static Regex {
    static REGEX: OnceLock<Regex> = OnceLock::new();
    REGEX.get_or_init(|| {
        Regex::new(r"(?:[A-Za-z0-9_\-.\p{Han}]+[/\\])*[A-Za-z0-9_\-\p{Han}][A-Za-z0-9_\-.\p{Han}]*\.(?:tsx|ts|jsx|mjs|cjs|js|rs|go|py|md|yaml|yml|toml|json)")
            .unwrap()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn markdown_headings_chunks_and_mentions() {
        let text = "# 总览\n介绍 `handleMessage` 和 [引擎](src/core/Engine.ts)。\n## 记忆\n长期记忆放在 bots/周小灵/记忆.md 里\n```\n# 不是标题\n```\n# 附录\n完\n";
        let (headings, chunks, mentions) = markdown(text);
        let names: Vec<&str> = headings.iter().map(|h| h.qname.as_str()).collect();
        assert_eq!(names, ["总览", "总览 > 记忆", "附录"]);
        assert_eq!(headings[0].end_line, 7);
        assert_eq!(chunks.len(), 3);
        assert_eq!(chunks[1].title, "总览 > 记忆");
        assert!(mentions.iter().any(|m| m.kind == "ident" && m.target == "handleMessage"));
        assert!(mentions.iter().any(|m| m.kind == "link" && m.target == "src/core/Engine.ts"));
        let paths: Vec<String> = path_mentions(text).into_iter().map(|m| m.target).collect();
        assert!(paths.contains(&"bots/周小灵/记忆.md".to_string()), "{paths:?}");
    }

    #[test]
    fn path_mentions_next_to_chinese() {
        let paths: Vec<String> = path_mentions("见 Engine.ts里的说明，和 src\\tools\\Tools.ts。").into_iter().map(|m| m.target).collect();
        assert_eq!(paths, ["Engine.ts", "src/tools/Tools.ts"]);
    }

    #[test]
    fn windows_overlap() {
        let text = (1..=100).map(|n| n.to_string()).collect::<Vec<_>>().join("\n");
        let chunks = window_chunks(&text, &[]);
        assert_eq!((chunks[0].start_line, chunks[0].end_line), (1, 40));
        assert_eq!((chunks[1].start_line, chunks[1].end_line), (33, 72));
        assert_eq!(chunks.last().unwrap().end_line, 100);
    }
}
