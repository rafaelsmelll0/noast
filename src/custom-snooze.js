const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const dateInput = document.querySelector("#date");
const timeInput = document.querySelector("#time");
const errorEl = document.querySelector("#error");
const confirmBtn = document.querySelector("#confirm");
const cancelBtn = document.querySelector("#cancel");

function applyTheme(theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

const pad = (n) => String(n).padStart(2, "0");

function dateValue(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function prefillDefaults() {
  const suggestion = new Date(Date.now() + 60 * 60 * 1000);
  dateInput.value = dateValue(suggestion);
  timeInput.value = `${pad(suggestion.getHours())}:${pad(suggestion.getMinutes())}`;
  // Impede escolher um dia passado já no seletor, em vez de só recusar depois.
  dateInput.min = dateValue(new Date());
}

// A janela é reutilizada (mostrada/ocultada), não recriada. Este reset devolve
// o estado inicial a cada abertura: sem erro, botão habilitado, sugestão fresca.
function reset() {
  clearError();
  confirmBtn.disabled = false;
  prefillDefaults();
  requestAnimationFrame(() => dateInput.focus());
}

async function init() {
  try {
    const settings = await invoke("get_settings");
    applyTheme(settings.theme);
  } catch {
    // segue com tema padrão
  }
  await listen("settings-changed", (event) => applyTheme(event.payload.theme));
  await listen("custom-snooze-open", reset);
  reset();
}

async function confirm() {
  // Enter repetido (ou clique duplo) chegaria aqui duas vezes antes do primeiro
  // reagendamento terminar.
  if (confirmBtn.disabled) return;
  clearError();
  if (!dateInput.value || !timeInput.value) {
    showError("Escolha data e hora.");
    return;
  }
  confirmBtn.disabled = true;
  try {
    const id = await invoke("get_custom_snooze_target");
    const datetime = `${dateInput.value}T${timeInput.value}`;
    await invoke("reschedule_notification", { id, datetime });
    await invoke("hide_custom_snooze");
  } catch (error) {
    const message =
      typeof error === "string" ? error : error?.message ?? "Não foi possível reagendar.";
    showError(message);
  } finally {
    confirmBtn.disabled = false;
  }
}

confirmBtn.addEventListener("click", confirm);
cancelBtn.addEventListener("click", () => invoke("hide_custom_snooze"));

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") invoke("hide_custom_snooze");
  if (event.key === "Enter") confirm();
});

await init();
