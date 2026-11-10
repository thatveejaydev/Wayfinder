use std::{
    ffi::OsString,
    fs,
    os::windows::ffi::{OsStrExt, OsStringExt},
    path::{Path, PathBuf},
    ptr,
    sync::Mutex,
};
use windows::{
    core::{Interface, Owned, BOOL, HSTRING, PWSTR},
    Win32::{
        Foundation::{ERROR_NO_MORE_FILES, HWND, LPARAM},
        Globalization::{CompareStringOrdinal, CSTR_EQUAL},
        Graphics::Dwm::{DwmGetWindowAttribute, DWMWA_CLOAKED},
        System::{
            Com::{
                CoCreateInstance, CoInitializeEx, CoUninitialize, IPersistFile,
                CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, STGM_READ,
            },
            Diagnostics::ToolHelp::{
                CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W,
                TH32CS_SNAPPROCESS,
            },
            Threading::{
                OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
                PROCESS_QUERY_LIMITED_INFORMATION,
            },
        },
        UI::{
            Shell::{IShellLinkW, ShellLink},
            WindowsAndMessaging::{
                EnumWindows, GetAncestor, GetLastActivePopup, GetWindow, GetWindowLongPtrW,
                GetWindowThreadProcessId, IsIconic, IsWindowVisible, SetForegroundWindow,
                ShowWindowAsync, GA_ROOTOWNER, GWL_EXSTYLE, GW_OWNER, SW_MINIMIZE, SW_RESTORE,
                WS_EX_APPWINDOW, WS_EX_NOACTIVATE, WS_EX_TOOLWINDOW,
            },
        },
    },
};

static APP_LAUNCH: Mutex<()> = Mutex::new(());

struct ComApartment;

impl Drop for ComApartment {
    fn drop(&mut self) {
        unsafe { CoUninitialize() };
    }
}

fn without_nul(value: &[u16]) -> &[u16] {
    value.split(|unit| *unit == 0).next().unwrap_or_default()
}

fn shortcut_target(path: &Path) -> windows::core::Result<PathBuf> {
    unsafe {
        CoInitializeEx(None, COINIT_APARTMENTTHREADED).ok()?;
        let _apartment = ComApartment;
        let link: IShellLinkW = CoCreateInstance(&ShellLink, None, CLSCTX_INPROC_SERVER)?;
        link.cast::<IPersistFile>()?
            .Load(&HSTRING::from(path.as_os_str()), STGM_READ)?;
        let mut target = [0; 260];
        link.GetPath(&mut target, ptr::null_mut(), 0)?;
        Ok(PathBuf::from(OsString::from_wide(without_nul(&target))))
    }
}

fn process_path(pid: u32) -> Option<PathBuf> {
    let process =
        unsafe { Owned::new(OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?) };
    let mut path = vec![0; 32_768];
    let mut length = path.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            *process,
            PROCESS_NAME_WIN32,
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )
    }
    .ok()?;
    Some(PathBuf::from(OsString::from_wide(&path[..length as usize])))
}

fn matching_processes(target: &Path) -> windows::core::Result<Vec<u32>> {
    let target = fs::canonicalize(target).unwrap_or_else(|_| target.to_owned());
    let name: Vec<_> = target
        .file_name()
        .unwrap_or_default()
        .encode_wide()
        .collect();
    let target: Vec<_> = target.as_os_str().encode_wide().collect();
    let snapshot = unsafe { Owned::new(CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)?) };
    let mut entry = PROCESSENTRY32W {
        dwSize: size_of::<PROCESSENTRY32W>() as u32,
        ..Default::default()
    };
    unsafe { Process32FirstW(*snapshot, &mut entry)? };
    let mut matches = Vec::new();
    loop {
        if unsafe { CompareStringOrdinal(without_nul(&entry.szExeFile), &name, true) } == CSTR_EQUAL
        {
            if let Some(path) = process_path(entry.th32ProcessID) {
                let path = fs::canonicalize(&path).unwrap_or(path);
                let path: Vec<_> = path.as_os_str().encode_wide().collect();
                if unsafe { CompareStringOrdinal(&path, &target, true) } == CSTR_EQUAL {
                    matches.push(entry.th32ProcessID);
                }
            }
        }
        match unsafe { Process32NextW(*snapshot, &mut entry) } {
            Ok(()) => {}
            Err(error) if error.code() == ERROR_NO_MORE_FILES.to_hresult() => return Ok(matches),
            Err(error) => return Err(error),
        }
    }
}

