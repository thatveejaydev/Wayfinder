//! Opens folders in Windows Terminal: as a new tab of the most recent terminal window,
//! or by switching to the tab already opened for that folder.

use std::{
    collections::{HashMap, HashSet},
    os::windows::process::CommandExt,
    path::Path,
    process::Command,
    slice,
    sync::{LazyLock, Mutex},
    thread,
    time::Duration,
};
use windows::{
    core::{w, PCWSTR},
    Win32::{
        Foundation::HWND,
        System::{
            Com::{CoCreateInstance, CoInitializeEx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED},
            Ole::SafeArrayDestroy,
            Variant::VARIANT,
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationElement,
                IUIAutomationSelectionItemPattern, TreeScope_Descendants,
                UIA_ControlTypePropertyId, UIA_SelectionItemPatternId, UIA_TabItemControlTypeId,
            },
            WindowsAndMessaging::{FindWindowExW, IsWindowVisible},
        },
    },
};

use crate::folder_launch::{bring_to_front, ComApartment};

/// Terminal tabs this app opened, keyed by folder, as UI Automation runtime ids. A tab
/// keeps its runtime id while it stays open, even if it moves within its window.
static OPENED_TABS: LazyLock<Mutex<HashMap<String, Vec<i32>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

struct TerminalTab {
    window: HWND,
    id: Vec<i32>,
    title: String,
    element: IUIAutomationElement,
}

pub(super) fn open_in_terminal(path: &Path) -> Result<(), String> {
    // Serializes launches so a quick second click sees the tab the first one opened.
    let mut opened = OPENED_TABS.lock().map_err(|error| error.to_string())?;
    let key = folder_key(path);
    let title = tab_title(path);
    // Without UI Automation, still open a tab; it just can't be found again later.
    let Some((_apartment, automation)) = automation() else {
        return launch(path, &title);
    };

    let tabs = terminal_tabs(&automation);
    opened.retain(|_, id| tabs.iter().any(|tab| &tab.id == id));
    if let Some(tab) = existing_tab(&tabs, &opened, &key, &title) {
        if select_tab(tab) {
            opened.insert(key, tab.id.clone());
            return Ok(());
        }
    }

    let before: HashSet<&[i32]> = tabs.iter().map(|tab| tab.id.as_slice()).collect();
    launch(path, &title)?;
    // Record the new tab so the next launch for this folder can switch to it. A cold
    // start of Windows Terminal can take a few seconds to show its first tab.
    for _ in 0..100 {
        if let Some(tab) = terminal_tabs(&automation)
            .into_iter()
            .find(|tab| !before.contains(tab.id.as_slice()) && tab.title == title)
        {
            opened.insert(key, tab.id);
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }
    Ok(())
}

/// The tab recorded for this folder, or else the only unrecorded tab titled with its name
/// (for example one opened before Wayfinder restarted).
fn existing_tab<'a>(
    tabs: &'a [TerminalTab],
    opened: &HashMap<String, Vec<i32>>,
    key: &str,
    title: &str,
) -> Option<&'a TerminalTab> {
    if let Some(id) = opened.get(key) {
        return tabs.iter().find(|tab| &tab.id == id);
    }
    let mut matches = tabs
        .iter()
        .filter(|tab| tab.title == title && !opened.values().any(|id| id == &tab.id));
    match (matches.next(), matches.next()) {
        (Some(tab), None) => Some(tab),
        _ => None,
    }
}

fn select_tab(tab: &TerminalTab) -> bool {
    let selected = unsafe {
        tab.element
            .GetCurrentPatternAs::<IUIAutomationSelectionItemPattern>(UIA_SelectionItemPatternId)
            .and_then(|pattern| pattern.Select())
    };
    if selected.is_err() {
        return false;
    }
    bring_to_front(tab.window);
    true
}

fn launch(path: &Path, title: &str) -> Result<(), String> {
    // Windows Terminal reads `;` as a command separator unless it is escaped.
    let escape = |value: &str| value.replace(';', "\\;");
    // `-w 0` adds a tab to the most recently used window, or opens a window if none is open.
    // The fixed title names the folder and lets the next launch find this tab.
    let terminal = Command::new("wt.exe")
        .args(["-w", "0", "new-tab", "--title"])
        .arg(escape(title))
        .arg("--suppressApplicationTitle")
        .arg("-d")
        .arg(escape(&path.to_string_lossy()))
        .spawn();
    if terminal.is_err() {
        const CREATE_NEW_CONSOLE: u32 = 0x10;
        Command::new("powershell.exe")
            .arg("-NoLogo")
            .current_dir(path)
            .creation_flags(CREATE_NEW_CONSOLE)
            .spawn()
            .map_err(|error| format!("Could not open a terminal: {error}"))?;
    }
    Ok(())
}

fn folder_key(path: &Path) -> String {
    path.to_string_lossy()
        .trim_end_matches(['\\', '/'])
        .to_lowercase()
}

fn tab_title(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string_lossy().into_owned())
}

fn automation() -> Option<(ComApartment, IUIAutomation)> {
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }.ok().ok()?;
    let apartment = ComApartment;
    let automation = unsafe { CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER) }.ok()?;
    Some((apartment, automation))
}

fn terminal_tabs(automation: &IUIAutomation) -> Vec<TerminalTab> {
    let mut tabs = Vec::new();
    let Ok(condition) = (unsafe {
        automation.CreatePropertyCondition(
            UIA_ControlTypePropertyId,
            &VARIANT::from(UIA_TabItemControlTypeId.0),
        )
    }) else {
        return tabs;
    };
    let mut previous = None;
    while let Ok(window) = unsafe {
        FindWindowExW(None, previous, w!("CASCADIA_HOSTING_WINDOW_CLASS"), PCWSTR::null())
    } {
        previous = Some(window);
        if !unsafe { IsWindowVisible(window) }.as_bool() {
            continue;
        }
        let Ok(items) = (unsafe {
            automation
                .ElementFromHandle(window)
                .and_then(|root| root.FindAll(TreeScope_Descendants, &condition))
        }) else {
            continue;
        };
        for index in 0..unsafe { items.Length() }.unwrap_or(0) {
            let Ok(element) = (unsafe { items.GetElement(index) }) else {
                continue;
            };
            let (Some(id), Ok(title)) = (runtime_id(&element), unsafe { element.CurrentName() })
            else {
                continue;
            };
            tabs.push(TerminalTab {
                window,
                id,
                title: title.to_string(),
                element,
            });
        }
    }
    tabs
}

fn runtime_id(element: &IUIAutomationElement) -> Option<Vec<i32>> {
    let array = unsafe { element.GetRuntimeId() }.ok()?;
    if array.is_null() {
        return None;
    }
    // A runtime id is a one-dimensional SAFEARRAY of VT_I4.
    let id = unsafe {
        let bounds = (*array).rgsabound[0];
        slice::from_raw_parts((*array).pvData as *const i32, bounds.cElements as usize).to_vec()
    };
    let _ = unsafe { SafeArrayDestroy(array) };
    Some(id)
}
