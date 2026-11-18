//! 代码解析（tree-sitter）：从一个源文件里取出三样东西，不做跨文件的解析（那在 graph.rs）：
//!   声明  函数、类、方法、接口、类型、结构体……，带“外层.名字”的全名（如 createEngine.handleMessage）
//!   引用  调用（f()、obj.f()、new F()）和当参数、对象属性传出去的名字（回调、{ handleMessage }）
//!   导入  import/require、Rust 的 mod/use、Go 的 import、Python 的 import
//!
//! 支持 TypeScript、TSX、JavaScript、Rust、Go、Python。
//! 只看语法，不知道名字到底指向哪个声明；graph.rs 先按“同文件 → 导入了的文件 → 全局唯一”的顺序去找，
//! 每条边带一个置信度。graphify 漏掉的“经返回对象转出去再调用”（engine.handleMessage）就是靠
//! 这里把 obj.f() 的 f 和 { handleMessage } 简写属性都记成引用接上的。

use tree_sitter::{Language, Node, Parser};

/// 支持的语言。
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    Ts,
    Tsx,
    Js,
    Rust,
    Go,
    Python,
}

impl Lang {
    /// 按扩展名认语言；不认识时是 None。
    pub fn from_path(path: &str) -> Option<Lang> {
        let ext = path.rsplit('.').next()?.to_ascii_lowercase();
        Some(match ext.as_str() {
            "ts" | "mts" | "cts" => Lang::Ts,
            "tsx" => Lang::Tsx,
            "js" | "jsx" | "mjs" | "cjs" => Lang::Js,
            "rs" => Lang::Rust,
            "go" => Lang::Go,
            "py" => Lang::Python,
            _ => return None,
        })
    }

    /// 存进数据库的名字。
    pub fn name(self) -> &'static str {
        match self {
            Lang::Ts => "typescript",
            Lang::Tsx => "tsx",
            Lang::Js => "javascript",
            Lang::Rust => "rust",
            Lang::Go => "go",
            Lang::Python => "python",
        }
    }

    /// 是不是 TS/JS 一家。
    fn is_js(self) -> bool {
        matches!(self, Lang::Ts | Lang::Tsx | Lang::Js)
    }

    /// tree-sitter 的语法。
    fn language(self) -> Language {
        match self {
            Lang::Ts => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Lang::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Lang::Js => tree_sitter_javascript::LANGUAGE.into(),
            Lang::Rust => tree_sitter_rust::LANGUAGE.into(),
            Lang::Go => tree_sitter_go::LANGUAGE.into(),
            Lang::Python => tree_sitter_python::LANGUAGE.into(),
        }
    }
}

/// 一个声明。
#[derive(Debug, Clone)]
pub struct Symbol {
    /// 名字。
    pub name: String,

    /// 全名：外层的名字用点连起来，如 createEngine.handleMessage、Store.open。
    pub qname: String,

    /// 种类：function、method、class、interface、type、struct、enum、trait、const、heading……
    pub kind: String,

    /// 起始行（从 1 数）。
    pub line: i64,

    /// 结束行。
    pub end_line: i64,
}

/// 一个引用。
#[derive(Debug, Clone)]
pub struct Ref {
    /// 发生在哪个声明里（全名）；在文件顶层时是 None。
    pub from: Option<String>,

    /// 被引用的名字。
    pub name: String,

    /// call：调用；member：obj.f() 这种调用；ref：当值传出去（回调、对象属性）；type：当类型用。
    pub kind: &'static str,

    /// 行。
    pub line: i64,
}

/// 一条导入，原样记下，graph.rs 再按语言规则找到文件。
#[derive(Debug, Clone)]
pub struct Import {
    /// 写法：TS/JS/Go 是路径字符串；Rust 是 mod:名字 或 use:路径；Python 是 abs:a.b 或 rel:.a。
    pub spec: String,

    /// 行。
    pub line: i64,
}