fn is_app_window(window: HWND, pids: &[u32]) -> bool {
    let mut pid = 0;
    unsafe { GetWindowThreadProcessId(window, Some(&mut pid)) };
    if !pids.contains(&pid) || !unsafe { IsWindowVisible(window) }.as_bool() {
        return false;
    }
    let style = unsafe { GetWindowLongPtrW(window, GWL_EXSTYLE) } as u32;
    if style & (WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE).0 != 0
        || (style & WS_EX_APPWINDOW.0 == 0 && unsafe { GetWindow(window, GW_OWNER) }.is_ok())
    {
        return false;
    }
    let mut cloaked = 0u32;
    let _ = unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_CLOAKED,
            ptr::from_mut(&mut cloaked).cast(),
            size_of::<u32>() as u32,
        )
    };
    cloaked == 0
}

fn app_window(pids: &[u32]) -> windows::core::Result<Option<HWND>> {
    struct Search<'a> {
        pids: &'a [u32],
        window: Option<HWND>,
        minimized: Option<HWND>,
    }
    unsafe extern "system" fn collect(window: HWND, data: LPARAM) -> BOOL {
        let search = unsafe { &mut *(data.0 as *mut Search<'_>) };
        if is_app_window(window, search.pids) {
            if unsafe { IsIconic(window) }.as_bool() {
                search.minimized.get_or_insert(window);
            } else {
                search.window.get_or_insert(window);
            }
        }
        BOOL(1)
    }
    let mut search = Search {
        pids,
        window: None,
        minimized: None,
    };
    unsafe { EnumWindows(Some(collect), LPARAM(ptr::from_mut(&mut search) as isize))? };
    Ok(search.window.or(search.minimized))
}

pub(super) fn toggle_or_launch(
    path: &str,
    previous_foreground: isize,
    launch: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let _lock = APP_LAUNCH.lock().map_err(|error| error.to_string())?;
    let path = Path::new(path);
    let target = if path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("lnk"))
    {
        shortcut_target(path).unwrap_or_default()
    } else {
        path.to_owned()
    };
    if !target
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return launch();
    }
    let pids = matching_processes(&target)
        .map_err(|error| format!("Could not check whether the app is running: {error}"))?;
    if pids.is_empty() {
        return launch();
    }
    let foreground = HWND(previous_foreground as *mut _);
    let owner = unsafe { GetAncestor(foreground, GA_ROOTOWNER) };
    // An owned dialog may have had focus when the palette opened.
    if let Some(window) = [foreground, owner]
        .into_iter()
        .find(|&window| is_app_window(window, &pids) && !unsafe { IsIconic(window) }.as_bool())
    {
        return if unsafe { ShowWindowAsync(window, SW_MINIMIZE) }.as_bool() {
            Ok(())
        } else {
            Err("Windows could not minimize the running app.".into())
        };
    }
    let window = app_window(&pids)
        .map_err(|error| format!("Could not find the app window: {error}"))?
        .ok_or("The app is running, but it has no window to bring forward.")?;
    if unsafe { IsIconic(window) }.as_bool() {
        let _ = unsafe { ShowWindowAsync(window, SW_RESTORE) };
    }
    let popup = unsafe { GetLastActivePopup(window) };
    let foreground = if unsafe { IsWindowVisible(popup) }.as_bool() {
        popup
    } else {
        window
    };
    if unsafe { SetForegroundWindow(foreground) }.as_bool() {
        Ok(())
    } else {
        Err("Windows could not bring the running app to the foreground.".into())
    }
}
