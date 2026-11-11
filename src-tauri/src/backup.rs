use crate::{
    next_shortcut_id, replace_palette_binding, settings_hotkey, workspaces::WorkspaceList,
    Appearance, PaletteBinding, PaletteHotkey, ThemeMode, WorkspaceStore, OPEN_FILE_PICKERS,
};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{atomic::Ordering, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const FORMAT: &str = "wayfinder-backup";
const VERSION: u32 = 1;
const SUFFIX: &str = ".wayfinder-backup.json";
const MAX_BACKUP_BYTES: u64 = 128 * 1024 * 1024;
const RESTORE_JOURNAL: &str = "restore-in-progress.json";
const SETTINGS_FILES: [&str; 3] = ["workspaces.json", "appearance.json", "palette-hotkey.txt"];

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Backup {
    format: String,
    version: u32,
    workspaces: WorkspaceStore,
    appearance: Appearance,
    palette_hotkey: Option<String>,
}

#[derive(Default)]
pub(crate) struct PendingBackup(Mutex<Option<(String, Backup)>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupPreview {
    token: String,
    workspaces: Vec<BackupWorkspace>,
    palette_hotkey: Option<String>,
    theme_mode: ThemeMode,
    palette_size: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupWorkspace {
    name: String,
    tile_count: usize,
    active: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RestoreResult {
    workspaces: WorkspaceList,
    appearance: Appearance,
    palette_hotkey: Option<String>,
}

fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let id = next_shortcut_id().map_err(io::Error::other)?;
    let temporary = path.with_file_name(format!(".wayfinder-{id}.tmp"));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = file.write_all(contents).and_then(|()| file.sync_all());
    drop(file);
    let result = result.and_then(|()| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn remove_if_present(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        result => result,
    }
}

// Keep the original files until the restore is committed. A restart can recover
// the previous setup even if the process stopped between individual file writes.
type RestoreJournal = [Option<Vec<u8>>; SETTINGS_FILES.len()];

pub(crate) fn recover_interrupted_restore(dir: &Path) -> io::Result<()> {
    let path = dir.join(RESTORE_JOURNAL);
    let contents = match fs::read(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let journal: RestoreJournal = serde_json::from_slice(&contents)?;
    for (name, previous) in SETTINGS_FILES.into_iter().zip(journal) {
        let destination = dir.join(name);
        match previous {
            Some(bytes) => atomic_write(&destination, &bytes)?,
            None => remove_if_present(&destination)?,
        }
    }
    fs::remove_file(path)
}

fn write_restore(dir: &Path, settings: [&[u8]; SETTINGS_FILES.len()]) -> io::Result<()> {
    let journal_path = dir.join(RESTORE_JOURNAL);
    recover_interrupted_restore(dir)?;
    let mut journal: RestoreJournal = Default::default();
    for (entry, name) in journal.iter_mut().zip(SETTINGS_FILES) {
        *entry = match fs::read(dir.join(name)) {
            Ok(bytes) => Some(bytes),
            Err(error) if error.kind() == io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        };
    }
    atomic_write(&journal_path, &serde_json::to_vec(&journal)?)?;
    let result = (|| {
        for (name, bytes) in SETTINGS_FILES.into_iter().zip(settings) {
            atomic_write(&dir.join(name), bytes)?;
        }
        fs::remove_file(journal_path)
    })();
    if let Err(error) = result {
        if let Err(recovery) = recover_interrupted_restore(dir) {
            return Err(io::Error::other(format!(
                "{error}. Restart Wayfinder to retry recovery: {recovery}"
            )));
        }
        return Err(error);
    }
    Ok(())
}

fn pick_backup(app: &AppHandle, save: bool) -> Result<Option<PathBuf>, String> {
    let editor = app
        .get_webview_window("editor")
        .ok_or("Settings window not found")?;
    let dialog = app
        .dialog()
        .file()
        .set_parent(&editor)
        .add_filter("Wayfinder backup", &["json"]);
    OPEN_FILE_PICKERS.fetch_add(1, Ordering::Relaxed);
    let selected = if save {
        dialog
            .set_file_name(format!("Wayfinder{SUFFIX}"))
            .blocking_save_file()
    } else {
        dialog.blocking_pick_file()
    };
    OPEN_FILE_PICKERS.fetch_sub(1, Ordering::Relaxed);
    selected
        .map(|path| path.into_path().map_err(|error| error.to_string()))
        .transpose()
}

fn backup_binding(value: Option<&str>) -> Result<Option<PaletteBinding>, String> {
    let binding = value.map(PaletteBinding::parse).transpose()?;
    if binding == Some(PaletteBinding::Keyboard(settings_hotkey())) {
        return Err("The backup uses the shortcut reserved for Settings".into());
    }
    Ok(binding)
}

fn decode_backup(bytes: &[u8]) -> Result<Backup, String> {
    let mut backup: Backup = serde_json::from_slice(bytes)
        .map_err(|error| format!("Could not read the Wayfinder backup: {error}"))?;
    if backup.format != FORMAT || backup.version != VERSION {
        return Err("This Wayfinder backup format or version is unsupported".into());
    }
    backup.workspaces.validate_backup()?;
    backup.workspaces.clear_previews();
    backup_binding(backup.palette_hotkey.as_deref())?;
    backup.appearance = backup.appearance.clamped();
    Ok(backup)
}

#[tauri::command]
pub(crate) async fn export_backup(app: AppHandle) -> Result<Option<String>, String> {
    let Some(path) = pick_backup(&app, true)? else {
        return Ok(None);
    };
    if !path
        .extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
    {
        return Err("Choose a .json filename for the backup".into());
    }
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    if path.file_name().is_some_and(|file| {
        SETTINGS_FILES
            .iter()
            .chain([&RESTORE_JOURNAL, &"shortcuts.json"])
            .any(|name| file.eq_ignore_ascii_case(name))
    }) && path
        .parent()
        .and_then(|parent| fs::canonicalize(parent).ok())
        == fs::canonicalize(&app_data).ok()
    {
        return Err("Choose a filename separate from Wayfinder’s settings files".into());
    }
    let backup = {
        let store = app.state::<Mutex<WorkspaceStore>>();
        let appearance = app.state::<Mutex<Appearance>>();
        let hotkey = app.state::<PaletteHotkey>();
        let store = store.lock().map_err(|error| error.to_string())?;
        let appearance = appearance.lock().map_err(|error| error.to_string())?;
        let hotkey = hotkey.0.lock().map_err(|error| error.to_string())?;
        Backup {
            format: FORMAT.into(),
            version: VERSION,
            workspaces: store.backup_copy(),
            appearance: appearance.clone(),
            palette_hotkey: hotkey.map(|binding| binding.to_string()),
        }
    };
    let bytes = serde_json::to_vec_pretty(&backup).map_err(|error| error.to_string())?;
    if bytes.len() as u64 > MAX_BACKUP_BYTES {
        return Err("The setup is too large for a Wayfinder backup".into());
    }
    atomic_write(&path, &bytes).map_err(|error| format!("Could not save the backup: {error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

#[tauri::command]
pub(crate) async fn preview_backup(app: AppHandle) -> Result<Option<BackupPreview>, String> {
    let Some(path) = pick_backup(&app, false)? else {
        return Ok(None);
    };
    let mut bytes = Vec::new();
    fs::File::open(path)
        .and_then(|file| file.take(MAX_BACKUP_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| format!("Could not open the backup: {error}"))?;
    if bytes.len() as u64 > MAX_BACKUP_BYTES {
        return Err("The backup file is too large".into());
    }
    let backup = decode_backup(&bytes)?;
    let token = next_shortcut_id()?;
    let preview = BackupPreview {
        token: token.clone(),
        workspaces: backup
            .workspaces
            .backup_summary()
            .map(|(name, tile_count, active)| BackupWorkspace {
                name: name.into(),
                tile_count,
                active,
            })
            .collect(),
        palette_hotkey: backup.palette_hotkey.clone(),
        theme_mode: backup.appearance.theme.mode.clone(),
        palette_size: backup.appearance.shell_size,
    };
    *app.state::<PendingBackup>()
        .0
        .lock()
        .map_err(|error| error.to_string())? = Some((token, backup));
    Ok(Some(preview))
}

#[tauri::command]
pub(crate) fn discard_backup(app: AppHandle, token: String) {
    if let Ok(mut pending) = app.state::<PendingBackup>().0.lock() {
        if pending.as_ref().is_some_and(|(id, _)| id == &token) {
            *pending = None;
        }
    }
}

#[tauri::command]
pub(crate) async fn restore_backup(app: AppHandle, token: String) -> Result<RestoreResult, String> {
    let pending = app.state::<PendingBackup>();
    let mut pending = pending.0.lock().map_err(|error| error.to_string())?;
    let (_, backup) = pending
        .as_ref()
        .filter(|(id, _)| id == &token)
        .ok_or("Choose the backup again before restoring")?;
    let next = backup_binding(backup.palette_hotkey.as_deref())?;
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let restored = {
        let store = app.state::<Mutex<WorkspaceStore>>();
        let appearance = app.state::<Mutex<Appearance>>();
        let hotkey = app.state::<PaletteHotkey>();
        let mut store = store.lock().map_err(|error| error.to_string())?;
        let mut appearance = appearance.lock().map_err(|error| error.to_string())?;
        let mut hotkey = hotkey.0.lock().map_err(|error| error.to_string())?;
        let workspace_json =
            serde_json::to_vec(&backup.workspaces).map_err(|error| error.to_string())?;
        let appearance_json =
            serde_json::to_vec(&backup.appearance).map_err(|error| error.to_string())?;
        let hotkey_text = next.map(|binding| binding.to_string());
        if *hotkey != next {
            replace_palette_binding(&app, *hotkey, next)
                .map_err(|error| format!("Could not restore the palette hotkey: {error}"))?;
        }
        let settings = [
            &workspace_json[..],
            &appearance_json[..],
            hotkey_text.as_deref().unwrap_or("").as_bytes(),
        ];
        if let Err(error) = write_restore(&directory, settings) {
            if *hotkey != next {
                if let Err(binding_error) = replace_palette_binding(&app, next, *hotkey) {
                    *hotkey = next;
                    return Err(format!("Could not restore the backup: {error}. Could not reinstate the previous hotkey: {binding_error}"));
                }
            }
            return Err(format!("Could not restore the backup: {error}"));
        }
        let (_, backup) = pending.take().expect("validated pending backup");
        *appearance = backup.appearance;
        *hotkey = next;
        RestoreResult {
            workspaces: store.replace_from_backup(backup.workspaces),
            appearance: appearance.clone(),
            palette_hotkey: hotkey_text,
        }
    };
    let _ = app.emit_to("main", "appearance-changed", &restored.appearance);
    let _ = app.emit_to("main", "backup-restored", ());
    Ok(restored)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn backup_json() -> serde_json::Value {
        serde_json::json!({
            "format": FORMAT,
            "version": VERSION,
            "workspaces": {
                "activeId": "work",
                "workspaces": [{
                    "id": "work", "name": "Work", "icon": "📁",
                    "shortcuts": [
                        {"id": "project", "path": "", "name": "Project", "kind": "submenu"},
                        {"id": "snippet", "parentId": "project", "path": "", "name": "Snippet", "kind": "text", "text": "Hello"},
                        {"id": "image", "path": "D:\\missing.png", "name": "Image", "kind": "image", "preview": "cached thumbnail"}
                    ]
                }]
            },
            "appearance": Appearance::default(),
            "paletteHotkey": "Ctrl+Space"
        })
    }

    #[test]
    fn backup_preserves_nested_tiles_and_paths_without_thumbnail_bytes() {
        let backup = decode_backup(&serde_json::to_vec(&backup_json()).unwrap()).unwrap();
        let summary: Vec<_> = backup.workspaces.backup_summary().collect();
        assert_eq!(summary, [("Work", 3, true)]);
        let shortcuts = backup.workspaces.shortcuts("work").unwrap();
        assert_eq!(shortcuts[1].parent_id.as_deref(), Some("project"));
        assert_eq!(shortcuts[1].text.as_deref(), Some("Hello"));
        assert_eq!(shortcuts[2].path, "D:\\missing.png");
        assert!(shortcuts[2].preview.is_none());
        let round_trip = serde_json::to_vec(&backup).unwrap();
        assert!(decode_backup(&round_trip).is_ok());
    }

    #[test]
    fn backup_rejects_unknown_versions_invalid_parents_and_reserved_hotkeys() {
        let mut data = backup_json();
        data["version"] = (VERSION + 1).into();
        assert!(decode_backup(&serde_json::to_vec(&data).unwrap()).is_err());
        data["version"] = VERSION.into();
        data["paletteHotkey"] = settings_hotkey().to_string().into();
        assert!(decode_backup(&serde_json::to_vec(&data).unwrap()).is_err());
        data["paletteHotkey"] = "Ctrl+Space".into();
        data["workspaces"]["workspaces"][0]["shortcuts"][1]["parentId"] = "missing".into();
        assert!(decode_backup(&serde_json::to_vec(&data).unwrap()).is_err());
    }

    #[test]
    fn restore_recovers_partial_writes_and_commits_complete_updates() {
        let dir =
            std::env::temp_dir().join(format!("wayfinder-restore-{}", next_shortcut_id().unwrap()));
        fs::create_dir(&dir).unwrap();
        let paths = SETTINGS_FILES.map(|name| dir.join(name));
        let journal_path = dir.join(RESTORE_JOURNAL);
        let journal: RestoreJournal = [
            Some(b"old workspaces".to_vec()),
            None,
            Some(b"old hotkey".to_vec()),
        ];
        atomic_write(&journal_path, &serde_json::to_vec(&journal).unwrap()).unwrap();
        atomic_write(&paths[0], b"new workspaces").unwrap();
        atomic_write(&paths[1], b"new appearance").unwrap();
        recover_interrupted_restore(&dir).unwrap();
        assert_eq!(fs::read(&paths[0]).unwrap(), b"old workspaces");
        assert!(!paths[1].exists());
        assert_eq!(fs::read(&paths[2]).unwrap(), b"old hotkey");
        assert!(!journal_path.exists());
        let updated: [&[u8]; 3] = [b"new workspaces", b"new appearance", b"new hotkey"];
        write_restore(&dir, updated).unwrap();
        assert!(!journal_path.exists());
        for (path, expected) in paths.into_iter().zip(updated) {
            assert_eq!(fs::read(&path).unwrap(), expected);
            fs::remove_file(path).unwrap();
        }
        fs::remove_dir(dir).unwrap();
    }
}
