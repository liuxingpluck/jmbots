//! RAG（docs/界面/01_界面设计.md 第 4.5 节）：Tantivy（BM25 全文检索）+ jieba 中文分词，不用嵌入模型，只暴露接口（server.rs 的 /rag/*）。
//!
//! 索引的是记忆库里 memorycli 已经切好的正文块（同样的文件、同样认 .gitignore），每个库一个 Tantivy 索引：<rag 目录>/<库名>/。
//! 增量：<rag 目录>/<库名>/files.json 记着每个文件的内容哈希，哈希变了才重做那个文件的块；库里没了的文件，它的块也删掉。
//! 检索：用户的话用同一个分词器切成词，哪个词命中都算分（不当成短语，整句中文也能搜到），每个库各搜一遍，按 BM25 分数合起来；
//! 每条是一个片段：库、文件、绝对路径、标题、行号、正文片段、分数。

use anyhow::{Context, Result};
use serde::Serialize;
use std::collections::{BTreeMap, HashSet};
use std::path::{Path, PathBuf};
use tantivy::collector::TopDocs;
use tantivy::query::{BooleanQuery, Occur, Query, TermQuery};
use tantivy::schema::{Field, IndexRecordOption, STORED, STRING, Schema, TextFieldIndexing, TextOptions, Value};
use tantivy::snippet::SnippetGenerator;
use tantivy::tokenizer::{LowerCaser, TextAnalyzer};
use tantivy::{Index, IndexWriter, TantivyDocument, Term, doc};

/// 分词器在 Tantivy 里登记的名字。
const TOKENIZER: &str = "jieba";
/// 建索引时写入缓冲多大（字节）。
const WRITER_MEMORY: usize = 50_000_000;
/// 片段最多多少字。
const SNIPPET_CHARS: usize = 240;
/// 记文件哈希的文件名。
const MANIFEST: &str = "files.json";

/// 索引里的几个字段。
struct Fields {
    /// 相对库根目录的路径（不分词，删一个文件的块时按它删）。
    path: Field,
    /// 块的标题（Markdown 标题等）。
    title: Field,
    /// 块的正文。
    body: Field,
    /// 从第几行开始。
    start_line: Field,
    /// 到第几行。
    end_line: Field,
}

/// 字段的定义（每个库的索引都一样）。
fn schema() -> (Schema, Fields) {
    let mut builder = Schema::builder();
    let text = TextOptions::default()
        .set_indexing_options(TextFieldIndexing::default().set_tokenizer(TOKENIZER).set_index_option(IndexRecordOption::WithFreqsAndPositions))
        .set_stored();
    let fields = Fields {
        path: builder.add_text_field("path", STRING | STORED),
        title: builder.add_text_field("title", text.clone()),
        body: builder.add_text_field("body", text),
        start_line: builder.add_u64_field("start_line", STORED),
        end_line: builder.add_u64_field("end_line", STORED),
    };
    (builder.build(), fields)
}

/// 打开一个库的索引（没有就建），登记 jieba 分词器（中文按词切，英文转小写）。
fn open_index(dir: &Path, create: bool) -> Result<Option<(Index, Fields)>> {
    let (schema, fields) = schema();
    let index = if dir.join("meta.json").is_file() {
        Index::open_in_dir(dir).with_context(|| format!("打不开 RAG 索引 {}", dir.display()))?
    } else if create {
        std::fs::create_dir_all(dir)?;
        Index::create_in_dir(dir, schema).with_context(|| format!("建不了 RAG 索引 {}", dir.display()))?
    } else {
        return Ok(None);
    };
    index.tokenizers().register(TOKENIZER, TextAnalyzer::builder(tantivy_jieba::JiebaTokenizer::new()).filter(LowerCaser).build());
    Ok(Some((index, fields)))
}

/// 把用户的话切成词，拼成“哪个词命中都算分”的查询（标题和正文都搜）。
///
/// 不用 QueryParser：它把一个词组切出来的几个词当成短语，要求挨着出现，整句中文（“飞书发件箱怎么用”）就一条也搜不到。
/// 输入：索引（分词器在上面登记过）、字段、用户的话。输出：查询；切不出一个词（全是标点、空白）时是 None。
fn words_query(index: &Index, fields: &Fields, query: &str) -> Result<Option<Box<dyn Query>>> {
    let mut analyzer = index.tokenizer_for_field(fields.body)?;
    let mut words: Vec<String> = Vec::new();
    let mut stream = analyzer.token_stream(query);
    while stream.advance() {
        let word = &stream.token().text;
        //G 标点、空白也会切成词，不要；重复的只留一个。
        if word.chars().any(char::is_alphanumeric) && !words.contains(word) {
            words.push(word.clone());
        }
    }
    if words.is_empty() {
        return Ok(None);
    }
    let mut clauses: Vec<(Occur, Box<dyn Query>)> = Vec::new();
    for word in &words {
        for field in [fields.title, fields.body] {
            clauses.push((Occur::Should, Box::new(TermQuery::new(Term::from_field_text(field, word), IndexRecordOption::WithFreqs))));
        }
    }
    Ok(Some(Box::new(BooleanQuery::new(clauses))))
}

