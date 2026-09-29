mod clipboard;
mod model;
mod repository;
mod scheduler;
mod vault;

use chrono::{Local, NaiveDateTime};
use model::{
    AlertMonitor, Note, Notification, Settings, TrayClickAction, Vault, VaultAccess,
    VaultAccessSummary, VaultCatalog, VaultClient,
};
use repository::{
    append_log, load_notes, load_notifications, load_settings, log_path, notes_path,
    notifications_path, save_notes, save_notifications, save_settings, settings_path, vault_path,
    LoadError,
};
use scheduler::{
    advance_after, is_due, occurrence_key, reschedule_to, snooze, snooze_until_tomorrow,
};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
#[cfg(not(debug_assertions))]
use tauri_plugin_autostart::ManagerExt;

#[derive(Clone)]
struct NotificationState(Arc<Mutex<Vec<Notification>>>);

#[derive(Clone)]
struct NoteState(Arc<Mutex<Vec<Note>>>);

#[derive(Clone)]
struct VaultState(Arc<Mutex<Vault>>);

#[derive(Clone)]
struct PendingState(Arc<Mutex<Vec<Notification>>>);

#[derive(Clone)]
struct SettingsState(Arc<Mutex<Settings>>);

#[derive(Clone)]
struct SnoozeMenuState(Arc<Mutex<SnoozeMenuSession>>);

#[derive(Default)]
struct SnoozeMenuSession {
    target_id: Option<String>,
    visible: bool,
    opened_at: Option<Instant>,
}

#[derive(serde::Deserialize)]
struct SnoozeMenuAnchor {
    x: f64,
    top: f64,
    bottom: f64,
    width: f64,
}

struct CustomSnoozeState(Arc<Mutex<CustomSnoozeSession>>);

#[derive(Default)]
struct CustomSnoozeSession {
    target_id: Option<String>,
    visible: bool,
    opened_at: Option<Instant>,
}

/// Um submenu esquecido aberto não pode desligar para sempre o watchdog do
/// toast: passado este tempo, o toast volta a ser resgatado mesmo assim.
const SUBMENU_GRACE: Duration = Duration::from_secs(120);

/// A bandeja pediu "Novo lembrete" enquanto a janela principal ainda estava
/// sendo criada: o evento emitido nessa hora se perde (o webview não carregou),
/// então o frontend consulta este pedido ao terminar de abrir.
#[derive(Default)]
struct NewReminderRequest(AtomicBool);

/// Versão nova detectada pelo check automático, para a janela principal
/// mostrar o aviso mesmo que o evento tenha sido emitido com ela fechada.
#[derive(Default)]
struct AvailableUpdate(Mutex<Option<String>>);

/// Número de sequência da última cópia de segredo ainda não limpa, para
/// limpar também ao encerrar o app antes dos 30 s.
#[derive(Default)]
struct PendingSecret(Mutex<Option<u32>>);

/// Limpa a área de transferência se ela ainda contém o último segredo copiado.
/// Chamado ao encerrar e no fim do prazo de `copy_secret`.
fn clear_pending_secret(app: &AppHandle) {
    let Some(sequence) = app
        .try_state::<PendingSecret>()
        .and_then(|state| state.0.lock().ok().and_then(|mut value| value.take()))
    else {
        return;
    };
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    match clipboard::clear_if_unchanged(&window, sequence) {
        Ok(true) => log(app, "Área de transferência limpa (segredo do cofre)."),
        Ok(false) => {}
        Err(error) => log(
            app,
            &format!("Falha ao limpar a área de transferência: {error}"),
        ),
    }
}

/// Motivo pelo qual um arquivo não pode ser gravado nesta sessão. Preenchido
/// quando a leitura na abertura falhou de um jeito em que gravar por cima
/// destruiria dados que provavelmente estão bons (disco ilegível, DPAPI).
#[derive(Default)]
struct StoreHealth {
    notifications: Mutex<Option<String>>,
    notes: Mutex<Option<String>>,
    settings: Mutex<Option<String>>,
    vault: Mutex<Option<String>>,
    /// Avisos da abertura para a janela principal mostrar.
    notices: Mutex<Vec<String>>,
}

fn ensure_writable(slot: &Mutex<Option<String>>, what: &str) -> Result<(), String> {
    match lock(slot, what)?.as_ref() {
        Some(reason) => Err(format!(
            "{what} não puderam ser lidos ao abrir o Noast, então nada será gravado por cima \
             deles. Reinicie o Noast. Detalhe: {reason}"
        )),
        None => Ok(()),
    }
}

#[derive(Clone)]
struct Paths {
    notifications: PathBuf,
    notes: PathBuf,
    vault: PathBuf,
    settings: PathBuf,
    log: PathBuf,
    health: Arc<StoreHealth>,
}

fn lock<'a, T>(mutex: &'a Mutex<T>, name: &str) -> Result<MutexGuard<'a, T>, String> {
    mutex
        .lock()
        .map_err(|_| format!("O estado interno de {name} ficou indisponível."))
}

fn log(app: &AppHandle, message: &str) {
    if let Some(paths) = app.try_state::<Paths>() {
        append_log(&paths.log, message);
    } else {
        append_log(&log_path(app), message);
    }
}

fn emit_main_changed(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        if let Err(error) = window.emit("notifications-changed", ()) {
            log(app, &format!("Falha ao avisar a janela principal: {error}"));
        }
    }
}

/// Executa `task` no thread principal (APIs de janela falham ou travam fora
/// dele) e registra no log se nem o agendamento funcionar.
fn on_main_thread(
    app: &AppHandle,
    what: &'static str,
    task: impl FnOnce(&AppHandle) + Send + 'static,
) {
    let handle = app.clone();
    if let Err(error) = app.run_on_main_thread(move || task(&handle)) {
        log(app, &format!("Falha ao agendar {what}: {error}"));
    }
}

/// Avisa o toast de que a fila mudou. Qualquer mudança desloca as linhas do
/// toast (e o redimensiona), então o submenu de adiar — posicionado ao lado
/// de uma linha — é fechado; o Personalizar só fecha se o lembrete dele saiu
/// da fila. Com a fila vazia, fecha tudo.
fn emit_queue_changed(app: &AppHandle) {
    let queue: Option<Vec<String>> = app.try_state::<PendingState>().and_then(|state| {
        lock(&state.0, "alertas pendentes")
            .ok()
            .map(|queue| queue.iter().map(|item| item.id.clone()).collect())
    });
    match queue {
        Some(ids) if ids.is_empty() => hide_alert_windows(app),
        Some(ids) => {
            hide_snooze_menu_window(app);
            let custom_target_gone = app
                .try_state::<CustomSnoozeState>()
                .and_then(|state| {
                    lock(&state.0, "personalizar adiamento")
                        .ok()
                        .map(|session| {
                            session.visible
                                && session
                                    .target_id
                                    .as_ref()
                                    .is_some_and(|target| !ids.contains(target))
                        })
                })
                .unwrap_or(false);
            if custom_target_gone {
                hide_custom_snooze_window(app);
            }
        }
        None => {}
    }
    if let Some(window) = app.get_webview_window("toast") {
        if let Err(error) = window.emit("queue-updated", ()) {
            log(app, &format!("Falha ao avisar o toast: {error}"));
        }
    }
}

/// Esconde e estaciona fora da tela uma janela de alerta. A ocultação roda
/// depois, no thread principal; até lá a janela pode ter sido reaberta (menu
/// reaberto, novo alerta no toast). Por isso a decisão é refeita na hora de
/// executar: esconder uma janela que voltou a ser necessária a deixava oculta
/// com o estado dizendo "visível" — e, no toast, violava o invariante de
/// nunca esconder com alertas na fila.
fn park_window(app: &AppHandle, label: &'static str) {
    on_main_thread(app, "ocultação de janela", move |handle| {
        let still_wanted = match label {
            "toast" => handle
                .try_state::<PendingState>()
                .and_then(|state| {
                    lock(&state.0, "alertas pendentes")
                        .ok()
                        .map(|q| !q.is_empty())
                })
                .unwrap_or(false),
            "snooze-menu" => handle
                .try_state::<SnoozeMenuState>()
                .and_then(|state| lock(&state.0, "menu de adiamento").ok().map(|s| s.visible))
                .unwrap_or(false),
            "custom-snooze" => handle
                .try_state::<CustomSnoozeState>()
                .and_then(|state| {
                    lock(&state.0, "personalizar adiamento")
                        .ok()
                        .map(|s| s.visible)
                })
                .unwrap_or(false),
            _ => false,
        };
        if still_wanted {
            return;
        }
        let Some(window) = handle.get_webview_window(label) else {
            return;
        };
        if let Err(error) = window.hide() {
            log(handle, &format!("Falha ao ocultar {label}: {error}"));
        }
        if let Err(error) = window.set_position(PhysicalPosition::new(-10_000, -10_000)) {
            log(handle, &format!("Falha ao estacionar {label}: {error}"));
        }
    });
}

fn hide_snooze_menu_window(app: &AppHandle) {
    if let Some(state) = app.try_state::<SnoozeMenuState>() {
        if let Ok(mut session) = lock(&state.0, "menu de adiamento") {
            session.visible = false;
            session.opened_at = None;
        }
    }
    park_window(app, "snooze-menu");
}

fn hide_custom_snooze_window(app: &AppHandle) {
    if let Some(state) = app.try_state::<CustomSnoozeState>() {
        if let Ok(mut session) = lock(&state.0, "personalizar adiamento") {
            session.visible = false;
            session.opened_at = None;
        }
    }
    park_window(app, "custom-snooze");
}

/// Fecha apenas os submenus de adiamento (menu "…" e Personalizar), sem tocar
/// no toast. Usado quando o toast deve permanecer (ex.: abrir o Noast).
fn hide_snooze_submenus(app: &AppHandle) {
    hide_snooze_menu_window(app);
    hide_custom_snooze_window(app);
}

