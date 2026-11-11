use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicUsize, Ordering},
        LazyLock, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, State, WindowEvent,
};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut as Hotkey, ShortcutState};
use tauri_plugin_opener::OpenerExt;
use url::Url;
use walkdir::WalkDir;

#[cfg(target_os = "windows")]
mod app_launch;
#[cfg(target_os = "windows")]
mod folder_launch;
#[cfg(target_os = "windows")]
mod keyboard;
mod mouse_hotkey;
mod tile_icons;
mod workspaces;

use workspaces::WorkspaceStore;

static OPEN_FILE_PICKERS: AtomicUsize = AtomicUsize::new(0);
#[cfg(target_os = "windows")]
static PALETTE_ORIGIN: std::sync::atomic::AtomicIsize = std::sync::atomic::AtomicIsize::new(0);
static TAILWIND_COLORS: LazyLock<HashSet<String>> = LazyLock::new(|| {
    serde_json::from_str::<serde_json::Value>(include_str!("../../src/tailwind_colors.json"))
        .ok()
        .and_then(|value| value.as_object().map(|map| map.keys().cloned().collect()))
        .unwrap_or_default()
});
static INSTALLED_APPS_CACHE: LazyLock<Mutex<Option<(Instant, Vec<InstalledApp>)>>> =
    LazyLock::new(|| Mutex::new(None));
const INSTALLED_APPS_TTL: Duration = Duration::from_secs(120);

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Shortcut {
    id: String,
    path: String,
    name: String,
    kind: String,
    preview: Option<String>,
    #[serde(default)]
    text: Option<String>,
    #[serde(default)]
    parent_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    emoji: Option<String>,
}

#[derive(Default)]
struct DragSession {
    generation: u64,
    tile: Option<(String, String)>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct InstalledApp {
    name: String,
    path: String,
}

#[cfg(target_os = "windows")]
fn cursor_in_palette(app: &AppHandle) -> Option<(i32, i32)> {
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[link(name = "user32")]
    unsafe extern "system" {
        #[link_name = "GetCursorPos"]
        fn get_cursor_pos(point: *mut Point) -> i32;
    }
    let mut cursor = Point { x: 0, y: 0 };
    if unsafe { get_cursor_pos(&mut cursor) } == 0 {
        return None;
    }
    let main = app.get_webview_window("main")?;
    let position = main.outer_position().ok()?;
    let size = main.outer_size().ok()?;
    let x = cursor.x - position.x;
    let y = cursor.y - position.y;
    if x >= 0 && y >= 0 && x < size.width as i32 && y < size.height as i32 {
        Some((x, y))
    } else {
        None
    }
}

const MAX_SHORTCUTS: usize = 12;
const MAX_RINGS: usize = 3;
const MAX_PREVIEW_BYTES: u64 = 3 * 1024 * 1024;

#[cfg(all(debug_assertions, target_os = "windows"))]
fn watch_dev_supervisor(app: AppHandle) {
    let Ok(pid) = std::env::var("WAYFINDER_DEV_SUPERVISOR_PID") else {
        return;
    };
    let Ok(pid) = pid.parse::<u32>() else {
        return;
    };
    std::thread::spawn(move || {
        use std::ffi::c_void;

        #[link(name = "kernel32")]
        unsafe extern "system" {
            #[link_name = "OpenProcess"]
            fn open_process(access: u32, inherit: i32, pid: u32) -> *mut c_void;
            #[link_name = "WaitForSingleObject"]
            fn wait_for_single_object(handle: *mut c_void, timeout: u32) -> u32;
            #[link_name = "CloseHandle"]
            fn close_handle(handle: *mut c_void) -> i32;
        }

        const SYNCHRONIZE: u32 = 0x0010_0000;
        const INFINITE: u32 = u32::MAX;
        let process = unsafe { open_process(SYNCHRONIZE, 0, pid) };
        if process.is_null() {
            return;
        }
        let result = unsafe { wait_for_single_object(process, INFINITE) };
        unsafe { close_handle(process) };
        if result == 0 {
            app.exit(0);
        }
    });
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
enum ThemeMode {
    Light,
    Dark,
    System,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default)]
struct Theme {
    mode: ThemeMode,
    background: Option<String>,
    highlight: Option<String>,
    border: Option<String>,
}

impl Default for Theme {
    fn default() -> Self {
        Self {
            mode: ThemeMode::Dark,
            background: None,
            highlight: None,
            border: None,
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Appearance {
    shell_size: u32,
    #[serde(default = "default_icon_size")]
    icon_size: u32,
    text_size: u32,
    inner_radius: u32,
    border_thickness: u32,
    #[serde(default)]
    tile_corner_radius: u32,
    #[serde(alias = "buttonPadding")]
    tile_padding: u32,
    submenu_padding: u32,
    #[serde(default = "default_color_label_distance")]
    color_label_distance: u32,
    #[serde(default)]
    theme: Theme,
    #[serde(default = "animations_enabled")]
    animations: bool,
    #[serde(default = "default_center_position")]
    open_at_screen_center: bool,
    #[serde(default)]
    cast_shadow: bool,
}

fn default_center_position() -> bool {
    true
}

fn animations_enabled() -> bool {
    true
}

fn default_color_label_distance() -> u32 {
    7
}

fn default_icon_size() -> u32 {
    42
}

impl Default for Appearance {
    fn default() -> Self {
        Self {
            shell_size: 620,
            icon_size: default_icon_size(),
            text_size: 9,
            inner_radius: 144,
            border_thickness: 2,
            tile_corner_radius: 0,
            tile_padding: 5,
            submenu_padding: 8,
            color_label_distance: default_color_label_distance(),
            theme: Theme::default(),
            animations: animations_enabled(),
            open_at_screen_center: default_center_position(),
            cast_shadow: false,
        }
    }
}

impl Appearance {
    fn clamped(mut self) -> Self {
        self.shell_size = self.shell_size.clamp(360, 760);
        self.icon_size = self.icon_size.clamp(20, 60);
        self.text_size = self.text_size.clamp(8, 18);
        self.inner_radius = self.inner_radius.clamp(60, 156);
        self.border_thickness = self.border_thickness.clamp(0, 6);
        self.tile_corner_radius = self.tile_corner_radius.clamp(0, 30);
        self.tile_padding = self.tile_padding.clamp(0, 16);
        self.submenu_padding = self.submenu_padding.clamp(0, 24);
        self.color_label_distance = self.color_label_distance.min(24);
        for color in [
            &mut self.theme.background,
            &mut self.theme.highlight,
            &mut self.theme.border,
        ] {
            *color = color.take().filter(|value| is_hex_color(value));
        }
        self
    }
}

fn import_previous_data(dir: &Path) -> io::Result<()> {
    let Some(parent) = dir.parent() else {
        return Ok(());
    };
    let legacy_dir = parent.join("app.radial.palette");
    for name in ["shortcuts.json", "appearance.json", "palette-hotkey.txt"] {
        let destination = dir.join(name);
        if destination.try_exists()? {
            continue;
        }
        let contents = match fs::read(legacy_dir.join(name)) {
            Ok(contents) => contents,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error),
        };
        fs::create_dir_all(dir)?;
        let mut file = match fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
        {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        if let Err(error) = file.write_all(&contents) {
            drop(file);
            let _ = fs::remove_file(&destination);
            return Err(error);
        }
    }
    Ok(())
}

fn appearance_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("appearance.json"))
}

fn load_appearance(app: &AppHandle) -> Appearance {
    let Ok(path) = appearance_path(app) else {
        return Appearance::default();
    };
    let Ok(contents) = fs::read_to_string(path) else {
        return Appearance::default();
    };
    serde_json::from_str::<Appearance>(&contents)
        .unwrap_or_default()
        .clamped()
}

fn cached_appearance(app: &AppHandle) -> Appearance {
    app.try_state::<Mutex<Appearance>>()
        .and_then(|state| state.lock().ok().map(|value| value.clone()))
        .unwrap_or_else(|| load_appearance(app))
}

#[tauri::command]
fn get_appearance(app: AppHandle) -> Appearance {
    cached_appearance(&app)
}

#[tauri::command]
fn set_appearance(
    app: AppHandle,
    state: State<'_, Mutex<Appearance>>,
    appearance: Appearance,
) -> Result<Appearance, String> {
    let appearance = appearance.clamped();
    let json = serde_json::to_vec_pretty(&appearance).map_err(|e| e.to_string())?;
    fs::write(appearance_path(&app)?, json).map_err(|e| e.to_string())?;
    if let Ok(mut cached) = state.lock() {
        *cached = appearance.clone();
    }
    Ok(appearance)
}

#[tauri::command]
fn preview_appearance(
    app: AppHandle,
    state: State<'_, Mutex<Appearance>>,
    appearance: Appearance,
) -> Result<(), String> {
    let clamped = appearance.clamped();
    if let Ok(mut cached) = state.lock() {
        *cached = clamped.clone();
    }
    app.emit_to("main", "appearance-changed", clamped)
        .map_err(|e| e.to_string())
}

fn preview_for(path: &Path, metadata: &fs::Metadata) -> Option<String> {
    tile_icons::image_preview(path, metadata, MAX_PREVIEW_BYTES)
}

fn kind_for(path: &Path, is_dir: bool) -> String {
    if is_dir {
        return "folder".into();
    }
    match path
        .extension()
        .and_then(|x| x.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "exe" | "lnk" => "app",
        "png" | "jpg" | "jpeg" | "gif" | "webp" | "bmp" | "svg" => "image",
        "pdf" => "pdf",
        "mp4" | "mov" | "mkv" | "avi" | "webm" => "video",
        "mp3" | "wav" | "flac" | "m4a" => "audio",
        _ => "file",
    }
    .into()
}

fn next_shortcut_id() -> Result<String, String> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos()
        .to_string())
}

