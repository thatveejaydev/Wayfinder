use std::fmt;

const BUTTONS: [&str; 5] = [
    "MouseLeft",
    "MouseRight",
    "MouseMiddle",
    "MouseBack",
    "MouseForward",
];
const MODIFIERS: [&str; 4] = ["control", "alt", "shift", "super"];

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) struct MouseHotkey {
    button: u8,
    modifiers: u8,
}

impl MouseHotkey {
    pub(super) fn parse(value: &str) -> Result<Option<Self>, String> {
        let (modifiers, button) = value.rsplit_once('+').unwrap_or(("", value));
        let Some(button) = BUTTONS
            .iter()
            .position(|name| name.eq_ignore_ascii_case(button))
        else {
            return Ok(None);
        };
        if modifiers.is_empty() {
            return Err("Use a modifier with a mouse button.".into());
        }
        let mut mask = 0;
        for modifier in modifiers.split('+') {
            let index = match modifier.to_ascii_lowercase().as_str() {
                "ctrl" | "control" => 0,
                "alt" => 1,
                "shift" => 2,
                "super" => 3,
                _ => return Err("Unsupported mouse modifier.".into()),
            };
            mask |= 1 << index;
        }
        Ok(Some(Self {
            button: button as u8,
            modifiers: mask,
        }))
    }
}

impl fmt::Display for MouseHotkey {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for (index, modifier) in MODIFIERS.iter().enumerate() {
            if self.modifiers & (1 << index) != 0 {
                write!(f, "{modifier}+")?;
            }
        }
        f.write_str(BUTTONS[self.button as usize])
    }
}

#[cfg(target_os = "windows")]
mod platform {
    use super::MouseHotkey;
    use std::sync::{
        atomic::{AtomicBool, AtomicU8, Ordering::Relaxed},
        OnceLock,
    };
    use tauri::AppHandle;
    use windows::Win32::{
        Foundation::{LPARAM, LRESULT, WPARAM},
        UI::{
            Input::KeyboardAndMouse::{
                GetAsyncKeyState, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT,
            },
            WindowsAndMessaging::{
                CallNextHookEx, SetWindowsHookExW, MSLLHOOKSTRUCT, WH_MOUSE_LL, WM_LBUTTONDOWN,
                WM_LBUTTONUP, WM_MBUTTONDOWN, WM_MBUTTONUP, WM_RBUTTONDOWN, WM_RBUTTONUP,
                WM_XBUTTONDOWN, WM_XBUTTONUP,
            },
        },
    };

    static APP: OnceLock<AppHandle> = OnceLock::new();
    static BINDING: AtomicU8 = AtomicU8::new(0);
    static SUPPRESSED: AtomicU8 = AtomicU8::new(0);
    static WATCH_OUTSIDE_CLICKS: AtomicBool = AtomicBool::new(false);

    pub(crate) fn watch_outside_clicks(watch: bool) {
        WATCH_OUTSIDE_CLICKS.store(watch, Relaxed);
    }

    pub(crate) fn init(app: &AppHandle) {
        match unsafe { SetWindowsHookExW(WH_MOUSE_LL, Some(mouse_event), None, 0) } {
            Ok(_) => {
                let _ = APP.set(app.clone());
            }
            Err(error) => eprintln!("Could not install the mouse hotkey hook: {error}"),
        }
    }

    pub(crate) fn set(hotkey: Option<MouseHotkey>) -> Result<(), String> {
        if hotkey.is_some() && APP.get().is_none() {
            return Err("Windows mouse hotkeys are unavailable.".into());
        }
        BINDING.store(
            hotkey.map_or(0, |key| key.modifiers << 3 | key.button),
            Relaxed,
        );
        Ok(())
    }

    unsafe extern "system" fn mouse_event(code: i32, wparam: WPARAM, lparam: LPARAM) -> LRESULT {
        if code == 0 {
            let message = wparam.0 as u32;
            let button = match message {
                WM_LBUTTONDOWN | WM_LBUTTONUP => Some(0),
                WM_RBUTTONDOWN | WM_RBUTTONUP => Some(1),
                WM_MBUTTONDOWN | WM_MBUTTONUP => Some(2),
                WM_XBUTTONDOWN | WM_XBUTTONUP => {
                    let event = unsafe { &*(lparam.0 as *const MSLLHOOKSTRUCT) };
                    Some(if event.mouseData >> 16 == 1 { 3 } else { 4 })
                }
                _ => None,
            };
            if let Some(button) = button {
                let bit = 1 << button;
                if matches!(
                    message,
                    WM_LBUTTONUP | WM_RBUTTONUP | WM_MBUTTONUP | WM_XBUTTONUP
                ) {
                    if SUPPRESSED.fetch_and(!bit, Relaxed) & bit != 0 {
                        if let Some(app) = APP.get() {
                            tauri::async_runtime::spawn(async move {
                                let _ = app.run_on_main_thread(move || crate::toggle_palette(app));
                            });
                        }
                        return LRESULT(1);
                    }
                    if WATCH_OUTSIDE_CLICKS.load(Relaxed) && !crate::file_picker_open() {
                        if let Some(app) = APP.get() {
                            let point = unsafe { (*(lparam.0 as *const MSLLHOOKSTRUCT)).pt };
                            tauri::async_runtime::spawn(async move {
                                let _ = app.run_on_main_thread(move || {
                                    crate::dismiss_palette_at(app, point.x, point.y);
                                });
                            });
                        }
                    }
                } else {
                    let binding = BINDING.load(Relaxed);
                    if binding != 0 && binding & 7 == button {
                        let down = |key| unsafe { GetAsyncKeyState(i32::from(key)) < 0 };
                        let modifiers = u8::from(down(VK_CONTROL.0))
                            | u8::from(down(VK_MENU.0)) << 1
                            | u8::from(down(VK_SHIFT.0)) << 2
                            | u8::from(down(VK_LWIN.0) || down(VK_RWIN.0)) << 3;
                        if modifiers == binding >> 3 {
                            SUPPRESSED.fetch_or(bit, Relaxed);
                            return LRESULT(1);
                        }
                    }
                }
            }
        }
        unsafe { CallNextHookEx(None, code, wparam, lparam) }
    }
}

#[cfg(target_os = "windows")]
pub(super) use platform::{init, set, watch_outside_clicks};

#[cfg(not(target_os = "windows"))]
pub(super) fn watch_outside_clicks(_: bool) {}

#[cfg(not(target_os = "windows"))]
pub(super) fn init(_: &tauri::AppHandle) {}

#[cfg(not(target_os = "windows"))]
pub(super) fn set(_: Option<MouseHotkey>) -> Result<(), String> {
    Err("Mouse hotkeys are available on Windows.".into())
}
