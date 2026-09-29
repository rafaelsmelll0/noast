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

/// Acima disto o log atual vira `noast.1.log` (substituindo o anterior): o
/// heartbeat do scheduler sozinho grava ~144 linhas por dia.
const LOG_ROTATE_BYTES: u64 = 2 * 1024 * 1024;

pub fn append_log(path: &Path, message: &str) {
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    if fs::metadata(path).is_ok_and(|meta| meta.len() > LOG_ROTATE_BYTES) {
        let _ = fs::rename(path, path.with_extension("1.log"));
    }
    // Uma única escrita por linha: se o processo morrer no meio (desligamento),
    // não sobra linha pela metade colada na próxima.
    let line = format!(
        "[{}] {}\n",
        chrono::Local::now().format("%Y-%m-%d %H:%M:%S%.3f"),
        message
    );
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = file.write_all(line.as_bytes());
    }
}

/// Por que uma leitura falhou — decide se é seguro seguir com dados vazios.
#[derive(Debug)]
pub enum LoadError {
    /// Nenhuma cópia pôde ser interpretada; o arquivo ruim foi preservado à
    /// parte. Seguir vazio é seguro: gravar não destrói nada recuperável.
    Corrupt(String),
    /// O disco não deixou ler (antivírus, OneDrive, permissão) ou o conteúdo
    /// não pôde ser tirado do caminho. Gravar agora sobrescreveria dados que
    /// provavelmente estão bons.
    Unreadable(String),
}

impl LoadError {
    pub fn message(&self) -> &str {
        match self {
            LoadError::Corrupt(message) | LoadError::Unreadable(message) => message,
        }
    }
}

/// Resultado de uma leitura. `read_only` vem preenchido quando o conteúdo
/// veio de uma cópia de segurança porque o principal não pôde ser lido: ele
/// provavelmente é mais novo, então nada pode ser gravado por cima dele.
pub struct Loaded<T> {
    pub value: T,
    pub read_only: Option<String>,
}

impl<T: Default> Loaded<T> {
    fn or_default(loaded: Option<Loaded<T>>) -> Loaded<T> {
        loaded.unwrap_or(Loaded {
            value: T::default(),
            read_only: None,
        })
    }
}

pub fn load_notifications(path: &Path, log: &Path) -> Result<Loaded<Vec<Notification>>, LoadError> {
    Ok(Loaded::or_default(load_recovering(
        path,
        log,
        decode_json,
        true,
    )?))
}

pub fn save_notifications(path: &Path, notifications: &[Notification]) -> Result<(), String> {
    save_json_atomic(path, notifications)
}

pub fn load_notes(path: &Path, log: &Path) -> Result<Loaded<Vec<Note>>, LoadError> {
    Ok(Loaded::or_default(load_recovering(
        path,
        log,
        decode_json,
        true,
    )?))
}

pub fn save_notes(path: &Path, notes: &[Note]) -> Result<(), String> {
    save_json_atomic(path, notes)
}

pub fn load_settings(path: &Path, log: &Path) -> Result<Loaded<Settings>, LoadError> {
    Ok(Loaded::or_default(load_recovering(
        path,
        log,
        decode_json,
        true,
    )?))
}

pub fn save_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    save_json_atomic(path, settings)
}

/// Lê um arquivo protegido (cofre) com a mesma recuperação dos JSON, mas sem
/// mover o original para `.corrupt`: uma falha da DPAPI (senha do Windows
/// redefinida, perfil migrado) não significa arquivo estragado.
pub fn load_protected<T>(
    path: &Path,
    log: &Path,
    decode: impl Fn(&[u8]) -> Result<T, String>,
) -> Result<Option<Loaded<T>>, LoadError> {
    load_recovering(path, log, decode, false)
}

pub fn save_protected_bytes(path: &Path, value: &[u8]) -> Result<(), String> {
    save_bytes_atomic(path, value)
}