fn parent_depth(shortcuts: &[Shortcut], parent_id: Option<&str>) -> Result<usize, String> {
    let mut depth = 0;
    let mut current = parent_id;
    while let Some(id) = current {
        let parent = shortcuts
            .iter()
            .find(|item| item.id == id && item.kind == "submenu")
            .ok_or_else(|| "Submenu not found".to_string())?;
        depth += 1;
        if depth >= MAX_RINGS {
            return Err("Submenus are limited to three rings".into());
        }
        current = parent.parent_id.as_deref();
    }
    Ok(depth)
}

fn sibling_count(shortcuts: &[Shortcut], parent_id: Option<&str>) -> usize {
    shortcuts
        .iter()
        .filter(|item| item.parent_id.as_deref() == parent_id)
        .count()
}

fn sibling_insert_position(shortcuts: &[Shortcut], parent_id: Option<&str>, index: usize) -> usize {
    let positions: Vec<usize> = shortcuts
        .iter()
        .enumerate()
        .filter_map(|(position, item)| (item.parent_id.as_deref() == parent_id).then_some(position))
        .collect();
    if index < positions.len() {
        positions[index]
    } else {
        positions
            .last()
            .map_or(shortcuts.len(), |position| position + 1)
    }
}

fn normalized_webpage(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    let candidate = if raw.contains("://") {
        raw.to_string()
    } else {
        format!("https://{raw}")
    };
    let url = Url::parse(&candidate).map_err(|_| "Enter a valid webpage URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
        return Err("Only http and https webpages are supported".into());
    }
    Ok(url.to_string())
}

