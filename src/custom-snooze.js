import { attachDatePicker } from "./date-picker.js";
import { attachTimePicker } from "./time-picker.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const dateInput = document.querySelector("#date");
const timeInput = document.querySelector("#time");
const errorEl = document.querySelector("#error");
const confirmBtn = document.querySelector("#confirm");
const cancelBtn = document.querySelector("#cancel");

// Mensagem do backend quando o alvo saiu da fila (concluído/adiado pelo toast
// ou por outra janela) enquanto esta estava aberta.
const NOT_PENDING = "não está mais pendente";

function applyTheme(theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

function errorMessage(error) {
  if (typeof error === "string") return error;
  return error?.message ?? "Não foi possível reagendar.";
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearError() {
  errorEl.hidden = true;
  errorEl.textContent = "";
}

function hideWindow() {
  invoke("hide_custom_snooze").catch(() => {
    // Sem janela para esconder não há o que fazer; o backend também fecha
    // esta janela sozinho quando o alvo sai da fila.
  });
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

const picker = attachDatePicker(dateInput);
const timePicker = attachTimePicker(timeInput);

// A janela tem o tamanho do painel: compacta normalmente e maior só enquanto
// o calendário ou a lista de horas estão abertos (eles abrem dentro do
// painel). O backend reposiciona mantendo a janela colada à linha do toast.
const panel = document.querySelector(".panel");
let lastHeight = 0;
function reportHeight(force = false) {
  // + padding do body (3 px em cima e embaixo).
  const height = Math.ceil(panel.getBoundingClientRect().height + 6);
  if (!force && Math.abs(height - lastHeight) < 1) return;
  lastHeight = height;
  invoke("resize_custom_snooze", { height }).catch(() => {
    // Sem redimensionar, a janela só fica com o tamanho anterior.
  });
}
new ResizeObserver(() => reportHeight()).observe(panel);

// A janela é reutilizada (mostrada/ocultada), não recriada. Este reset devolve
// o estado inicial a cada abertura: sem erro, botão habilitado, calendário
// fechado, sugestão fresca.
// Cada abertura é uma sessão: um Confirmar da abertura anterior que termine
// depois não pode esconder nem destravar a janela reaberta.
let session = 0;

function reset() {
  session += 1;
  clearError();
  confirmBtn.disabled = false;
  picker?.close();
  timePicker?.close();
  prefillDefaults();
  // O backend abre com uma altura estimada; corrige pelo conteúdo real (o
  // ResizeObserver não dispara se o painel não mudou desde a última vez).
  window.setTimeout(() => reportHeight(true), 0);
  // O <input type="date"> original fica escondido (focá-lo não fazia nada);
  // o foco vai para o campo visível do calendário. Aqui o rAF é proposital:
  // se a janela ainda não foi mostrada, o foco espera até ela aparecer.
  requestAnimationFrame(() => (picker?.field ?? timeInput).focus());
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
  const mySession = session;
  try {
    const id = await invoke("get_custom_snooze_target");
    const datetime = `${dateInput.value}T${timeInput.value}`;
    await invoke("reschedule_notification", { id, datetime });
    if (mySession === session) await invoke("hide_custom_snooze");
  } catch (error) {
    if (mySession !== session) return;
    const message = errorMessage(error);
    // O lembrete já saiu da fila: não há mais o que reagendar aqui.
    if (message.includes(NOT_PENDING)) {
      hideWindow();
    } else {
      showError(message);
    }
  } finally {
    if (mySession === session) confirmBtn.disabled = false;
  }
}

confirmBtn.addEventListener("click", confirm);
cancelBtn.addEventListener("click", hideWindow);

// Esc com o calendário aberto é tratado (e interrompido) pelo próprio
// date-picker na fase de captura; aqui só chega o Esc "de fechar a janela".
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    event.preventDefault();
    hideWindow();
    return;
  }
  if (event.key !== "Enter") return;
  // Enter no calendário só escolhe o dia (ou navega), sem confirmar na hora.
  if (picker?.isOpen() || timePicker?.isOpen()) return;
  // Só confirma a partir dos campos ou do próprio Confirmar. Em Cancelar, o
  // Enter segue o comportamento normal do botão (fechar sem reagendar).
  const target = event.target;
  if (target !== timePicker?.field && target !== picker?.field && target !== confirmBtn) return;
  // Impede que o Enter também "clique" o botão focado (abrir o calendário ou
  // disparar o Confirmar uma segunda vez).
  event.preventDefault();
  confirm();
});

// Listeners primeiro, antes de qualquer outra chamada ao backend: se o
// get_settings falhar ou demorar, a janela ainda reseta a cada abertura e
// acompanha a troca de tema.
try {
  await listen("settings-changed", (event) => {
    if (event.payload?.theme) applyTheme(event.payload.theme);
  });
  await listen("custom-snooze-open", reset);
} catch {
  // Sem eventos a janela ainda funciona; só não reseta sozinha.
}
reset();

try {
  const settings = await invoke("get_settings");
  applyTheme(settings.theme);
} catch {
  // segue com tema padrão
}