/// 建一次索引的统计。
#[derive(Debug, Clone, Default, Serialize)]
pub struct IndexStats {
    /// 库里一共多少个文件。
    pub files: usize,
    /// 这次重做了几个文件（新的或内容变了的）。
    pub changed: usize,
    /// 这次删掉了几个文件（库里已经没了）。
    pub removed: usize,
    /// 这次写进去多少块。
    pub chunks: usize,
}

/// 给一个库建 RAG 索引（增量）。
///
/// 输入：RAG 目录、库名、库的数据库文件、进度怎么打。输出：统计。
/// 副作用：读那个库（自己开一个连接，不挡搜索）；写 <RAG 目录>/<库名>/ 下的索引和 files.json。
pub fn index_lib(rag_dir: &Path, name: &str, db: &Path, progress: &dyn Fn(&str)) -> Result<IndexStats> {
    let store = memorycli::store::Store::open(db)?;
    let dir = rag_dir.join(name);
    let (index, fields) = open_index(&dir, true)?.context("索引没建出来")?;
    let mut writer: IndexWriter = index.writer(WRITER_MEMORY)?;
    let manifest_file = dir.join(MANIFEST);
    let mut manifest: BTreeMap<String, String> = std::fs::read_to_string(&manifest_file).ok().and_then(|text| serde_json::from_str(&text).ok()).unwrap_or_default();
    let files = store.files()?;
    let mut stats = IndexStats { files: files.len(), ..IndexStats::default() };
    let mut seen = HashSet::new();
    for file in &files {
        seen.insert(file.path.clone());
        //M 内容哈希没变的文件不动。
        if manifest.get(&file.path) == Some(&file.hash) {
            continue;
        }
        writer.delete_term(Term::from_field_text(fields.path, &file.path));
        for (_, chunk) in store.chunks_of(file.id)? {
            writer.add_document(doc!(
                fields.path => file.path.as_str(),
                fields.title => chunk.title.as_str(),
                fields.body => chunk.text.as_str(),
                fields.start_line => u64::try_from(chunk.start_line).unwrap_or(0),
                fields.end_line => u64::try_from(chunk.end_line).unwrap_or(0),
            ))?;
            stats.chunks += 1;
        }
        manifest.insert(file.path.clone(), file.hash.clone());
        stats.changed += 1;
        if stats.changed % 200 == 0 {
            progress(&format!("RAG {name}：已经重做 {} 个文件", stats.changed));
        }
    }
    //M 库里已经没了的文件，块也删掉。
    let gone: Vec<String> = manifest.keys().filter(|path| !seen.contains(*path)).cloned().collect();
    for path in &gone {
        writer.delete_term(Term::from_field_text(fields.path, path));
        manifest.remove(path);
    }
    stats.removed = gone.len();
    writer.commit()?;
    let temp = dir.join(format!("{MANIFEST}.tmp"));
    std::fs::write(&temp, serde_json::to_string(&manifest)?)?;
    std::fs::rename(&temp, &manifest_file)?;
    Ok(stats)
}

/// 一条检索结果：一个片段。
#[derive(Debug, Clone, Serialize)]
pub struct RagHit {
    /// 哪个库。
    pub lib: String,
    /// 相对库根目录的路径。
    pub path: String,
    /// 绝对路径（库里记着根目录时才有）。
    #[serde(skip_serializing_if = "Option::is_none")]
    pub abs_path: Option<String>,
    /// 块的标题。
    pub title: String,
    /// 从第几行开始。
    pub start_line: u64,
    /// 到第几行。
    pub end_line: u64,
    /// 正文片段（命中的那一段）。
    pub text: String,
    /// BM25 分数。
    pub score: f32,
}

/// 检索的回答。
#[derive(Debug, Clone, Serialize)]
pub struct RagOut {
    /// 搜的是什么。
    pub query: String,
    /// 片段，分数高的在前。
    pub hits: Vec<RagHit>,
    /// 还没建索引的库（要先 POST /rag/index）。
    pub not_indexed: Vec<String>,
}

