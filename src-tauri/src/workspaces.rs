use crate::{next_shortcut_id, Shortcut};
use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager, State};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkspaceInfo {
    id: String,
    name: String,
    icon: String,
}

#[derive(Clone, Serialize, Deserialize)]
pub(crate) struct Workspace {
    #[serde(flatten)]
    info: WorkspaceInfo,
    shortcuts: Vec<Shortcut>,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceStore {
    active_id: String,
    workspaces: Vec<Workspace>,
    #[serde(skip)]
    revision: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WorkspaceList {
    revision: u64,
    active_id: String,
    workspaces: Vec<WorkspaceInfo>,
}

#[derive(Serialize)]
pub(crate) struct WorkspacePalette {
    #[serde(flatten)]
    list: WorkspaceList,
    shortcuts: Vec<Shortcut>,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub(crate) enum WorkspaceChange {
    Create {
        name: String,
        icon: String,
    },
    Update {
        id: String,
        name: String,
        icon: String,
    },
    Move {
        id: String,
        index: usize,
    },
    Delete {
        id: String,
    },
    Activate {
        id: String,
    },
}

fn workspace_info(id: String, name: String, icon: String) -> Result<WorkspaceInfo, String> {
    let name = name.trim();
    let icon = icon.trim();
    if name.is_empty() || name.chars().count() > 80 || name.chars().any(char::is_control) {
        return Err("Enter a workspace name of up to 80 characters".into());
    }
    if icon.len() > 128 || icon.chars().any(char::is_control) {
        return Err("Choose one emoji for the workspace icon".into());
    }
    Ok(WorkspaceInfo {
        id,
        name: name.into(),
        icon: if icon.is_empty() {
            "🗂️".into()
        } else {
            icon.into()
        },
    })
}

impl WorkspaceStore {
    pub(crate) fn load(dir: &Path) -> io::Result<Self> {
        match fs::read(dir.join("workspaces.json")) {
            Ok(contents) => {
                let store: Self = serde_json::from_slice(&contents)?;
                let ids: std::collections::HashSet<_> = store
                    .workspaces
                    .iter()
                    .map(|workspace| &workspace.info.id)
                    .collect();
                if !ids.contains(&store.active_id) || ids.len() != store.workspaces.len() {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        "Invalid workspace list",
                    ));
                }
                Ok(store)
            }
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                let shortcuts = match fs::read(dir.join("shortcuts.json")) {
                    Ok(contents) => serde_json::from_slice(&contents)?,
                    Err(error) if error.kind() == io::ErrorKind::NotFound => Vec::new(),
                    Err(error) => return Err(error),
                };
                let store = Self {
                    active_id: "default".into(),
                    workspaces: vec![Workspace {
                        info: WorkspaceInfo {
                            id: "default".into(),
                            name: "Default".into(),
                            icon: "🗂️".into(),
                        },
                        shortcuts,
                    }],
                    revision: 0,
                };
                fs::create_dir_all(dir)?;
                store.save(dir)?;
                Ok(store)
            }
            Err(error) => Err(error),
        }
    }

    fn save(&self, dir: &Path) -> io::Result<()> {
        let temporary = dir.join("workspaces.tmp");
        let file = fs::File::create(&temporary)?;
        let mut writer = io::BufWriter::new(file);
        serde_json::to_writer(&mut writer, self)?;
        io::Write::flush(&mut writer)?;
        writer.get_ref().sync_all()?;
        drop(writer);
        fs::rename(temporary, dir.join("workspaces.json"))
    }

    fn position(&self, id: &str) -> Result<usize, String> {
        self.workspaces
            .iter()
            .position(|workspace| workspace.info.id == id)
            .ok_or_else(|| "Workspace not found".into())
    }

    pub(crate) fn shortcuts(&self, id: &str) -> Result<&Vec<Shortcut>, String> {
        Ok(&self.workspaces[self.position(id)?].shortcuts)
    }

    pub(crate) fn edit_shortcuts(&self, id: &str) -> Result<&Vec<Shortcut>, String> {
        if self.active_id != id {
            return Err("The active workspace has changed".into());
        }
        self.shortcuts(id)
    }

    pub(crate) fn save_shortcuts(
        &mut self,
        app: &AppHandle,
        id: &str,
        shortcuts: Vec<Shortcut>,
    ) -> Result<(), String> {
        let dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let index = self.position(id)?;
        let previous = std::mem::replace(&mut self.workspaces[index].shortcuts, shortcuts);
        if let Err(error) = self.save(&dir) {
            self.workspaces[index].shortcuts = previous;
            return Err(error.to_string());
        }
        self.revision += 1;
        let _ = app.emit_to("main", "shortcuts-changed", ());
        Ok(())
    }

    fn list(&self) -> WorkspaceList {
        WorkspaceList {
            revision: self.revision,
            active_id: self.active_id.clone(),
            workspaces: self
                .workspaces
                .iter()
                .map(|workspace| workspace.info.clone())
                .collect(),
        }
    }