fn hide_alert_windows(app: &AppHandle) {
    hide_snooze_submenus(app);
    park_window(app, "toast");
}

fn persist_notifications(paths: &Paths, notifications: &[Notification]) -> Result<(), String> {
    ensure_writable(&paths.health.notifications, "Os lembretes")?;
    save_notifications(&paths.notifications, notifications)
}

fn persist_notes(paths: &Paths, notes: &[Note]) -> Result<(), String> {
    ensure_writable(&paths.health.notes, "As notas")?;
    save_notes(&paths.notes, notes)
}

fn persist_vault(paths: &Paths, vault: &Vault) -> Result<(), String> {
    ensure_vault_available(paths)?;
    vault::save(&paths.vault, vault)
}

fn ensure_vault_available(paths: &Paths) -> Result<(), String> {
    match lock(&paths.health.vault, "cofre")?.as_ref() {
        Some(reason) => Err(format!(
            "Cofre indisponível: o arquivo não pôde ser aberto neste usuário do Windows e foi \
             preservado sem alterações. Detalhe: {reason}"
        )),
        None => Ok(()),
    }
}

/// Aplica `change` numa cópia da lista e só a adota depois de gravada: uma
/// falha de disco não deixa a memória diferente do arquivo.
fn update_notifications<R>(
    paths: &Paths,
    state: &NotificationState,
    change: impl FnOnce(&mut Vec<Notification>) -> Result<R, String>,
) -> Result<R, String> {
    let mut current = lock(&state.0, "lembretes")?;
    let mut next = current.clone();
    let result = change(&mut next)?;
    persist_notifications(paths, &next)?;
    *current = next;
    Ok(result)
}

fn update_notes<R>(
    paths: &Paths,
    state: &NoteState,
    change: impl FnOnce(&mut Vec<Note>) -> Result<R, String>,
) -> Result<R, String> {
    let mut current = lock(&state.0, "notas")?;
    let mut next = current.clone();
    let result = change(&mut next)?;
    persist_notes(paths, &next)?;
    *current = next;
    Ok(result)
}

/// Mesmo horário para o formulário, que só edita até o minuto: lembretes
/// adiados por versões antigas guardavam segundos.
fn same_minute(left: &str, right: &str) -> bool {
    left.get(..16)
        .is_some_and(|prefix| Some(prefix) == right.get(..16))
}

const NOT_PENDING: &str = "Este lembrete não está mais pendente.";

/// Age sobre um lembrete que está na fila do toast. As ações do toast e dos
/// submenus se referem ao alerta que o usuário VIU: se ele já saiu da fila
/// (concluído, editado ou excluído em outro lugar), agir mesmo assim
/// ressuscitaria um lembrete concluído. Trava lembretes → fila, nesta ordem,
/// durante toda a operação — a mesma ordem de `enqueue_alert`.
fn act_on_pending(
    paths: &Paths,
    state: &NotificationState,
    pending: &PendingState,
    ids: &[String],
    mut action: impl FnMut(&mut Notification) -> Result<(), String>,
) -> Result<usize, String> {
    let mut notifications = lock(&state.0, "lembretes")?;
    let mut queue = lock(&pending.0, "alertas pendentes")?;
    let targets: Vec<&String> = ids
        .iter()
        .filter(|id| queue.iter().any(|item| &item.id == *id))
        .collect();
    if targets.is_empty() {
        return Ok(0);
    }
    let mut next = notifications.clone();
    for id in &targets {
        if let Some(notification) = next.iter_mut().find(|item| &item.id == *id) {
            action(notification)?;
        }
    }
    persist_notifications(paths, &next)?;
    *notifications = next;
    queue.retain(|item| !targets.contains(&&item.id));
    Ok(targets.len())
}

#[tauri::command]
fn get_notifications(state: tauri::State<NotificationState>) -> Result<Vec<Notification>, String> {
    Ok(lock(&state.0, "lembretes")?.clone())
}

#[tauri::command]
fn get_pending_alerts(state: tauri::State<PendingState>) -> Result<Vec<Notification>, String> {
    Ok(lock(&state.0, "alertas pendentes")?.clone())
}

#[tauri::command]
fn save_notification(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NotificationState>,
    pending: tauri::State<PendingState>,
    mut notification: Notification,
) -> Result<(), String> {
    let notification_id = notification.id.clone();
    notification.text = notification.text.trim().to_string();
    notification.validate()?;

    // Mesmo horário e mesma repetição = só o texto mudou. Aí o lembrete
    // mantém tudo que o agendador sabe dele (disparo, série, dia da série) e,
    // se estiver tocando agora, continua no toast com o texto novo — tirá-lo
    // da fila sem limpar o disparo o fazia sumir para sempre.
    //
    // Trava lembretes → fila (a ordem de `enqueue_alert`) durante tudo: com a
    // fila tratada à parte, o agendador podia enfileirar o lembrete recém-
    // salvo no intervalo e o `retain` seguinte o apagava.
    {
        let mut notifications = lock(&state.0, "lembretes")?;
        let mut queue = lock(&pending.0, "alertas pendentes")?;
        let mut next = notifications.clone();
        let slot_kept = match next.iter_mut().find(|item| item.id == notification.id) {
            None => {
                notification.done = false;
                notification.last_fired.clear();
                notification.series_datetime.clear();
                notification.series_day = 0;
                next.push(notification);
                false
            }
            Some(existing) => {
                let kept = same_minute(&existing.datetime, &notification.datetime)
                    && existing.repeat == notification.repeat;
                if kept {
                    existing.text = notification.text;
                } else {
                    // Data ou repetição novas: a âncora antiga da série não
                    // vale mais. Só a hora mudou (mesmo dia, mesma repetição):
                    // o dia pretendido da série mensal continua valendo — um
                    // "todo dia 31" parado em 28/02 não pode virar "dia 28".
                    let same_day = existing.datetime.get(..10).is_some()
                        && existing.datetime.get(..10) == notification.datetime.get(..10)
                        && existing.repeat == notification.repeat;
                    notification.series_day = if same_day { existing.series_day } else { 0 };
                    notification.done = false;
                    notification.last_fired.clear();
                    notification.series_datetime.clear();
                    *existing = notification;
                }
                kept
            }
        };
        persist_notifications(&paths, &next)?;
        if slot_kept {
            let text = next
                .iter()
                .find(|item| item.id == notification_id)
                .map(|item| item.text.clone());
            if let (Some(text), Some(queued)) = (
                text,
                queue.iter_mut().find(|item| item.id == notification_id),
            ) {
                queued.text = text;
            }
        } else {
            queue.retain(|item| item.id != notification_id);
        }
        *notifications = next;
    }

    emit_main_changed(&app);
    emit_queue_changed(&app);
    log(&app, "Lembrete salvo.");
    Ok(())
}

#[tauri::command]
fn restore_notification(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NotificationState>,
    mut notification: Notification,
) -> Result<(), String> {
    notification.validate()?;
    // Excluído enquanto tocava: sem limpar o disparo, o lembrete restaurado
    // ficaria vencido e mudo. Limpo, ele volta a alertar se ainda for devido.
    if !notification.done {
        notification.last_fired.clear();
    }
    update_notifications(&paths, &state, |notifications| {
        if notifications.iter().any(|item| item.id == notification.id) {
            return Err("Este lembrete já foi restaurado.".to_string());
        }
        notifications.push(notification);
        Ok(())
    })?;
    emit_main_changed(&app);
    log(&app, "Lembrete restaurado.");
    Ok(())
}

#[tauri::command]
fn delete_notification(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NotificationState>,
    pending: tauri::State<PendingState>,
    id: String,
) -> Result<(), String> {
    update_notifications(&paths, &state, |notifications| {
        let previous_len = notifications.len();
        notifications.retain(|item| item.id != id);
        if notifications.len() == previous_len {
            return Err("Lembrete não encontrado.".to_string());
        }
        Ok(())
    })?;
    lock(&pending.0, "alertas pendentes")?.retain(|item| item.id != id);

    emit_main_changed(&app);
    emit_queue_changed(&app);
    log(&app, "Lembrete excluído.");
    Ok(())
}

#[tauri::command]
fn get_notes(state: tauri::State<NoteState>) -> Result<Vec<Note>, String> {
    Ok(lock(&state.0, "notas")?.clone())
}

#[tauri::command]
fn save_note(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NoteState>,
    mut note: Note,
) -> Result<Note, String> {
    note.title = note.title.trim().to_string();
    note.validate()?;
    let now = Local::now().to_rfc3339();

    let note = update_notes(&paths, &state, |notes| {
        if let Some(current) = notes.iter().position(|item| item.id == note.id) {
            note.created_at = notes[current].created_at.clone();
            note.updated_at = now;
            notes[current] = note.clone();
        } else {
            note.created_at = now.clone();
            note.updated_at = now;
            notes.push(note.clone());
        }
        Ok(note)
    })?;

    log(&app, "Nota salva.");
    Ok(note)
}

#[tauri::command]
fn restore_note(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NoteState>,
    mut note: Note,
) -> Result<Note, String> {
    note.title = note.title.trim().to_string();
    note.validate()?;

    let note = update_notes(&paths, &state, |notes| {
        if notes.iter().any(|item| item.id == note.id) {
            return Err("Esta nota já foi restaurada.".to_string());
        }
        if note.created_at.is_empty() {
            note.created_at = Local::now().to_rfc3339();
        }
        note.updated_at = Local::now().to_rfc3339();
        notes.push(note.clone());
        Ok(note)
    })?;

    log(&app, "Nota restaurada.");
    Ok(note)
}

