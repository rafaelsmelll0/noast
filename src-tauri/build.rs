// Comandos do app declarados no manifesto: sem isto qualquer janela pode
// chamar qualquer comando — inclusive o toast lendo senhas do cofre. Cada
// janela recebe só o que usa, em capabilities/*.json.
const COMMANDS: &[&str] = &[
    "get_notifications",
    "get_pending_alerts",
    "save_notification",
    "restore_notification",
    "delete_notification",
    "get_notes",
    "save_note",
    "restore_note",
    "delete_note",
    "get_vault_catalog",
    "save_vault_client",
    "delete_vault_client",
    "get_vault_access",
    "save_vault_access",
    "delete_vault_access",
    "open_external_url",
    "copy_secret",
    "mark_done",
    "snooze_notification",
    "snooze_tomorrow",
    "mark_all_done",
    "snooze_all",
    "get_settings",
    "save_user_settings",
    "get_snooze_target",
    "open_snooze_menu",
    "hide_snooze_menu",
    "hide_main_window",
    "minimize_main_window",
    "open_main_from_toast",
    "hide_toast",
    "present_toast",
    "open_custom_snooze",
    "get_custom_snooze_target",
    "hide_custom_snooze",
    "reschedule_notification",
    "take_new_reminder_request",
    "ready_to_quit",
    "get_available_update",
    "get_load_warnings",
    "app_version",
    "check_for_update",
    "install_update",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("falha ao executar o tauri-build");
}