    fn apply(&mut self, change: WorkspaceChange) -> Result<(), String> {
        match change {
            WorkspaceChange::Create { name, icon } => {
                let info = workspace_info(next_shortcut_id()?, name, icon)?;
                self.active_id.clone_from(&info.id);
                self.workspaces.push(Workspace {
                    info,
                    shortcuts: Vec::new(),
                });
            }
            WorkspaceChange::Update { id, name, icon } => {
                let index = self.position(&id)?;
                self.workspaces[index].info = workspace_info(id, name, icon)?;
            }
            WorkspaceChange::Move { id, index } => {
                let position = self.position(&id)?;
                if index >= self.workspaces.len() {
                    return Err("Invalid workspace position".into());
                }
                let workspace = self.workspaces.remove(position);
                self.workspaces.insert(index, workspace);
            }
            WorkspaceChange::Delete { id } => {
                let position = self.position(&id)?;
                if self.workspaces.len() == 1 {
                    return Err("Keep at least one workspace".into());
                }
                self.workspaces.remove(position);
                if self.active_id == id {
                    self.active_id.clone_from(
                        &self.workspaces[position.min(self.workspaces.len() - 1)]
                            .info
                            .id,
                    );
                }
            }
            WorkspaceChange::Activate { id } => {
                self.position(&id)?;
                self.active_id = id;
            }
        }
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn get_workspaces(
    state: State<'_, Mutex<WorkspaceStore>>,
) -> Result<WorkspaceList, String> {
    Ok(state.lock().map_err(|error| error.to_string())?.list())
}

#[tauri::command]
pub(crate) fn get_workspace_palette(
    state: State<'_, Mutex<WorkspaceStore>>,
) -> Result<WorkspacePalette, String> {
    let store = state.lock().map_err(|error| error.to_string())?;
    Ok(WorkspacePalette {
        list: store.list(),
        shortcuts: store.shortcuts(&store.active_id)?.clone(),
    })
}

#[tauri::command]
pub(crate) fn get_workspace_search(
    state: State<'_, Mutex<WorkspaceStore>>,
) -> Result<Vec<Workspace>, String> {
    let store = state.lock().map_err(|error| error.to_string())?;
    Ok(store.workspaces.clone())
}

#[tauri::command]
pub(crate) fn get_workspace_preview(
    state: State<'_, Mutex<WorkspaceStore>>,
    workspace_id: String,
) -> Result<Vec<Shortcut>, String> {
    let store = state.lock().map_err(|error| error.to_string())?;
    Ok(store
        .shortcuts(&workspace_id)?
        .iter()
        .filter(|shortcut| shortcut.parent_id.is_none())
        .cloned()
        .collect())
}

#[tauri::command]
pub(crate) fn change_workspace(
    app: AppHandle,
    state: State<'_, Mutex<WorkspaceStore>>,
    change: WorkspaceChange,
) -> Result<WorkspaceList, String> {
    let mut store = state.lock().map_err(|error| error.to_string())?;
    if matches!(&change, WorkspaceChange::Activate { id } if *id == store.active_id) {
        return Ok(store.list());
    }
    let mut updated = store.clone();
    updated.apply(change)?;
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    updated.save(&dir).map_err(|error| error.to_string())?;
    updated.revision += 1;
    *store = updated;
    let _ = app.emit_to("main", "workspaces-changed", ());
    let _ = app.emit_to("editor", "workspaces-changed", ());
    Ok(store.list())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_nested_shortcuts_and_restores_workspace_order_and_selection() {
        let dir = std::env::temp_dir().join(format!(
            "wayfinder-workspaces-{}-{}",
            std::process::id(),
            next_shortcut_id().unwrap()
        ));
        fs::create_dir(&dir).unwrap();
        let legacy = r#"[
          {"id":"parent","path":"","name":"Projects","kind":"submenu","preview":null},
          {"id":"child","path":"","name":"Snippet","kind":"text","preview":null,"parentId":"parent","text":"Example"}
        ]"#;
        fs::write(dir.join("shortcuts.json"), legacy).unwrap();

        let mut store = WorkspaceStore::load(&dir).unwrap();
        assert_eq!(store.active_id, "default");
        assert_eq!(
            store.shortcuts("default").unwrap()[1].parent_id.as_deref(),
            Some("parent")
        );
        store
            .apply(WorkspaceChange::Create {
                name: "Editing".into(),
                icon: "🎬".into(),
            })
            .unwrap();
        let editing = store.active_id.clone();
        assert!(store.edit_shortcuts(&editing).unwrap().is_empty());
        assert!(store.edit_shortcuts("default").is_err());
        store
            .apply(WorkspaceChange::Move {
                id: editing.clone(),
                index: 0,
            })
            .unwrap();
        store.save(&dir).unwrap();

        let mut restored = WorkspaceStore::load(&dir).unwrap();
        assert_eq!(restored.active_id, editing);
        assert_eq!(restored.list().workspaces[0].icon, "🎬");
        assert_eq!(restored.shortcuts("default").unwrap().len(), 2);
        restored
            .apply(WorkspaceChange::Delete { id: editing })
            .unwrap();
        assert_eq!(restored.active_id, "default");
        assert!(restored
            .apply(WorkspaceChange::Delete {
                id: "default".into()
            })
            .is_err());
        assert_eq!(
            fs::read_to_string(dir.join("shortcuts.json")).unwrap(),
            legacy
        );

        fs::remove_file(dir.join("workspaces.json")).unwrap();
        fs::remove_file(dir.join("shortcuts.json")).unwrap();
        fs::remove_dir(dir).unwrap();
    }
}
