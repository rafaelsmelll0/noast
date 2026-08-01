use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Note {
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub pinned: bool,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Vault {
    #[serde(default)]
    pub clients: Vec<VaultClient>,
    #[serde(default)]
    pub accesses: Vec<VaultAccess>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultClient {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

impl VaultClient {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("Identificador do cliente inválido.".to_string());
        }
        if self.name.trim().is_empty() {
            return Err("O nome do cliente é obrigatório.".to_string());
        }
        if self.name.chars().count() > 120 {
            return Err("O nome do cliente deve ter no máximo 120 caracteres.".to_string());
        }
        if self.notes.chars().count() > 2_000 {
            return Err(
                "As observações do cliente devem ter no máximo 2.000 caracteres.".to_string(),
            );
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VaultAccess {
    pub id: String,
    pub client_id: String,
    pub label: String,
    #[serde(default)]
    pub service: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub recovery_email: String,
    #[serde(default)]
    pub notes: String,
    #[serde(default)]
    pub created_at: String,
    #[serde(default)]
    pub updated_at: String,
}

impl VaultAccess {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() || self.client_id.trim().is_empty() {
            return Err("Identificador do acesso inválido.".to_string());
        }
        if self.label.trim().is_empty() {
            return Err("O nome do acesso é obrigatório.".to_string());
        }
        if self.label.chars().count() > 120 || self.service.chars().count() > 80 {
            return Err("O nome ou tipo do acesso é muito longo.".to_string());
        }
        if self.url.chars().count() > 2_000
            || self.username.chars().count() > 500
            || self.password.chars().count() > 2_000
            || self.recovery_email.chars().count() > 500
            || self.notes.chars().count() > 5_000
        {
            return Err("Um dos campos do acesso excedeu o tamanho permitido.".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultAccessSummary {
    pub id: String,
    pub client_id: String,
    pub label: String,
    pub service: String,
    pub url: String,
    pub username: String,
    pub has_password: bool,
    pub updated_at: String,
}

impl From<&VaultAccess> for VaultAccessSummary {
    fn from(access: &VaultAccess) -> Self {
        Self {
            id: access.id.clone(),
            client_id: access.client_id.clone(),
            label: access.label.clone(),
            service: access.service.clone(),
            url: access.url.clone(),
            username: access.username.clone(),
            has_password: !access.password.is_empty(),
            updated_at: access.updated_at.clone(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct VaultCatalog {
    pub clients: Vec<VaultClient>,
    pub accesses: Vec<VaultAccessSummary>,
}

impl From<&Vault> for VaultCatalog {
    fn from(vault: &Vault) -> Self {
        Self {
            clients: vault.clients.clone(),
            accesses: vault
                .accesses
                .iter()
                .map(VaultAccessSummary::from)
                .collect(),
        }
    }
}

impl Note {
    pub fn validate(&self) -> Result<(), String> {
        if self.id.trim().is_empty() {
            return Err("Identificador da nota inválido.".to_string());
        }
        if self.title.chars().count() > 120 {
            return Err("O título deve ter no máximo 120 caracteres.".to_string());
        }
        if self.content.chars().count() > 50_000 {
            return Err("A nota deve ter no máximo 50.000 caracteres.".to_string());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    #[default]
    None,
    Daily,
    Weekly,
    Biweekly,
    Monthly,
    Yearly,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Notification {
    pub id: String,
    pub text: String,
    pub datetime: String,
    #[serde(default)]
    pub repeat: Repeat,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub last_fired: String,
}

impl Notification {
    pub fn parsed_datetime(&self) -> Result<NaiveDateTime, String> {
        NaiveDateTime::parse_from_str(&self.datetime, "%Y-%m-%dT%H:%M:%S")
            .map_err(|_| "Data e hora inválidas.".to_string())
    }

    pub fn validate(&self) -> Result<(), String> {
        let text = self.text.trim();
        if self.id.trim().is_empty() {
            return Err("Identificador do lembrete inválido.".to_string());
        }
        if text.is_empty() {
            return Err("A mensagem do lembrete é obrigatória.".to_string());
        }
        if text.chars().count() > 80 {
            return Err("A mensagem deve ter no máximo 80 caracteres.".to_string());
        }
        self.parsed_datetime()?;
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AlertMonitor {
    Cursor,
    Primary,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TrayClickAction {
    Open,
    New,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct Settings {
    pub theme: Theme,
    pub snooze_minutes: u32,
    pub alert_monitor: AlertMonitor,
    pub alert_always_on_top: bool,
    pub alert_sound: bool,
    pub start_with_windows: bool,
    pub tray_click_action: TrayClickAction,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            theme: Theme::System,
            snooze_minutes: 15,
            alert_monitor: AlertMonitor::Cursor,
            alert_always_on_top: true,
            alert_sound: true,
            start_with_windows: true,
            tray_click_action: TrayClickAction::Open,
        }
    }
}

impl Settings {
    pub fn validate(&self) -> Result<(), String> {
        if !(1..=1_440).contains(&self.snooze_minutes) {
            return Err("O adiamento padrão deve ficar entre 1 minuto e 24 horas.".to_string());
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note() -> Note {
        Note {
            id: "note-1".into(),
            title: String::new(),
            content: String::new(),
            pinned: false,
            created_at: String::new(),
            updated_at: String::new(),
        }
    }

    #[test]
    fn empty_note_is_valid_for_autosave() {
        assert!(note().validate().is_ok());
    }

    #[test]
    fn note_limits_are_enforced() {
        let mut value = note();
        value.title = "a".repeat(121);
        assert!(value.validate().is_err());

        value.title.clear();
        value.content = "a".repeat(50_001);
        assert!(value.validate().is_err());
    }

    #[test]
    fn vault_catalog_never_contains_passwords() {
        let vault = Vault {
            clients: Vec::new(),
            accesses: vec![VaultAccess {
                id: "access-1".into(),
                client_id: "client-1".into(),
                label: "Painel".into(),
                service: "cPanel".into(),
                url: String::new(),
                username: "rafael".into(),
                password: "segredo-real".into(),
                recovery_email: String::new(),
                notes: String::new(),
                created_at: String::new(),
                updated_at: String::new(),
            }],
        };

        let json = serde_json::to_string(&VaultCatalog::from(&vault)).expect("catalog");
        assert!(!json.contains("segredo-real"));
        assert!(json.contains("\"has_password\":true"));
    }
}