fn decode_json<T: DeserializeOwned>(bytes: &[u8]) -> Result<T, String> {
    // Bloco de Notas antigo e PowerShell 5.1 gravam UTF-8 com BOM, que o
    // serde_json recusa ("expected value at line 1 column 1").
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    serde_json::from_slice(bytes).map_err(|error| error.to_string())
}

/// Carrega `path` tentando, nesta ordem: o arquivo principal; se ele sumiu, o
/// `.tmp` (gravação interrompida entre os renames nas versões até 0.8.0, em que
/// o `.tmp` já estava completo); e o `.bak`. `Ok(None)` só quando não existe
/// nada — instalação nova.
fn load_recovering<T>(
    path: &Path,
    log: &Path,
    decode: impl Fn(&[u8]) -> Result<T, String>,
    preserve_corrupt: bool,
) -> Result<Option<Loaded<T>>, LoadError> {
    let mut problems = Vec::new();
    // Primeira falha de LEITURA (não de interpretação) em qualquer cópia: com
    // ela, "nada aproveitável" não significa "nada existe".
    let mut io_trouble: Option<String> = None;
    let mut primary_unreadable = false;
    let primary_present = match read_with_retry(path) {
        Ok(Some(bytes)) => match decode(&bytes) {
            Ok(value) => {
                return Ok(Some(Loaded {
                    value,
                    read_only: None,
                }))
            }
            Err(error) => {
                problems.push(format!("{}: {error}", path.display()));
                true
            }
        },
        Ok(None) => false,
        Err(error) => {
            io_trouble = Some(format!("Falha ao ler {}: {error}", path.display()));
            primary_unreadable = true;
            true
        }
    };

    let mut candidates = Vec::new();
    if !primary_present {
        candidates.push(temporary_path(path));
    }
    candidates.push(backup_path(path));

    for candidate in candidates {
        match read_with_retry(&candidate) {
            Ok(Some(bytes)) => match decode(&bytes) {
                Ok(value) => {
                    append_log(
                        log,
                        &format!("{} recuperado de {}.", path.display(), candidate.display()),
                    );
                    if primary_unreadable {
                        // O principal (provavelmente mais novo) continua lá:
                        // mostra a cópia, mas não grava por cima dele.
                        return Ok(Some(Loaded {
                            value,
                            read_only: io_trouble,
                        }));
                    }
                    restore_primary(path, &candidate, primary_present, log);
                    return Ok(Some(Loaded {
                        value,
                        read_only: None,
                    }));
                }
                // Um .tmp que não decodifica é só o resto de uma gravação
                // interrompida no meio: ignorado, não conta como problema (senão
                // um cofre novo ficaria bloqueado para sempre por ele).
                Err(_) if candidate == temporary_path(path) => {}
                Err(error) => problems.push(format!("{}: {error}", candidate.display())),
            },
            Ok(None) => {}
            Err(error) => {
                let message = format!("Falha ao ler {}: {error}", candidate.display());
                io_trouble.get_or_insert_with(|| message.clone());
                problems.push(message);
            }
        }
    }

    if let Some(message) = io_trouble {
        return Err(LoadError::Unreadable(message));
    }
    if problems.is_empty() {
        return Ok(None);
    }
    let mut message = format!("Falha ao interpretar {}", problems.join("; "));
    if preserve_corrupt && primary_present {
        let corrupt = corrupt_path(path);
        if let Err(error) = fs::rename(path, &corrupt) {
            // Sem conseguir tirá-lo do caminho, gravar por cima o perderia.
            return Err(LoadError::Unreadable(format!(
                "{message}. Também não foi possível preservar o arquivo: {error}"
            )));
        }
        message.push_str(&format!(
            ". O arquivo foi preservado em {}.",
            corrupt.display()
        ));
    } else if !preserve_corrupt {
        return Err(LoadError::Unreadable(message));
    } else {
        let backup = backup_path(path);
        let corrupt = corrupt_path(&backup);
        if backup.exists() && fs::rename(&backup, &corrupt).is_ok() {
            message.push_str(&format!(
                ". O backup foi preservado em {}.",
                corrupt.display()
            ));
        }
    }
    Err(LoadError::Corrupt(message))
}

