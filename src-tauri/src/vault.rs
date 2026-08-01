use crate::model::Vault;
use crate::repository::{load_protected_backup, load_protected_bytes, save_protected_bytes};
use std::path::Path;

pub fn load(path: &Path) -> Result<Vault, String> {
    let Some(encrypted) = load_protected_bytes(path)? else {
        return Ok(Vault::default());
    };
    match decode(&encrypted) {
        Ok(vault) => Ok(vault),
        Err(primary_error) => {
            if let Some(backup) = load_protected_backup(path)? {
                if let Ok(vault) = decode(&backup) {
                    return Ok(vault);
                }
            }
            Err(format!(
                "{primary_error} O backup criptografado também não pôde ser recuperado."
            ))
        }
    }
}

pub fn save(path: &Path, vault: &Vault) -> Result<(), String> {
    let plain = serde_json::to_vec(vault)
        .map_err(|error| format!("Falha ao serializar o cofre: {error}"))?;
    let encrypted = protect(&plain)?;
    save_protected_bytes(path, &encrypted)
}

fn decode(encrypted: &[u8]) -> Result<Vault, String> {
    let plain = unprotect(encrypted)?;
    serde_json::from_slice(&plain).map_err(|error| format!("Falha ao interpretar o cofre: {error}"))
}

#[cfg(target_os = "windows")]
fn protect(value: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptProtectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: value
            .len()
            .try_into()
            .map_err(|_| "O cofre excedeu o tamanho suportado.".to_string())?,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptProtectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|error| format!("Falha ao proteger o cofre: {error}"))?;
        let encrypted = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        Ok(encrypted)
    }
}

#[cfg(target_os = "windows")]
fn unprotect(value: &[u8]) -> Result<Vec<u8>, String> {
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Cryptography::{
        CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    };

    let input = CRYPT_INTEGER_BLOB {
        cbData: value
            .len()
            .try_into()
            .map_err(|_| "O cofre excedeu o tamanho suportado.".to_string())?,
        pbData: value.as_ptr() as *mut u8,
    };
    let mut output = CRYPT_INTEGER_BLOB::default();
    unsafe {
        CryptUnprotectData(
            &input,
            None,
            None,
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            &mut output,
        )
        .map_err(|error| {
            format!("Não foi possível abrir o cofre neste usuário do Windows: {error}")
        })?;
        let plain = std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec();
        let _ = LocalFree(HLOCAL(output.pbData.cast()));
        Ok(plain)
    }
}

#[cfg(not(target_os = "windows"))]
fn protect(_value: &[u8]) -> Result<Vec<u8>, String> {
    Err("O cofre local está disponível apenas no Windows.".to_string())
}

#[cfg(not(target_os = "windows"))]
fn unprotect(_value: &[u8]) -> Result<Vec<u8>, String> {
    Err("O cofre local está disponível apenas no Windows.".to_string())
}

#[cfg(all(test, target_os = "windows"))]
mod tests {
    use super::*;
    use crate::model::{VaultAccess, VaultClient};
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn vault_is_encrypted_at_rest_and_can_be_reopened() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock")
            .as_nanos();
        let path = std::env::temp_dir().join(format!("noast-vault-{nonce}.dat"));
        let vault = Vault {
            clients: vec![VaultClient {
                id: "client-1".into(),
                name: "Cliente".into(),
                parent_id: String::new(),
                notes: String::new(),
                created_at: String::new(),
                updated_at: String::new(),
            }],
            accesses: vec![VaultAccess {
                id: "access-1".into(),
                client_id: "client-1".into(),
                label: "Login".into(),
                service: "E-mail".into(),
                url: String::new(),
                username: "usuario".into(),
                password: "segredo-improvavel-123".into(),
                recovery_email: String::new(),
                notes: String::new(),
                created_at: String::new(),
                updated_at: String::new(),
            }],
        };

        save(&path, &vault).expect("save");
        let encrypted = fs::read(&path).expect("encrypted bytes");
        assert!(!encrypted
            .windows(b"segredo-improvavel-123".len())
            .any(|window| window == b"segredo-improvavel-123"));

        let reopened = load(&path).expect("load");
        assert_eq!(reopened.accesses[0].password, "segredo-improvavel-123");

        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(path.with_extension("bak"));
    }
}