/// 一个文件解析出来的全部东西。
#[derive(Debug, Default)]
pub struct Parsed {
    pub symbols: Vec<Symbol>,
    pub refs: Vec<Ref>,
    pub imports: Vec<Import>,
}

/// 解析一个源文件。语法错误不影响别的部分（tree-sitter 会尽量解析）。
pub fn parse(lang: Lang, src: &str) -> Parsed {
    let mut parser = Parser::new();
    if parser.set_language(&lang.language()).is_err() {
        return Parsed::default();
    }
    let Some(tree) = parser.parse(src, None) else {
        return Parsed::default();
    };
    let mut walker = Walker { lang, src: src.as_bytes(), out: Parsed::default(), scope: Vec::new() };
    walker.visit(tree.root_node(), 0);
    walker.out
}

/// 一层作用域：名字，以及它是不是声明（是的话带全名）。
struct Scope {
    part: String,
    qname: Option<String>,
}

/// 一个声明节点的信息。
struct Decl {
    name: String,
    kind: &'static str,
    /// 是不是要记成声明（Rust 的 impl 只是作用域，不记）。
    is_symbol: bool,
    /// 自带的外层（Go 方法的接收者类型）。
    qualifier: Option<String>,
}

/// 遍历语法树。
struct Walker<'a> {
    lang: Lang,
    src: &'a [u8],
    out: Parsed,
    scope: Vec<Scope>,
}

/// 名字字段是“自己的名字”的声明（类型引用不算它们）。
const DECL_KINDS: &[&str] = &[
    "class_declaration",
    "abstract_class_declaration",
    "interface_declaration",
    "type_alias_declaration",
    "enum_declaration",
    "type_parameter",
    "struct_item",
    "enum_item",
    "union_item",
    "trait_item",
    "type_item",
    "type_spec",
    "type_alias",
];

/// 嵌套太深的树（生成的代码）不往下走，免得栈溢出。
const MAX_DEPTH: usize = 400;

impl<'a> Walker<'a> {
    fn text(&self, node: Node) -> String {
        node.utf8_text(self.src).unwrap_or_default().to_string()
    }

    fn field_text(&self, node: Node, field: &str) -> Option<String> {
        node.child_by_field_name(field).map(|child| self.text(child))
    }

    /// 当前所在的声明的全名。
    fn current(&self) -> Option<String> {
        self.scope.iter().rev().find_map(|scope| scope.qname.clone())
    }

    fn visit(&mut self, node: Node, depth: usize) {
        if depth > MAX_DEPTH {
            return;
        }
        let mut pushed = false;
        if let Some(decl) = self.declaration(node) {
            let qname = match &decl.qualifier {
                Some(qualifier) => format!("{qualifier}.{}", decl.name),
                None => {
                    let mut parts: Vec<&str> = self.scope.iter().map(|scope| scope.part.as_str()).collect();
                    parts.push(&decl.name);
                    parts.join(".")
                }
            };
            if decl.is_symbol {
                self.out.symbols.push(Symbol {
                    name: decl.name.clone(),
                    qname: qname.clone(),
                    kind: decl.kind.to_string(),
                    line: node.start_position().row as i64 + 1,
                    end_line: node.end_position().row as i64 + 1,
                });
            }
            self.scope.push(Scope { part: decl.name, qname: decl.is_symbol.then_some(qname) });
            pushed = true;
        }
        self.reference(node);
        self.import(node);
        let mut cursor = node.walk();
        let children: Vec<Node> = node.children(&mut cursor).collect();
        for child in children {
            self.visit(child, depth + 1);
        }
        if pushed {
            self.scope.pop();
        }
    }