fn validated_tile_path(raw: &str, folder: bool) -> Result<String, String> {
    let raw = raw.trim().trim_matches('"');
    let path = PathBuf::from(raw);
    if !path.is_absolute() {
        return Err("Choose an absolute path".into());
    }
    let metadata =
        fs::metadata(&path).map_err(|_| "The selected path does not exist".to_string())?;
    if folder {
        if !metadata.is_dir() {
            return Err("Choose a folder".into());
        }
    } else if !metadata.is_file()
        || !matches!(
            path.extension()
                .and_then(|ext| ext.to_str())
                .unwrap_or("")
                .to_ascii_lowercase()
                .as_str(),
            "exe" | "lnk"
        )
    {
        return Err("Choose an .exe or .lnk app shortcut".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn create_tile(
    app: AppHandle,
    state: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    kind: String,
    name: String,
    value: String,
    index: usize,
    parent_id: Option<String>,
    color: Option<String>,
) -> Result<Shortcut, String> {
    let mut store = state.lock().map_err(|e| e.to_string())?;
    let shortcuts = store.edit_shortcuts(&workspace_id)?;
    let depth = parent_depth(shortcuts, parent_id.as_deref())?;
    if sibling_count(shortcuts, parent_id.as_deref()) >= MAX_SHORTCUTS {
        return Err(format!("This ring is full ({MAX_SHORTCUTS} items)"));
    }
    if kind == "submenu" && depth >= MAX_RINGS - 1 {
        return Err("Submenus are limited to three rings".into());
    }
    if kind == "folder" && name.trim().is_empty() {
        return Err("Enter a name for the folder tile".into());
    }
    let (path, text, name) = tile_fields(&kind, &name, &value)?;
    let emoji = submenu_emoji(&kind, &value)?;
    let item = Shortcut {
        id: next_shortcut_id()?,
        path,
        name,
        kind,
        preview: None,
        text,
        parent_id: parent_id.clone(),
        color: tile_color(color)?,
        emoji,
    };
    let mut updated = shortcuts.clone();
    let position = sibling_insert_position(&updated, parent_id.as_deref(), index);
    updated.insert(position, item.clone());
    store.save_shortcuts(&app, &workspace_id, updated)?;
    Ok(item)
}

fn is_hex_color(value: &str) -> bool {
    value.len() == 7
        && value.starts_with('#')
        && value.as_bytes()[1..].iter().all(u8::is_ascii_hexdigit)
}

fn tile_color(color: Option<String>) -> Result<Option<String>, String> {
    match color {
        Some(value) if is_hex_color(&value) => Ok(Some(value.to_ascii_lowercase())),
        Some(value) => {
            if TAILWIND_COLORS.contains(&value) {
                Ok(Some(value))
            } else {
                Err("Choose a valid tile color".into())
            }
        }
        None => Ok(None),
    }
}

fn submenu_emoji(kind: &str, value: &str) -> Result<Option<String>, String> {
    let value = value.trim();
    if kind != "submenu" || value.is_empty() {
        return Ok(None);
    }
    if value.len() > 128 || value.chars().any(char::is_control) {
        return Err("Choose one emoji for the submenu icon".into());
    }
    Ok(Some(value.to_string()))
}

fn tile_fields(
    kind: &str,
    name: &str,
    value: &str,
) -> Result<(String, Option<String>, String), String> {
    let (path, text, default_name) = match kind {
        "submenu" => {
            let default_name = if value.trim().is_empty() { "Submenu" } else { "" };
            (String::new(), None, default_name.to_string())
        }
        "text" => {
            if value.is_empty() || value.chars().count() > 20_000 {
                return Err("Enter text up to 20,000 characters".into());
            }
            (String::new(), Some(value.to_string()), String::new())
        }
        "webpage" => (normalized_webpage(value)?, None, String::new()),
        "app" => (validated_tile_path(value, false)?, None, String::new()),
        "folder" => {
            let path = validated_tile_path(value, true)?;
            let default_name = Path::new(&path)
                .file_name()
                .map(|name| name.to_string_lossy().into_owned())
                .unwrap_or_else(|| kind.to_string());
            (path, None, default_name)
        }
        _ => return Err("Unsupported tile type".into()),
    };
    Ok((path, text, tile_name(name, default_name)?))
}

fn tile_name(name: &str, default_name: String) -> Result<String, String> {
    let name = if name.trim().is_empty() {
        default_name
    } else {
        name.trim().to_string()
    };
    if name.chars().count() > 80 {
        return Err("Tile name must be 80 characters or fewer".into());
    }
    Ok(name)
}

fn edited_tile(
    shortcuts: &[Shortcut],
    existing: &Shortcut,
    kind: &str,
    name: &str,
    value: &str,
) -> Result<Shortcut, String> {
    if kind != "submenu" && sibling_count(shortcuts, Some(&existing.id)) > 0 {
        return Err("This submenu contains tiles. Empty it before changing its type".into());
    }
    if kind == "submenu" && parent_depth(shortcuts, existing.parent_id.as_deref())? >= MAX_RINGS - 1
    {
        return Err("Submenus are limited to three rings".into());
    }
    let mut item = existing.clone();
    item.emoji = submenu_emoji(kind, value)?;
    if kind == "file" {
        let path = Path::new(value.trim().trim_matches('"'));
        if !path.is_absolute() {
            return Err("Choose an absolute path".into());
        }
        let metadata =
            fs::metadata(path).map_err(|_| "The selected path does not exist".to_string())?;
        if !metadata.is_file() {
            return Err("Choose a file".into());
        }
        item.kind = kind_for(path, false);
        if item.kind == "app" {
            item.kind = "file".to_string();
        }
        if name != existing.name || name.trim().is_empty() {
            let default_name = path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned();
            item.name = tile_name(name, default_name)?;
        }
        item.preview = if path == Path::new(&existing.path) {
            existing.preview.clone()
        } else {
            preview_for(path, &metadata)
        };
        item.path = path.to_string_lossy().into_owned();
        item.text = None;
    } else {
        let (path, text, name) = tile_fields(kind, name, value)?;
        item.kind = kind.to_string();
        item.path = path;
        item.text = text;
        item.name = name;
        item.preview = None;
    }
    Ok(item)
}

#[tauri::command]
fn update_tile(
    app: AppHandle,
    state: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    id: String,
    kind: String,
    name: String,
    value: String,
    color: Option<String>,
) -> Result<Shortcut, String> {
    let mut store = state.lock().map_err(|e| e.to_string())?;
    let shortcuts = store.edit_shortcuts(&workspace_id)?;
    let position = shortcuts
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| "Shortcut not found".to_string())?;
    let mut item = edited_tile(shortcuts, &shortcuts[position], &kind, &name, &value)?;
    item.color = tile_color(color)?;
    let mut updated = shortcuts.clone();
    updated[position] = item.clone();
    store.save_shortcuts(&app, &workspace_id, updated)?;
    Ok(item)
}

fn move_tile(shortcuts: &mut Vec<Shortcut>, id: &str, index: usize) -> Result<bool, String> {
    let position = shortcuts
        .iter()
        .position(|item| item.id == id)
        .ok_or_else(|| "Shortcut not found".to_string())?;
    let parent_id = shortcuts[position].parent_id.as_deref();
    if index >= sibling_count(shortcuts, parent_id) {
        return Err("That position is outside the tile's ring".into());
    }
    if position == sibling_insert_position(shortcuts, parent_id, index) {
        return Ok(false);
    }

    let tile = shortcuts.remove(position);
    let destination = sibling_insert_position(shortcuts, tile.parent_id.as_deref(), index);
    shortcuts.insert(destination, tile);
    Ok(true)
}

#[tauri::command]
fn reorder_tile(
    app: AppHandle,
    state: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    id: String,
    index: usize,
) -> Result<(), String> {
    let mut store = state.lock().map_err(|e| e.to_string())?;
    let shortcuts = store.edit_shortcuts(&workspace_id)?;
    let mut updated = shortcuts.clone();
    if move_tile(&mut updated, &id, index)? {
        store.save_shortcuts(&app, &workspace_id, updated)?;
    }
    Ok(())
}

#[tauri::command]
fn open_emoji_picker(app: AppHandle) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        use windows::Win32::UI::{
            Input::KeyboardAndMouse::{VK_LWIN, VK_OEM_PERIOD},
            WindowsAndMessaging::GetForegroundWindow,
        };

        let editor = app
            .get_webview_window("editor")
            .ok_or_else(|| "Settings window not found".to_string())?;
        let hwnd = editor.hwnd().map_err(|error| error.to_string())?;
        if unsafe { GetForegroundWindow() }.0 == hwnd.0
            && keyboard::send_shortcut(VK_LWIN, VK_OEM_PERIOD)
        {
            return Ok(());
        }
        Err("Focus the emoji field and press Win + . to open the emoji picker.".into())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = app;
        Err("Use your system emoji picker in the emoji field.".into())
    }
}

