use serde::{de::DeserializeOwned, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

use crate::model::{Note, Notification, Settings};

pub fn notifications_path(app: &AppHandle) -> PathBuf {
    #[cfg(debug_assertions)]
    {
        let _ = app;
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .unwrap_or_else(|| Path::new("."))
            .join("noast_data.json")
    }
    #[cfg(not(debug_assertions))]
    {
        data_dir(app).join("noast_data.json")
    }
}

pub fn settings_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("settings.json")
}

pub fn notes_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("notes.json")
}

pub fn vault_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("vault.dat")
}

pub fn log_path(app: &AppHandle) -> PathBuf {
    data_dir(app).join("noast.log")
}

fn data_dir(app: &AppHandle) -> PathBuf {
    let base = app
        .path()
        .app_local_data_dir()
        .unwrap_or_else(|_| PathBuf::from("."));
    let _ = fs::create_dir_all(&base);
    base
}

pub fn append_log(path: &Path, message: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(
            file,
            "[{}] {}",
            chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
            message
        );
    }
}

pub fn load_notifications(path: &Path) -> Result<Vec<Notification>, String> {
    load_json_with_backup(path, Vec::new)
}

pub fn save_notifications(path: &Path, notifications: &[Notification]) -> Result<(), String> {
    save_json_atomic(path, notifications)
}

pub fn load_notes(path: &Path) -> Result<Vec<Note>, String> {
    load_json_with_backup(path, Vec::new)
}

pub fn save_notes(path: &Path, notes: &[Note]) -> Result<(), String> {
    save_json_atomic(path, notes)
}

pub fn load_settings(path: &Path) -> Result<Settings, String> {
    load_json_with_backup(path, Settings::default)
}

pub fn save_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    save_json_atomic(path, settings)
}

pub fn load_protected_bytes(path: &Path) -> Result<Option<Vec<u8>>, String> {
    if !path.exists() {
        return Ok(None);
    }

    match fs::read(path) {
        Ok(value) => Ok(Some(value)),
        Err(primary_error) => {
            let backup = backup_path(path);
            if backup.exists() {
                if let Ok(value) = fs::read(&backup) {
                    return Ok(Some(value));
                }
            }
            Err(format!("Falha ao ler {}: {primary_error}", path.display()))
        }
    }
}

pub fn load_protected_backup(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let backup = backup_path(path);
    if !backup.exists() {
        return Ok(None);
    }
    fs::read(&backup)
        .map(Some)
        .map_err(|error| format!("Falha ao ler o backup {}: {error}", backup.display()))
}

pub fn save_protected_bytes(path: &Path, value: &[u8]) -> Result<(), String> {
    save_bytes_atomic(path, value)
}

fn load_json_with_backup<T, F>(path: &Path, default: F) -> Result<T, String>
where
    T: DeserializeOwned,
    F: FnOnce() -> T,
{
    if !path.exists() {
        return Ok(default());
    }

    match read_json(path) {
        Ok(value) => Ok(value),
        Err(primary_error) => {
            let backup = backup_path(path);
            if backup.exists() {
                if let Ok(value) = read_json(&backup) {
                    return Ok(value);
                }
            }

            let corrupt = corrupt_path(path);
            fs::rename(path, &corrupt).map_err(|rename_error| {
                format!(
                    "{primary_error} Também não foi possível preservar o arquivo corrompido: {rename_error}"
                )
            })?;
            Err(format!(
                "{primary_error} O arquivo foi preservado em {}.",
                corrupt.display()
            ))
        }
    }
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Falha ao ler {}: {error}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Falha ao interpretar {}: {error}", path.display()))
}

fn save_json_atomic<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Falha ao criar {}: {error}", parent.display()))?;
    }

    let json = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Falha ao serializar dados: {error}"))?;
    save_bytes_atomic(path, &json)
}

fn save_bytes_atomic(path: &Path, value: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Falha ao criar {}: {error}", parent.display()))?;
    }

    let temporary = temporary_path(path);
    let backup = backup_path(path);

    {
        let mut file = File::create(&temporary)
            .map_err(|error| format!("Falha ao criar {}: {error}", temporary.display()))?;
        file.write_all(value)
            .map_err(|error| format!("Falha ao escrever {}: {error}", temporary.display()))?;
        file.sync_all()
            .map_err(|error| format!("Falha ao sincronizar {}: {error}", temporary.display()))?;
    }

    if backup.exists() {
        fs::remove_file(&backup)
            .map_err(|error| format!("Falha ao remover backup antigo: {error}"))?;
    }

    if path.exists() {
        fs::rename(path, &backup)
            .map_err(|error| format!("Falha ao criar backup de {}: {error}", path.display()))?;
    }

    if let Err(error) = fs::rename(&temporary, path) {
        if backup.exists() {
            let _ = fs::rename(&backup, path);
        }
        return Err(format!(
            "Falha ao finalizar gravação de {}: {error}",
            path.display()
        ));
    }

    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    path.with_extension("tmp")
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("bak")
}

fn corrupt_path(path: &Path) -> PathBuf {
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    path.with_extension(format!("corrupt-{timestamp}.json"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};
    use std::time::{SystemTime, UNIX_EPOCH};

    #[derive(Debug, PartialEq, Serialize, Deserialize)]
    struct Example {
        value: String,
    }

    fn temp_file(name: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        std::env::temp_dir().join(format!("noast-{name}-{nonce}.json"))
    }

    #[test]
    fn atomic_save_keeps_previous_version_as_backup() {
        let path = temp_file("atomic");
        save_json_atomic(
            &path,
            &Example {
                value: "one".into(),
            },
        )
        .expect("first save");
        save_json_atomic(
            &path,
            &Example {
                value: "two".into(),
            },
        )
        .expect("second save");

        let current: Example = read_json(&path).expect("current");
        let backup: Example = read_json(&backup_path(&path)).expect("backup");
        assert_eq!(current.value, "two");
        assert_eq!(backup.value, "one");

        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(backup_path(&path));
    }

    #[test]
    fn invalid_primary_recovers_from_backup() {
        let path = temp_file("recovery");
        fs::write(&path, "{broken").expect("invalid primary");
        fs::write(
            backup_path(&path),
            serde_json::to_vec(&Example {
                value: "safe".into(),
            })
            .expect("json"),
        )
        .expect("backup");

        let loaded: Example = load_json_with_backup(&path, || Example {
            value: "default".into(),
        })
        .expect("recovery");
        assert_eq!(loaded.value, "safe");

        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(backup_path(&path));
    }
}