    /// 这个节点是不是声明。
    fn declaration(&self, node: Node) -> Option<Decl> {
        let simple = |kind: &'static str| -> Option<Decl> {
            let name = self.field_text(node, "name")?;
            Some(Decl { name, kind, is_symbol: true, qualifier: None })
        };
        let kind = node.kind();
        if self.lang.is_js() {
            return match kind {
                "function_declaration" | "generator_function_declaration" | "function_signature" => simple("function"),
                "class_declaration" | "abstract_class_declaration" => simple("class"),
                "interface_declaration" => simple("interface"),
                "type_alias_declaration" => simple("type"),
                "enum_declaration" => simple("enum"),
                "method_definition" | "method_signature" | "abstract_method_signature" => simple("method"),
                "internal_module" | "module" => simple("namespace"),
                "public_field_definition" => {
                    let value = node.child_by_field_name("value")?;
                    matches!(value.kind(), "arrow_function" | "function_expression").then_some(())?;
                    simple("method")
                }
                "variable_declarator" => {
                    let name_node = node.child_by_field_name("name")?;
                    if name_node.kind() != "identifier" {
                        return None;
                    }
                    let value_kind = node.child_by_field_name("value").map(|value| value.kind());
                    let decl_kind = match value_kind {
                        Some("arrow_function" | "function_expression" | "function" | "generator_function") => "function",
                        Some("class") => "class",
                        _ => {
                            // 顶层的常量也记下（如 DEFAULT_TOOLS），搜得到。
                            let top = node.parent().and_then(|parent| parent.parent()).map(|grand| grand.kind());
                            if matches!(top, Some("program" | "export_statement")) { "const" } else { return None }
                        }
                    };
                    Some(Decl { name: self.text(name_node), kind: decl_kind, is_symbol: true, qualifier: None })
                }
                _ => None,
            };
        }
        match self.lang {
            Lang::Rust => match kind {
                "function_item" | "function_signature_item" => simple("function"),
                "struct_item" => simple("struct"),
                "enum_item" => simple("enum"),
                "union_item" => simple("union"),
                "trait_item" => simple("trait"),
                "type_item" => simple("type"),
                "const_item" | "static_item" => simple("const"),
                "mod_item" => simple("mod"),
                "macro_definition" => simple("macro"),
                "impl_item" => {
                    let name = base_type_name(&self.field_text(node, "type")?);
                    Some(Decl { name, kind: "impl", is_symbol: false, qualifier: None })
                }
                _ => None,
            },
            Lang::Go => match kind {
                "function_declaration" => simple("function"),
                "type_spec" | "type_alias" => simple("type"),
                "method_declaration" => {
                    let name = self.field_text(node, "name")?;
                    let receiver = node
                        .child_by_field_name("receiver")
                        .and_then(|list| {
                            let mut cursor = list.walk();

                            list.named_children(&mut cursor).find(|child| child.kind() == "parameter_declaration")
                        })
                        .and_then(|param| self.field_text(param, "type"))
                        .map(|text| base_type_name(&text));
                    Some(Decl { name, kind: "method", is_symbol: true, qualifier: receiver })
                }
                _ => None,
            },
            Lang::Python => match kind {
                "function_definition" => simple("function"),
                "class_definition" => simple("class"),
                _ => None,
            },
            _ => None,
        }
    }

    /// 记一个引用。
    fn push_ref(&mut self, name: String, kind: &'static str, node: Node) {
        if name.is_empty() || name.len() > 80 {
            return;
        }
        let from = self.current();
        self.out.refs.push(Ref { from, name, kind, line: node.start_position().row as i64 + 1 });
    }

    /// 被调用的是哪个名字：f → f，obj.f → f，a::b::f → f。返回名字所在的节点（行号按它算，
    /// 跨行的链式调用 a\n  .f() 记在 f 那一行）。
    fn callee<'t>(&self, node: Node<'t>) -> Option<Node<'t>> {
        match node.kind() {
            "identifier" | "type_identifier" | "field_identifier" | "property_identifier" => Some(node),
            "member_expression" => node.child_by_field_name("property"),
            "scoped_identifier" => node.child_by_field_name("name"),
            "field_expression" | "selector_expression" => node.child_by_field_name("field"),
            "attribute" => node.child_by_field_name("attribute"),
            "generic_function" => node.child_by_field_name("function").and_then(|inner| self.callee(inner)),
            "non_null_expression" | "parenthesized_expression" => node.named_child(0).and_then(|inner| self.callee(inner)),
            _ => None,
        }
    }

    /// 记一个调用：field 字段里的东西是被调用的。
    /// obj.f() 记成 member（obj 不是 this、self 时）：f 多半来自别的文件，graph.rs 不让同文件的同名函数抢先。
    fn call_ref(&mut self, node: Node, field: &str) {
        let Some(func) = node.child_by_field_name(field) else { return };
        let Some(target) = self.callee(func) else { return };
        let name = self.text(target);
        if name == "require" {
            return;
        }
        let receiver = match func.kind() {
            "member_expression" => func.child_by_field_name("object"),
            "field_expression" | "selector_expression" => func.child_by_field_name("value").or_else(|| func.child_by_field_name("operand")),
            "attribute" => func.child_by_field_name("object"),
            _ => None,
        };
        let is_member = receiver.is_some_and(|receiver| !matches!(self.text(receiver).as_str(), "this" | "self" | "Self" | "super"));
        self.push_ref(name, if is_member { "member" } else { "call" }, target);
    }

    /// 参数列表里直接写的名字（当回调传出去）。
    fn argument_refs(&mut self, node: Node) {
        let mut cursor = node.walk();
        let names: Vec<Node> = node
            .named_children(&mut cursor)
            .filter_map(|child| match child.kind() {
                "identifier" => Some(child),
                // router.describeAction 这种当回调传的。
                "member_expression" | "field_expression" | "selector_expression" | "attribute" => self.callee(child),
                _ => None,
            })
            .collect();
        for child in names {
            let name = self.text(child);
            self.push_ref(name, "ref", child);
        }
    }

    /// 这个节点是不是引用。
    fn reference(&mut self, node: Node) {
        let kind = node.kind();
        //M 类型的用处（参数、返回值、字段的类型），声明自己的名字不算。
        if kind == "type_identifier" && matches!(self.lang, Lang::Ts | Lang::Tsx | Lang::Rust | Lang::Go) {
            let is_own_name = node.parent().is_some_and(|parent| {
                DECL_KINDS.contains(&parent.kind()) && parent.child_by_field_name("name").is_some_and(|name| name.id() == node.id())
            });
            if !is_own_name {
                let name = self.text(node);
                self.push_ref(name, "type", node);
            }
            return;
        }
        if self.lang.is_js() {
            match kind {
                "call_expression" => self.call_ref(node, "function"),
                "new_expression" => self.call_ref(node, "constructor"),
                "arguments" => self.argument_refs(node),
                "shorthand_property_identifier" => {
                    let name = self.text(node);
                    self.push_ref(name, "ref", node);
                }
                "pair" => {
                    if let Some(value) = node.child_by_field_name("value").filter(|value| value.kind() == "identifier") {
                        let name = self.text(value);
                        self.push_ref(name, "ref", value);
                    }
                }
                "jsx_opening_element" | "jsx_self_closing_element" => {
                    if let Some(target) = node.child_by_field_name("name").and_then(|func| self.callee(func)) {
                        let name = self.text(target);
                        if name.starts_with(|c: char| c.is_ascii_uppercase()) {
                            self.push_ref(name, "call", target);
                        }
                    }
                }
                _ => {}
            }
            return;
        }
        match (self.lang, kind) {
            (Lang::Rust, "call_expression") | (Lang::Go, "call_expression") | (Lang::Python, "call") => self.call_ref(node, "function"),
            (Lang::Rust, "arguments") | (Lang::Go, "argument_list") | (Lang::Python, "argument_list") => self.argument_refs(node),
            (Lang::Rust, "struct_expression") => self.call_ref(node, "name"),
            (Lang::Go, "composite_literal") => self.call_ref(node, "type"),
            (Lang::Python, "decorator") => {
                if let Some(target) = node.named_child(0).and_then(|inner| self.callee(inner)) {
                    let name = self.text(target);
                    self.push_ref(name, "call", target);
                }
            }
            _ => {}
        }
    }

    fn push_import(&mut self, spec: String, node: Node) {
        if !spec.is_empty() {
            self.out.imports.push(Import { spec, line: node.start_position().row as i64 + 1 });
        }
    }

    /// 这个节点是不是导入。
    fn import(&mut self, node: Node) {
        let kind = node.kind();
        if self.lang.is_js() {
            match kind {
                "import_statement" | "export_statement" => {
                    if let Some(source) = self.field_text(node, "source") {
                        self.push_import(unquote(&source), node);
                    }
                }
                "call_expression" => {
                    let func = node.child_by_field_name("function");
                    let is_import = func.is_some_and(|func| func.kind() == "import" || self.text(func) == "require");
                    if is_import {
                        let arg = node.child_by_field_name("arguments").and_then(|args| args.named_child(0));
                        if let Some(arg) = arg.filter(|arg| arg.kind() == "string") {
                            let spec = unquote(&self.text(arg));
                            self.push_import(spec, node);
                        }
                    }
                }
                _ => {}
            }
            return;
        }
        match (self.lang, kind) {
            (Lang::Rust, "mod_item") => {
                if node.child_by_field_name("body").is_none()
                    && let Some(name) = self.field_text(node, "name")
                {
                    self.push_import(format!("mod:{name}"), node);
                }
            }
            (Lang::Rust, "use_declaration") => {
                if let Some(argument) = self.field_text(node, "argument") {
                    for path in expand_rust_use(&argument) {
                        self.push_import(format!("use:{path}"), node);
                    }
                }
            }
            (Lang::Go, "import_spec") => {
                if let Some(path) = self.field_text(node, "path") {
                    self.push_import(unquote(&path), node);
                }
            }
            (Lang::Python, "import_statement") => {
                let mut cursor = node.walk();
                let names: Vec<String> = node
                    .named_children(&mut cursor)
                    .filter_map(|child| match child.kind() {
                        "dotted_name" => Some(self.text(child)),
                        "aliased_import" => self.field_text(child, "name"),
                        _ => None,
                    })
                    .collect();
                for name in names {
                    self.push_import(format!("abs:{name}"), node);
                }
            }
            (Lang::Python, "import_from_statement") => {
                let Some(module) = self.field_text(node, "module_name") else { return };
                if module.chars().all(|c| c == '.') {
                    // from . import a, b：每个名字可能是一个模块文件。
                    let mut cursor = node.walk();
                    let names: Vec<String> = node
                        .children_by_field_name("name", &mut cursor)
                        .filter_map(|child| match child.kind() {
                            "dotted_name" => Some(self.text(child)),
                            "aliased_import" => self.field_text(child, "name"),
                            _ => None,
                        })
                        .collect();
                    for name in names {
                        self.push_import(format!("rel:{module}{name}"), node);
                    }
                } else if module.starts_with('.') {
                    self.push_import(format!("rel:{module}"), node);
                } else {
                    self.push_import(format!("abs:{module}"), node);
                }
            }
            _ => {}
        }
    }
}

