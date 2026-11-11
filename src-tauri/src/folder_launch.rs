use std::{
    os::windows::process::CommandExt, path::Path, process::Command, ptr, sync::Mutex, thread,
    time::Duration,
};
use windows::{
    core::{w, Interface, BOOL, HSTRING, PCWSTR},
    Win32::{
        Foundation::{HWND, LPARAM, WPARAM},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IServiceProvider,
                CLSCTX_ALL, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED,
            },
            Variant::VARIANT,
        },
        UI::{
            Accessibility::{
                CUIAutomation, IUIAutomation, IUIAutomationInvokePattern, TreeScope_Descendants,
                UIA_AutomationIdPropertyId, UIA_InvokePatternId,
            },
            Input::KeyboardAndMouse::{VK_CONTROL, VK_T},
            Shell::{
                Common::ITEMIDLIST, IFolderView, IPersistFolder2, IShellBrowser, IShellItem,
                IShellWindows, SHCreateItemFromIDList, SHParseDisplayName, SID_STopLevelBrowser,
                ShellWindows, SBSP_ABSOLUTE, SBSP_SAMEBROWSER, SICHINT_CANONICAL,
                SICHINT_TEST_FILESYSPATH_IF_NOT_EQUAL,
            },
            WindowsAndMessaging::{
                EnumChildWindows, FindWindowExW, GetAncestor, GetClassNameW, GetForegroundWindow,
                IsIconic, IsWindowVisible, SendMessageTimeoutW, SetForegroundWindow,
                ShowWindowAsync, GA_ROOT, SMTO_ABORTIFHUNG, SW_RESTORE, WM_COMMAND,
            },
        },
    },
};

static OPEN_EXPLORER_TAB: Mutex<()> = Mutex::new(());