/// Recoloca a cópia boa como arquivo principal já na abertura. Sem isto, a
/// próxima gravação copiaria o principal estragado por cima do `.bak` bom.
fn restore_primary(path: &Path, source: &Path, primary_present: bool, log: &Path) {
    // No cofre (`preserve_corrupt` falso) o .bak ter decodificado prova que a
    // DPAPI funciona: o principal está mesmo estragado e deve sair do caminho,
    // senão a próxima gravação o copiaria por cima do .bak bom.
    if primary_present {
        let corrupt = corrupt_path(path);
        if let Err(error) = fs::rename(path, &corrupt) {
            append_log(
                log,
                &format!("Não foi possível preservar {}: {error}", path.display()),
            );
            return;
        }
        append_log(
            log,
            &format!("Arquivo ilegível preservado em {}.", corrupt.display()),
        );
    }
    if let Err(error) = fs::copy(source, path) {
        append_log(
            log,
            &format!("Não foi possível restaurar {}: {error}", path.display()),
        );
    }
}

/// Antivírus, indexador e OneDrive às vezes seguram o arquivo por instantes:
/// uma falha isolada de leitura não pode virar "arquivo vazio".
fn read_with_retry(path: &Path) -> std::io::Result<Option<Vec<u8>>> {
    retry_io(|| match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error),
    })
}

fn retry_io<T>(mut operation: impl FnMut() -> std::io::Result<T>) -> std::io::Result<T> {
    const ATTEMPTS: u64 = 5;
    let mut attempt = 1;
    loop {
        match operation() {
            Ok(value) => return Ok(value),
            Err(error) if attempt >= ATTEMPTS => return Err(error),
            Err(_) => {
                std::thread::sleep(std::time::Duration::from_millis(100 * attempt));
                attempt += 1;
            }
        }
    }
}

fn save_json_atomic<T: Serialize + ?Sized>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_vec_pretty(value)
        .map_err(|error| format!("Falha ao serializar dados: {error}"))?;
    save_bytes_atomic(path, &json)
}

/// Grava sem nunca deixar o arquivo principal ausente: a versão atual é
/// COPIADA para `.bak` (o principal continua no lugar) e o `.tmp` completo e
/// sincronizado substitui o principal num único rename, que no Windows troca o
/// destino de uma vez. Um desligamento em qualquer ponto deixa o principal
/// antigo ou o novo — nunca nenhum.
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

    if path.exists() {
        retry_io(|| fs::copy(path, &backup))
            .map_err(|error| format!("Falha ao criar backup de {}: {error}", path.display()))?;
    }

    retry_io(|| fs::rename(&temporary, path))
        .map_err(|error| format!("Falha ao finalizar gravação de {}: {error}", path.display()))
}

fn temporary_path(path: &Path) -> PathBuf {
    path.with_extension("tmp")
}

fn backup_path(path: &Path) -> PathBuf {
    path.with_extension("bak")
}