#[tauri::command]
fn delete_note(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NoteState>,
    id: String,
) -> Result<(), String> {
    update_notes(&paths, &state, |notes| {
        let previous_len = notes.len();
        notes.retain(|item| item.id != id);
        if notes.len() == previous_len {
            return Err("Nota não encontrada.".to_string());
        }
        Ok(())
    })?;

    log(&app, "Nota excluída.");
    Ok(())
}

#[tauri::command]
fn get_vault_catalog(
    paths: tauri::State<Paths>,
    state: tauri::State<VaultState>,
) -> Result<VaultCatalog, String> {
    ensure_vault_available(&paths)?;
    let vault = lock(&state.0, "cofre")?;
    Ok(VaultCatalog::from(&*vault))
}

#[tauri::command]
fn save_vault_client(
    paths: tauri::State<Paths>,
    state: tauri::State<VaultState>,
    mut client: VaultClient,
) -> Result<VaultClient, String> {
    client.name = client.name.trim().to_string();
    client.notes = client.notes.trim().to_string();
    client.validate()?;
    ensure_vault_available(&paths)?;
    let now = Local::now().to_rfc3339();

    {
        let mut vault = lock(&state.0, "cofre")?;
        if !client.parent_id.is_empty() {
            let parent = vault
                .clients
                .iter()
                .find(|item| item.id == client.parent_id)
                .ok_or_else(|| "Responsável não encontrado.".to_string())?;
            // Dois níveis apenas: quem já está dentro de alguém não agrupa outros.
            if !parent.parent_id.is_empty() {
                return Err(
                    "Só é possível agrupar em um nível: escolha um responsável principal."
                        .to_string(),
                );
            }
            // Virar filho de alguém exigiria realocar os próprios filhos.
            if vault.clients.iter().any(|item| item.parent_id == client.id) {
                return Err(
                    "Este cliente já agrupa outros; mova-os antes de colocá-lo dentro de alguém."
                        .to_string(),
                );
            }
        }
        let mut next = vault.clone();
        if let Some(index) = next.clients.iter().position(|item| item.id == client.id) {
            client.created_at = next.clients[index].created_at.clone();
            client.updated_at = now;
            next.clients[index] = client.clone();
        } else {
            client.created_at = now.clone();
            client.updated_at = now;
            next.clients.push(client.clone());
        }
        persist_vault(&paths, &next)?;
        *vault = next;
    }
    Ok(client)
}

#[tauri::command]
fn delete_vault_client(
    paths: tauri::State<Paths>,
    state: tauri::State<VaultState>,
    id: String,
) -> Result<(), String> {
    ensure_vault_available(&paths)?;
    let mut vault = lock(&state.0, "cofre")?;
    let mut next = vault.clone();
    let previous_len = next.clients.len();
    next.clients.retain(|item| item.id != id);
    if previous_len == next.clients.len() {
        return Err("Cliente não encontrado.".to_string());
    }
    next.accesses.retain(|item| item.client_id != id);
    // Quem era agrupado por ele volta a ser raiz: excluir um responsável não
    // pode arrastar junto os clientes (e as senhas) que estavam dentro dele.
    for child in next.clients.iter_mut().filter(|item| item.parent_id == id) {
        child.parent_id.clear();
    }
    persist_vault(&paths, &next)?;
    *vault = next;
    Ok(())
}

#[tauri::command]
fn get_vault_access(
    paths: tauri::State<Paths>,
    state: tauri::State<VaultState>,
    id: String,
) -> Result<VaultAccess, String> {
    ensure_vault_available(&paths)?;
    lock(&state.0, "cofre")?
        .accesses
        .iter()
        .find(|item| item.id == id)
        .cloned()
        .ok_or_else(|| "Acesso não encontrado.".to_string())
}

#[tauri::command]
fn save_vault_access(
    paths: tauri::State<Paths>,
    state: tauri::State<VaultState>,
    mut access: VaultAccess,
) -> Result<VaultAccessSummary, String> {
    access.label = access.label.trim().to_string();
    access.service = access.service.trim().to_string();
    access.url = access.url.trim().to_string();
    access.username = access.username.trim().to_string();
    access.recovery_email = access.recovery_email.trim().to_string();
    access.notes = access.notes.trim().to_string();
    access.validate()?;
    ensure_vault_available(&paths)?;
    let now = Local::now().to_rfc3339();

    {
        let mut vault = lock(&state.0, "cofre")?;
        let mut next = vault.clone();
        if !next.clients.iter().any(|item| item.id == access.client_id) {
            return Err("Selecione um cliente válido.".to_string());
        }
        if let Some(index) = next.accesses.iter().position(|item| item.id == access.id) {
            access.created_at = next.accesses[index].created_at.clone();
            access.updated_at = now;
            next.accesses[index] = access.clone();
        } else {
            access.created_at = now.clone();
            access.updated_at = now;
            next.accesses.push(access.clone());
        }
        persist_vault(&paths, &next)?;
        *vault = next;
    }
    Ok(VaultAccessSummary::from(&access))
}

#[tauri::command]
fn delete_vault_access(
    paths: tauri::State<Paths>,
    state: tauri::State<VaultState>,
    id: String,
) -> Result<(), String> {
    ensure_vault_available(&paths)?;
    let mut vault = lock(&state.0, "cofre")?;
    let mut next = vault.clone();
    let previous_len = next.accesses.len();
    next.accesses.retain(|item| item.id != id);
    if previous_len == next.accesses.len() {
        return Err("Acesso não encontrado.".to_string());
    }
    persist_vault(&paths, &next)?;
    *vault = next;
    Ok(())
}

/// Copia um segredo do cofre: fora do histórico do Win+V e da nuvem, e limpo
/// sozinho depois de um tempo se ninguém copiou outra coisa por cima.
#[tauri::command]
fn copy_secret(
    app: AppHandle,
    secret: tauri::State<PendingSecret>,
    value: String,
) -> Result<(), String> {
    const CLEAR_AFTER: Duration = Duration::from_secs(30);
    if value.is_empty() {
        return Err("Nada para copiar.".to_string());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| "Janela principal indisponível.".to_string())?;
    let sequence = clipboard::copy_sensitive(&window, &value)?;
    *lock(&secret.0, "área de transferência")? = Some(sequence);
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(CLEAR_AFTER);
        on_main_thread(
            &handle,
            "limpeza da área de transferência",
            move |handle| {
                // Só limpa se esta ainda é a última cópia de segredo: uma cópia
                // mais nova tem o próprio prazo.
                let current = handle
                    .try_state::<PendingSecret>()
                    .and_then(|state| state.0.lock().ok().and_then(|value| *value));
                if current == Some(sequence) {
                    clear_pending_secret(handle);
                }
            },
        );
    });
    Ok(())
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let url = url.trim().to_string();
    let lower = url.to_ascii_lowercase();
    let has_scheme = lower.split_once(':').is_some_and(|(scheme, _)| {
        !scheme.is_empty()
            && scheme
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "+.-".contains(character))
    }) && !lower.split_once(':').is_some_and(|(_, rest)| {
        // "host:porta" não é esquema.
        rest.chars()
            .next()
            .is_some_and(|character| character.is_ascii_digit())
    });
    let normalized = if ["http://", "https://", "ftp://", "sftp://"]
        .iter()
        .any(|prefix| lower.starts_with(prefix))
    {
        url
    } else if has_scheme {
        // file:, javascript:, ms-*: e afins abririam programas ou arquivos locais.
        return Err("Só é possível abrir endereços http, https, ftp ou sftp.".to_string());
    } else {
        format!("https://{url}")
    };
    if normalized
        .chars()
        .any(|character| character.is_whitespace() || character.is_control())
        || normalized.len() > 2_048
    {
        return Err("Endereço inválido.".to_string());
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::ffi::OsStrExt;
        use windows::core::{w, PCWSTR};
        use windows::Win32::UI::Shell::ShellExecuteW;
        use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

        let wide: Vec<u16> = std::ffi::OsStr::new(&normalized)
            .encode_wide()
            .chain(Some(0))
            .collect();
        let result = unsafe {
            ShellExecuteW(
                None,
                w!("open"),
                PCWSTR(wide.as_ptr()),
                None,
                None,
                SW_SHOWNORMAL,
            )
        };
        if result.0 as isize <= 32 {
            return Err("Não foi possível abrir o endereço.".to_string());
        }
        Ok(())
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = normalized;
        Err("A abertura de endereço está disponível apenas no Windows.".to_string())
    }
}

/// Resposta comum às ações do toast: avisa as janelas e, se o alvo já não
/// estava na fila, informa quem chamou.
fn after_toast_action(app: &AppHandle, acted: usize) -> Result<(), String> {
    emit_main_changed(app);
    emit_queue_changed(app);
    if acted == 0 {
        return Err(NOT_PENDING.to_string());
    }
    Ok(())
}

#[tauri::command]
fn mark_done(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NotificationState>,
    pending: tauri::State<PendingState>,
    id: String,
) -> Result<(), String> {
    let now = Local::now().naive_local();
    let acted = act_on_pending(&paths, &state, &pending, &[id], |notification| {
        advance_after(notification, now)
    })?;
    // Concluir algo que já saiu da fila é inofensivo: só ressincroniza o toast.
    emit_main_changed(&app);
    emit_queue_changed(&app);
    if acted == 0 {
        log(&app, "Concluir ignorado: o lembrete já não estava na fila.");
    }
    Ok(())
}

#[tauri::command]
fn snooze_notification(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NotificationState>,
    pending: tauri::State<PendingState>,
    id: String,
    minutes: u32,
) -> Result<(), String> {
    if !(1..=1_440).contains(&minutes) {
        return Err("O adiamento deve ficar entre 1 minuto e 24 horas.".to_string());
    }
    let now = Local::now().naive_local();
    let acted = act_on_pending(&paths, &state, &pending, &[id], |notification| {
        snooze(notification, minutes, now);
        Ok(())
    })?;
    after_toast_action(&app, acted)
}