#[tauri::command]
async fn pick_tile_path(app: AppHandle, kind: String) -> Result<Option<String>, String> {
    let editor = app
        .get_webview_window("editor")
        .ok_or_else(|| "Settings window not found".to_string())?;
    let dialog = app.dialog().file().set_parent(&editor);
    if !matches!(kind.as_str(), "app" | "folder" | "file") {
        return Err("This tile does not use a file picker".into());
    }
    OPEN_FILE_PICKERS.fetch_add(1, Ordering::Relaxed);
    let selected = match kind.as_str() {
        "app" => dialog
            .add_filter("Applications", &["exe", "lnk"])
            .blocking_pick_file(),
        "folder" => dialog.blocking_pick_folder(),
        _ => dialog.blocking_pick_file(),
    };
    OPEN_FILE_PICKERS.fetch_sub(1, Ordering::Relaxed);
    selected
        .map(|path| {
            path.into_path()
                .map(|path| path.to_string_lossy().into_owned())
                .map_err(|error| error.to_string())
        })
        .transpose()
}

fn collect_installed_apps() -> Vec<InstalledApp> {
    if let Ok(cache) = INSTALLED_APPS_CACHE.lock() {
        if let Some((timestamp, apps)) = cache.as_ref() {
            if timestamp.elapsed() < INSTALLED_APPS_TTL {
                return apps.clone();
            }
        }
    }
    let mut apps = Vec::new();
    for (variable, suffix) in [
        ("APPDATA", "Microsoft/Windows/Start Menu/Programs"),
        ("ProgramData", "Microsoft/Windows/Start Menu/Programs"),
    ] {
        let Ok(root) = std::env::var(variable) else {
            continue;
        };
        for entry in WalkDir::new(Path::new(&root).join(suffix))
            .max_depth(7)
            .into_iter()
            .filter_map(Result::ok)
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let path = entry.path();
            if !matches!(
                path.extension()
                    .and_then(|extension| extension.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase()
                    .as_str(),
                "exe" | "lnk"
            ) {
                continue;
            }
            let Some(name) = path.file_stem() else {
                continue;
            };
            apps.push(InstalledApp {
                name: name.to_string_lossy().into_owned(),
                path: path.to_string_lossy().into_owned(),
            });
        }
    }
    apps.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    apps.dedup_by(|a, b| a.path.eq_ignore_ascii_case(&b.path));
    if let Ok(mut cache) = INSTALLED_APPS_CACHE.lock() {
        *cache = Some((Instant::now(), apps.clone()));
    }
    apps
}

#[tauri::command]
async fn list_installed_apps() -> Vec<InstalledApp> {
    if let Ok(cache) = INSTALLED_APPS_CACHE.lock() {
        if let Some((timestamp, apps)) = cache.as_ref() {
            if timestamp.elapsed() < INSTALLED_APPS_TTL {
                return apps.clone();
            }
        }
    }
    tauri::async_runtime::spawn_blocking(collect_installed_apps)
        .await
        .unwrap_or_default()
}

#[tauri::command]
fn begin_tile_drag(
    app: AppHandle,
    state: State<'_, Mutex<DragSession>>,
    kind: String,
    workspace_id: String,
) -> Result<(), String> {
    if !matches!(
        kind.as_str(),
        "submenu" | "text" | "folder" | "webpage" | "app"
    ) {
        return Err("Unsupported tile type".into());
    }
    let generation = {
        let mut session = state.lock().map_err(|e| e.to_string())?;
        session.generation = session.generation.wrapping_add(1);
        session.tile = Some((kind.clone(), workspace_id.clone()));
        session.generation
    };
    app.emit_to("main", "tile-drag-start", (kind, workspace_id))
        .map_err(|e| e.to_string())?;
    #[cfg(target_os = "windows")]
    std::thread::spawn(move || {
        let mut last_position: Option<Option<(i32, i32)>> = None;
        loop {
            let active = app
                .state::<Mutex<DragSession>>()
                .lock()
                .map(|session| session.generation == generation && session.tile.is_some())
                .unwrap_or(false);
            if !active {
                break;
            }
            let position = cursor_in_palette(&app);
            if last_position != Some(position) {
                last_position = Some(position);
                let _ = app.emit_to("main", "tile-drag-position", position);
            }
            std::thread::sleep(Duration::from_millis(24));
        }
    });
    Ok(())
}

