//! 录屏后端 v1 客户端与线上字段。连接只使用基地的本机后端配置。

use std::io::{BufRead, BufReader};
use std::net::IpAddr;
use std::sync::OnceLock;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize, de::DeserializeOwned};
use windows_sys::Win32::System::Com::CoCreateGuid;
use windows_sys::core::GUID;

use super::overlay::Display;
use super::privacy::Rect;

const VERSION: u32 = 1;
const STATE: &str = "/api/screen/state";
const STATUS: &str = "/api/screen/status";
const CLICK: &str = "/api/screen/click";
const CLICK_STREAM: &str = "/api/screen/click/stream";
const PRESENTED: &str = "/api/screen/presented";
const CONTROL_TIMEOUT: Duration = Duration::from_secs(2);
pub(super) const CLICK_TIMEOUT: Duration = Duration::from_secs(10);
pub(super) const HEARTBEAT: Duration = Duration::from_secs(5);
pub(super) const MAX_SEND_AGE: u64 = 1500;
const REPLY_LIMIT: u64 = 16 * 1024;
const MAX_LEASE_MS: u64 = 10_000;

static CLIENT: OnceLock<String> = OnceLock::new();
static NEXT_EPOCH: AtomicU64 = AtomicU64::new(1);

/// 按 Windows GUID 产生进程、会话和点击身份，协议中只作相关性标识。
pub(super) fn guid() -> Option<String> {
    let mut id = GUID::default();
    if unsafe { CoCreateGuid(&mut id) } < 0 { return None; }
    let tail = u64::from_be_bytes(id.data4);
    Some(format!("{:08x}-{:04x}-{:04x}-{:04x}-{:012x}", id.data1, id.data2, id.data3, tail >> 48, tail & 0x0000_ffff_ffff_ffff))
}

