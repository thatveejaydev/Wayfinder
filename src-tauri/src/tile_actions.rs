//! Extra per-tile actions offered by the palette's right-click menu.

use crate::{workspaces::WorkspaceStore, Shortcut};
use std::{path::Path, sync::Mutex};
use tauri::{AppHandle, State};
use tauri_plugin_opener::OpenerExt;

fn has_disk_target(item: &Shortcut) -> bool {
    matches!(
        item.kind.as_str(),
        "folder" | "app" | "file" | "image" | "pdf" | "video" | "audio"
    )
}

fn require_existing_target(item: &Shortcut) -> Result<(), String> {
    if !has_disk_target(item) {
        return Err("This tile has no file or folder".into());
    }
    if !matches!(Path::new(&item.path).try_exists(), Ok(true)) {
        return Err("The original file or folder no longer exists".into());
    }
    Ok(())
}

fn set_clipboard(text: String) -> Result<(), String> {
    arboard::Clipboard::new()
        .and_then(|mut clipboard| clipboard.set_text(text))
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn shell_verb(verb: &str, path: &str) -> Result<(), String> {
    use windows::{
        core::{HSTRING, PCWSTR},
        Win32::{
            System::Com::{CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED},
            UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
        },
    };

    let verb = HSTRING::from(verb);
    let file = HSTRING::from(path);
    let directory = Path::new(path)
        .parent()
        .map(|parent| HSTRING::from(parent.as_os_str()));
    let com_ready = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.is_ok();
    let result = unsafe {
        ShellExecuteW(
            None,
            &verb,
            &file,
            PCWSTR::null(),
            directory
                .as_ref()
                .map_or(PCWSTR::null(), |directory| PCWSTR(directory.as_ptr())),
            SW_SHOWNORMAL,
        )
    };
    if com_ready {
        unsafe { CoUninitialize() };
    }
    // ShellExecuteW reports success with a value above 32.
    if result.0 as isize > 32 {
        Ok(())
    } else {
        Err("Windows could not complete that action".into())
    }
}

#[cfg(target_os = "windows")]
fn paste_into_previous_window(text: String) -> Result<(), String> {
    use std::{ffi::c_void, sync::atomic::Ordering, thread, time::Duration};
    use windows::Win32::{
        Foundation::HWND,
        UI::{
            Input::KeyboardAndMouse::{VK_CONTROL, VK_V},
            WindowsAndMessaging::{IsWindow, SetForegroundWindow},
        },
    };

    let origin = crate::PALETTE_ORIGIN.load(Ordering::Relaxed);
    let window = HWND(origin as *mut c_void);
    if origin == 0 || !unsafe { IsWindow(Some(window)) }.as_bool() {
        return Err("There is no previous window to paste into".into());
    }
    set_clipboard(text)?;
    if !unsafe { SetForegroundWindow(window) }.as_bool() {
        return Err("Could not switch back to the previous window".into());
    }
    // Give the window a moment to take focus before sending the keystroke.
    thread::sleep(Duration::from_millis(150));
    if crate::keyboard::send_shortcut(VK_CONTROL, VK_V) {
        Ok(())
    } else {
        Err("Could not send the paste keystroke".into())
    }
}

/// Runs one of the right-click menu actions on a tile: `reveal`, `copy-path`,
/// `run-as-admin`, `open-with`, or `paste-previous`.
#[tauri::command]
pub(crate) async fn tile_action(
    app: AppHandle,
    state: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    id: String,
    action: String,
) -> Result<(), String> {
    let item = state
        .lock()
        .map_err(|error| error.to_string())?
        .shortcuts(&workspace_id)?
        .iter()
        .find(|item| item.id == id)
        .cloned()
        .ok_or_else(|| "Shortcut not found".to_string())?;
    match action.as_str() {
        "reveal" => {
            require_existing_target(&item)?;
            app.opener()
                .reveal_item_in_dir(&item.path)
                .map_err(|error| error.to_string())
        }
        "copy-path" => {
            if item.path.is_empty() {
                return Err("This tile has no path to copy".into());
            }
            set_clipboard(item.path)
        }
        #[cfg(target_os = "windows")]
        "run-as-admin" if item.kind == "app" => {
            require_existing_target(&item)?;
            tauri::async_runtime::spawn_blocking(move || shell_verb("runas", &item.path))
                .await
                .map_err(|error| error.to_string())?
        }
        #[cfg(target_os = "windows")]
        "open-with" if has_disk_target(&item) && item.kind != "folder" => {
            require_existing_target(&item)?;
            tauri::async_runtime::spawn_blocking(move || shell_verb("openas", &item.path))
                .await
                .map_err(|error| error.to_string())?
        }
        #[cfg(target_os = "windows")]
        "paste-previous" if item.kind == "text" => {
            let text = item.text.unwrap_or_default();
            tauri::async_runtime::spawn_blocking(move || paste_into_previous_window(text))
                .await
                .map_err(|error| error.to_string())?
        }
        _ => Err("That action isn't available for this tile".into()),
    }
}