fn corrupt_path(path: &Path) -> PathBuf {
    let timestamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("json");
    path.with_extension(format!("corrupt-{timestamp}.{extension}"))
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

    /// Diretório próprio por teste: cada um cria principal, .bak, .tmp e
    /// .corrupt, e tudo some junto no fim.
    struct Sandbox(PathBuf);

    impl Sandbox {
        fn new(name: &str) -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock")
                .as_nanos();
            let dir = std::env::temp_dir().join(format!("noast-{name}-{nonce}"));
            fs::create_dir_all(&dir).expect("sandbox");
            Sandbox(dir)
        }

        fn data(&self) -> PathBuf {
            self.0.join("data.json")
        }

        fn log(&self) -> PathBuf {
            self.0.join("noast.log")
        }

        fn files(&self) -> Vec<String> {
            let mut names: Vec<String> = fs::read_dir(&self.0)
                .expect("list")
                .map(|entry| {
                    entry
                        .expect("entry")
                        .file_name()
                        .to_string_lossy()
                        .into_owned()
                })
                .collect();
            names.sort();
            names
        }
    }

    impl Drop for Sandbox {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn example(value: &str) -> Example {
        Example {
            value: value.into(),
        }
    }

    fn write_json(path: &Path, value: &str) {
        fs::write(path, serde_json::to_vec(&example(value)).expect("json")).expect("write");
    }

    fn load(sandbox: &Sandbox) -> Result<Option<Example>, LoadError> {
        load_recovering(&sandbox.data(), &sandbox.log(), decode_json, true)
            .map(|loaded| loaded.map(|loaded| loaded.value))
    }

    /// Abre `path` sem compartilhamento, como um antivírus segurando o
    /// arquivo; a leitura falha com violação de compartilhamento.
    #[cfg(windows)]
    fn hold_exclusively(path: &Path) -> File {
        use std::os::windows::fs::OpenOptionsExt;
        OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(path)
            .expect("exclusive open")
    }

    #[test]
    fn atomic_save_keeps_previous_version_as_backup() {
        let sandbox = Sandbox::new("atomic");
        let path = sandbox.data();
        save_json_atomic(&path, &example("one")).expect("first save");
        save_json_atomic(&path, &example("two")).expect("second save");

        let current: Example = decode_json(&fs::read(&path).expect("current")).expect("json");
        let backup: Example =
            decode_json(&fs::read(backup_path(&path)).expect("backup")).expect("json");
        assert_eq!(current.value, "two");
        assert_eq!(backup.value, "one");
        assert!(!temporary_path(&path).exists());
    }

    #[test]
    fn invalid_primary_recovers_from_backup_and_restores_it() {
        let sandbox = Sandbox::new("recovery");
        let path = sandbox.data();
        fs::write(&path, "{broken").expect("invalid primary");
        write_json(&backup_path(&path), "safe");

        let loaded = load(&sandbox).expect("recovery").expect("value");
        assert_eq!(loaded.value, "safe");
        // O principal volta a ser a cópia boa e o estragado fica à parte, para
        // a próxima gravação não copiar lixo por cima do .bak.
        let restored: Example = decode_json(&fs::read(&path).expect("primary")).expect("json");
        assert_eq!(restored.value, "safe");
        assert!(sandbox
            .files()
            .iter()
            .any(|name| name.contains(".corrupt-")));
    }

    /// Estado deixado por uma queda de energia entre os dois renames da
    /// gravação antiga: sem principal, com .bak e .tmp. Antes o app abria
    /// vazio e a gravação seguinte apagava o .bak.
    #[test]
    fn missing_primary_recovers_from_interrupted_save() {
        let sandbox = Sandbox::new("interrupted");
        let path = sandbox.data();
        write_json(&backup_path(&path), "older");
        write_json(&temporary_path(&path), "newest");

        let loaded = load(&sandbox).expect("recovery").expect("value");
        assert_eq!(loaded.value, "newest");
        assert!(path.exists());
    }

    #[test]
    fn missing_primary_falls_back_to_backup_when_tmp_is_partial() {
        let sandbox = Sandbox::new("partial-tmp");
        let path = sandbox.data();
        write_json(&backup_path(&path), "older");
        fs::write(temporary_path(&path), "{\"value\": \"tru").expect("partial tmp");

        let loaded = load(&sandbox).expect("recovery").expect("value");
        assert_eq!(loaded.value, "older");
    }

    #[test]
    fn nothing_on_disk_is_a_fresh_install() {
        let sandbox = Sandbox::new("fresh");
        assert!(load(&sandbox).expect("fresh").is_none());
    }

    #[test]
    fn utf8_bom_is_accepted() {
        let sandbox = Sandbox::new("bom");
        let mut bytes = b"\xEF\xBB\xBF".to_vec();
        bytes.extend(serde_json::to_vec(&example("with-bom")).expect("json"));
        fs::write(sandbox.data(), bytes).expect("write");

        let loaded = load(&sandbox).expect("bom").expect("value");
        assert_eq!(loaded.value, "with-bom");
    }

    #[test]
    fn unrecoverable_file_is_preserved_and_reported_as_corrupt() {
        let sandbox = Sandbox::new("corrupt");
        fs::write(sandbox.data(), "{broken").expect("invalid primary");

        let error = load(&sandbox).expect_err("corrupt");
        assert!(matches!(error, LoadError::Corrupt(_)));
        assert!(!sandbox.data().exists());
        assert!(sandbox
            .files()
            .iter()
            .any(|name| name.contains(".corrupt-")));
    }

    #[test]
    fn protected_files_are_never_moved_aside() {
        let sandbox = Sandbox::new("protected");
        fs::write(sandbox.data(), "cannot decrypt").expect("primary");

        let result = load_recovering(
            &sandbox.data(),
            &sandbox.log(),
            decode_json::<Example>,
            false,
        );
        assert!(matches!(result, Err(LoadError::Unreadable(_))));
        assert!(sandbox.data().exists());
    }

    /// Principal travado e .bak legível: mostra o .bak (uma gravação atrás),
    /// mas bloqueia a gravação — senão a versão mais nova no principal seria
    /// copiada para .bak e sobrescrita, e perdida na gravação seguinte.
    #[cfg(windows)]
    #[test]
    fn locked_primary_loads_backup_read_only() {
        let sandbox = Sandbox::new("locked-primary");
        write_json(&sandbox.data(), "newest");
        write_json(&backup_path(&sandbox.data()), "older");
        let _guard = hold_exclusively(&sandbox.data());

        let loaded = load_recovering(
            &sandbox.data(),
            &sandbox.log(),
            decode_json::<Example>,
            true,
        )
        .expect("fallback")
        .expect("value");
        assert_eq!(loaded.value.value, "older");
        assert!(loaded.read_only.is_some());
    }

    /// Principal ausente e .bak travado não é "arquivo corrompido": abrir
    /// vazio com gravação liberada apagaria o .bak bom duas gravações depois.
    #[cfg(windows)]
    #[test]
    fn locked_backup_is_unreadable_not_corrupt() {
        let sandbox = Sandbox::new("locked-backup");
        write_json(&backup_path(&sandbox.data()), "only-copy");
        let _guard = hold_exclusively(&backup_path(&sandbox.data()));

        assert!(matches!(load(&sandbox), Err(LoadError::Unreadable(_))));
    }

    #[test]
    fn partial_tmp_alone_is_a_fresh_start() {
        let sandbox = Sandbox::new("tmp-alone");
        fs::write(temporary_path(&sandbox.data()), "{\"value\": \"tru").expect("partial tmp");

        assert!(load(&sandbox).expect("fresh").is_none());
        let protected = load_recovering(
            &sandbox.data(),
            &sandbox.log(),
            decode_json::<Example>,
            false,
        )
        .expect("fresh vault");
        assert!(protected.is_none());
    }

    #[test]
    fn protected_primary_is_restored_from_backup() {
        let sandbox = Sandbox::new("protected-restore");
        fs::write(sandbox.data(), "{broken").expect("primary");
        write_json(&backup_path(&sandbox.data()), "safe");

        let loaded = load_recovering(
            &sandbox.data(),
            &sandbox.log(),
            decode_json::<Example>,
            false,
        )
        .expect("recovery")
        .expect("value");
        assert_eq!(loaded.value.value, "safe");
        let restored: Example =
            decode_json(&fs::read(sandbox.data()).expect("primary")).expect("json");
        assert_eq!(restored.value, "safe");
    }
}
