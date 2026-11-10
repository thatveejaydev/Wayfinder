use std::{
    mem::size_of, os::windows::process::CommandExt, path::Path, process::Command, ptr, sync::Mutex,
    thread, time::Duration,
};
use windows::{
    core::{w, Interface, BOOL, HSTRING, PCWSTR},
    Win32::{
        Foundation::{HWND, LPARAM},
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
            Input::KeyboardAndMouse::{
                SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYEVENTF_KEYUP, VK_CONTROL,
                VK_T,
            },
            Shell::{
                Common::ITEMIDLIST, IShellBrowser, IShellWindows, SHParseDisplayName,
                SID_STopLevelBrowser, ShellWindows, SBSP_ABSOLUTE, SBSP_SAMEBROWSER,
            },
            WindowsAndMessaging::{
                EnumChildWindows, FindWindowExW, GetClassNameW, GetForegroundWindow, IsIconic,
                IsWindowVisible, SetForegroundWindow, ShowWindowAsync, SW_RESTORE,
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

fn shell_tab(
    windows: &IShellWindows,
    target: HWND,
) -> windows::core::Result<Option<IShellBrowser>> {
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
                    if shell.GetWindow().ok() == Some(target) {
                        return Ok(Some(shell));
                    }
                }
            }
        }
    }
    Ok(None)
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
    let inputs = [
        (VK_CONTROL, false),
        (VK_T, false),
        (VK_T, true),
        (VK_CONTROL, true),
    ]
    .map(|(key, released)| INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: key,
                dwFlags: if released {
                    KEYEVENTF_KEYUP
                } else {
                    Default::default()
                },
                ..Default::default()
            },
        },
    });
    if unsafe { SendInput(&inputs, size_of::<INPUT>() as i32) } as usize != inputs.len() {
        return Err("Could not send the shortcut to File Explorer.".into());
    }
    Ok(())
}

pub(super) fn open_in_explorer_tab(path: &str) -> Result<bool, String> {
    // Keep simultaneous launches from trying to claim the same new tab.
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
    let existing = tab_handles(frame);
    if unsafe { IsIconic(frame) }.as_bool() {
        let _ = unsafe { ShowWindowAsync(frame, SW_RESTORE) };
    }
    let _ = unsafe { SetForegroundWindow(frame) };
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
            if let Ok(Some(browser)) = shell_tab(&windows, tab) {
                unsafe { browser.BrowseObject(folder.0, SBSP_SAMEBROWSER | SBSP_ABSOLUTE) }
                    .map_err(|error| format!("Could not navigate the new Explorer tab: {error}"))?;
                return Ok(true);
            }
        }
        thread::sleep(Duration::from_millis(40));
    }
    Err("File Explorer did not register the new tab for navigation.".into())
}