/// 检索。
///
/// 输入：RAG 目录、要搜的库（名字和根目录）、搜什么、最多几条。输出：片段（各库按 BM25 分数合起来）和还没建索引的库。
/// 副作用：只读索引。
pub fn search(rag_dir: &Path, libs: &[(String, Option<PathBuf>)], query: &str, limit: usize) -> Result<RagOut> {
    let mut hits = Vec::new();
    let mut not_indexed = Vec::new();
    for (name, root) in libs {
        let Some((index, fields)) = open_index(&rag_dir.join(name), false)? else {
            not_indexed.push(name.clone());
            continue;
        };
        let searcher = index.reader()?.searcher();
        let Some(parsed) = words_query(&index, &fields, query)? else {
            continue;
        };
        let mut snippets = SnippetGenerator::create(&searcher, &*parsed, fields.body)?;
        snippets.set_max_num_chars(SNIPPET_CHARS);
        for (score, address) in searcher.search(&*parsed, &TopDocs::with_limit(limit).order_by_score())? {
            let document: TantivyDocument = searcher.doc(address)?;
            let text_of = |field: Field| document.get_first(field).and_then(|value| value.as_str()).unwrap_or_default().to_string();
            let path = text_of(fields.path);
            let fragment = snippets.snippet_from_doc(&document).fragment().to_string();
            hits.push(RagHit {
                lib: name.clone(),
                abs_path: root.as_ref().map(|root| root.join(&path).display().to_string()),
                title: text_of(fields.title),
                start_line: document.get_first(fields.start_line).and_then(|value| value.as_u64()).unwrap_or(0),
                end_line: document.get_first(fields.end_line).and_then(|value| value.as_u64()).unwrap_or(0),
                text: if fragment.is_empty() { text_of(fields.body).chars().take(SNIPPET_CHARS).collect() } else { fragment },
                path,
                score,
            });
        }
    }
    hits.sort_by(|a, b| b.score.total_cmp(&a.score));
    hits.truncate(limit);
    Ok(RagOut { query: query.to_string(), hits, not_indexed })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::{Overrides, resolve};
    use crate::memory;
    use crate::test_support::temp_dir;

    #[test]
    fn index_and_search_chinese_with_bm25() {
        let runtime = temp_dir("rag");
        let docs = runtime.join("资料");
        std::fs::create_dir_all(&docs).unwrap();
        std::fs::write(docs.join("飞书发件箱.md"), "# 飞书发件箱\n\n往发件箱放一份 Markdown，服务每五秒取一次，发给最近私聊的人。\n\n## 别的\n\n这一段讲天气，和发件箱无关。\n").unwrap();
        std::fs::write(docs.join("模型.md"), "# 模型清单\n\n分派用决策模型，审核也先问它。\n").unwrap();
        let settings = resolve(&Overrides { runtime: Some(runtime.clone()), ..Overrides::default() }, &|_| None, &runtime);
        memory::ingest(&settings, "资料库", Some(&docs), false, &|_| ()).expect("摄取");
        let db = settings.libs_dir.join("资料库").join("index.db");
        // 还没建索引：说清楚。
        let before = search(&settings.rag_dir, &[("资料库".to_string(), Some(docs.clone()))], "发件箱", 5).unwrap();
        assert_eq!(before.not_indexed, vec!["资料库".to_string()]);
        let stats = index_lib(&settings.rag_dir, "资料库", &db, &|_| ()).expect("建索引");
        assert_eq!(stats.files, 2);
        assert!(stats.chunks >= 2, "{stats:?}");
        let out = search(&settings.rag_dir, &[("资料库".to_string(), Some(docs.clone()))], "发件箱", 5).unwrap();
        let first = out.hits.first().expect("有结果");
        assert_eq!(first.path, "飞书发件箱.md");
        assert!(first.score > 0.0);
        assert!(first.text.contains("发件箱"), "{}", first.text);
        assert!(first.abs_path.as_deref().unwrap_or("").ends_with("飞书发件箱.md"));
        //整句中文（不是短语）也能搜到，第一条是讲飞书发件箱的那份。
        let whole = search(&settings.rag_dir, &[("资料库".to_string(), Some(docs.clone()))], "飞书发件箱怎么用", 5).unwrap();
        assert_eq!(whole.hits.first().expect("整句有结果").path, "飞书发件箱.md");
        //全是标点：不报错，也没有结果。
        let punctuation = search(&settings.rag_dir, &[("资料库".to_string(), Some(docs.clone()))], "，。！", 5).unwrap();
        assert!(punctuation.hits.is_empty());
        // 带查询语法字符也不报错。
        assert!(search(&settings.rag_dir, &[("资料库".to_string(), None)], "决策:模型\"", 5).is_ok());
        // 第二次：没变的文件不重做。
        let again = index_lib(&settings.rag_dir, "资料库", &db, &|_| ()).expect("再建");
        assert_eq!(again.changed, 0);
        // 删一个文件、重新摄取：索引里它的块也没了。
        std::fs::remove_file(docs.join("模型.md")).unwrap();
        memory::ingest(&settings, "资料库", None, false, &|_| ()).expect("再摄取");
        let third = index_lib(&settings.rag_dir, "资料库", &db, &|_| ()).expect("三建");
        assert_eq!(third.removed, 1);
        let gone = search(&settings.rag_dir, &[("资料库".to_string(), None)], "决策模型", 5).unwrap();
        assert!(gone.hits.iter().all(|hit| hit.path != "模型.md"));
    }
}