#[tauri::command]
fn snooze_tomorrow(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NotificationState>,
    pending: tauri::State<PendingState>,
    id: String,
) -> Result<(), String> {
    let now = Local::now().naive_local();
    let acted = act_on_pending(&paths, &state, &pending, &[id], |notification| {
        snooze_until_tomorrow(notification, now)
    })?;
    after_toast_action(&app, acted)
}

fn pending_ids(pending: &PendingState) -> Result<Vec<String>, String> {
    Ok(lock(&pending.0, "alertas pendentes")?
        .iter()
        .map(|item| item.id.clone())
        .collect())
}

/// "Concluir todos" e "Adiar todos" agem só sobre os alertas que estavam na
/// fila; um que chegue no meio da operação continua nela.
#[tauri::command]
fn mark_all_done(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NotificationState>,
    pending: tauri::State<PendingState>,
) -> Result<(), String> {
    let ids = pending_ids(&pending)?;
    let now = Local::now().naive_local();
    act_on_pending(&paths, &state, &pending, &ids, |notification| {
        advance_after(notification, now)
    })?;
    emit_main_changed(&app);
    emit_queue_changed(&app);
    Ok(())
}

#[tauri::command]
fn snooze_all(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NotificationState>,
    pending: tauri::State<PendingState>,
    minutes: u32,
) -> Result<(), String> {
    if !(1..=1_440).contains(&minutes) {
        return Err("O adiamento deve ficar entre 1 minuto e 24 horas.".to_string());
    }
    let ids = pending_ids(&pending)?;
    let now = Local::now().naive_local();
    act_on_pending(&paths, &state, &pending, &ids, |notification| {
        snooze(notification, minutes, now);
        Ok(())
    })?;
    emit_main_changed(&app);
    emit_queue_changed(&app);
    Ok(())
}

#[tauri::command]
fn get_settings(state: tauri::State<SettingsState>) -> Result<Settings, String> {
    Ok(lock(&state.0, "configurações")?.clone())
}

#[tauri::command]
fn save_user_settings(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<SettingsState>,
    settings: Settings,
) -> Result<(), String> {
    settings.validate()?;
    ensure_writable(&paths.health.settings, "As configurações")?;
    save_settings(&paths.settings, &settings)?;
    *lock(&state.0, "configurações")? = settings.clone();

    for label in ["toast", "snooze-menu", "custom-snooze"] {
        let Some(window) = app.get_webview_window(label) else {
            continue;
        };
        if let Err(error) = window.set_always_on_top(settings.alert_always_on_top) {
            log(
                &app,
                &format!("Falha ao ajustar 'sempre no topo' em {label}: {error}"),
            );
        }
        if let Err(error) = window.emit("settings-changed", settings.clone()) {
            log(
                &app,
                &format!("Falha ao avisar {label} das configurações: {error}"),
            );
        }
    }

    // Em desenvolvimento, registrar o autostart apontaria o login do Windows
    // para o executável de debug no lugar do instalado.
    #[cfg(not(debug_assertions))]
    {
        let result = if settings.start_with_windows {
            app.autolaunch().enable()
        } else {
            app.autolaunch().disable()
        };
        if let Err(error) = result {
            log(
                &app,
                &format!("Falha ao ajustar o início com o Windows: {error}"),
            );
            return Err(format!(
                "Configurações salvas, mas não foi possível ajustar o início com o Windows: {error}"
            ));
        }
    }
    Ok(())
}

#[tauri::command]
fn get_snooze_target(state: tauri::State<SnoozeMenuState>) -> Result<String, String> {
    lock(&state.0, "menu de adiamento")?
        .target_id
        .clone()
        .ok_or_else(|| "Nenhum lembrete selecionado.".to_string())
}

/// Posiciona um submenu ao lado da linha `anchor` do toast, dentro da área
/// de trabalho do monitor do toast: acima da linha se couber, senão abaixo,
/// sempre sem sair da tela. Tamanho e posição usam a escala DESTE monitor
/// (a janela pode estar estacionada fora da tela, noutro DPI).
fn place_beside_toast(
    toast: &WebviewWindow,
    window: &WebviewWindow,
    anchor: &SnoozeMenuAnchor,
    width: f64,
    height: f64,
) -> Result<(), String> {
    const GAP: f64 = 6.0;
    let toast_position = toast.outer_position().map_err(|error| error.to_string())?;
    let monitor = toast
        .monitor_from_point(f64::from(toast_position.x), f64::from(toast_position.y))
        .map_err(|error| error.to_string())?
        .or_else(|| toast.primary_monitor().ok().flatten())
        .ok_or_else(|| "Não foi possível localizar o monitor.".to_string())?;
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let width_px = (width * scale).round() as i32;
    let height_px = (height * scale).round() as i32;

    let left = area.position.x;
    let right = area.position.x + area.size.width as i32 - width_px;
    let top = area.position.y;
    let bottom = area.position.y + area.size.height as i32 - height_px;

    let desired_x = toast_position.x + ((anchor.x + anchor.width - width) * scale).round() as i32;
    let x = desired_x.min(right).max(left);
    let above = toast_position.y + ((anchor.top - height - GAP) * scale).round() as i32;
    let below = toast_position.y + ((anchor.bottom + GAP) * scale).round() as i32;
    let y = if above >= top {
        above
    } else {
        below.min(bottom).max(top)
    };

    let position = PhysicalPosition::new(x, y);
    window
        .set_position(position)
        .map_err(|error| error.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(
            width_px.max(1) as u32,
            height_px.max(1) as u32,
        ))
        .map_err(|error| error.to_string())?;
    // Mudar de monitor pode trocar o DPI e o Windows reposicionar a janela.
    window
        .set_position(position)
        .map_err(|error| error.to_string())
}

fn is_pending(pending: &PendingState, id: &str) -> Result<bool, String> {
    Ok(lock(&pending.0, "alertas pendentes")?
        .iter()
        .any(|item| item.id == id))
}

#[tauri::command]
fn open_snooze_menu(
    app: AppHandle,
    state: tauri::State<SnoozeMenuState>,
    settings: tauri::State<SettingsState>,
    pending: tauri::State<PendingState>,
    id: String,
    anchor: SnoozeMenuAnchor,
) -> Result<bool, String> {
    const WIDTH: f64 = 168.0;
    const HEIGHT: f64 = 190.0;

    let toast = app
        .get_webview_window("toast")
        .ok_or_else(|| "Janela de alerta indisponível.".to_string())?;
    let menu = app
        .get_webview_window("snooze-menu")
        .ok_or_else(|| "Menu de adiamento indisponível.".to_string())?;
    {
        let mut session = lock(&state.0, "menu de adiamento")?;
        let same_target = session
            .target_id
            .as_ref()
            .is_some_and(|target| target == &id);
        if same_target && session.visible {
            session.visible = false;
            session.opened_at = None;
            drop(session);
            menu.hide().map_err(|error| error.to_string())?;
            if let Err(error) = menu.set_position(PhysicalPosition::new(-10_000, -10_000)) {
                log(
                    &app,
                    &format!("Falha ao estacionar o menu de adiamento: {error}"),
                );
            }
            log(&app, "Menu de adiamento: fechado pelo toggle.");
            return Ok(false);
        }
    }
    if !is_pending(&pending, &id)? {
        return Err(NOT_PENDING.to_string());
    }

    place_beside_toast(&toast, &menu, &anchor, WIDTH, HEIGHT)?;
    let always_on_top = lock(&settings.0, "configurações")?.alert_always_on_top;
    show_without_activation(&menu, always_on_top)?;
    // Só marca como aberto depois de aparecer: um erro no meio deixava o
    // estado "visível" preso e o watchdog do toast desligado.
    {
        let mut session = lock(&state.0, "menu de adiamento")?;
        session.target_id = Some(id);
        session.visible = true;
        session.opened_at = Some(Instant::now());
    }
    if let Err(error) = menu.emit("snooze-menu-open", ()) {
        log(
            &app,
            &format!("Menu de adiamento: falha ao avisar abertura: {error}"),
        );
    }
    log(&app, "Menu de adiamento: aberto pelo toggle.");
    Ok(true)
}

#[tauri::command]
fn hide_snooze_menu(app: AppHandle) -> Result<(), String> {
    hide_snooze_menu_window(&app);
    log(&app, "Menu de adiamento: fechado explicitamente.");
    Ok(())
}

#[tauri::command]
fn open_custom_snooze(
    app: AppHandle,
    state: tauri::State<CustomSnoozeState>,
    settings: tauri::State<SettingsState>,
    pending: tauri::State<PendingState>,
    id: String,
    anchor: SnoozeMenuAnchor,
) -> Result<bool, String> {
    const WIDTH: f64 = 300.0;
    const HEIGHT: f64 = 430.0;

    let toast = app
        .get_webview_window("toast")
        .ok_or_else(|| "Janela de alerta indisponível.".to_string())?;
    let window = app
        .get_webview_window("custom-snooze")
        .ok_or_else(|| "Janela de personalização indisponível.".to_string())?;
    if !is_pending(&pending, &id)? {
        return Err(NOT_PENDING.to_string());
    }

    // O alvo é gravado antes de exibir: o frontend o consulta ao receber
    // "custom-snooze-open".
    lock(&state.0, "personalizar adiamento")?.target_id = Some(id);
    place_beside_toast(&toast, &window, &anchor, WIDTH, HEIGHT)?;

    let always_on_top = lock(&settings.0, "configurações")?.alert_always_on_top;
    // Primeiro exibe sem ativação — é o que garante que a janela apareça e
    // receba cliques (show() + set_focus() a partir de um app em segundo plano
    // a deixava visível porém surda). Só depois pede o foco, para o teclado
    // funcionar (digitar a data, Enter confirmar, Esc fechar). Se o foco falhar,
    // a janela continua utilizável no mouse.
    show_without_activation(&window, always_on_top)?;
    {
        let mut session = lock(&state.0, "personalizar adiamento")?;
        session.visible = true;
        session.opened_at = Some(Instant::now());
    }
    if let Err(error) = window.set_focus() {
        log(&app, &format!("Personalizar: sem foco de teclado: {error}"));
    }
    // A janela é reutilizada: avisa o frontend para resetar (botão habilitado,
    // sugestão de horário fresca) a cada abertura.
    if let Err(error) = app.emit("custom-snooze-open", ()) {
        log(
            &app,
            &format!("Personalizar: falha ao avisar abertura: {error}"),
        );
    }

    log(&app, "Personalizar adiamento: aberto.");
    Ok(true)
}

