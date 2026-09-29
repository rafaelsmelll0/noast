const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const errorEl = document.querySelector("#menuError");

// Mensagem do backend quando o lembrete saiu da fila (concluído/adiado por
// outra janela) enquanto o menu estava aberto.
const NOT_PENDING = "não está mais pendente";
let errorTimer = null;

function applyTheme(theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

function errorMessage(error) {
  if (typeof error === "string") return error;
  if (error?.message) return error.message;
  return "Não foi possível adiar.";
}

function hideMenu() {
  window.clearTimeout(errorTimer);
  errorEl.hidden = true;
  invoke("hide_snooze_menu").catch(() => {
    // O backend também fecha o menu sozinho quando a fila muda.
  });
}

/// Antes, um erro aqui sumia sem aviso e o menu ficava aberto. Lembrete que
/// saiu da fila: só fecha (o toast já se atualiza sozinho). Outros erros: mostra
/// a mensagem por um instante no lugar das opções e fecha.
function handleError(error) {
  const message = errorMessage(error);
  if (message.includes(NOT_PENDING)) {
    hideMenu();
    return;
  }
  errorEl.textContent = message;
  errorEl.hidden = false;
  window.clearTimeout(errorTimer);
  errorTimer = window.setTimeout(hideMenu, 2_500);
}

// A janela é reutilizada: cada abertura começa limpa. Sem isto, um erro da
// abertura anterior (e o timer dele) fechava o menu recém-reaberto.
listen("snooze-menu-open", () => {
  window.clearTimeout(errorTimer);
  errorEl.hidden = true;
  document.querySelectorAll("button").forEach((button) => {
    button.disabled = false;
  });
}).catch(() => {});

// Os handlers são registrados antes de qualquer chamada ao backend: se o
// get_settings falhasse no await do topo, os botões ficariam sem ação.
document.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", async () => {
    if (button.disabled) return;
    button.disabled = true;
    try {
      const id = await invoke("get_snooze_target");
      if (button.dataset.action === "custom") {
        const rect = button.getBoundingClientRect();
        await invoke("open_custom_snooze", {
          id,
          anchor: {
            x: rect.left,
            top: rect.top,
            bottom: rect.bottom,
            width: rect.width,
          },
        });
        await invoke("hide_snooze_menu");
      } else if (button.dataset.action === "tomorrow") {
        await invoke("snooze_tomorrow", { id });
        await invoke("hide_snooze_menu");
      } else {
        await invoke("snooze_notification", {
          id,
          minutes: Number(button.dataset.minutes),
        });
        await invoke("hide_snooze_menu");
      }
    } catch (error) {
      handleError(error);
    } finally {
      button.disabled = false;
    }
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") hideMenu();
});

try {
  await listen("settings-changed", (event) => {
    if (event.payload?.theme) applyTheme(event.payload.theme);
  });
} catch {
  // Sem o evento, o tema só não acompanha trocas até a próxima abertura.
}

try {
  const settings = await invoke("get_settings");
  applyTheme(settings.theme);
} catch {
  // Segue com o tema do sistema.
}
