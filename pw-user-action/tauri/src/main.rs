#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// pw-user-action-renderer
//
// Protocol: line-delimited JSON over stdin/stdout
//
// stdin (commands from parent):
//   {"type":"init","id":"...","prompt":"...","actions":["approve","cancel"]}  (first, required)
//   {"type":"visible","value":true|false}
//   {"type":"update","prompt":"...","actions":[...]}
//   {"type":"exit"}
//
// stdout (events to parent):
//   {"type":"ready"}
//   {"type":"clicked","action":"approve","submittedAt":"2026-04-05T..."}

use std::io::{self, BufRead, Write};
use std::sync::Arc;
use std::thread;

use serde::{Deserialize, Serialize};
use tao::{
    event::{Event, WindowEvent},
    event_loop::{ControlFlow, EventLoopBuilder},
    window::WindowBuilder,
    dpi::LogicalSize,
};
use wry::WebViewBuilder;

#[derive(Deserialize, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Command {
    Init {
        #[serde(default)]
        id: String,
        prompt: String,
        actions: Vec<String>,
    },
    Visible {
        value: bool,
    },
    Update {
        prompt: String,
        actions: Vec<String>,
    },
    Exit,
}

#[derive(Serialize, Debug)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Event_ {
    Ready,
    Clicked {
        action: String,
        #[serde(rename = "submittedAt")]
        submitted_at: String,
    },
}

#[derive(Debug)]
enum UserEvent {
    InitialRequest { id: String, prompt: String, actions: Vec<String> },
    SetBrowserVisible(bool),
    UpdateContent { prompt: String, actions: Vec<String> },
    ButtonClicked(String),
    ExternalExit,
}