#[tauri::command]
fn end_tile_drag(app: AppHandle, state: State<'_, Mutex<DragSession>>) -> Result<(), String> {
    let tile = state.lock().map_err(|e| e.to_string())?.tile.take();
    #[cfg(target_os = "windows")]
    if let (Some((kind, workspace_id)), Some((x, y))) = (tile, cursor_in_palette(&app)) {
        app.emit_to("main", "tile-drag-finished", (kind, workspace_id, x, y))
            .map_err(|e| e.to_string())?;
    }
    app.emit_to("main", "tile-drag-end", ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn select_tile_for_edit(
    app: AppHandle,
    state: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    id: String,
    level: u8,
) -> Result<(), String> {
    let editor = app
        .get_webview_window("editor")
        .ok_or_else(|| "Edit window not found".to_string())?;
    if !editor.is_visible().map_err(|error| error.to_string())? {
        return Ok(());
    }
    let payload = {
        let store = state.lock().map_err(|error| error.to_string())?;
        let item = store
            .edit_shortcuts(&workspace_id)?
            .iter()
            .find(|item| item.id == id)
            .ok_or("Shortcut not found")?;
        serde_json::json!({
            "item": {
                "id": item.id,
                "name": item.name,
                "kind": item.kind,
                "path": item.path,
                "text": item.text,
                "color": item.color,
                "emoji": item.emoji,
            },
            "level": level,
            "workspaceId": workspace_id,
        })
    };
    app.emit_to("editor", "tile-selection-changed", payload)
        .map_err(|error| error.to_string())?;
    if editor.is_minimized().map_err(|error| error.to_string())? {
        editor.unminimize().map_err(|error| error.to_string())?;
    }
    editor.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn open_tile_form(
    app: AppHandle,
    workspace_id: String,
    kind: String,
    index: usize,
    parent_id: Option<String>,
    draft_id: String,
) -> Result<(), String> {
    app.emit_to(
        "editor",
        "tile-form-requested",
        (kind, index, parent_id, workspace_id, draft_id),
    )
    .map_err(|e| e.to_string())?;
    if let Some(editor) = app.get_webview_window("editor") {
        let _ = editor.set_focus();
    }
    Ok(())
}

#[tauri::command]
fn list_shortcuts(
    state: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
) -> Result<Vec<Shortcut>, String> {
    let store = state.lock().map_err(|e| e.to_string())?;
    Ok(store.edit_shortcuts(&workspace_id)?.clone())
}

#[tauri::command]
async fn shortcut_icon(
    id: String,
    state: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
) -> Result<Option<String>, String> {
    let (kind, path) = {
        let store = state.lock().map_err(|error| error.to_string())?;
        let Some(item) = store.shortcuts(&workspace_id)?.iter().find(|item| item.id == id) else {
            return Ok(None);
        };
        (item.kind.clone(), item.path.clone())
    };
    Ok(match kind.as_str() {
        "webpage" => tile_icons::site_icon(&path).await,
        #[cfg(windows)]
        "app" => tauri::async_runtime::spawn_blocking(move || tile_icons::app_icon(&path))
            .await
            .ok()
            .flatten(),
        _ => None,
    })
}

#[tauri::command]
fn add_paths(
    app: AppHandle,
    state: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    paths: Vec<String>,
    parent_id: Option<String>,
    index: Option<usize>,
) -> Result<Vec<Shortcut>, String> {
    let mut store = state.lock().map_err(|e| e.to_string())?;
    let shortcuts = store.edit_shortcuts(&workspace_id)?;
    parent_depth(shortcuts, parent_id.as_deref())?;
    let mut updated = shortcuts.clone();
    let mut added = Vec::new();
    for (path_index, raw) in paths.into_iter().enumerate() {
        if sibling_count(&updated, parent_id.as_deref()) >= MAX_SHORTCUTS {
            break;
        }
        let path = PathBuf::from(&raw);
        if !path.is_absolute() {
            continue;
        }
        let Ok(metadata) = fs::metadata(&path) else {
            continue;
        };
        if !(metadata.is_file() || metadata.is_dir()) {
            continue;
        }
        let normalized = path;
        let normalized_text = normalized.to_string_lossy().into_owned();
        if updated
            .iter()
            .any(|item| item.path.eq_ignore_ascii_case(&normalized_text))
        {
            continue;
        }
        let name = normalized
            .file_name()
            .map(|x| x.to_string_lossy().into_owned())
            .unwrap_or_else(|| normalized_text.clone());
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_nanos();
        let item = Shortcut {
            id: format!("{stamp}-{path_index}"),
            path: normalized_text,
            name,
            kind: kind_for(&normalized, metadata.is_dir()),
            preview: if metadata.is_file() {
                preview_for(&normalized, &metadata)
            } else {
                None
            },
            text: None,
            parent_id: parent_id.clone(),
            color: None,
            emoji: None,
        };
        let insert_at = sibling_insert_position(
            &updated,
            parent_id.as_deref(),
            index.unwrap_or(usize::MAX).saturating_add(added.len()),
        );
        updated.insert(insert_at, item.clone());
        added.push(item);
    }
    if !added.is_empty() {
        store.save_shortcuts(&app, &workspace_id, updated)?;
    }
    Ok(added)
}

#[tauri::command]
fn remove_shortcut(
    app: AppHandle,
    state: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    id: String,
    confirmed_descendants: Option<usize>,
) -> Result<Option<usize>, String> {
    let mut store = state.lock().map_err(|e| e.to_string())?;
    let shortcuts = store.edit_shortcuts(&workspace_id)?;
    let mut removed = HashSet::from([id]);
    loop {
        let before = removed.len();
        for item in shortcuts.iter() {
            if item
                .parent_id
                .as_ref()
                .is_some_and(|parent| removed.contains(parent))
            {
                removed.insert(item.id.clone());
            }
        }
        if removed.len() == before {
            break;
        }
    }
    let descendants = removed.len() - 1;
    if descendants > 0 && confirmed_descendants != Some(descendants) {
        return Ok(Some(descendants));
    }
    let mut updated = shortcuts.clone();
    updated.retain(|item| !removed.contains(&item.id));
    store.save_shortcuts(&app, &workspace_id, updated)?;
    Ok(None)
}

#[tauri::command]
async fn open_shortcut(
    app: AppHandle,
    state: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
    id: String,
    in_terminal: Option<bool>,
) -> Result<(), String> {
    let item = state
        .lock()
        .map_err(|e| e.to_string())?
        .shortcuts(&workspace_id)?
        .iter()
        .find(|item| item.id == id)
        .cloned()
        .ok_or_else(|| "Shortcut not found".to_string())?;
    match item.kind.as_str() {
        "text" => arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set_text(item.text.unwrap_or_default()))
            .map_err(|error| error.to_string()),
        "webpage" => app
            .opener()
            .open_url(normalized_webpage(&item.path)?, None::<&str>)
            .map_err(|error| error.to_string()),
        "submenu" => Ok(()),
        #[cfg(target_os = "windows")]
        "app" => {
            let previous_foreground = PALETTE_ORIGIN.load(Ordering::Relaxed);
            tauri::async_runtime::spawn_blocking(move || {
                app_launch::toggle_or_launch(&item.path, previous_foreground, || {
                    app.opener()
                        .open_path(&item.path, None::<&str>)
                        .map_err(|error| error.to_string())
                })
            })
            .await
            .map_err(|error| error.to_string())?
        }
        "folder" => {
            if !Path::new(&item.path).is_dir() {
                return Err("The original folder no longer exists".into());
            }
            #[cfg(target_os = "windows")]
            {
                let path = item.path.clone();
                let opened = tauri::async_runtime::spawn_blocking(move || {
                    if in_terminal.unwrap_or(false) {
                        folder_launch::open_in_terminal(Path::new(&path)).map(|()| true)
                    } else {
                        folder_launch::open_in_explorer_tab(&path)
                    }
                })
                .await
                .map_err(|error| error.to_string())??;
                if opened {
                    return Ok(());
                }
            }
            app.opener()
                .open_path(item.path, None::<&str>)
                .map_err(|error| error.to_string())
        }
        _ => {
            if !Path::new(&item.path).exists() {
                return Err("The original file or folder no longer exists".into());
            }
            app.opener()
                .open_path(item.path, None::<&str>)
                .map_err(|error| error.to_string())
        }
    }
}

#[tauri::command]
fn set_edit_window_visible(app: AppHandle, visible: bool) -> Result<(), String> {
    let editor = app
        .get_webview_window("editor")
        .ok_or_else(|| "Edit window not found".to_string())?;
    if visible {
        if !editor.is_visible().map_err(|e| e.to_string())? {
            let _ = tauri::async_runtime::spawn_blocking(collect_installed_apps);
            let _ = fit_editor_height(app.clone(), 0);
            if app
                .get_webview_window("main")
                .is_some_and(|main| main.is_visible().unwrap_or(false))
            {
                position_editor(&app);
            } else {
                let _ = editor.center();
            }
            editor.show().map_err(|e| e.to_string())?;
        }
        if editor.is_minimized().map_err(|e| e.to_string())? {
            editor.unminimize().map_err(|e| e.to_string())?;
        }
        editor.set_focus().map_err(|e| e.to_string())?;
    } else {
        editor.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn fit_editor_height(app: AppHandle, height: u32) -> Result<(), String> {
    let editor = app
        .get_webview_window("editor")
        .ok_or_else(|| "Edit window not found".to_string())?;
    if editor.is_maximized().map_err(|error| error.to_string())? {
        return Ok(());
    }
    let visible = editor.is_visible().map_err(|error| error.to_string())?;
    let monitor_window = if visible {
        editor.clone()
    } else {
        app.get_webview_window("main")
            .unwrap_or_else(|| editor.clone())
    };
    let Some(monitor) = monitor_window
        .current_monitor()
        .map_err(|error| error.to_string())?
    else {
        return Ok(());
    };
    let work = monitor.work_area();
    let inner = editor.inner_size().map_err(|error| error.to_string())?;
    let outer = editor.outer_size().map_err(|error| error.to_string())?;
    let scale = editor.scale_factor().map_err(|error| error.to_string())?;
    let frame = outer.height.saturating_sub(inner.height);
    let available = work.size.height.saturating_sub(frame).max(1);
    let requested = (f64::from(height) * scale).ceil() as u32;
    let target = inner.height.max(requested).min(available);
    if target != inner.height {
        editor
            .set_size(PhysicalSize::new(inner.width, target))
            .map_err(|error| error.to_string())?;
        if visible {
            let position = editor.outer_position().map_err(|error| error.to_string())?;
            let bottom = work.position.y
                + work
                    .size
                    .height
                    .saturating_sub(target.saturating_add(frame)) as i32;
            let y = position.y.clamp(work.position.y, bottom);
            if y != position.y {
                editor
                    .set_position(PhysicalPosition::new(position.x, y))
                    .map_err(|error| error.to_string())?;
            }
        }
    }
    Ok(())
}

fn position_editor(app: &AppHandle) {
    let (Some(main), Some(editor)) = (
        app.get_webview_window("main"),
        app.get_webview_window("editor"),
    ) else {
        return;
    };
    if let (Ok(position), Ok(size), Ok(editor_size), Ok(Some(monitor))) = (
        main.outer_position(),
        main.outer_size(),
        editor.outer_size(),
        main.current_monitor(),
    ) {
        let work = monitor.work_area();
        let monitor_position = work.position;
        let monitor_size = work.size;
        let right_edge = monitor_position.x + monitor_size.width as i32;
        let bottom_edge = monitor_position.y + monitor_size.height as i32;
        let right = position.x + size.width as i32 + 16;
        let left = position.x - editor_size.width as i32 - 16;
        let x = if right + editor_size.width as i32 <= right_edge {
            right
        } else {
            left.max(monitor_position.x)
        };
        let max_y = (bottom_edge - editor_size.height as i32).max(monitor_position.y);
        let y = (position.y + (size.height as i32 - editor_size.height as i32) / 2)
            .clamp(monitor_position.y, max_y);
        let _ = editor.set_position(PhysicalPosition::new(x, y));
    }
}

const DEFAULT_PALETTE_HOTKEY: &str = "Ctrl+Space";

#[derive(Default)]
struct PaletteHotkey(Mutex<Option<PaletteBinding>>);

#[derive(Clone, Copy, PartialEq, Eq)]
enum PaletteBinding {
    Keyboard(Hotkey),
    Mouse(mouse_hotkey::MouseHotkey),
}

impl PaletteBinding {
    fn parse(value: &str) -> Result<Self, String> {
        if let Some(mouse) = mouse_hotkey::MouseHotkey::parse(value)? {
            return Ok(Self::Mouse(mouse));
        }
        value.parse().map(Self::Keyboard).map_err(|_| "Unsupported key combination.".into())
    }
}

impl std::fmt::Display for PaletteBinding {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Keyboard(key) => key.fmt(f),
            Self::Mouse(key) => key.fmt(f),
        }
    }
}

fn hotkey_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(appearance_path(app)?.with_file_name("palette-hotkey.txt"))
}

fn register_palette_hotkey(app: &AppHandle, shortcut: Hotkey) -> Result<(), String> {
    app.global_shortcut()
        .on_shortcut(shortcut, |app, _, event| {
            if event.state() == ShortcutState::Pressed {
                toggle_palette(app);
            }
        })
        .map_err(|error| error.to_string())
}

fn replace_palette_binding(
    app: &AppHandle,
    previous: Option<PaletteBinding>,
    next: Option<PaletteBinding>,
) -> Result<(), String> {
    let next_keyboard = match next {
        Some(PaletteBinding::Keyboard(key)) => Some(key),
        _ => None,
    };
    if let Some(key) = next_keyboard {
        register_palette_hotkey(app, key)?;
    }
    let result = match (previous, next) {
        (Some(PaletteBinding::Keyboard(key)), Some(PaletteBinding::Mouse(mouse))) => {
            mouse_hotkey::set(Some(mouse)).and_then(|()| {
                app.global_shortcut().unregister(key).map_err(|error| {
                    let _ = mouse_hotkey::set(None);
                    error.to_string()
                })
            })
        }
        (Some(PaletteBinding::Keyboard(key)), _) => {
            app.global_shortcut().unregister(key).map_err(|error| error.to_string())
        }
        (_, Some(PaletteBinding::Mouse(mouse))) => mouse_hotkey::set(Some(mouse)),
        (Some(PaletteBinding::Mouse(_)), _) => mouse_hotkey::set(None),
        _ => Ok(()),
    };
    if result.is_err() {
        if let Some(key) = next_keyboard {
            let _ = app.global_shortcut().unregister(key);
        }
    }
    result
}

fn init_palette_hotkey(app: &AppHandle) -> PaletteHotkey {
    let default = PaletteBinding::parse(DEFAULT_PALETTE_HOTKEY).unwrap();
    let saved = hotkey_path(app)
        .ok()
        .and_then(|path| fs::read_to_string(path).ok())
        .and_then(|value| PaletteBinding::parse(value.trim()).ok())
        .unwrap_or(default);
    for shortcut in [Some(saved), (saved != default).then_some(default)]
        .into_iter()
        .flatten()
    {
        match replace_palette_binding(app, None, Some(shortcut)) {
            Ok(()) => return PaletteHotkey(Mutex::new(Some(shortcut))),
            Err(error) => eprintln!("Could not register {shortcut}: {error}"),
        }
    }
    PaletteHotkey::default()
}

#[tauri::command]
async fn get_palette_hotkey(app: AppHandle) -> Result<Option<String>, String> {
    let hotkey = app.state::<PaletteHotkey>();
    let current = hotkey.0.lock().map_err(|error| error.to_string())?;
    Ok(current.map(|shortcut| shortcut.to_string()))
}

#[tauri::command]
async fn set_palette_hotkey(app: AppHandle, combination: String) -> Result<String, String> {
    let next = PaletteBinding::parse(&combination)?;
    let path = hotkey_path(&app)?;
    let hotkey = app.state::<PaletteHotkey>();
    let mut current = hotkey.0.lock().map_err(|error| error.to_string())?;
    if *current == Some(next) {
        return Ok(next.to_string());
    }

    replace_palette_binding(&app, *current, Some(next))?;
    let temporary = path.with_extension("tmp");
    if let Err(error) = fs::write(&temporary, next.to_string()).and_then(|()| fs::rename(&temporary, &path)) {
        let _ = fs::remove_file(temporary);
        if replace_palette_binding(&app, Some(next), *current).is_err() {
            *current = Some(next);
        }
        return Err(error.to_string());
    }
    *current = Some(next);
    Ok(next.to_string())
}

fn position_palette(window: &tauri::WebviewWindow, at_screen_center: bool) -> tauri::Result<()> {
    let cursor = window.cursor_position()?;
    let size = window.outer_size()?;
    let (x, y) = if at_screen_center {
        let Some(monitor) = window.monitor_from_point(cursor.x, cursor.y)? else {
            return window.center();
        };
        let origin = monitor.position();
        let size = monitor.size();
        (origin.x as f64 + size.width as f64 / 2.0, origin.y as f64 + size.height as f64 / 2.0)
    } else {
        (cursor.x, cursor.y)
    };
    window.set_position(PhysicalPosition::new(
        (x - size.width as f64 / 2.0).round() as i32,
        (y - size.height as f64 / 2.0).round() as i32,
    ))
}

fn show_palette(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            let _ = window.set_focus();
        } else {
            let _ = app.emit_to("main", "palette-opening", ());
        }
    }
}

