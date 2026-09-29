//! Área de transferência para segredos do cofre. Fica no backend porque a API
//! do navegador só funciona com a janela em foco — e a limpeza acontece
//! quando o usuário já está colando a senha em outro programa.

use tauri::WebviewWindow;

/// Coloca `value` na área de transferência marcado para ficar fora do
/// histórico do Win+V, da sincronização na nuvem e de monitores de clipboard.
/// Devolve o número de sequência resultante, que identifica esta cópia.
#[cfg(target_os = "windows")]
pub fn copy_sensitive(window: &WebviewWindow, value: &str) -> Result<u32, String> {
    use windows::core::w;
    use windows::Win32::System::DataExchange::{
        EmptyClipboard, GetClipboardSequenceNumber, RegisterClipboardFormatW,
    };

    const CF_UNICODETEXT: u32 = 13;

    let mut text: Vec<u16> = value.encode_utf16().collect();
    text.push(0);
    let text_bytes: Vec<u8> = text.iter().flat_map(|unit| unit.to_le_bytes()).collect();
    // Os formatos de exclusão só precisam existir; o valor 0 diz "não incluir".
    let zero = 0u32.to_le_bytes();

    let clipboard = OpenedClipboard::open(window)?;
    unsafe {
        EmptyClipboard()
            .map_err(|error| format!("Falha ao limpar a área de transferência: {error}"))?;
        set_data(CF_UNICODETEXT, &text_bytes)?;
        for format in [
            w!("ExcludeClipboardContentFromMonitorProcessing"),
            w!("CanIncludeInClipboardHistory"),
            w!("CanUploadToCloudClipboard"),
        ] {
            let id = RegisterClipboardFormatW(format);
            if id != 0 {
                set_data(id, &zero)?;
            }
        }
        // Fecha antes de ler a sequência: é o fechamento que a consolida.
        drop(clipboard);
        Ok(GetClipboardSequenceNumber())
    }
}

/// Esvazia a área de transferência só se ela ainda contém a cópia feita em
/// `copy_sensitive` (mesmo número de sequência): o que o usuário copiou depois
/// não é tocado. Devolve se limpou.
#[cfg(target_os = "windows")]
pub fn clear_if_unchanged(window: &WebviewWindow, sequence: u32) -> Result<bool, String> {
    use windows::Win32::System::DataExchange::{EmptyClipboard, GetClipboardSequenceNumber};

    if unsafe { GetClipboardSequenceNumber() } != sequence {
        return Ok(false);
    }
    let _clipboard = OpenedClipboard::open(window)?;
    unsafe {
        EmptyClipboard()
            .map_err(|error| format!("Falha ao limpar a área de transferência: {error}"))?;
    }
    Ok(true)
}

/// Área de transferência aberta; fecha ao sair de escopo, inclusive em erro.
#[cfg(target_os = "windows")]
struct OpenedClipboard;

#[cfg(target_os = "windows")]
impl OpenedClipboard {
    fn open(window: &WebviewWindow) -> Result<Self, String> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::System::DataExchange::OpenClipboard;

        let raw = window.hwnd().map_err(|error| error.to_string())?;
        let owner = HWND(raw.0 as *mut _);
        // Outro programa pode estar com ela aberta por um instante.
        let mut last_error = None;
        for _ in 0..10 {
            match unsafe { OpenClipboard(owner) } {
                Ok(()) => return Ok(OpenedClipboard),
                Err(error) => {
                    last_error = Some(error);
                    std::thread::sleep(std::time::Duration::from_millis(30));
                }
            }
        }
        Err(format!(
            "A área de transferência está ocupada por outro programa: {}",
            last_error
                .map(|error| error.to_string())
                .unwrap_or_default()
        ))
    }
}

#[cfg(target_os = "windows")]
impl Drop for OpenedClipboard {
    fn drop(&mut self) {
        unsafe {
            let _ = windows::Win32::System::DataExchange::CloseClipboard();
        }
    }
}

/// Copia `bytes` para memória global e a entrega à área de transferência, que
/// passa a ser dona dela (só é liberada aqui se a entrega falhar).
#[cfg(target_os = "windows")]
unsafe fn set_data(format: u32, bytes: &[u8]) -> Result<(), String> {
    use windows::Win32::Foundation::{GlobalFree, HANDLE};
    use windows::Win32::System::DataExchange::SetClipboardData;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};

    let memory = GlobalAlloc(GMEM_MOVEABLE, bytes.len())
        .map_err(|error| format!("Falha ao reservar memória: {error}"))?;
    let target = GlobalLock(memory);
    if target.is_null() {
        let _ = GlobalFree(memory);
        return Err("Falha ao preparar a cópia.".to_string());
    }
    std::ptr::copy_nonoverlapping(bytes.as_ptr(), target.cast::<u8>(), bytes.len());
    // Retorna "erro" quando o contador de travas chega a zero, que é o normal.
    let _ = GlobalUnlock(memory);
    if let Err(error) = SetClipboardData(format, HANDLE(memory.0)) {
        let _ = GlobalFree(memory);
        return Err(format!("Falha ao copiar: {error}"));
    }
    Ok(())
}

#[cfg(not(target_os = "windows"))]
pub fn copy_sensitive(_window: &WebviewWindow, _value: &str) -> Result<u32, String> {
    Err("A cópia segura está disponível apenas no Windows.".to_string())
}

#[cfg(not(target_os = "windows"))]
pub fn clear_if_unchanged(_window: &WebviewWindow, _sequence: u32) -> Result<bool, String> {
    Ok(false)
}