/// 去掉引号。
fn unquote(text: &str) -> String {
    text.trim().trim_matches(|c| c == '"' || c == '\'' || c == '`').to_string()
}

/// 类型名去掉引用、泛型和路径：&mut a::Foo<T> → Foo，*Server → Server。
fn base_type_name(text: &str) -> String {
    let text = text.trim_start_matches(['&', '*', ' ']).trim_start_matches("mut ");
    let text = text.split('<').next().unwrap_or(text);
    let text = text.split('[').next().unwrap_or(text);
    text.rsplit("::").next().unwrap_or(text).rsplit('.').next().unwrap_or(text).trim().to_string()
}

/// Rust 的 use 展开成一条条路径：crate::a::{b, c::D} → crate::a::b、crate::a::c::D。只展开一层花括号。
fn expand_rust_use(argument: &str) -> Vec<String> {
    let compact: String = argument.chars().filter(|c| !c.is_whitespace()).collect();
    let Some(open) = compact.find('{') else {
        return vec![compact.split(" as ").next().unwrap_or(&compact).to_string()];
    };
    let prefix = compact[..open].trim_end_matches("::");
    let inner = compact[open + 1..].trim_end_matches('}');
    inner
        .split(',')
        .filter(|item| !item.is_empty() && !item.contains('{'))
        .map(|item| {
            let item = item.split("as").next().unwrap_or(item);
            if item == "self" { prefix.to_string() } else { format!("{prefix}::{item}") }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn typescript_nested_functions_and_member_calls() {
        let src = r#"
import * as engineModule from './Engine.ts';
export function createEngine() {
  async function handleMessage(input: string) { return run(input); }
  return { handleMessage };
}
export const DEFAULT_TOOLS = ['read'];
class Feishu { start(engine: any) { engine.handleMessage('hi'); setTimeout(tick, 10); } }
"#;
        let parsed = parse(Lang::Ts, src);
        let qnames: Vec<&str> = parsed.symbols.iter().map(|symbol| symbol.qname.as_str()).collect();
        assert!(qnames.contains(&"createEngine.handleMessage"), "{qnames:?}");
        assert!(qnames.contains(&"DEFAULT_TOOLS"));
        assert!(qnames.contains(&"Feishu.start"));
        assert!(parsed.refs.iter().any(|r| r.name == "handleMessage" && r.kind == "member" && r.from.as_deref() == Some("Feishu.start")));
        assert!(parsed.refs.iter().any(|r| r.name == "handleMessage" && r.kind == "ref" && r.from.as_deref() == Some("createEngine")));
        assert!(parsed.refs.iter().any(|r| r.name == "tick" && r.kind == "ref"));
        assert_eq!(parsed.imports[0].spec, "./Engine.ts");
    }

    #[test]
    fn rust_impl_methods_and_uses() {
        let src = "mod store;\nuse crate::store::{Store, self};\nstruct A;\nimpl A { fn go(&self) { Store::open(); helper(x); } }\n";
        let parsed = parse(Lang::Rust, src);
        assert!(parsed.symbols.iter().any(|symbol| symbol.qname == "A.go" && symbol.kind == "function"));
        assert!(parsed.refs.iter().any(|r| r.name == "open" && r.kind == "call" && r.from.as_deref() == Some("A.go")));
        let specs: Vec<&str> = parsed.imports.iter().map(|import| import.spec.as_str()).collect();
        assert_eq!(specs, ["mod:store", "use:crate::store::Store", "use:crate::store"]);
    }

    #[test]
    fn go_methods_get_receiver_qualifier() {
        let src = "package main\nimport \"example.com/m/util\"\ntype Server struct{}\nfunc (s *Server) Run() { util.Do(handler) }\n";
        let parsed = parse(Lang::Go, src);
        assert!(parsed.symbols.iter().any(|symbol| symbol.qname == "Server.Run"));
        assert!(parsed.refs.iter().any(|r| r.name == "Do" && r.from.as_deref() == Some("Server.Run")));
        assert!(parsed.refs.iter().any(|r| r.name == "handler" && r.kind == "ref"));
        assert_eq!(parsed.imports[0].spec, "example.com/m/util");
    }

    #[test]
    fn python_imports() {
        let src = "import os.path\nfrom . import util\nfrom .models import User\nclass A:\n    def f(self):\n        return helper()\n";
        let parsed = parse(Lang::Python, src);
        let specs: Vec<&str> = parsed.imports.iter().map(|import| import.spec.as_str()).collect();
        assert_eq!(specs, ["abs:os.path", "rel:.util", "rel:.models"]);
        assert!(parsed.refs.iter().any(|r| r.name == "helper" && r.from.as_deref() == Some("A.f")));
    }
}