#[tauri::command]
fn get_custom_snooze_target(
    app: AppHandle,
    state: tauri::State<CustomSnoozeState>,
) -> Result<String, String> {
    let id = lock(&state.0, "personalizar adiamento")?
        .target_id
        .clone()
        .ok_or_else(|| "Nenhum lembrete selecionado.".to_string())?;
    log(&app, &format!("Personalizar: alvo consultado ({id})."));
    Ok(id)
}

#[tauri::command]
fn hide_custom_snooze(app: AppHandle) -> Result<(), String> {
    hide_custom_snooze_window(&app);
    log(&app, "Personalizar adiamento: fechado.");
    Ok(())
}

#[tauri::command]
fn reschedule_notification(
    app: AppHandle,
    notifications: tauri::State<NotificationState>,
    pending: tauri::State<PendingState>,
    paths: tauri::State<Paths>,
    id: String,
    datetime: String,
) -> Result<(), String> {
    log(
        &app,
        &format!("Personalizar: reschedule chamado (id={id}, datetime={datetime})."),
    );
    let normalized = if datetime.len() == 16 {
        format!("{datetime}:00")
    } else {
        datetime.clone()
    };
    let target = NaiveDateTime::parse_from_str(&normalized, "%Y-%m-%dT%H:%M:%S")
        .map_err(|_| "Data e hora inválidas.".to_string())?;
    let now = Local::now().naive_local();

    let acted = act_on_pending(&paths, &notifications, &pending, &[id], |notification| {
        reschedule_to(notification, target, now)
    })?;
    if acted > 0 {
        log(&app, "Personalizar: reagendado com sucesso.");
    } else {
        log(
            &app,
            "Personalizar: recusado, o lembrete já não estava na fila.",
        );
        hide_custom_snooze_window(&app);
    }
    after_toast_action(&app, acted)
}

#[tauri::command]
fn hide_main_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Janela principal indisponível.".to_string())?
        .hide()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn minimize_main_window(app: AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or_else(|| "Janela principal indisponível.".to_string())?
        .minimize()
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn open_main_from_toast(app: AppHandle) -> Result<(), String> {
    open_main_window(&app)?;
    // Abrir o Noast não é uma decisão sobre o lembrete: o alerta segue pendente,
    // então o toast permanece visível (só fecha os submenus de adiamento).
    hide_snooze_submenus(&app);
    Ok(())
}

#[tauri::command]
fn hide_toast(app: AppHandle, pending: tauri::State<PendingState>) -> Result<(), String> {
    let queued = lock(&pending.0, "alertas pendentes")?.len();
    if queued > 0 {
        // Invariante: com alertas pendentes o toast não pode ser ocultado. Um
        // pedido assim vem de leitura obsoleta do frontend (ex.: no startup o
        // webview consulta a fila antes do atrasado ser enfileirado e "vê"
        // vazio). O backend é a fonte da verdade: recusa e manda o frontend
        // ressincronizar — o refresh verá a fila real e apresentará o toast.
        log(
            &app,
            &format!("Toast: ocultação recusada (fila: {queued}); ressincronizando frontend."),
        );
        if let Some(window) = app.get_webview_window("toast") {
            let _ = window.emit("queue-updated", ());
        }
        return Ok(());
    }
    log(&app, "Toast oculto a pedido do frontend (fila: 0).");
    hide_alert_windows(&app);
    Ok(())
}

#[tauri::command]
fn present_toast(
    app: AppHandle,
    settings: tauri::State<SettingsState>,
    pending: tauri::State<PendingState>,
    height: f64,
) -> Result<(), String> {
    let count = lock(&pending.0, "alertas pendentes")?.len();
    if count == 0 {
        hide_alert_windows(&app);
        return Ok(());
    }
    let window = app
        .get_webview_window("toast")
        .ok_or_else(|| "Janela de alerta indisponível.".to_string())?;
    let settings = lock(&settings.0, "configurações")?.clone();
    position_toast(&app, &window, height, &settings)?;
    log(&app, &format!("Toast apresentado ({count} na fila)."));
    show_without_activation(&window, settings.alert_always_on_top)
}

fn position_toast(
    app: &AppHandle,
    window: &WebviewWindow,
    height: f64,
    settings: &Settings,
) -> Result<(), String> {
    const WIDTH: f64 = 400.0;
    const MARGIN: f64 = 14.0;
    let height = height.clamp(104.0, 520.0);
    let monitor = match settings.alert_monitor {
        AlertMonitor::Cursor => app
            .cursor_position()
            .ok()
            .and_then(|position| {
                app.monitor_from_point(position.x, position.y)
                    .ok()
                    .flatten()
            })
            .or_else(|| app.primary_monitor().ok().flatten()),
        AlertMonitor::Primary => app.primary_monitor().ok().flatten(),
    }
    .ok_or_else(|| "Não foi possível localizar um monitor.".to_string())?;

    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let width_px = (WIDTH * scale).round() as i32;
    let height_px = (height * scale).round() as i32;
    let margin_px = (MARGIN * scale).round() as i32;
    let x = area.position.x + area.size.width as i32 - width_px - margin_px;
    let y = area.position.y + area.size.height as i32 - height_px - margin_px;

    // Posição antes do tamanho, e tamanho em pixels físicos do monitor de
    // destino: um LogicalSize seria convertido pela escala do lugar onde a
    // janela estava estacionada, que pode ter outro DPI.
    let position = PhysicalPosition::new(x, y);
    window
        .set_position(position)
        .map_err(|error| error.to_string())?;
    window
        .set_size(tauri::PhysicalSize::new(width_px as u32, height_px as u32))
        .map_err(|error| error.to_string())?;
    window
        .set_position(position)
        .map_err(|error| error.to_string())?;
    window
        .set_always_on_top(settings.alert_always_on_top)
        .map_err(|error| error.to_string())
}

#[cfg(target_os = "windows")]
fn show_without_activation(window: &WebviewWindow, always_on_top: bool) -> Result<(), String> {
    use windows::Win32::UI::WindowsAndMessaging::{
        SetWindowPos, ShowWindow, HWND_NOTOPMOST, HWND_TOPMOST, SWP_NOACTIVATE, SWP_NOMOVE,
        SWP_NOSIZE, SW_SHOWNOACTIVATE,
    };

    let raw = window.hwnd().map_err(|error| error.to_string())?;
    let hwnd = windows::Win32::Foundation::HWND(raw.0 as *mut _);
    let insert_after = if always_on_top {
        HWND_TOPMOST
    } else {
        HWND_NOTOPMOST
    };
    unsafe {
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        SetWindowPos(
            hwnd,
            insert_after,
            0,
            0,
            0,
            0,
            SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE,
        )
        .map_err(|error| error.to_string())
    }
}

#[cfg(not(target_os = "windows"))]
fn show_without_activation(window: &WebviewWindow, _always_on_top: bool) -> Result<(), String> {
    window.show().map_err(|error| error.to_string())
}

fn create_toast_window(app: &AppHandle, settings: &Settings) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(app, "toast", WebviewUrl::App("alert.html".into()))
        .title("Noast")
        .inner_size(400.0, 160.0)
        .resizable(false)
        .decorations(false)
        .transparent(true)
        .always_on_top(settings.alert_always_on_top)
        .skip_taskbar(true)
        .visible(false)
        .build()
}

fn create_snooze_menu_window(app: &AppHandle, settings: &Settings) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(
        app,
        "snooze-menu",
        WebviewUrl::App("snooze-menu.html".into()),
    )
    .title("")
    .inner_size(168.0, 190.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .focusable(false)
    .always_on_top(settings.alert_always_on_top)
    .skip_taskbar(true)
    .visible(false)
    .build()
}

fn create_custom_snooze_window(
    app: &AppHandle,
    settings: &Settings,
) -> tauri::Result<WebviewWindow> {
    WebviewWindowBuilder::new(
        app,
        "custom-snooze",
        WebviewUrl::App("custom-snooze.html".into()),
    )
    .title("")
    .inner_size(300.0, 430.0)
    .resizable(false)
    .decorations(false)
    .transparent(true)
    .shadow(false)
    .focusable(true)
    .always_on_top(settings.alert_always_on_top)
    .skip_taskbar(true)
    .visible(false)
    .build()
}

fn open_main_window(app: &AppHandle) -> Result<(), String> {
    open_main_window_reporting(app).map(|_| ())
}

/// Abre (ou traz de volta) a janela principal. Devolve `true` se ela acabou de
/// ser criada — o webview ainda vai carregar e não ouve eventos.
fn open_main_window_reporting(app: &AppHandle) -> Result<bool, String> {
    if let Some(window) = app.get_webview_window("main") {
        // show() numa janela minimizada não faz nada (ela já é "visível").
        if window.is_minimized().unwrap_or(false) {
            window.unminimize().map_err(|error| error.to_string())?;
        }
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(false);
    }

    let window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Noast")
        .inner_size(1300.0, 650.0)
        .min_inner_size(720.0, 520.0)
        .decorations(false)
        .shadow(true)
        .skip_taskbar(false)
        .center()
        .build()
        .map_err(|error| format!("Falha ao criar janela principal: {error}"))?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(true)
}

