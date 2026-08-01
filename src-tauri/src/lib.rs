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
};
use scheduler::{
    advance_after, is_due, occurrence_key, reschedule_to, snooze, snooze_until_tomorrow,
};
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager, PhysicalPosition, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
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
}

#[derive(Clone)]
struct Paths {
    notifications: PathBuf,
    notes: PathBuf,
    vault: PathBuf,
    settings: PathBuf,
    log: PathBuf,
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
        let _ = window.emit("notifications-changed", ());
    }
}

fn emit_queue_changed(app: &AppHandle) {
    let queue_empty = app
        .try_state::<PendingState>()
        .and_then(|state| {
            lock(&state.0, "alertas pendentes")
                .ok()
                .map(|queue| queue.is_empty())
        })
        .unwrap_or(false);
    if queue_empty {
        hide_alert_windows(app);
    }
    if let Some(window) = app.get_webview_window("toast") {
        let _ = window.emit("queue-updated", ());
    }
}

/// Fecha apenas os submenus de adiamento (menu "…" e Personalizar), sem tocar
/// no toast. Usado quando o toast deve permanecer (ex.: abrir o Noast).
fn hide_snooze_submenus(app: &AppHandle) {
    if let Some(state) = app.try_state::<SnoozeMenuState>() {
        if let Ok(mut session) = lock(&state.0, "menu de adiamento") {
            session.visible = false;
        }
    }
    if let Some(menu) = app.get_webview_window("snooze-menu") {
        let _ = menu.hide();
        let _ = menu.set_position(PhysicalPosition::new(-10_000, -10_000));
    }
    if let Some(state) = app.try_state::<CustomSnoozeState>() {
        if let Ok(mut session) = lock(&state.0, "personalizar adiamento") {
            session.visible = false;
        }
    }
    if let Some(window) = app.get_webview_window("custom-snooze") {
        let _ = window.hide();
        let _ = window.set_position(PhysicalPosition::new(-10_000, -10_000));
    }
}

fn hide_alert_windows(app: &AppHandle) {
    hide_snooze_submenus(app);
    if let Some(toast) = app.get_webview_window("toast") {
        let _ = toast.hide();
        let _ = toast.set_position(PhysicalPosition::new(-10_000, -10_000));
    }
}

fn persist_notifications(paths: &Paths, notifications: &[Notification]) -> Result<(), String> {
    save_notifications(&paths.notifications, notifications)
}

fn persist_notes(paths: &Paths, notes: &[Note]) -> Result<(), String> {
    save_notes(&paths.notes, notes)
}

fn persist_vault(paths: &Paths, vault: &Vault) -> Result<(), String> {
    vault::save(&paths.vault, vault)
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

    {
        let mut notifications = lock(&state.0, "lembretes")?;
        if let Some(current) = notifications
            .iter()
            .position(|item| item.id == notification.id)
        {
            let existing = &notifications[current];
            notification.done = existing.done;
            if existing.datetime == notification.datetime && existing.repeat == notification.repeat
            {
                notification.last_fired = existing.last_fired.clone();
            } else {
                notification.last_fired.clear();
                notification.done = false;
            }
            notifications[current] = notification;
        } else {
            notification.done = false;
            notification.last_fired.clear();
            notifications.push(notification);
        }
        persist_notifications(&paths, &notifications)?;
    }
    lock(&pending.0, "alertas pendentes")?.retain(|item| item.id != notification_id);

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
    notification: Notification,
) -> Result<(), String> {
    notification.validate()?;
    {
        let mut notifications = lock(&state.0, "lembretes")?;
        if notifications.iter().any(|item| item.id == notification.id) {
            return Err("Este lembrete já foi restaurado.".to_string());
        }
        notifications.push(notification);
        persist_notifications(&paths, &notifications)?;
    }
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
    {
        let mut notifications = lock(&state.0, "lembretes")?;
        let previous_len = notifications.len();
        notifications.retain(|item| item.id != id);
        if notifications.len() == previous_len {
            return Err("Lembrete não encontrado.".to_string());
        }
        persist_notifications(&paths, &notifications)?;
    }
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

    {
        let mut notes = lock(&state.0, "notas")?;
        if let Some(current) = notes.iter().position(|item| item.id == note.id) {
            note.created_at = notes[current].created_at.clone();
            note.updated_at = now;
            notes[current] = note.clone();
        } else {
            note.created_at = now.clone();
            note.updated_at = now;
            notes.push(note.clone());
        }
        persist_notes(&paths, &notes)?;
    }

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

    {
        let mut notes = lock(&state.0, "notas")?;
        if notes.iter().any(|item| item.id == note.id) {
            return Err("Esta nota já foi restaurada.".to_string());
        }
        if note.created_at.is_empty() {
            note.created_at = Local::now().to_rfc3339();
        }
        note.updated_at = Local::now().to_rfc3339();
        notes.push(note.clone());
        persist_notes(&paths, &notes)?;
    }

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
    {
        let mut notes = lock(&state.0, "notas")?;
        let previous_len = notes.len();
        notes.retain(|item| item.id != id);
        if notes.len() == previous_len {
            return Err("Nota não encontrada.".to_string());
        }
        persist_notes(&paths, &notes)?;
    }

    log(&app, "Nota excluída.");
    Ok(())
}

