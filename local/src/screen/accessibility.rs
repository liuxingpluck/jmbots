//! 在独立的 COM MTA 工作线程查看 UIA 元素。先确认密码属性，再读取安全按钮等控件的标签。

use std::ptr::null_mut;
use std::time::{Duration, Instant};

use uiautomation::core::{UICacheRequest, UICondition};
use uiautomation::types::{ControlType, Handle, Point, TreeScope, UIProperty};
use uiautomation::variants::Variant;
use uiautomation::{UIAutomation, UIElement};
use windows_sys::Win32::System::Com::{COINIT_MULTITHREADED, CoInitializeEx, CoUninitialize};

use super::privacy::{self, Denial, Rect, WindowKey};

const MAX_NODES: usize = 200;
const MAX_TIME: Duration = Duration::from_millis(150);

/// 这个对象始终在创建它的工作线程上使用和释放，声明顺序让 UIA 先于 COM 释放。
pub(super) struct ControlProbe {
    automation: UIAutomation,
    child_condition: UICondition,
    properties: UICacheRequest,
    _com: ComApartment,
}

struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        //M 和本线程成功的 CoInitializeEx 配对。
        unsafe { CoUninitialize() };
    }
}

/// 只保留控件类型和安全标签，不读取编辑框值或文档正文。
#[derive(Clone)]
pub struct ControlInfo {
    pub kind: ControlType,
    pub name: Option<String>,
    pub(super) automation_id: String,
    pub(super) rect: Rect,
    pub(super) observed_at_ms: u64,
}

impl ControlInfo {
    pub(super) fn same_element(&self, other: &Self) -> bool {
        self.kind == other.kind && self.name == other.name
            && self.automation_id == other.automation_id && self.rect == other.rect
    }
}

impl ControlProbe {
    /// 初始化本线程的 COM 与 UIA。失败时工作线程不得开启 WGC。
    pub fn new() -> Result<Self, Denial> {
        let status = unsafe { CoInitializeEx(null_mut(), COINIT_MULTITHREADED as u32) };
        if status < 0 { return Err(Denial::AccessibilityUnavailable); }
        let com = ComApartment;
        let automation = uia(UIAutomation::new_direct())?;
        let child_condition = uia(automation.create_true_condition())?;
        let properties = uia(automation.create_cache_request())?;
        uia(properties.set_tree_scope(TreeScope::Element))?;
        for property in [
            UIProperty::ProcessId,
            UIProperty::IsPassword,
            UIProperty::ControlType,
            UIProperty::NativeWindowHandle,
            UIProperty::IsKeyboardFocusable,
            UIProperty::IsValuePatternAvailable,
            UIProperty::IsTextPatternAvailable,
        ] {
            uia(properties.add_property(property))?;
        }
        Ok(Self { automation, child_condition, properties, _com: com })
    }

    /// 确认整个前台窗口内都可安全采集。这比只校验点击邻域严格。
    pub fn check_window(&self, window: WindowKey) -> Result<(), Denial> {
        let mut budget = Budget::new();
        let root = self.root(window)?;
        self.check_tree(root, window, &mut budget)
    }

    /// 检查点击与焦点的归属和密码属性，并验证附近没有密码框。只在末尾读标签。
    pub fn inspect(&self, window: WindowKey, x: i32, y: i32, check_focus: bool) -> Result<ControlInfo, Denial> {
        if !window.rect.contains(x, y) || privacy::window_at(x, y) != window.hwnd {
            return Err(Denial::WindowChanged);
        }

        let mut budget = Budget::new();
        let root = self.root(window)?;
        let point = Point::new(x, y);
        let clicked = uia(self.automation.element_from_point(point))?;
        self.check_ancestors(&clicked, &root, window, &mut budget)?;
        if check_focus {
            let focused = uia(self.automation.get_focused_element())?;
            self.check_ancestors(&focused, &root, window, &mut budget)?;
        }

        //G 密码框可能是所点控件的兄弟节点。检查整棵子树才允许获取标签。
        self.check_tree(root, window, &mut budget)?;
        let bounds = uia(clicked.get_bounding_rectangle())?;
        let rect = Rect {
            left: bounds.get_left(),
            top: bounds.get_top(),
            right: bounds.get_right(),
            bottom: bounds.get_bottom(),
        };
        if !rect.contains(x, y) || privacy::window_at(x, y) != window.hwnd {
            return Err(Denial::WindowChanged);
        }
        let refreshed = uia(self.automation.element_from_point(point))?;
        if !uia(self.automation.compare_elements(&clicked, &refreshed))? {
            return Err(Denial::WindowChanged);
        }

        //G 只读明确用于标记操作的控件名称，避免把编辑内容或文档标题当标签。
        let kind = uia(clicked.get_control_type())?;
        let mut name = None;
        budget.check_time()?;
        if matches!(kind, ControlType::Button | ControlType::MenuItem | ControlType::CheckBox
            | ControlType::RadioButton | ControlType::TabItem)
        {
            name = Some(uia(clicked.get_name())?);
        }
        let automation_id = clicked.get_automation_id().unwrap_or_default();
        budget.check_time()?;
        let observed_at_ms = super::unix_ms();
        Ok(ControlInfo { kind, name, automation_id, rect, observed_at_ms })
    }