fn open_new_reminder(app: &AppHandle) -> Result<(), String> {
    // Guardado sempre: a janela pode existir mas ainda estar carregando (logo
    // após o startup) e perder o evento. O frontend consome o pedido tanto ao
    // terminar de carregar quanto ao receber o evento.
    if let Some(request) = app.try_state::<NewReminderRequest>() {
        request.0.store(true, Ordering::SeqCst);
    }
    let created = open_main_window_reporting(app)?;
    if !created {
        if let Some(window) = app.get_webview_window("main") {
            if let Err(error) = window.emit("open-new-reminder", ()) {
                log(app, &format!("Falha ao pedir novo lembrete: {error}"));
            }
        }
    }
    Ok(())
}

/// "Sair" da bandeja: dá à janela principal a chance de gravar o que está
/// pendente (autosave das notas) antes de encerrar. Ela responde com
/// `ready_to_quit`; se não responder a tempo, encerra assim mesmo.
fn request_quit(app: &AppHandle) {
    const GRACE: Duration = Duration::from_millis(2_000);
    clear_pending_secret(app);
    let Some(window) = app.get_webview_window("main") else {
        app.exit(0);
        return;
    };
    if window.emit("app-quitting", ()).is_err() {
        app.exit(0);
        return;
    }
    let handle = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(GRACE);
        log(
            &handle,
            "Saída: a janela principal não confirmou a tempo; encerrando.",
        );
        handle.exit(0);
    });
}

#[tauri::command]
fn ready_to_quit(app: AppHandle) {
    clear_pending_secret(&app);
    app.exit(0);
}

/// Consome o pedido de "Novo lembrete" feito pela bandeja. O frontend chama ao
/// terminar de carregar e também ao receber o evento, então o pedido nunca é
/// atendido duas vezes nem se perde.
#[tauri::command]
fn take_new_reminder_request(request: tauri::State<NewReminderRequest>) -> bool {
    request.0.swap(false, Ordering::SeqCst)
}

/// Mostra a janela do toast num tamanho padrão; o frontend refina altura e
/// posição em seguida via present_toast. Sempre executa no thread principal
/// (APIs de janela/monitor não são confiáveis fora dele) e registra qualquer
/// falha no log em vez de engoli-la. Após exibir, emite "queue-updated" para o
/// webview renderizar o conteúdo — o requestAnimationFrame dele descongela
/// quando a janela fica visível.
fn show_toast_window(app: &AppHandle, reason: &'static str) {
    let handle = app.clone();
    let scheduled = app.run_on_main_thread(move || {
        let Some(window) = handle.get_webview_window("toast") else {
            return;
        };
        let Some(settings) = handle
            .try_state::<SettingsState>()
            .and_then(|s| lock(&s.0, "configurações").ok().map(|value| value.clone()))
        else {
            return;
        };
        let shown = position_toast(&handle, &window, 160.0, &settings)
            .and_then(|_| show_without_activation(&window, settings.alert_always_on_top));
        match shown {
            Ok(()) => {
                let _ = window.emit("queue-updated", ());
                log(&handle, &format!("Toast exibido pelo backend ({reason})."));
            }
            Err(error) => log(
                &handle,
                &format!("Falha ao exibir toast ({reason}): {error}"),
            ),
        }
    });
    if let Err(error) = scheduled {
        log(
            app,
            &format!("Falha ao agendar exibição do toast ({reason}): {error}"),
        );
    }
}

fn enqueue_alert(app: &AppHandle, notification: Notification) {
    let (Some(pending), Some(notifications)) = (
        app.try_state::<PendingState>(),
        app.try_state::<NotificationState>(),
    ) else {
        log(app, "Fila de alertas indisponível.");
        return;
    };
    // Trava lembretes → fila (a ordem de `act_on_pending`) e confere que o
    // lembrete ainda existe como disparado: entre a coleta e aqui ele pode ter
    // sido excluído, concluído ou editado pela janela principal.
    let notifications = match lock(&notifications.0, "lembretes") {
        Ok(notifications) => notifications,
        Err(error) => {
            log(app, &error);
            return;
        }
    };
    let still_due = notifications.iter().any(|item| {
        item.id == notification.id && !item.done && item.last_fired == notification.last_fired
    });
    if !still_due {
        log(
            app,
            &format!(
                "Disparo descartado: \"{}\" mudou antes de entrar na fila.",
                notification.text
            ),
        );
        return;
    }
    let mut queue = match lock(&pending.0, "alertas pendentes") {
        Ok(queue) => queue,
        Err(error) => {
            log(app, &error);
            return;
        }
    };
    let already_queued = queue.iter().any(|item| item.id == notification.id);
    let should_notify = queue.is_empty() && !already_queued;
    if !already_queued {
        log(
            app,
            &format!(
                "Enfileirado (fila: {}): \"{}\"",
                queue.len() + 1,
                notification.text
            ),
        );
        queue.push(notification);
    }
    drop(queue);
    drop(notifications);
    if should_notify {
        let sound_enabled = app
            .try_state::<SettingsState>()
            .and_then(|settings| {
                lock(&settings.0, "configurações")
                    .ok()
                    .map(|value| value.alert_sound)
            })
            .unwrap_or(false);
        if sound_enabled {
            play_alert_sound();
        }
    }
    emit_queue_changed(app);
}

#[cfg(target_os = "windows")]
fn play_alert_sound() {
    use windows::Win32::System::Diagnostics::Debug::MessageBeep;
    use windows::Win32::UI::WindowsAndMessaging::MB_ICONINFORMATION;
    unsafe {
        let _ = MessageBeep(MB_ICONINFORMATION);
    }
}

#[cfg(not(target_os = "windows"))]
fn play_alert_sound() {}

fn collect_due(
    app: &AppHandle,
    state: &NotificationState,
    paths: &Paths,
    include_fired: bool,
) -> Vec<Notification> {
    let now = Local::now().naive_local();
    let mut notifications = match lock(&state.0, "lembretes") {
        Ok(notifications) => notifications,
        Err(error) => {
            log(app, &error);
            return Vec::new();
        }
    };
    let mut due = Vec::new();

    for notification in notifications.iter_mut() {
        if is_due(notification, now, include_fired) {
            if let Ok(datetime) = notification.parsed_datetime() {
                notification.last_fired = occurrence_key(&datetime);
                log(
                    app,
                    &format!(
                        "Disparo{}: \"{}\" (ocorrência {})",
                        if include_fired { " recuperado" } else { "" },
                        notification.text,
                        occurrence_key(&datetime)
                    ),
                );
                due.push(notification.clone());
            }
        }
    }

    if !due.is_empty() {
        // Mesmo sem conseguir gravar, o alerta é mostrado: descartá-lo com o
        // disparo já marcado na memória o fazia sumir até reiniciar. No pior
        // caso ele volta a tocar na próxima abertura.
        if let Err(error) = persist_notifications(paths, &notifications) {
            log(app, &format!("Falha ao persistir disparos: {error}"));
        }
        drop(notifications);
        emit_main_changed(app);
    }
    due
}

/// Watchdog do toast: com alertas pendentes e nenhum submenu aberto, garante
/// que o toast esteja na tela. Janela visível → reafirma no topo (caso tenha
/// ficado atrás de jogo/janela topmost). Janela oculta → cutuca o frontend com
/// "queue-updated" para ELE renderizar e apresentar (a janela só deve aparecer
/// com conteúdo pronto; mostrar antes causa janela branca). Se vários avisos
/// seguidos não surtirem efeito (webview travado), força a exibição pelo
/// backend como último recurso.
fn ensure_toast_presented(app: &AppHandle, unanswered_nudges: &mut u32) {
    let pending_count = app
        .try_state::<PendingState>()
        .and_then(|pending| lock(&pending.0, "alertas pendentes").ok().map(|q| q.len()))
        .unwrap_or(0);
    if pending_count == 0 {
        *unanswered_nudges = 0;
        return;
    }
    let blocks = |opened_at: Option<Instant>, visible: bool| {
        visible && opened_at.is_some_and(|since| since.elapsed() < SUBMENU_GRACE)
    };
    let submenu_open = app
        .try_state::<SnoozeMenuState>()
        .and_then(|s| {
            lock(&s.0, "menu de adiamento")
                .ok()
                .map(|v| blocks(v.opened_at, v.visible))
        })
        .unwrap_or(false)
        || app
            .try_state::<CustomSnoozeState>()
            .and_then(|s| {
                lock(&s.0, "personalizar adiamento")
                    .ok()
                    .map(|v| blocks(v.opened_at, v.visible))
            })
            .unwrap_or(false);
    if submenu_open {
        *unanswered_nudges = 0;
        return;
    }
    let Some(toast) = app.get_webview_window("toast") else {
        // A janela foi destruída (não deveria: o fechamento é bloqueado).
        // Recria; o webview novo consulta a fila ao carregar.
        log(app, "Watchdog: janela do toast ausente; recriando.");
        on_main_thread(app, "recriação do toast", |handle| {
            let Some(settings) = handle
                .try_state::<SettingsState>()
                .and_then(|s| lock(&s.0, "configurações").ok().map(|value| value.clone()))
            else {
                return;
            };
            if let Err(error) = create_toast_window(handle, &settings) {
                log(handle, &format!("Falha ao recriar o toast: {error}"));
            }
        });
        return;
    };
    if toast.is_visible().unwrap_or(false) {
        *unanswered_nudges = 0;
        on_main_thread(app, "reafirmação do toast", |handle| {
            let Some(toast) = handle.get_webview_window("toast") else {
                return;
            };
            let always_on_top = handle
                .try_state::<SettingsState>()
                .and_then(|s| {
                    lock(&s.0, "configurações")
                        .ok()
                        .map(|v| v.alert_always_on_top)
                })
                .unwrap_or(true);
            if let Err(error) = show_without_activation(&toast, always_on_top) {
                log(
                    handle,
                    &format!("Watchdog: falha ao reafirmar o toast: {error}"),
                );
            }
        });
        return;
    }
    *unanswered_nudges += 1;
    if *unanswered_nudges >= 4 {
        *unanswered_nudges = 0;
        show_toast_window(app, "watchdog: frontend sem resposta aos avisos");
        return;
    }
    if let Err(error) = toast.emit("queue-updated", ()) {
        log(app, &format!("Watchdog: falha ao avisar o toast: {error}"));
    }
    log(
        app,
        &format!(
            "Watchdog: toast oculto com fila {pending_count}; avisando frontend (tentativa {})...",
            *unanswered_nudges
        ),
    );
}