fn build_html(prompt: &str, actions: &[String]) -> String {
    let buttons: String = actions
        .iter()
        .map(|a| {
            let escaped = a.replace('\'', "\\'").replace('<', "&lt;").replace('>', "&gt;");
            format!(
                r#"<button class="btn" onclick="submit('{}')">{}</button>"#,
                escaped, escaped
            )
        })
        .collect();

    let prompt_escaped = prompt.replace('<', "&lt;").replace('>', "&gt;");

    format!(
        r#"<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* {{ box-sizing: border-box; margin: 0; padding: 0; }}
body {{
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  background: #1a1a2e;
  color: #fff;
  padding: 24px;
  display: flex;
  flex-direction: column;
  height: 100vh;
  user-select: none;
}}
.title {{
  font-size: 12px;
  color: #8b8ba7;
  text-transform: uppercase;
  letter-spacing: 1.2px;
  margin-bottom: 14px;
  font-weight: 600;
}}
.prompt {{
  font-size: 15px;
  line-height: 1.6;
  margin-bottom: 28px;
  flex: 1;
  color: #e5e7eb;
}}
.buttons {{
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}}
.btn {{
  background: #4f46e5;
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 10px 22px;
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s;
}}
.btn:hover {{ background: #6366f1; transform: translateY(-1px); }}
.btn:active {{ transform: scale(0.98); }}
</style></head>
<body>
  <div class="title">pw-user-action</div>
  <div class="prompt">{}</div>
  <div class="buttons">{}</div>
<script>
function submit(action) {{
  window.ipc.postMessage(action);
}}
</script>
</body></html>"#,
        prompt_escaped, buttons
    )
}

fn write_event(event: &Event_) {
    let json = serde_json::to_string(event).unwrap();
    let stdout = io::stdout();
    let mut handle = stdout.lock();
    let _ = writeln!(handle, "{}", json);
    let _ = handle.flush();
}

fn format_iso8601(secs: u64, nanos: u32) -> String {
    let days_since_epoch = (secs / 86400) as i64;
    let secs_today = secs % 86400;
    let hour = (secs_today / 3600) as u32;
    let minute = ((secs_today % 3600) / 60) as u32;
    let second = (secs_today % 60) as u32;
    let (year, month, day) = days_to_ymd(days_since_epoch);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        year, month, day, hour, minute, second, nanos / 1_000_000
    )
}

fn days_to_ymd(days: i64) -> (i32, u32, u32) {
    let z = days + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = if m <= 2 { y + 1 } else { y };
    (y as i32, m as u32, d as u32)
}

fn main() -> wry::Result<()> {
    // Read first line from stdin: must be init command
    let stdin = io::stdin();
    let mut first_line = String::new();
    stdin.lock().read_line(&mut first_line).expect("read init line");
    let first_line = first_line.trim();
    if first_line.is_empty() {
        eprintln!("expected init command on stdin, got EOF");
        std::process::exit(1);
    }
    let init: Command = serde_json::from_str(first_line).expect("parse init command");
    let (init_id, init_prompt, init_actions) = match init {
        Command::Init { id, prompt, actions } => (id, prompt, actions),
        _ => {
            eprintln!("first stdin message must be init");
            std::process::exit(1);
        }
    };

    let event_loop = EventLoopBuilder::<UserEvent>::with_user_event().build();
    let proxy = event_loop.create_proxy();

    // Spawn stdin reader thread for subsequent commands
    let stdin_proxy = proxy.clone();
    thread::spawn(move || {
        let stdin = io::stdin();
        for line in stdin.lock().lines() {
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let cmd: Result<Command, _> = serde_json::from_str(line);
            let event = match cmd {
                Ok(Command::Visible { value }) => UserEvent::SetBrowserVisible(value),
                Ok(Command::Update { prompt, actions }) => {
                    UserEvent::UpdateContent { prompt, actions }
                }
                Ok(Command::Exit) => UserEvent::ExternalExit,
                Ok(Command::Init { .. }) => continue, // ignore re-init
                Err(_) => continue, // ignore malformed
            };
            if stdin_proxy.send_event(event).is_err() {
                break;
            }
        }
    });

    // Send initial request to event loop
    proxy.send_event(UserEvent::InitialRequest {
        id: init_id.clone(),
        prompt: init_prompt,
        actions: init_actions,
    }).ok();

    let window = WindowBuilder::new()
        .with_title("pw-user-action")
        .with_inner_size(LogicalSize::new(500.0, 260.0))
        .with_resizable(false)
        .with_always_on_top(true)
        .with_visible(false) // start hidden; parent must send Visible{true}
        .build(&event_loop)
        .unwrap();

    let window = Arc::new(window);
    let webview_proxy = proxy.clone();

    let webview = WebViewBuilder::new(&*window)
        .with_html(build_html("Loading...", &[]))
        .with_ipc_handler(move |req_msg| {
            let action = req_msg.body().to_string();
            let _ = webview_proxy.send_event(UserEvent::ButtonClicked(action));
        })
        .build()?;

    write_event(&Event_::Ready);

    // Track visibility state: show when browser focused OR dialog has focus.
    let mut browser_visible = false;
    let mut dialog_has_focus = false;
    let mut last_hide_request: Option<std::time::Instant> = None;
    const HIDE_DEBOUNCE_MS: u128 = 300;

    let apply_visibility = {
        let window = window.clone();
        move |browser: bool, dialog: bool| {
            let should_show = browser || dialog;
            eprintln!("[renderer] apply: browser={} dialog={} → show={}", browser, dialog, should_show);
            window.set_visible(should_show);
            if should_show {
                window.set_always_on_top(true);
            }
        }
    };
    let apply_visibility = std::rc::Rc::new(std::cell::RefCell::new(apply_visibility));

    event_loop.run(move |event, _, control_flow| {
        *control_flow = ControlFlow::Wait;

        match event {
            Event::WindowEvent {
                event: WindowEvent::CloseRequested,
                ..
            } => *control_flow = ControlFlow::Exit,

            Event::WindowEvent {
                event: WindowEvent::Focused(focused),
                ..
            } => {
                eprintln!("[renderer] Window.Focused({})", focused);
                dialog_has_focus = focused;
                (apply_visibility.borrow_mut())(browser_visible, dialog_has_focus);
            }

            Event::UserEvent(UserEvent::InitialRequest { prompt, actions, .. }) => {
                eprintln!("[renderer] InitialRequest (actions={:?})", actions);
                let html = build_html(&prompt, &actions);
                let _ = webview.load_html(&html);
            }

            Event::UserEvent(UserEvent::UpdateContent { prompt, actions }) => {
                let html = build_html(&prompt, &actions);
                let _ = webview.load_html(&html);
            }

            Event::UserEvent(UserEvent::SetBrowserVisible(visible)) => {
                eprintln!("[renderer] SetBrowserVisible({})", visible);
                browser_visible = visible;
                (apply_visibility.borrow_mut())(browser_visible, dialog_has_focus);
            }

            Event::UserEvent(UserEvent::ButtonClicked(ref action)) if false => { unreachable!(); }
            Event::UserEvent(UserEvent::ButtonClicked(action)) => {
                eprintln!("[renderer] ButtonClicked({})", action);
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap();
                let submitted_at = format_iso8601(now.as_secs(), now.subsec_nanos());
                write_event(&Event_::Clicked {
                    action,
                    submitted_at,
                });
                *control_flow = ControlFlow::Exit;
            }

            Event::UserEvent(UserEvent::ExternalExit) => {
                *control_flow = ControlFlow::Exit;
            }

            _ => (),
        }
    });
}