#[tauri::command]
fn get_vault_catalog(state: tauri::State<VaultState>) -> Result<VaultCatalog, String> {
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
    let now = Local::now().to_rfc3339();

    {
        let mut vault = lock(&state.0, "cofre")?;
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
    let mut vault = lock(&state.0, "cofre")?;
    let mut next = vault.clone();
    let previous_len = next.clients.len();
    next.clients.retain(|item| item.id != id);
    if previous_len == next.clients.len() {
        return Err("Cliente não encontrado.".to_string());
    }
    next.accesses.retain(|item| item.client_id != id);
    persist_vault(&paths, &next)?;
    *vault = next;
    Ok(())
}

#[tauri::command]
fn get_vault_access(state: tauri::State<VaultState>, id: String) -> Result<VaultAccess, String> {
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

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let normalized = if url.starts_with("https://") || url.starts_with("http://") {
        url
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

fn finish_notification(
    id: &str,
    now: NaiveDateTime,
    paths: &Paths,
    state: &NotificationState,
) -> Result<(), String> {
    let mut notifications = lock(&state.0, "lembretes")?;
    let notification = notifications
        .iter_mut()
        .find(|item| item.id == id)
        .ok_or_else(|| "Lembrete não encontrado.".to_string())?;
    advance_after(notification, now)?;
    persist_notifications(paths, &notifications)
}

#[tauri::command]
fn mark_done(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NotificationState>,
    pending: tauri::State<PendingState>,
    id: String,
) -> Result<(), String> {
    finish_notification(&id, Local::now().naive_local(), &paths, &state)?;
    lock(&pending.0, "alertas pendentes")?.retain(|item| item.id != id);
    emit_main_changed(&app);
    emit_queue_changed(&app);
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

    {
        let mut notifications = lock(&state.0, "lembretes")?;
        let notification = notifications
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| "Lembrete não encontrado.".to_string())?;
        snooze(notification, minutes, Local::now().naive_local());
        persist_notifications(&paths, &notifications)?;
    }
    lock(&pending.0, "alertas pendentes")?.retain(|item| item.id != id);
    emit_main_changed(&app);
    emit_queue_changed(&app);
    Ok(())
}

#[tauri::command]
fn snooze_tomorrow(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NotificationState>,
    pending: tauri::State<PendingState>,
    id: String,
) -> Result<(), String> {
    {
        let mut notifications = lock(&state.0, "lembretes")?;
        let notification = notifications
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| "Lembrete não encontrado.".to_string())?;
        snooze_until_tomorrow(notification, Local::now().naive_local())?;
        persist_notifications(&paths, &notifications)?;
    }
    lock(&pending.0, "alertas pendentes")?.retain(|item| item.id != id);
    emit_main_changed(&app);
    emit_queue_changed(&app);
    Ok(())
}

#[tauri::command]
fn mark_all_done(
    app: AppHandle,
    paths: tauri::State<Paths>,
    state: tauri::State<NotificationState>,
    pending: tauri::State<PendingState>,
) -> Result<(), String> {
    let ids: Vec<String> = lock(&pending.0, "alertas pendentes")?
        .iter()
        .map(|item| item.id.clone())
        .collect();
    let now = Local::now().naive_local();

    {
        let mut notifications = lock(&state.0, "lembretes")?;
        for notification in notifications
            .iter_mut()
            .filter(|item| ids.contains(&item.id))
        {
            advance_after(notification, now)?;
        }
        persist_notifications(&paths, &notifications)?;
    }
    lock(&pending.0, "alertas pendentes")?.clear();
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
    let ids: Vec<String> = lock(&pending.0, "alertas pendentes")?
        .iter()
        .map(|item| item.id.clone())
        .collect();

    {
        let now = Local::now().naive_local();
        let mut notifications = lock(&state.0, "lembretes")?;
        for notification in notifications
            .iter_mut()
            .filter(|item| ids.contains(&item.id))
        {
            snooze(notification, minutes, now);
        }
        persist_notifications(&paths, &notifications)?;
    }
    lock(&pending.0, "alertas pendentes")?.clear();
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
    if settings.start_with_windows {
        app.autolaunch()
            .enable()
            .map_err(|error| error.to_string())?;
    } else {
        app.autolaunch()
            .disable()
            .map_err(|error| error.to_string())?;
    }
    save_settings(&paths.settings, &settings)?;
    *lock(&state.0, "configurações")? = settings.clone();

    if let Some(toast) = app.get_webview_window("toast") {
        let _ = toast.set_always_on_top(settings.alert_always_on_top);
        let _ = toast.emit("settings-changed", settings.clone());
    }
    if let Some(menu) = app.get_webview_window("snooze-menu") {
        let _ = menu.set_always_on_top(settings.alert_always_on_top);
        let _ = menu.emit("settings-changed", settings);
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

#[tauri::command]
fn open_snooze_menu(
    app: AppHandle,
    state: tauri::State<SnoozeMenuState>,
    settings: tauri::State<SettingsState>,
    id: String,
    anchor: SnoozeMenuAnchor,
) -> Result<bool, String> {
    const WIDTH: f64 = 168.0;
    const HEIGHT: f64 = 190.0;
    const GAP: f64 = 6.0;

    let toast = app
        .get_webview_window("toast")
        .ok_or_else(|| "Janela de alerta indisponível.".to_string())?;
    let menu = app
        .get_webview_window("snooze-menu")
        .ok_or_else(|| "Menu de adiamento indisponível.".to_string())?;
    let mut session = lock(&state.0, "menu de adiamento")?;
    let same_target = session
        .target_id
        .as_ref()
        .is_some_and(|target| target == &id);
    if same_target && session.visible {
        session.visible = false;
        drop(session);
        menu.hide().map_err(|error| error.to_string())?;
        let _ = menu.set_position(PhysicalPosition::new(-10_000, -10_000));
        log(&app, "Menu de adiamento: fechado pelo toggle.");
        return Ok(false);
    }
    session.target_id = Some(id);
    session.visible = true;
    drop(session);
    let toast_position = toast.outer_position().map_err(|error| error.to_string())?;
    let scale = toast.scale_factor().map_err(|error| error.to_string())?;
    let monitor = toast
        .monitor_from_point(f64::from(toast_position.x), f64::from(toast_position.y))
        .map_err(|error| error.to_string())?
        .or_else(|| toast.primary_monitor().ok().flatten())
        .ok_or_else(|| "Não foi possível localizar o monitor.".to_string())?;
    let work_area = monitor.work_area();

    let desired_x = toast_position.x + ((anchor.x + anchor.width - WIDTH) * scale).round() as i32;
    let menu_width = (WIDTH * scale).round() as i32;
    let min_x = work_area.position.x;
    let max_x = work_area.position.x + work_area.size.width as i32 - menu_width;
    let x = desired_x.clamp(min_x, max_x);
    let above = toast_position.y + ((anchor.top - HEIGHT - GAP) * scale).round() as i32;
    let below = toast_position.y + ((anchor.bottom + GAP) * scale).round() as i32;
    let y = if above >= work_area.position.y {
        above
    } else {
        below
    };

    menu.set_size(tauri::LogicalSize::new(WIDTH, HEIGHT))
        .map_err(|error| error.to_string())?;
    menu.set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;
    let always_on_top = lock(&settings.0, "configurações")?.alert_always_on_top;
    if let Err(error) = show_without_activation(&menu, always_on_top) {
        if let Ok(mut session) = lock(&state.0, "menu de adiamento") {
            session.visible = false;
        }
        return Err(error);
    }
    log(&app, "Menu de adiamento: aberto pelo toggle.");
    Ok(true)
}

#[tauri::command]
fn hide_snooze_menu(app: AppHandle, state: tauri::State<SnoozeMenuState>) -> Result<(), String> {
    lock(&state.0, "menu de adiamento")?.visible = false;
    if let Some(menu) = app.get_webview_window("snooze-menu") {
        menu.hide().map_err(|error| error.to_string())?;
        let _ = menu.set_position(PhysicalPosition::new(-10_000, -10_000));
    }
    log(&app, "Menu de adiamento: fechado explicitamente.");
    Ok(())
}

#[tauri::command]
fn open_custom_snooze(
    app: AppHandle,
    state: tauri::State<CustomSnoozeState>,
    settings: tauri::State<SettingsState>,
    id: String,
    anchor: SnoozeMenuAnchor,
) -> Result<bool, String> {
    const WIDTH: f64 = 248.0;
    const HEIGHT: f64 = 208.0;
    const GAP: f64 = 6.0;

    let toast = app
        .get_webview_window("toast")
        .ok_or_else(|| "Janela de alerta indisponível.".to_string())?;
    let window = app
        .get_webview_window("custom-snooze")
        .ok_or_else(|| "Janela de personalização indisponível.".to_string())?;

    {
        let mut session = lock(&state.0, "personalizar adiamento")?;
        session.target_id = Some(id);
        session.visible = true;
    }

    let toast_position = toast.outer_position().map_err(|error| error.to_string())?;
    let scale = toast.scale_factor().map_err(|error| error.to_string())?;
    let monitor = toast
        .monitor_from_point(f64::from(toast_position.x), f64::from(toast_position.y))
        .map_err(|error| error.to_string())?
        .or_else(|| toast.primary_monitor().ok().flatten())
        .ok_or_else(|| "Não foi possível localizar o monitor.".to_string())?;
    let work_area = monitor.work_area();

    let desired_x = toast_position.x + ((anchor.x + anchor.width - WIDTH) * scale).round() as i32;
    let menu_width = (WIDTH * scale).round() as i32;
    let min_x = work_area.position.x;
    let max_x = work_area.position.x + work_area.size.width as i32 - menu_width;
    let x = desired_x.clamp(min_x, max_x);
    let above = toast_position.y + ((anchor.top - HEIGHT - GAP) * scale).round() as i32;
    let below = toast_position.y + ((anchor.bottom + GAP) * scale).round() as i32;
    let y = if above >= work_area.position.y {
        above
    } else {
        below
    };

    window
        .set_size(tauri::LogicalSize::new(WIDTH, HEIGHT))
        .map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|error| error.to_string())?;

    let always_on_top = lock(&settings.0, "configurações")?.alert_always_on_top;
    // Primeiro exibe sem ativação — é o que garante que a janela apareça e
    // receba cliques (show() + set_focus() a partir de um app em segundo plano
    // a deixava visível porém surda). Só depois pede o foco, para o teclado
    // funcionar (digitar a data, Enter confirmar, Esc fechar). Se o foco falhar,
    // a janela continua utilizável no mouse.
    show_without_activation(&window, always_on_top)?;
    if let Err(error) = window.set_focus() {
        log(&app, &format!("Personalizar: sem foco de teclado: {error}"));
    }
    // A janela é reutilizada: avisa o frontend para resetar (botão habilitado,
    // sugestão de horário fresca) a cada abertura.
    let _ = app.emit("custom-snooze-open", ());

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
fn hide_custom_snooze(
    app: AppHandle,
    state: tauri::State<CustomSnoozeState>,
) -> Result<(), String> {
    lock(&state.0, "personalizar adiamento")?.visible = false;
    if let Some(window) = app.get_webview_window("custom-snooze") {
        window.hide().map_err(|error| error.to_string())?;
        let _ = window.set_position(PhysicalPosition::new(-10_000, -10_000));
    }
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

    {
        let mut list = lock(&notifications.0, "lembretes")?;
        let notification = list
            .iter_mut()
            .find(|item| item.id == id)
            .ok_or_else(|| "Lembrete não encontrado.".to_string())?;
        reschedule_to(notification, target, now)?;
        persist_notifications(&paths, &list)?;
    }

    lock(&pending.0, "alertas pendentes")?.retain(|item| item.id != id);

    log(&app, "Personalizar: reagendado com sucesso.");
    emit_main_changed(&app);
    emit_queue_changed(&app);
    Ok(())
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
fn open_main_from_toast(app: AppHandle) -> Result<(), String> {
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

    window
        .set_size(tauri::LogicalSize::new(WIDTH, height))
        .map_err(|error| error.to_string())?;
    window
        .set_position(PhysicalPosition::new(x, y))
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
    .inner_size(248.0, 208.0)
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
    if let Some(window) = app.get_webview_window("main") {
        window.show().map_err(|error| error.to_string())?;
        window.set_focus().map_err(|error| error.to_string())?;
        return Ok(());
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
    window.set_focus().map_err(|error| error.to_string())
}

fn open_new_reminder(app: &AppHandle) -> Result<(), String> {
    open_main_window(app)?;
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.emit("open-new-reminder", ());
    }
    Ok(())
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
    let Some(pending) = app.try_state::<PendingState>() else {
        log(app, "Fila de alertas indisponível.");
        return;
    };
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
        if let Err(error) = persist_notifications(paths, &notifications) {
            log(app, &format!("Falha ao persistir disparos: {error}"));
            return Vec::new();
        }
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
    let submenu_open = app
        .try_state::<SnoozeMenuState>()
        .and_then(|s| lock(&s.0, "menu de adiamento").ok().map(|v| v.visible))
        .unwrap_or(false)
        || app
            .try_state::<CustomSnoozeState>()
            .and_then(|s| lock(&s.0, "personalizar adiamento").ok().map(|v| v.visible))
            .unwrap_or(false);
    if submenu_open {
        *unanswered_nudges = 0;
        return;
    }
    let Some(toast) = app.get_webview_window("toast") else {
        return;
    };
    if toast.is_visible().unwrap_or(false) {
        *unanswered_nudges = 0;
        let always_on_top = app
            .try_state::<SettingsState>()
            .and_then(|s| {
                lock(&s.0, "configurações")
                    .ok()
                    .map(|v| v.alert_always_on_top)
            })
            .unwrap_or(true);
        let _ = show_without_activation(&toast, always_on_top);
        return;
    }
    *unanswered_nudges += 1;
    if *unanswered_nudges >= 4 {
        *unanswered_nudges = 0;
        show_toast_window(app, "watchdog: frontend sem resposta aos avisos");
        return;
    }
    let _ = toast.emit("queue-updated", ());
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
            if ticks % 40 == 0 {
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

/// Instalar reinicia o aplicativo, então só é aceitável quando o usuário não
/// está no meio de algo: sem alertas na fila e com a janela principal fechada
/// (o uso normal é pela bandeja). Caso contrário, a atualização espera a
/// próxima rodada.
#[cfg(desktop)]
fn safe_to_install_update(app: &AppHandle) -> Result<(), &'static str> {
    let busy_queue = app
        .try_state::<PendingState>()
        .and_then(|pending| lock(&pending.0, "alertas pendentes").ok().map(|q| !q.is_empty()))
        .unwrap_or(false);
    if busy_queue {
        return Err("há lembretes na fila");
    }
    let main_open = app
        .get_webview_window("main")
        .and_then(|window| window.is_visible().ok())
        .unwrap_or(false);
    if main_open {
        return Err("a janela principal está aberta");
    }
    Ok(())
}

/// Verifica periodicamente se há versão nova publicada nos Releases e, havendo,
/// baixa e instala em um momento seguro. A verificação se repete enquanto o app
/// estiver aberto — ficar dias ligado é o uso normal, e só checar no startup
/// deixaria essas sessões sem nunca atualizar. Cada passo é registrado no log.
#[cfg(desktop)]
fn start_update_check(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;

    use std::time::Duration;

    const FIRST_CHECK: Duration = Duration::from_secs(20);
    const INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
    // Quando há atualização mas o momento é ruim, tenta de novo mais cedo.
    const RETRY: Duration = Duration::from_secs(15 * 60);

    std::thread::spawn(move || {
        // Respiro para o app terminar de abrir antes de usar rede/disco.
        std::thread::sleep(FIRST_CHECK);
        loop {
            let app = app.clone();
            let postponed = tauri::async_runtime::block_on(async move {
                let updater = match app.updater() {
                    Ok(updater) => updater,
                    Err(error) => {
                        log(&app, &format!("Atualizador indisponível: {error}"));
                        return false;
                    }
                };

                let update = match updater.check().await {
                    Ok(Some(update)) => update,
                    Ok(None) => return false,
                    Err(error) => {
                        log(&app, &format!("Atualização: falha ao verificar: {error}"));
                        return false;
                    }
                };

                if let Err(reason) = safe_to_install_update(&app) {
                    log(
                        &app,
                        &format!(
                            "Atualização {} disponível, adiada porque {reason}.",
                            update.version
                        ),
                    );
                    return true;
                }

                log(
                    &app,
                    &format!(
                        "Atualização disponível: {} (atual: {}). Baixando...",
                        update.version, update.current_version
                    ),
                );

                match update.download_and_install(|_chunk, _total| {}, || {}).await {
                    Ok(()) => {
                        log(&app, "Atualização instalada; reiniciando o Noast.");
                        app.restart();
                    }
                    Err(error) => log(&app, &format!("Atualização: falha ao instalar: {error}")),
                }
                false
            });

            std::thread::sleep(if postponed { RETRY } else { INTERVAL });
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
                start_update_check(app.handle().clone());
            }
            let paths = Paths {
                notifications: notifications_path(app.handle()),
                notes: notes_path(app.handle()),
                vault: vault_path(app.handle()),
                settings: settings_path(app.handle()),
                log: log_path(app.handle()),
            };
            install_panic_hook(paths.log.clone());

            let notifications = load_notifications(&paths.notifications).unwrap_or_else(|error| {
                append_log(&paths.log, &error);
                Vec::new()
            });
            append_log(
                &paths.log,
                &format!(
                    "Startup: {} lembrete(s) carregado(s) de {}",
                    notifications.len(),
                    paths.notifications.display()
                ),
            );
            let notes = load_notes(&paths.notes).unwrap_or_else(|error| {
                append_log(&paths.log, &error);
                Vec::new()
            });
            let vault = vault::load(&paths.vault).map_err(std::io::Error::other)?;
            let settings = load_settings(&paths.settings).unwrap_or_else(|error| {
                append_log(&paths.log, &error);
                Settings::default()
            });
            settings.validate().map_err(std::io::Error::other)?;

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

            #[cfg(not(debug_assertions))]
            {
                if settings.start_with_windows {
                    let _ = app.autolaunch().enable();
                } else {
                    let _ = app.autolaunch().disable();
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
                "quit" => menu_handle.exit(0),
                _ => {}
            });

            for notification in collect_due(app.handle(), &notification_state, &paths, true) {
                enqueue_alert(app.handle(), notification);
            }
            start_scheduler(app.handle().clone(), notification_state, paths);

            if !std::env::args().any(|argument| argument == "--minimized") {
                open_main_window(app.handle()).map_err(std::io::Error::other)?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let _ = window.hide();
                    api.prevent_close();
                }
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