fn start_scheduler(app: AppHandle, state: NotificationState, paths: Paths) {
    std::thread::spawn(move || {
        log(&app, "Scheduler iniciado.");
        let mut ticks: u64 = 0;
        let mut unanswered_nudges: u32 = 0;
        loop {
            for notification in collect_due(&app, &state, &paths, false) {
                enqueue_alert(&app, notification);
            }
            // Resgata o toast oculto ou atrás de outra janela.
            ensure_toast_presented(&app, &mut unanswered_nudges);
            // Heartbeat a cada ~10 min (40 ticks de 15s): confirma que a thread
            // do scheduler continua viva mesmo após dias de app ligado.
            ticks += 1;
            if ticks.is_multiple_of(40) {
                let queued = app
                    .try_state::<PendingState>()
                    .and_then(|pending| lock(&pending.0, "alertas pendentes").ok().map(|q| q.len()))
                    .unwrap_or(0);
                log(&app, &format!("Scheduler vivo (fila: {queued})."));
            }
            std::thread::sleep(std::time::Duration::from_secs(15));
        }
    });
}

/// Verifica se há versão nova e devolve o número dela, ou `None` se o app já
/// está atualizado. Usado pelo botão "Verificar atualizações".
#[cfg(desktop)]
#[tauri::command]
async fn check_for_update(app: AppHandle) -> Result<Option<String>, String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|error| error.to_string())?;
    match updater.check().await {
        Ok(Some(update)) => {
            log(
                &app,
                &format!("Atualização disponível: {}.", update.version),
            );
            Ok(Some(update.version))
        }
        Ok(None) => {
            log(&app, "Atualização: já está na versão mais recente.");
            Ok(None)
        }
        Err(error) => {
            log(&app, &format!("Atualização: falha ao verificar: {error}"));
            Err(format!("Não foi possível verificar atualizações: {error}"))
        }
    }
}

/// Baixa e instala a atualização, reiniciando o app em seguida. Pedido
/// explícito do usuário, então não passa pelas guardas do check automático.
#[cfg(desktop)]
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    use tauri_plugin_updater::UpdaterExt;

    let updater = app.updater().map_err(|error| error.to_string())?;
    let update = updater
        .check()
        .await
        .map_err(|error| format!("Não foi possível verificar atualizações: {error}"))?
        .ok_or_else(|| "O Noast já está atualizado.".to_string())?;

    log(&app, &format!("Baixando atualização {}...", update.version));
    // `download` confere a assinatura; a instalação fica com o Noast. O
    // `install` do plugin encerra o processo mesmo quando o usuário recusa o
    // pedido de administrador (UAC) — e os lembretes paravam até o próximo login.
    let bytes = update
        .download(|_chunk, _total| {}, || {})
        .await
        .map_err(|error| {
            log(&app, &format!("Atualização: falha ao baixar: {error}"));
            format!("Não foi possível baixar a atualização: {error}")
        })?;
    let version = update.version.clone();
    let launched = tauri::async_runtime::spawn_blocking(move || launch_installer(&version, &bytes))
        .await
        .map_err(|error| error.to_string())?;
    if let Err(error) = launched {
        log(
            &app,
            &format!("Atualização: instalador não iniciado: {error}"),
        );
        return Err(error);
    }

    // O instalador está rodando e vai fechar e reabrir o Noast. Um segredo
    // copiado há menos de 30 s não pode ficar na área de transferência.
    on_main_thread(&app, "encerramento para atualizar", |handle| {
        clear_pending_secret(handle);
        log(
            handle,
            "Atualização: instalador iniciado; encerrando o Noast.",
        );
        handle.exit(0);
    });
    Ok(())
}

/// Grava o instalador baixado (já verificado) e o executa como o plugin faria
/// (`/P` passivo, `/R` reabre o app, `/UPDATE`), mas esperando a resposta do
/// UAC: recusado, o Noast continua aberto e avisa o usuário.
#[cfg(target_os = "windows")]
fn launch_installer(version: &str, bytes: &[u8]) -> Result<(), String> {
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::ERROR_CANCELLED;
    use windows::Win32::System::Com::{
        CoInitializeEx, CoUninitialize, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE,
    };
    use windows::Win32::UI::Shell::{ShellExecuteExW, SEE_MASK_NOASYNC, SHELLEXECUTEINFOW};
    use windows::Win32::UI::WindowsAndMessaging::SW_SHOW;

    if !bytes.starts_with(b"MZ") {
        return Err("O pacote de atualização não é um instalador do Windows.".to_string());
    }
    let path = std::env::temp_dir().join(format!("Noast_{version}_x64-setup.exe"));
    std::fs::write(&path, bytes)
        .map_err(|error| format!("Não foi possível salvar o instalador: {error}"))?;

    let file = HSTRING::from(path.as_os_str());
    let parameters = HSTRING::from("/P /R /UPDATE");
    let mut info = SHELLEXECUTEINFOW {
        cbSize: std::mem::size_of::<SHELLEXECUTEINFOW>() as u32,
        fMask: SEE_MASK_NOASYNC,
        lpVerb: w!("open"),
        lpFile: PCWSTR(file.as_ptr()),
        lpParameters: PCWSTR(parameters.as_ptr()),
        nShow: SW_SHOW.0,
        ..Default::default()
    };
    unsafe {
        // O ShellExecuteEx pede COM inicializado no thread que o chama.
        let com = CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE);
        let result = ShellExecuteExW(&mut info);
        if com.is_ok() {
            CoUninitialize();
        }
        match result {
            Ok(()) => Ok(()),
            Err(error) if error.code() == ERROR_CANCELLED.to_hresult() => Err(
                "A instalação foi cancelada na permissão do Windows. O Noast continua aberto."
                    .to_string(),
            ),
            Err(error) => Err(format!("Não foi possível iniciar o instalador: {error}")),
        }
    }
}

#[cfg(not(target_os = "windows"))]
fn launch_installer(_version: &str, _bytes: &[u8]) -> Result<(), String> {
    Err("A atualização automática está disponível apenas no Windows.".to_string())
}

/// Problemas de leitura na abertura (arquivo danificado, bloqueado), para a
/// janela principal avisar o usuário.
#[tauri::command]
fn get_load_warnings(paths: tauri::State<Paths>) -> Vec<String> {
    paths
        .health
        .notices
        .lock()
        .map(|notices| notices.clone())
        .unwrap_or_default()
}

/// Versão em execução, para exibir nas configurações.
#[tauri::command]
fn app_version(app: AppHandle) -> String {
    app.package_info().version.to_string()
}

/// Versão nova já detectada, para a janela principal mostrar o aviso ao abrir.
#[tauri::command]
fn get_available_update(available: tauri::State<AvailableUpdate>) -> Option<String> {
    available.0.lock().ok().and_then(|value| value.clone())
}

/// Verifica periodicamente se há versão nova publicada nos Releases e avisa a
/// janela principal. NÃO instala sozinho: o instalador pede elevação (UAC), e
/// um prompt surgindo do nada — ou negado com ninguém no PC — encerrava o
/// Noast e parava os lembretes. Quem instala é o usuário, pelo aviso.
#[cfg(desktop)]
fn start_update_check(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    const FIRST_CHECK: Duration = Duration::from_secs(20);
    const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

    std::thread::spawn(move || {
        // Respiro para o app terminar de abrir antes de usar rede/disco.
        std::thread::sleep(FIRST_CHECK);
        loop {
            let app = app.clone();
            tauri::async_runtime::block_on(async move {
                let updater = match app.updater() {
                    Ok(updater) => updater,
                    Err(error) => {
                        log(&app, &format!("Atualizador indisponível: {error}"));
                        return;
                    }
                };
                match updater.check().await {
                    Ok(Some(update)) => {
                        log(
                            &app,
                            &format!(
                                "Atualização disponível: {} (atual: {}). Aguardando o usuário.",
                                update.version, update.current_version
                            ),
                        );
                        if let Some(available) = app.try_state::<AvailableUpdate>() {
                            if let Ok(mut value) = available.0.lock() {
                                *value = Some(update.version.clone());
                            }
                        }
                        if let Err(error) = app.emit("update-available", update.version.clone()) {
                            log(&app, &format!("Falha ao avisar da atualização: {error}"));
                        }
                    }
                    Ok(None) => {}
                    Err(error) => log(&app, &format!("Atualização: falha ao verificar: {error}")),
                }
            });
            std::thread::sleep(INTERVAL);
        }
    });
}