#[tauri::command]
fn present_palette(app: AppHandle) -> Result<(), String> {
    let window = app.get_webview_window("main").ok_or("Palette window not found")?;
    if !window.is_visible().unwrap_or(false) {
        #[cfg(target_os = "windows")]
        {
            use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

            // The palette takes focus, so record which window it opened over.
            let foreground = unsafe { GetForegroundWindow() };
            PALETTE_ORIGIN.store(foreground.0 as isize, Ordering::Relaxed);
        }
        let _ = position_palette(&window, cached_appearance(&app).open_at_screen_center);
        window.show().map_err(|error| error.to_string())?;
        mouse_hotkey::watch_outside_clicks(true);
    }
    let _ = window.set_focus();
    Ok(())
}

#[tauri::command]
fn dismiss_palette(app: AppHandle) {
    #[cfg(target_os = "windows")]
    PALETTE_ORIGIN.store(0, Ordering::Relaxed);
    mouse_hotkey::watch_outside_clicks(false);
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.hide();
    }
    if let Some(editor) = app.get_webview_window("editor") {
        let _ = editor.hide();
    }
    let _ = app.emit_to("main", "editor-closed", ());
    let _ = app.emit_to("editor", "editor-closed", ());
}

#[cfg(target_os = "windows")]
fn file_picker_open() -> bool {
    OPEN_FILE_PICKERS.load(Ordering::Relaxed) != 0
}