    fn root(&self, window: WindowKey) -> Result<UIElement, Denial> {
        let handle = Handle::from(window.hwnd as isize);
        uia(self.automation.element_from_handle(handle))
    }

    /// 只沿当前根窗口的祖先链检查，必须能走回指定根。
    fn check_ancestors(
        &self, start: &UIElement, root: &UIElement, window: WindowKey, budget: &mut Budget,
    ) -> Result<(), Denial> {
        let walker = uia(self.automation.get_raw_view_walker())?;
        let mut element = start.clone();
        let mut has_checked_child = false;
        loop {
            budget.visit()?;
            let cached = uia(element.build_updated_cache(&self.properties))?;
            check_node(&cached, window, has_checked_child)?;
            if uia(self.automation.compare_elements(&element, root))? { return Ok(()); }
            element = uia(walker.get_parent(&element))?;
            has_checked_child = true;
        }
    }

    /// 逐层枚举原始 UIA 子树，预算不足时整窗拒绝。
    fn check_tree(&self, root: UIElement, window: WindowKey, budget: &mut Budget) -> Result<(), Denial> {
        let root = uia(root.build_updated_cache(&self.properties))?;
        let mut pending = vec![root];
        while let Some(element) = pending.pop() {
            budget.visit()?;
            //M 一次读取每批子节点的安全属性，避免逐个属性与 provider 往返。
            let children = uia(element.find_all_build_cache(
                TreeScope::Children, &self.child_condition, &self.properties,
            ))?;
            check_node(&element, window, !children.is_empty())?;
            if children.len() + pending.len() > budget.remaining { return Err(Denial::AccessibilityBudget); }
            pending.extend(children);
        }
        budget.check_time()
    }
}

/// 淡化 provider 错误，只向外传固定分类，防止泄露第三方错误里的文字。
fn uia<T>(result: uiautomation::Result<T>) -> Result<T, Denial> {
    result.map_err(|_| Denial::AccessibilityUnavailable)
}

/// 点击、焦点和子树共用同一预算。
struct Budget {
    deadline: Instant,
    remaining: usize,
}

impl Budget {
    fn new() -> Self {
        Self { deadline: Instant::now() + MAX_TIME, remaining: MAX_NODES }
    }

    fn check_time(&self) -> Result<(), Denial> {
        if Instant::now() >= self.deadline { return Err(Denial::AccessibilityBudget); }
        Ok(())
    }

    fn visit(&mut self) -> Result<(), Denial> {
        self.check_time()?;
        if self.remaining == 0 { return Err(Denial::AccessibilityBudget); }
        self.remaining -= 1;
        Ok(())
    }
}

/// 对可编辑节点使用真实密码属性。个别原生桥接容器只承担布局，对其后代逐一检查。
fn check_node(element: &UIElement, window: WindowKey, has_child: bool) -> Result<(), Denial> {
    let pid = u32::try_from(uia(element.get_cached_process_id())?)
        .map_err(|_| Denial::AccessibilityUnavailable)?;
    let password = read_cached_bool(element, UIProperty::IsPassword, true)?;
    if password.is_none() && pid == window.pid && has_child && known_container(element, window)? {
        return Ok(());
    }
    privacy::check_element(password, pid, window.pid)
}

fn known_container(element: &UIElement, window: WindowKey) -> Result<bool, Denial> {
    let kind = uia(element.get_cached_control_type())?;
    if !matches!(kind, ControlType::Window | ControlType::Pane) { return Ok(false); }
    if uia(element.is_cached_keyboard_focusable())? { return Ok(false); }
    let handle: isize = uia(element.get_cached_native_window_handle())?.into();
    if !privacy::native_container(handle as usize, window) { return Ok(false); }

    //G 容器本身没有值和文本模式。任何缺少这两项证据的节点仍按未知阻止。
    let value = read_cached_bool(element, UIProperty::IsValuePatternAvailable, false)?;
    let text = read_cached_bool(element, UIProperty::IsTextPatternAvailable, false)?;
    Ok(value == Some(false) && text == Some(false))
}

/// 密码属性使用 UIA 的 ignore-default 模式，保留未提供属性与明确 false 的区别。
fn read_cached_bool(
    element: &UIElement, property: UIProperty, ignore_default: bool,
) -> Result<Option<bool>, Denial> {
    let property = property.into();
    let raw = unsafe { element.as_ref().GetCachedPropertyValueEx(property, ignore_default) };
    let value = Variant::from(raw.map_err(|_| Denial::AccessibilityUnavailable)?);
    let bool_type = Variant::from(false).get_type();
    if value.get_type() != bool_type { return Ok(None); }
    let value = value.try_into().map_err(|_| Denial::AccessibilityUnavailable)?;
    Ok(Some(value))
}