fn install_panic_hook(log_file: PathBuf) {
    std::panic::set_hook(Box::new(move |info| {
        let message = format!("Falha inesperada: {info}");
        eprintln!("{message}");
        append_log(&log_file, &message);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Err(error) = open_main_window(app) {
                log(app, &error);
            }
        }))
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec!["--minimized"]),
        ))
        .setup(|app| {
            #[cfg(desktop)]
            {
                app.handle()
                    .plugin(tauri_plugin_updater::Builder::new().build())?;
            }
            let paths = Paths {
                notifications: notifications_path(app.handle()),
                notes: notes_path(app.handle()),
                vault: vault_path(app.handle()),
                settings: settings_path(app.handle()),
                log: log_path(app.handle()),
                health: Arc::new(StoreHealth::default()),
            };
            install_panic_hook(paths.log.clone());

            // Nenhuma falha de leitura derruba o app: os lembretes são o
            // essencial. Arquivo corrompido (já preservado à parte) → segue
            // vazio; arquivo ilegível → segue vazio SEM gravar por cima.
            // Tudo que der errado aqui também vira aviso na janela principal
            // (get_load_warnings): sem isso a sessão seguia com a lista vazia
            // e o usuário só descobria ao tentar salvar.
            let notice = |text: String| {
                if let Ok(mut notices) = paths.health.notices.lock() {
                    notices.push(text);
                }
            };
            let block = |slot: &Mutex<Option<String>>, what: &str, error: &LoadError| {
                append_log(&paths.log, error.message());
                match error {
                    LoadError::Unreadable(reason) => {
                        if let Ok(mut value) = slot.lock() {
                            *value = Some(reason.clone());
                        }
                        notice(format!(
                            "Não foi possível ler o arquivo de {what}. Para não apagar nada, as alterações não serão salvas nesta sessão — reinicie o Noast."
                        ));
                    }
                    LoadError::Corrupt(_) => notice(format!(
                        "O arquivo de {what} estava danificado e foi guardado à parte (detalhes no noast.log). O Noast começou sem esses dados."
                    )),
                }
            };
            // Veio do backup porque o principal estava ilegível: mostra, mas
            // não grava por cima do principal (provavelmente mais novo).
            let read_only = |slot: &Mutex<Option<String>>, what: &str, reason: Option<String>| {
                if let Some(reason) = reason {
                    notice(format!(
                        "O arquivo de {what} estava bloqueado e foi aberto da cópia de segurança. As alterações não serão salvas nesta sessão — reinicie o Noast."
                    ));
                    append_log(
                        &paths.log,
                        &format!("Somente leitura nesta sessão: {reason}"),
                    );
                    if let Ok(mut value) = slot.lock() {
                        *value = Some(reason);
                    }
                }
            };
            let notifications = match load_notifications(&paths.notifications, &paths.log) {
                Ok(loaded) => {
                    read_only(&paths.health.notifications, "lembretes", loaded.read_only);
                    loaded.value
                }
                Err(error) => {
                    block(&paths.health.notifications, "lembretes", &error);
                    Vec::new()
                }
            };
            append_log(
                &paths.log,
                &format!(
                    "Startup: {} lembrete(s) carregado(s) de {}",
                    notifications.len(),
                    paths.notifications.display()
                ),
            );
            let notes = match load_notes(&paths.notes, &paths.log) {
                Ok(loaded) => {
                    read_only(&paths.health.notes, "notas", loaded.read_only);
                    loaded.value
                }
                Err(error) => {
                    block(&paths.health.notes, "notas", &error);
                    Vec::new()
                }
            };
            let vault = match vault::load(&paths.vault, &paths.log) {
                Ok((vault, reason)) => {
                    read_only(&paths.health.vault, "cofre", reason);
                    vault
                }
                Err(error) => {
                    append_log(&paths.log, &format!("Cofre indisponível: {error}"));
                    if let Ok(mut value) = paths.health.vault.lock() {
                        *value = Some(error);
                    }
                    Vault::default()
                }
            };
            let mut settings = match load_settings(&paths.settings, &paths.log) {
                Ok(loaded) => {
                    read_only(&paths.health.settings, "configurações", loaded.read_only);
                    loaded.value
                }
                Err(error) => {
                    block(&paths.health.settings, "configurações", &error);
                    Settings::default()
                }
            };
            if let Err(error) = settings.validate() {
                append_log(
                    &paths.log,
                    &format!("Configurações inválidas ({error}); usando os padrões."),
                );
                settings = Settings::default();
            }

            let notification_state = NotificationState(Arc::new(Mutex::new(notifications)));
            let note_state = NoteState(Arc::new(Mutex::new(notes)));
            let vault_state = VaultState(Arc::new(Mutex::new(vault)));
            let pending_state = PendingState(Arc::new(Mutex::new(Vec::new())));
            let settings_state = SettingsState(Arc::new(Mutex::new(settings.clone())));
            let snooze_menu_state =
                SnoozeMenuState(Arc::new(Mutex::new(SnoozeMenuSession::default())));
            let custom_snooze_state =
                CustomSnoozeState(Arc::new(Mutex::new(CustomSnoozeSession::default())));

            app.manage(paths.clone());
            app.manage(notification_state.clone());
            app.manage(note_state);
            app.manage(vault_state);
            app.manage(pending_state);
            app.manage(settings_state);
            app.manage(snooze_menu_state);
            app.manage(custom_snooze_state);
            app.manage(NewReminderRequest::default());
            app.manage(AvailableUpdate::default());
            app.manage(PendingSecret::default());

            #[cfg(not(debug_assertions))]
            {
                let result = if settings.start_with_windows {
                    app.autolaunch().enable()
                } else {
                    app.autolaunch().disable()
                };
                if let Err(error) = result {
                    append_log(
                        &paths.log,
                        &format!("Falha ao sincronizar o início com o Windows: {error}"),
                    );
                }
            }

            create_toast_window(app.handle(), &settings)?;
            create_snooze_menu_window(app.handle(), &settings)?;
            create_custom_snooze_window(app.handle(), &settings)?;

            let open_item = MenuItem::with_id(app, "open", "Abrir Noast", true, None::<&str>)?;
            let new_item = MenuItem::with_id(app, "new", "Novo lembrete", true, None::<&str>)?;
            let quit_item = MenuItem::with_id(app, "quit", "Sair", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&open_item, &new_item, &quit_item])?;

            let tray = TrayIconBuilder::new()
                .tooltip("Noast - Lembretes")
                .icon(
                    app.default_window_icon()
                        .cloned()
                        .ok_or_else(|| std::io::Error::other("Ícone padrão indisponível"))?,
                )
                .menu(&tray_menu)
                .build(app)?;

            let click_handle = app.handle().clone();
            tray.on_tray_icon_event(move |_tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    ..
                } = event
                {
                    let action = click_handle
                        .try_state::<SettingsState>()
                        .and_then(|settings| {
                            lock(&settings.0, "configurações")
                                .ok()
                                .map(|value| value.tray_click_action)
                        })
                        .unwrap_or(TrayClickAction::Open);
                    let result = match action {
                        TrayClickAction::Open => open_main_window(&click_handle),
                        TrayClickAction::New => open_new_reminder(&click_handle),
                    };
                    if let Err(error) = result {
                        log(&click_handle, &error);
                    }
                }
            });

            let menu_handle = app.handle().clone();
            tray.on_menu_event(move |_tray, event| match event.id().as_ref() {
                "open" => {
                    if let Err(error) = open_main_window(&menu_handle) {
                        log(&menu_handle, &error);
                    }
                }
                "new" => {
                    if let Err(error) = open_new_reminder(&menu_handle) {
                        log(&menu_handle, &error);
                    }
                }
                "quit" => request_quit(&menu_handle),
                _ => {}
            });

            for notification in collect_due(app.handle(), &notification_state, &paths, true) {
                enqueue_alert(app.handle(), notification);
            }
            start_scheduler(app.handle().clone(), notification_state, paths);
            #[cfg(desktop)]
            start_update_check(app.handle().clone());

            if !std::env::args().any(|argument| argument == "--minimized") {
                open_main_window(app.handle()).map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            let tauri::WindowEvent::CloseRequested { api, .. } = event else {
                return;
            };
            // Nenhuma janela do Noast é destruída: Alt+F4 no toast o destruía
            // e os alertas seguintes nunca mais apareciam.
            api.prevent_close();
            let app = window.app_handle();
            match window.label() {
                "main" => {
                    if let Err(error) = window.hide() {
                        log(
                            app,
                            &format!("Falha ao ocultar a janela principal: {error}"),
                        );
                    }
                }
                "snooze-menu" => hide_snooze_menu_window(app),
                "custom-snooze" => hide_custom_snooze_window(app),
                // O toast só some quando a fila esvazia (invariante do
                // hide_toast); com alertas pendentes o Alt+F4 é ignorado.
                "toast" => {
                    let queue_empty = app
                        .try_state::<PendingState>()
                        .and_then(|state| {
                            lock(&state.0, "alertas pendentes")
                                .ok()
                                .map(|q| q.is_empty())
                        })
                        .unwrap_or(false);
                    if queue_empty {
                        hide_alert_windows(app);
                    } else {
                        log(app, "Toast: fechamento ignorado (há alertas pendentes).");
                    }
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_notifications,
            get_pending_alerts,
            save_notification,
            restore_notification,
            delete_notification,
            get_notes,
            save_note,
            restore_note,
            delete_note,
            get_vault_catalog,
            save_vault_client,
            delete_vault_client,
            get_vault_access,
            save_vault_access,
            delete_vault_access,
            open_external_url,
            mark_done,
            snooze_notification,
            snooze_tomorrow,
            mark_all_done,
            snooze_all,
            get_settings,
            save_user_settings,
            get_snooze_target,
            open_snooze_menu,
            hide_snooze_menu,
            hide_main_window,
            minimize_main_window,
            open_main_from_toast,
            hide_toast,
            present_toast,
            open_custom_snooze,
            get_custom_snooze_target,
            hide_custom_snooze,
            reschedule_notification,
            take_new_reminder_request,
            ready_to_quit,
            copy_secret,
            get_available_update,
            get_load_warnings,
            app_version,
            check_for_update,
            install_update,
        ])
        .build(tauri::generate_context!())
        .expect("erro ao iniciar Noast")
        .run(|_app_handle, event| {
            if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
                if code.is_none() {
                    api.prevent_exit();
                }
            }
        });
}