fn client_id() -> Option<String> {
    if let Some(id) = CLIENT.get() { return Some(id.clone()); }
    let fresh = guid()?;
    Some(CLIENT.get_or_init(|| fresh).clone())
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct Identity {
    protocol_version: u32,
    client_id: String,
    session_id: String,
    epoch: u64,
}

impl Identity {
    pub fn new() -> Option<Self> {
        Some(Self {
            protocol_version: VERSION,
            client_id: client_id()?,
            session_id: guid()?,
            epoch: NEXT_EPOCH.fetch_add(1, Ordering::Relaxed),
        })
    }

    pub fn advance(&mut self) {
        self.epoch = NEXT_EPOCH.fetch_add(1, Ordering::Relaxed);
    }
}

#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClickId {
    #[serde(flatten)]
    pub identity: Identity,
    pub click_id: String,
    pub seq: u64,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub(super) struct Point {
    pub x: i32,
    pub y: i32,
}

#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
pub(super) struct WireRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl WireRect {
    pub fn from_rect(rect: Rect) -> Option<Self> {
        let width = rect.right.checked_sub(rect.left)?;
        let height = rect.bottom.checked_sub(rect.top)?;
        if width <= 0 || height <= 0 { return None; }
        Some(Self { x: rect.left, y: rect.top, width, height })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct MonitorBody {
    id: String,
    rect: WireRect,
    dpi_x: u32,
    dpi_y: u32,
}

impl MonitorBody {
    pub fn new(display: &Display) -> Option<Self> {
        Some(Self {
            id: display.id.clone(),
            rect: WireRect::from_rect(display.rect)?,
            dpi_x: display.dpi_x,
            dpi_y: display.dpi_y,
        })
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct WindowBody {
    pub pid: u32,
    pub process_name: String,
    pub process_started_at_ms: u64,
    pub window_id: String,
    pub title: String,
    pub rect: WireRect,
    pub observed_at_ms: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ControlBody {
    pub name: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub automation_id: String,
    pub rect: Option<WireRect>,
    pub observed_at_ms: u64,
    pub is_password: bool,
    pub privacy_checked: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ImageBody {
    pub mime_type: &'static str,
    pub data: String,
    pub captured_at_ms: u64,
    pub age_before_click_ms: u64,
    pub source_rect: WireRect,
    pub width: u32,
    pub height: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct ClickBody {
    #[serde(flatten)]
    pub id: ClickId,
    pub clicked_at_ms: u64,
    pub age_at_send_ms: u64,
    pub button: &'static str,
    pub position: Point,
    pub monitor: MonitorBody,
    pub window: WindowBody,
    pub control: ControlBody,
    pub image: Option<ImageBody>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_omitted_reason: Option<&'static str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    protocol_version: u32,
    available: bool,
    enabled: bool,
    effective: Effective,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Effective {
    pub crop_width: u32,
    pub crop_height: u32,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum Action {
    UserStart,
    Heartbeat,
    PrivacyPause,
    UserStop,
    Resume,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct StateBody<'a> {
    #[serde(flatten)]
    identity: &'a Identity,
    active: bool,
    reason_code: Action,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StateReply {
    ok: bool,
    session_id: String,
    epoch: u64,
    active: bool,
    lease_ms: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Explanation {
    #[serde(flatten)]
    id: ClickId,
    ok: bool,
    pub text: String,
    pub display_for_ms: u64,
    #[serde(default)]
    pub speak_eligible: bool,
    pub segment: Option<u8>,
}

#[derive(Deserialize)]
struct StreamFrame {
    phase: String,
    #[serde(flatten)]
    explanation: Explanation,
}

/// 只有未安装流式入口的后端才允许回退为完整请求。
pub(super) enum StreamResult {
    Complete,
    Legacy,
    Failed,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PresentedBody<'a> {
    #[serde(flatten)]
    identity: &'a Identity,
    click_id: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    segment: Option<u8>,
}

impl Explanation {
    fn validate(self, request: &ClickBody) -> Option<Self> {
        if !self.ok || self.id != request.id || !(1_000..=10_000).contains(&self.display_for_ms) {
            return None;
        }
        let count = self.text.chars().count();
        if self.text.trim().is_empty() || count > 256 || self.text.chars().any(char::is_control) { return None; }
        Some(self)
    }
}

/// 独立 Agent 避免点击网络等待占用续租连接。响应拒绝、错误体和超时只以 None 回传。
#[derive(Clone)]
pub(super) struct Transport {
    server: String,
    controls: ureq::Agent,
    models: ureq::Agent,
}

impl Transport {
    pub fn connect(address: &str) -> Option<(Self, Effective)> {
        let server = address.trim_end_matches('/');
        if !is_local(server) { return None; }
        let transport = Self {
            server: server.to_owned(),
            controls: client(CONTROL_TIMEOUT),
            models: client(CLICK_TIMEOUT),
        };
        let id = client_id()?;
        let url = format!("{}{STATUS}?clientId={id}", transport.server);
        let response = transport.controls.get(&url).call().ok()?;
        let status: Status = decode(response)?;
        if status.protocol_version != VERSION || !status.available || !status.enabled { return None; }
        let effective = status.effective;
        if !(64..=1280).contains(&effective.crop_width) || !(64..=720).contains(&effective.crop_height) {
            return None;
        }
        Some((transport, effective))
    }

    /// 返回以请求起点算出的保守租约截止时间。
    pub fn state(&self, identity: &Identity, active: bool, action: Action) -> Option<Instant> {
        let started = Instant::now();
        let url = format!("{}{STATE}", self.server);
        let body = StateBody { identity, active, reason_code: action };
        let response = self.controls.post(&url).send_json(&body).ok()?;
        let reply: StateReply = decode(response)?;
        if !reply.ok || reply.session_id != identity.session_id || reply.epoch != identity.epoch
            || reply.active != active || !(1..=MAX_LEASE_MS).contains(&reply.lease_ms)
        {
            return None;
        }
        Some(started + Duration::from_millis(reply.lease_ms))
    }

    pub fn explain(&self, request: &ClickBody) -> Option<Explanation> {
        let url = format!("{}{CLICK}", self.server);
        let response = self.models.post(&url).send_json(request).ok()?;
        let explanation: Explanation = decode(response)?;
        explanation.validate(request)
    }

    /// 从专用响应逐行交付片段。错误或断开时终止此点击，只有旧路由缺席才回退。
    pub fn explain_stream(
        &self, request: &ClickBody, mut on_frame: impl FnMut(Explanation) -> bool,
    ) -> StreamResult {
        let url = format!("{}{CLICK_STREAM}", self.server);
        let sent = self.models.post(&url).send_json(request);
        let Ok(mut response) = sent else { return StreamResult::Failed; };
        if response.status().as_u16() == 404 { return StreamResult::Legacy; }
        if !response.status().is_success() { return StreamResult::Failed; }

        let content_type = response.headers().get("content-type");
        let is_stream = content_type.and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("application/x-ndjson"));
        if !is_stream { return StreamResult::Failed; }

        //G 限制整个响应大小，并验证每条实际呈现的帧都属于本次点击。
        let body = response.body_mut().with_config().limit(REPLY_LIMIT).reader();
        let lines = BufReader::new(body).lines();
        let mut partial = false;
        for line in lines {
            let Ok(line) = line else { return StreamResult::Failed; };
            let decoded = serde_json::from_str::<StreamFrame>(&line);
            let Ok(frame) = decoded else { return StreamResult::Failed; };
            let Some(explanation) = frame.explanation.validate(request) else { return StreamResult::Failed; };
            let segment = explanation.segment.unwrap_or(1);

            if frame.phase == "partial" && !partial && segment == 1 {
                partial = true;
                if !on_frame(explanation) { return StreamResult::Failed; }
                continue;
            }
            if frame.phase != "done" || segment == 0 || segment > 2 || (!partial && segment > 1) {
                return StreamResult::Failed;
            }
            if !on_frame(explanation) { return StreamResult::Failed; }
            return StreamResult::Complete;
        }
        StreamResult::Failed
    }

    /// 只确认已显示的点击标识，讲解正文仍由后端回执缓存提供。
    pub fn presented(&self, id: &ClickId, segment: Option<u8>) {
        let url = format!("{}{PRESENTED}", self.server);
        let body = PresentedBody { identity: &id.identity, click_id: &id.click_id, segment };
        let _ = self.controls.post(&url).send_json(&body);
    }
}

fn client(timeout: Duration) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(timeout))
        .build();
    config.into()
}

fn decode<T: DeserializeOwned>(mut response: ureq::http::Response<ureq::Body>) -> Option<T> {
    if !response.status().is_success() { return None; }
    response.body_mut().with_config().limit(REPLY_LIMIT).read_json().ok()
}

fn is_local(address: &str) -> bool {
    let Ok(uri) = address.parse::<ureq::http::Uri>() else { return false; };
    if !matches!(uri.scheme_str(), Some("http" | "https")) || uri.query().is_some() {
        return false;
    }
    let Some(host) = uri.host() else { return false; };
    if host.eq_ignore_ascii_case("localhost") { return true; }
    let ip = host.trim_start_matches('[').trim_end_matches(']').parse::<IpAddr>();
    ip.is_ok_and(|ip| ip.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, to_value};

    fn fixture(identity: Identity) -> ClickBody {
        let rect = WireRect { x: -100, y: 0, width: 100, height: 100 };
        let id = ClickId { identity, click_id: "click-1".into(), seq: 1 };
        ClickBody {
            id,
            clicked_at_ms: 2000,
            age_at_send_ms: 25,
            button: "left",
            position: Point { x: -30, y: 15 },
            monitor: MonitorBody { id: "monitor-test".into(), rect, dpi_x: 120, dpi_y: 120 },
            window: WindowBody {
                pid: 21, process_name: "notepad.exe".into(), process_started_at_ms: 1000,
                window_id: "handle-test".into(), title: "测试文档".into(), rect, observed_at_ms: 2010,
            },
            control: ControlBody {
                name: "保存".into(), kind: "按钮".into(), automation_id: "control-test".into(),
                rect: None, observed_at_ms: 2011, is_password: false, privacy_checked: true,
            },
            image: None,
            image_omitted_reason: Some("no_preclick_frame"),
        }
    }

    #[test]
    fn click_json_matches_backend_protocol_fixture() {
        let identity = Identity {
            protocol_version: 1, client_id: "base-one".into(), session_id: "screen-one".into(), epoch: 1,
        };
        let body = fixture(identity);
        let rect = body.window.rect;
        let expected = json!({
            "protocolVersion": 1, "clientId": "base-one", "sessionId": "screen-one", "epoch": 1,
            "clickId": "click-1", "seq": 1, "clickedAtMs": 2000, "ageAtSendMs": 25, "button": "left",
            "position": {"x": -30, "y": 15},
            "monitor": {"id": "monitor-test", "rect": {"x":-100,"y":0,"width":100,"height":100},
                "dpiX": 120, "dpiY": 120},
            "window": {"pid": 21, "processName": "notepad.exe", "processStartedAtMs": 1000,
                "windowId": "handle-test", "title": "测试文档",
                "rect": {"x":-100,"y":0,"width":100,"height":100}, "observedAtMs": 2010},
            "control": {"name": "保存", "type": "按钮", "automationId": "control-test", "rect": null,
                "observedAtMs": 2011, "isPassword": false, "privacyChecked": true},
            "image": null, "imageOmittedReason": "no_preclick_frame"
        });
        assert_eq!(to_value(&body).unwrap(), expected);
        let control = StateBody { identity: &body.id.identity, active: false, reason_code: Action::PrivacyPause };
        assert_eq!(to_value(&control).unwrap()["reasonCode"], "privacy_pause");

        let response = |seq| serde_json::from_value::<Explanation>(json!({
            "protocolVersion": 1, "clientId": "base-one", "sessionId": "screen-one", "epoch": 1,
            "clickId": "click-1", "seq": seq, "ok": true, "text": "安全的模拟值", "displayForMs": 6000
        })).unwrap();
        assert!(response(1).validate(&body).is_some());
        assert!(response(2).validate(&body).is_none());

        let mut with_image = body;
        with_image.image = Some(ImageBody {
            mime_type: "image/jpeg", data: "/9j/wAALCAABAAEBAREA/9oACAEBAAA/AAD/2Q==".into(), captured_at_ms: 1900,
            age_before_click_ms: 100, source_rect: rect, width: 1, height: 1,
        });
        with_image.image_omitted_reason = None;
        let sent = to_value(&with_image).unwrap();
        let expected_image = json!({
            "mimeType": "image/jpeg", "data": "/9j/wAALCAABAAEBAREA/9oACAEBAAA/AAD/2Q==", "capturedAtMs": 1900,
            "ageBeforeClickMs": 100, "sourceRect": {"x":-100,"y":0,"width":100,"height":100},
            "width": 1, "height": 1,
        });
        assert_eq!(sent["image"], expected_image);
        assert!(sent.get("imageOmittedReason").is_none());
    }

    #[test]
    fn screen_transport_rejects_remote_server_and_redirect_like_addresses() {
        assert!(is_local("http://127.0.0.1:32010"));
        assert!(is_local("http://[::1]:32010"));
        assert!(is_local("http://localhost:32010"));
        assert!(!is_local("http://local.test:32010"));
        assert!(!is_local("http://127.0.0.1@remote.test"));
        assert!(!is_local("http://127.0.0.1:32010?target=remote"));
    }

    #[test]
    fn status_state_and_click_roundtrip_with_a_loopback_fixture() {
        let server = tiny_http::Server::http("127.0.0.1:0").unwrap();
        let address = format!("http://{}", server.server_addr());
        let work = std::thread::spawn(move || {
            for path in [STATUS, STATE, STATE, CLICK, CLICK_STREAM, PRESENTED] {
                let timeout = Duration::from_secs(4);
                let mut request = server.recv_timeout(timeout).unwrap().unwrap();
                let actual = request.url().split('?').next().unwrap();
                assert_eq!(actual, path);
                assert!(!request.headers().iter().any(|header| header.field.equiv("Authorization")));
                let value = match path {
                    STATUS => {
                        assert_eq!(*request.method(), tiny_http::Method::Get);
                        json!({
                            "protocolVersion": 1, "available": true, "enabled": true, "active": false,
                            "effective": {"cropWidth":480,"cropHeight":320},
                        })
                    }
                    _ => {
                        assert_eq!(*request.method(), tiny_http::Method::Post);
                        let json: serde_json::Value = serde_json::from_reader(request.as_reader()).unwrap();
                        assert_eq!(json["protocolVersion"], 1);
                        if path == PRESENTED {
                            assert_eq!(json["segment"], 2);
                            let reply = tiny_http::Response::from_string(r#"{"ok":true}"#);
                            request.respond(reply).unwrap();
                            continue;
                        }
                        if path == STATE {
                            assert!(json["reasonCode"] == "user_start" || json["reasonCode"] == "heartbeat");
                            assert_eq!(json["active"], true);
                            let reply = json!({
                                "ok":true,"sessionId":json["sessionId"],"epoch":json["epoch"],
                                "active":true,"leaseMs":10000
                            });
                            let reply = tiny_http::Response::from_string(reply.to_string());
                            request.respond(reply).unwrap();
                            continue;
                        }
                        assert_eq!(json["image"], serde_json::Value::Null);
                        assert_eq!(json["imageOmittedReason"], "no_preclick_frame");
                        json!({
                            "protocolVersion":1,"clientId":json["clientId"],"sessionId":json["sessionId"],
                            "epoch":json["epoch"],"clickId":json["clickId"],"seq":json["seq"],"ok":true,
                            "text":"模拟讲解。","displayForMs":6000
                        })
                    }
                };
                if path == CLICK_STREAM {
                    //M 同一点击的两条有效记录逐行到达，结束帧携带累计文字。
                    let mut preview = value.clone();
                    preview["phase"] = json!("partial");
                    preview["segment"] = json!(1);
                    let mut done = value;
                    done["phase"] = json!("done");
                    done["segment"] = json!(2);
                    done["text"] = json!("模拟讲解。保存当前文档。");
                    let body = format!("{preview}\n{done}\n");
                    let header = tiny_http::Header::from_bytes("content-type", "application/x-ndjson").unwrap();
                    let reply = tiny_http::Response::from_string(body).with_header(header);
                    request.respond(reply).unwrap();
                    continue;
                }
                let reply = tiny_http::Response::from_string(value.to_string());
                request.respond(reply).unwrap();
            }
        });

        let (client, effective) = Transport::connect(&address).unwrap();
        assert_eq!((effective.crop_width, effective.crop_height), (480, 320));
        let identity = Identity::new().unwrap();
        let opened = client.state(&identity, true, Action::UserStart).unwrap();
        let heartbeat = client.state(&identity, true, Action::Heartbeat).unwrap();
        assert!(heartbeat >= opened);
        let request = fixture(identity);
        let received = client.explain(&request).unwrap();
        assert_eq!(received.text, "模拟讲解。");
        let mut frames = Vec::new();
        let stream = client.explain_stream(&request, |frame| {
            frames.push((frame.segment, frame.text));
            true
        });
        assert!(matches!(stream, StreamResult::Complete));
        assert_eq!(frames, [(Some(1), "模拟讲解。".to_string()), (Some(2), "模拟讲解。保存当前文档。".to_string())]);
        client.presented(&request.id, Some(2));
        work.join().unwrap();
    }
}