#[cfg(target_os = "windows")]
fn dismiss_palette_at(app: &AppHandle, x: i32, y: i32) {
    if file_picker_open()
        || app
            .get_webview_window("editor")
            .is_some_and(|editor| editor.is_visible().unwrap_or(false))
    {
        return;
    }
    let Some(palette) = app.get_webview_window("main") else {
        return;
    };
    if !palette.is_visible().unwrap_or(false) {
        return;
    }
    let (Ok(position), Ok(size)) = (palette.outer_position(), palette.outer_size()) else {
        return;
    };
    let inside = x >= position.x && x < position.x + size.width as i32
        && y >= position.y && y < position.y + size.height as i32;
    if !inside {
        dismiss_palette(app.clone());
    }
}

fn toggle_palette(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if window.is_visible().unwrap_or(false) {
            dismiss_palette(app.clone());
        } else {
            show_palette(app);
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            import_previous_data(&app_data_dir)?;
            tile_icons::init(app_data_dir.join("icon-cache"));
            #[cfg(all(debug_assertions, target_os = "windows"))]
            watch_dev_supervisor(app.handle().clone());
            let workspaces = WorkspaceStore::load(&app_data_dir)?;
            let appearance = load_appearance(app.handle());
            app.manage(Mutex::new(workspaces));
            app.manage(Mutex::new(appearance));
            app.manage(Mutex::new(DragSession::default()));
            app.handle()
                .plugin(tauri_plugin_global_shortcut::Builder::new().build())?;
            mouse_hotkey::init(app.handle());
            app.manage(init_palette_hotkey(app.handle()));

            let show = MenuItem::with_id(app, "show", "Show palette", true, None::<&str>)?;
            let settings = MenuItem::with_id(app, "settings", "Settings", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &settings, &quit])?;
            let mut tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| {
                    if event.id() == "show" {
                        show_palette(app);
                    } else if event.id() == "settings" {
                        if set_edit_window_visible(app.clone(), true).is_ok() {
                            let _ = app.emit_to("main", "editor-opened", ());
                        }
                    } else if event.id() == "quit" {
                        app.exit(0);
                    }
                });
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;
            Ok(())
        })
        .on_window_event(|window, event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if window.label() == "main" {
                    api.prevent_close();
                    dismiss_palette(window.app_handle().clone());
                } else if window.label() == "editor" {
                    api.prevent_close();
                    let _ = window.hide();
                    let _ = window.app_handle().emit_to("main", "editor-closed", ());
                    let _ = window.app_handle().emit_to("editor", "editor-closed", ());
                }
            }
            #[cfg(target_os = "windows")]
            WindowEvent::Focused(false) if window.label() == "main" => {
                let app = window.app_handle();
                if !file_picker_open()
                    && !app
                        .get_webview_window("editor")
                        .is_some_and(|editor| editor.is_visible().unwrap_or(false))
                {
                    dismiss_palette(app.clone());
                }
            }
            _ => {}
        })
        .invoke_handler(tauri::generate_handler![
            workspaces::get_workspaces,
            workspaces::get_workspace_palette,
            workspaces::get_workspace_search,
            workspaces::get_workspace_preview,
            workspaces::change_workspace,
            list_shortcuts,
            shortcut_icon,
            add_paths,
            remove_shortcut,
            open_shortcut,
            set_edit_window_visible,
            fit_editor_height,
            get_appearance,
            set_appearance,
            preview_appearance,
            get_palette_hotkey,
            set_palette_hotkey,
            present_palette,
            dismiss_palette,
            create_tile,
            update_tile,
            reorder_tile,
            pick_tile_path,
            open_emoji_picker,
            list_installed_apps,
            begin_tile_drag,
            end_tile_drag,
            select_tile_for_edit,
            open_tile_form
        ])
        .run(tauri::generate_context!())
        .expect("failed to run Wayfinder");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn old_appearance_keeps_saved_values_with_square_corners() {
        let old = r#"{"shellSize":480,"textSize":10,"innerRadius":110,"borderThickness":1,"tilePadding":5,"submenuPadding":12}"#;
        let appearance: Appearance = serde_json::from_str(old).unwrap();
        assert_eq!(appearance.shell_size, 480);
        assert_eq!(appearance.icon_size, 42);
        assert_eq!(appearance.inner_radius, 110);
        assert_eq!(appearance.tile_corner_radius, 0);
        assert_eq!(appearance.color_label_distance, 7);
        assert!(matches!(appearance.theme.mode, ThemeMode::Dark));
        assert!(appearance.theme.background.is_none());
        assert!(appearance.animations);
    }

    #[test]
    fn existing_shortcuts_load_without_optional_fields() {
        let old = r#"[{"id":"1","path":"C:\\Users\\Example\\Pictures","name":"Pictures","kind":"folder","preview":null}]"#;
        let mut shortcuts: Vec<Shortcut> = serde_json::from_str(old).unwrap();
        assert_eq!(shortcuts[0].kind, "folder");
        assert!(shortcuts[0].text.is_none());
        assert!(shortcuts[0].parent_id.is_none());
        assert!(shortcuts[0].color.is_none());
        assert!(shortcuts[0].emoji.is_none());
        assert!(tile_color(Some("red".into())).is_err());
        assert_eq!(
            tile_color(Some("sky-500".into())).unwrap().as_deref(),
            Some("sky-500")
        );
        shortcuts[0].color = tile_color(Some("#A0B1C2".into())).unwrap();
        let saved = serde_json::to_string(&shortcuts).unwrap();
        let restored: Vec<Shortcut> = serde_json::from_str(&saved).unwrap();
        assert_eq!(restored[0].color.as_deref(), Some("#a0b1c2"));
    }

    #[test]
    fn webpage_accepts_plain_domains_and_rejects_other_schemes() {
        assert_eq!(
            normalized_webpage("example.com").unwrap(),
            "https://example.com/"
        );
        assert!(normalized_webpage("file:///C:/secret.txt").is_err());
    }

    #[test]
    fn submenu_depth_and_insertion_preserve_ring_order() {
        let item = |id: &str, kind: &str, parent_id: Option<&str>| Shortcut {
            id: id.into(),
            path: String::new(),
            name: id.into(),
            kind: kind.into(),
            preview: None,
            text: None,
            parent_id: parent_id.map(str::to_string),
            color: None,
            emoji: None,
        };
        let mut items = vec![
            item("root", "submenu", None),
            item("child-a", "submenu", Some("root")),
            item("grandchild", "text", Some("child-a")),
            item("child-b", "folder", Some("root")),
        ];
        assert_eq!(parent_depth(&items, Some("root")).unwrap(), 1);
        assert_eq!(parent_depth(&items, Some("child-a")).unwrap(), 2);
        assert_eq!(sibling_count(&items, Some("root")), 2);
        assert_eq!(sibling_insert_position(&items, Some("root"), 1), 3);
        let emoji_only = edited_tile(&items, &items[0], "submenu", "", "🗂️").unwrap();
        assert!(emoji_only.name.is_empty());
        assert_eq!(emoji_only.emoji.as_deref(), Some("🗂️"));
        let combined = edited_tile(&items, &emoji_only, "submenu", "Projects", "🗂️").unwrap();
        assert_eq!(combined.name, "Projects");
        assert_eq!(combined.emoji.as_deref(), Some("🗂️"));
        let name_only = edited_tile(&items, &combined, "submenu", "Projects", "").unwrap();
        assert_eq!(name_only.name, "Projects");
        assert!(name_only.emoji.is_none());
        assert!(edited_tile(&items, &items[0], "text", "Root", "Example").is_err());
        assert!(edited_tile(&items, &items[2], "submenu", "Nested", "").is_err());

        let edited = edited_tile(&items, &items[2], "webpage", "", "example.com").unwrap();
        assert_eq!(edited.id, items[2].id);
        assert_eq!(edited.parent_id, items[2].parent_id);
        assert_eq!(edited.kind, "webpage");
        assert_eq!(edited.path, "https://example.com/");
        assert!(edited.name.is_empty());
        assert!(edited.text.is_none());

        assert!(move_tile(&mut items, "child-a", 1).unwrap());
        let siblings: Vec<_> = items
            .iter()
            .filter(|item| item.parent_id.as_deref() == Some("root"))
            .map(|item| item.id.as_str())
            .collect();
        assert_eq!(siblings, ["child-b", "child-a"]);
        assert_eq!(parent_depth(&items, Some("child-a")).unwrap(), 2);
        assert_eq!(sibling_count(&items, Some("child-a")), 1);
        assert!(!move_tile(&mut items, "child-a", 1).unwrap());
        assert!(move_tile(&mut items, "child-a", 2).is_err());
        assert!(move_tile(&mut items, "child-a", 0).unwrap());
        assert_eq!(
            items[sibling_insert_position(&items, Some("root"), 0)].id,
            "child-a"
        );
    }
}