pub(super) fn open_in_terminal(path: &Path) -> Result<(), String> {
    if Command::new("wt.exe")
        .args(["-d", "."])
        .current_dir(path)
        .spawn()
        .is_err()
    {
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

struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

struct FolderIdList(*mut ITEMIDLIST);

impl Drop for FolderIdList {
    fn drop(&mut self) {
        unsafe { CoTaskMemFree(Some(self.0.cast())) };
    }
}

fn window_class(window: HWND, expected: &str) -> bool {
    let mut class = [0u16; 32];
    let length = unsafe { GetClassNameW(window, &mut class) } as usize;
    class[..length].iter().copied().eq(expected.encode_utf16())
}

fn explorer_frame() -> Option<HWND> {
    let mut previous = None;
    while let Ok(frame) =
        unsafe { FindWindowExW(None, previous, w!("CabinetWClass"), PCWSTR::null()) }
    {
        if unsafe { IsWindowVisible(frame) }.as_bool() {
            return Some(frame);
        }
        previous = Some(frame);
    }
    None
}

fn tab_handles(frame: HWND) -> Vec<HWND> {
    unsafe extern "system" fn collect(window: HWND, data: LPARAM) -> BOOL {
        if window_class(window, "ShellTabWindowClass") {
            let tabs = unsafe { &mut *(data.0 as *mut Vec<HWND>) };
            tabs.push(window);
        }
        BOOL(1)
    }
    let mut tabs = Vec::new();
    let _ = unsafe {
        EnumChildWindows(
            Some(frame),
            Some(collect),
            LPARAM(&mut tabs as *mut _ as isize),
        )
    };
    tabs
}

fn find_shell_browser(
    windows: &IShellWindows,
    mut matches: impl FnMut(HWND, &IShellBrowser) -> bool,
) -> windows::core::Result<Option<(HWND, IShellBrowser)>> {
    for index in 0..unsafe { windows.Count()? } {
        unsafe {
            let Ok(service) = windows
                .Item(&VARIANT::from(index))
                .and_then(|item| item.cast::<IServiceProvider>())
            else {
                continue;
            };
            for id in [IShellBrowser::IID, SID_STopLevelBrowser] {
                if let Ok(shell) = service.QueryService::<IShellBrowser>(&id) {
                    if let Ok(window) = shell.GetWindow() {
                        if matches(window, &shell) {
                            return Ok(Some((window, shell)));
                        }
                    }
                }
            }
        }
    }
    Ok(None)
}

fn shows_folder(browser: &IShellBrowser, target: &IShellItem) -> windows::core::Result<bool> {
    unsafe {
        let view = browser.QueryActiveShellView()?.cast::<IFolderView>()?;
        let folder = view.GetFolder::<IPersistFolder2>()?;
        let id = FolderIdList(folder.GetCurFolder()?);
        let current: IShellItem = SHCreateItemFromIDList(id.0)?;
        let hints = SICHINT_CANONICAL.0 | SICHINT_TEST_FILESYSPATH_IF_NOT_EQUAL.0;
        Ok(target.Compare(&current, hints as u32)? == 0)
    }
}

fn bring_to_front(frame: HWND) {
    if unsafe { IsIconic(frame) }.as_bool() {
        let _ = unsafe { ShowWindowAsync(frame, SW_RESTORE) };
    }
    let _ = unsafe { SetForegroundWindow(frame) };
}

fn active_tab(frame: HWND) -> Option<HWND> {
    // Explorer puts the selected tab's native window first in the z-order.
    unsafe { FindWindowExW(Some(frame), None, w!("ShellTabWindowClass"), PCWSTR::null()) }.ok()
}

fn select_explorer_tab(frame: HWND, tab: HWND) -> Result<(), String> {
    if tab == frame || active_tab(frame) == Some(tab) {
        return Ok(());
    }

    // Explorer's indexed tab command uses visual order, which can differ from z-order.
    // Check the selected handle after each command so reordered tabs still match.
    const SELECT_TAB_COMMAND: WPARAM = WPARAM(0xA221);
    for index in 1..=tab_handles(frame).len() {
        let previous = active_tab(frame);
        let sent = unsafe {
            SendMessageTimeoutW(
                frame,
                WM_COMMAND,
                SELECT_TAB_COMMAND,
                LPARAM(index as isize),
                SMTO_ABORTIFHUNG,
                250,
                None,
            )
        };
        if sent.0 == 0 {
            break;
        }
        for _ in 0..10 {
            let selected = active_tab(frame);
            if selected == Some(tab) {
                return Ok(());
            }
            if selected.is_some() && selected != previous {
                break;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }
    Err("Could not switch to the existing Explorer tab.".into())
}

fn new_tab_button(frame: HWND) -> windows::core::Result<IUIAutomationInvokePattern> {
    unsafe {
        let automation: IUIAutomation =
            CoCreateInstance(&CUIAutomation, None, CLSCTX_INPROC_SERVER)?;
        let window = automation.ElementFromHandle(frame)?;
        let condition = automation
            .CreatePropertyCondition(UIA_AutomationIdPropertyId, &VARIANT::from("AddButton"))?;
        window
            .FindFirst(TreeScope_Descendants, &condition)?
            .GetCurrentPatternAs(UIA_InvokePatternId)
    }
}

fn open_tab_with_keyboard(frame: HWND) -> Result<(), String> {
    if unsafe { GetForegroundWindow() } != frame {
        return Err("File Explorer could not take focus.".into());
    }
    if !crate::keyboard::send_shortcut(VK_CONTROL, VK_T) {
        return Err("Could not send the shortcut to File Explorer.".into());
    }
    Ok(())
}

pub(super) fn open_in_explorer_tab(path: &str) -> Result<bool, String> {
    // Serialize folder matching and tab creation across launches.
    let _lock = OPEN_EXPLORER_TAB
        .lock()
        .map_err(|error| error.to_string())?;
    let Some(frame) = explorer_frame() else {
        return Ok(false);
    };
    unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED) }
        .ok()
        .map_err(|error| format!("Could not initialize Explorer integration: {error}"))?;
    let _apartment = ComApartment;
    let windows: IShellWindows = unsafe { CoCreateInstance(&ShellWindows, None, CLSCTX_ALL) }
        .map_err(|error| format!("Could not connect to File Explorer: {error}"))?;
    let mut folder = FolderIdList(ptr::null_mut());
    unsafe { SHParseDisplayName(&HSTRING::from(path), None, &mut folder.0, 0, None) }
        .map_err(|error| format!("Could not resolve the folder in File Explorer: {error}"))?;
    let target: IShellItem = unsafe { SHCreateItemFromIDList(folder.0) }
        .map_err(|error| format!("Could not identify the folder in File Explorer: {error}"))?;
    let matching_tab = find_shell_browser(&windows, |tab, browser| {
        let root = unsafe { GetAncestor(tab, GA_ROOT) };
        window_class(root, "CabinetWClass")
            && unsafe { IsWindowVisible(root) }.as_bool()
            && shows_folder(browser, &target).unwrap_or(false)
    })
    .map_err(|error| format!("Could not check open Explorer tabs: {error}"))?;
    if let Some((tab, _)) = matching_tab {
        let frame = unsafe { GetAncestor(tab, GA_ROOT) };
        select_explorer_tab(frame, tab)?;
        bring_to_front(frame);
        return Ok(true);
    }

    let existing = tab_handles(frame);
    bring_to_front(frame);
    if let Ok(button) = new_tab_button(frame) {
        unsafe { button.Invoke() }
            .map_err(|error| format!("Could not open an Explorer tab: {error}"))?;
    } else {
        open_tab_with_keyboard(frame)?;
    }

    // The native tab can appear before Explorer publishes its COM navigation object.
    for _ in 0..60 {
        if let Some(tab) = tab_handles(frame)
            .into_iter()
            .find(|tab| !existing.contains(tab))
        {
            if let Ok(Some((_, browser))) = find_shell_browser(&windows, |window, _| window == tab)
            {
                unsafe { browser.BrowseObject(folder.0, SBSP_SAMEBROWSER | SBSP_ABSOLUTE) }
                    .map_err(|error| format!("Could not navigate the new Explorer tab: {error}"))?;
                // Give Explorer time to publish the new location before another launch checks it.
                for _ in 0..60 {
                    if shows_folder(&browser, &target).unwrap_or(false) {
                        break;
                    }
                    thread::sleep(Duration::from_millis(40));
                }
                return Ok(true);
            }
        }
        thread::sleep(Duration::from_millis(40));
    }
    Err("File Explorer did not register the new tab for navigation.".into())
}
