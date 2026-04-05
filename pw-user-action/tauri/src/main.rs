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
    window::{Icon, WindowBuilder},
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
        #[serde(default)]
        title: Option<String>,
    },
    Visible {
        value: bool,
    },
    Update {
        prompt: String,
        actions: Vec<String>,
        #[serde(default)]
        title: Option<String>,
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
    InitialRequest { id: String, prompt: String, actions: Vec<String>, title: Option<String> },
    SetBrowserVisible(bool),
    UpdateContent { prompt: String, actions: Vec<String>, title: Option<String> },
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

/// Build a simple 32x32 icon programmatically — an indigo rounded square
/// with a white checkmark. Shipped in-process so there's no PNG to load.
fn build_default_icon() -> Icon {
    const SIZE: u32 = 32;
    // indigo-500 (#4f46e5) background, white foreground
    let bg = [0x4f_u8, 0x46, 0xe5, 0xff];
    let fg = [0xff_u8, 0xff, 0xff, 0xff];
    let transparent = [0_u8, 0, 0, 0];

    let mut rgba = vec![0_u8; (SIZE * SIZE * 4) as usize];

    // Rounded-square background (corner radius ~6)
    let radius: i32 = 6;
    let w = SIZE as i32;
    let h = SIZE as i32;
    for y in 0..h {
        for x in 0..w {
            let dx = if x < radius {
                radius - x
            } else if x >= w - radius {
                x - (w - radius - 1)
            } else {
                0
            };
            let dy = if y < radius {
                radius - y
            } else if y >= h - radius {
                y - (h - radius - 1)
            } else {
                0
            };
            let inside = dx * dx + dy * dy <= radius * radius;
            let idx = ((y as u32 * SIZE + x as u32) * 4) as usize;
            let color = if inside { bg } else { transparent };
            rgba[idx..idx + 4].copy_from_slice(&color);
        }
    }

    // Draw a simple check mark (three line segments)
    let check_points: [(i32, i32); 9] = [
        (9, 16),
        (10, 17),
        (11, 18),
        (12, 19),
        (13, 20),
        (16, 17),
        (19, 14),
        (22, 11),
        (23, 10),
    ];
    for (cx, cy) in check_points.iter() {
        for dy in -1..=1 {
            for dx in -1..=1 {
                let x = cx + dx;
                let y = cy + dy;
                if x < 0 || y < 0 || x >= w || y >= h {
                    continue;
                }
                let idx = ((y as u32 * SIZE + x as u32) * 4) as usize;
                rgba[idx..idx + 4].copy_from_slice(&fg);
            }
        }
    }

    Icon::from_rgba(rgba, SIZE, SIZE).expect("build default icon")
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
    let (init_id, init_prompt, init_actions, init_title) = match init {
        Command::Init { id, prompt, actions, title } => (id, prompt, actions, title),
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
                Ok(Command::Update { prompt, actions, title }) => {
                    UserEvent::UpdateContent { prompt, actions, title }
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

    // Resolve initial window title: user-supplied or default
    let initial_title = init_title
        .clone()
        .unwrap_or_else(|| "pw-user-action".to_string());

    // Send initial request to event loop
    proxy.send_event(UserEvent::InitialRequest {
        id: init_id.clone(),
        prompt: init_prompt,
        actions: init_actions,
        title: init_title,
    }).ok();

    let window = WindowBuilder::new()
        .with_title(&initial_title)
        .with_window_icon(Some(build_default_icon()))
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

            Event::UserEvent(UserEvent::InitialRequest { prompt, actions, title, .. }) => {
                eprintln!("[renderer] InitialRequest (actions={:?})", actions);
                if let Some(t) = title.as_ref() {
                    window.set_title(t);
                }
                let html = build_html(&prompt, &actions);
                let _ = webview.load_html(&html);
            }

            Event::UserEvent(UserEvent::UpdateContent { prompt, actions, title }) => {
                if let Some(t) = title.as_ref() {
                    window.set_title(t);
                }
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
