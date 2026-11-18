//! 文字处理：给全文检索（SQLite FTS5）准备正文和查询语句。
//!
//! FTS5 自带的 unicode61 分词器按空格和标点切词，连在一起的汉字会被当成一个词，
//! 搜“记忆”就找不到“长期记忆”。这里在入库和查询时都把汉字（以及日文、韩文）一个字一个字隔开，
//! 查询时再拼成短语（"记 忆"），两字、三字的中文词都能搜到，也不用装分词库。
//! 代码里的标识符（handleMessage、read_file）另外拆成小写的单词附在后面，搜“handle message”也能找到。

use std::collections::HashSet;

/// 是不是要一个字一个字隔开的文字（汉字、日文假名、韩文）。
pub fn is_cjk(c: char) -> bool {
    matches!(c as u32,
        0x3040..=0x30FF      // 日文假名
        | 0x3400..=0x4DBF    // 汉字扩展 A
        | 0x4E00..=0x9FFF    // 常用汉字
        | 0xAC00..=0xD7AF    // 韩文
        | 0xF900..=0xFAFF    // 兼容汉字
        | 0x20000..=0x2FA1F) // 汉字扩展 B 以后
}

/// 汉字两边加空格，其余原样。
fn space_cjk(text: &str) -> String {
    let mut out = String::with_capacity(text.len() * 2);
    for c in text.chars() {
        if is_cjk(c) {
            out.push(' ');
            out.push(c);
            out.push(' ');
        } else {
            out.push(c);
        }
    }
    out
}

/// 把一个标识符拆成单词：handleMessage → handle message，read_file → read file；拆不开时返回空。
fn split_identifier(word: &str) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut previous_lower = false;
    for c in word.chars() {
        if c == '_' || c == '-' {
            if !current.is_empty() {
                parts.push(std::mem::take(&mut current));
            }
            previous_lower = false;
            continue;
        }
        if c.is_ascii_uppercase() && previous_lower && !current.is_empty() {
            parts.push(std::mem::take(&mut current));
        }
        previous_lower = c.is_ascii_lowercase() || c.is_ascii_digit();
        current.push(c.to_ascii_lowercase());
    }
    if !current.is_empty() {
        parts.push(current);
    }
    if parts.len() < 2 { Vec::new() } else { parts }
}

/// 入库用的正文：汉字隔开，标识符拆开的单词附在最后一行。
pub fn to_fts(text: &str) -> String {
    let mut out = space_cjk(text);
    let mut seen = HashSet::new();
    let mut extra = Vec::new();
    for word in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '-')) {
        if word.len() < 4 || !seen.insert(word) {
            continue;
        }
        for part in split_identifier(word) {
            if part.len() >= 2 {
                extra.push(part);
            }
        }
    }
    if !extra.is_empty() {
        out.push('\n');
        out.push_str(&extra.join(" "));
    }
    out
}

/// 把用户的查询拆成词：按空白切，去掉空的。
pub fn terms(query: &str) -> Vec<String> {
    query.split_whitespace().map(|term| term.trim().to_string()).filter(|term| !term.is_empty()).collect()
}

/// 查询语句：每个词变成一个短语（汉字隔开、标点去掉），词之间用 OR，按 BM25 排序时命中越多越靠前。
/// 没有能查的词时返回 None。
pub fn fts_query(query: &str) -> Option<String> {
    let mut phrases = Vec::new();
    for term in terms(query) {
        let spaced = space_cjk(&term);
        let tokens: Vec<&str> = spaced.split(|c: char| !c.is_alphanumeric()).filter(|token| !token.is_empty()).collect();
        if tokens.is_empty() {
            continue;
        }
        phrases.push(format!("\"{}\"", tokens.join(" ")));
        // 标识符再拆开查一次（handleMessage 也能命中只写了 handle message 的地方）。
        let split = split_identifier(&term);
        if split.len() >= 2 {
            phrases.push(format!("\"{}\"", split.join(" ")));
        }
    }
    if phrases.is_empty() { None } else { Some(phrases.join(" OR ")) }
}

/// 截取前 max_chars 个字符（按字符算，不切坏汉字）。
pub fn head_chars(text: &str, max_chars: usize) -> &str {
    match text.char_indices().nth(max_chars) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cjk_is_spaced_and_identifiers_are_split() {
        let text = to_fts("长期记忆 handleMessage");
        assert!(text.contains(" 记  忆 "));
        assert!(text.ends_with("handle message"));
    }

    #[test]
    fn query_becomes_phrases() {
        assert_eq!(fts_query("记忆 handleMessage").unwrap(), "\"记 忆\" OR \"handleMessage\" OR \"handle message\"");
        assert_eq!(fts_query("  ...  "), None);
    }

    #[test]
    fn head_chars_keeps_chinese_whole() {
        assert_eq!(head_chars("一二三四", 2), "一二");
        assert_eq!(head_chars("ab", 5), "ab");
    }
}
