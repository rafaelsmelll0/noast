import { createConfirmDialog } from "./confirm-dialog.js";
import { attachDatePicker } from "./date-picker.js";
import { createNotesController } from "./notes.js";
import { createVaultController, requestCloseVaultForms } from "./vault.js";

const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;
const { getCurrentWindow } = window.__TAURI__.window;
const appWindow = getCurrentWindow();
const sidebarMedia = window.matchMedia("(max-width: 820px)");
const sidebarPreferenceKey = "noast.sidebar.preference";

const state = {
  notifications: [],
  settings: null,
  filter: "upcoming",
  recurringOnly: false,
  query: "",
  activeView: "reminders",
  editingId: null,
  // Lembrete como estava ao abrir o formulário de edição (atualizado quando o
  // backend avisa de mudanças) e os valores de data/hora que o formulário
  // recebeu — comparar com eles diz se o usuário mexeu nos campos.
  editingSnapshot: null,
  editingOpenedDone: false,
  formBaseline: null,
  loadSeq: 0,
  lastGroupsHtml: null,
  settingsLoaded: false,
  snackbarTimer: null,
};

const repeatLabels = {
  none: "Sem repetição",
  daily: "Diário",
  weekly: "Semanal",
  biweekly: "A cada 15 dias",
  monthly: "Mensal",
  yearly: "Anual",
};

const icons = {
  bell: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10 21h4"/></svg>',
  edit: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>',
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6"/><path d="M10 11v5M14 11v5"/></svg>',
};

const elements = {
  appShell: document.querySelector(".app-shell"),
  titlebar: document.querySelector(".titlebar"),
  toggleSidebar: document.querySelector("#toggleSidebar"),
  remindersView: document.querySelector("#remindersView"),
  notesView: document.querySelector("#notesView"),
  vaultView: document.querySelector("#vaultView"),
  settingsView: document.querySelector("#settingsView"),
  groups: document.querySelector("#reminderGroups"),
  listState: document.querySelector("#listState"),
  subtitle: document.querySelector("#remindersSubtitle"),
  modal: document.querySelector("#modalOverlay"),
  modalTitle: document.querySelector("#modalTitle"),
  form: document.querySelector("#reminderForm"),
  text: document.querySelector("#reminderText"),
  date: document.querySelector("#reminderDate"),
  time: document.querySelector("#reminderTime"),
  repeat: document.querySelector("#reminderRepeat"),
  characterCount: document.querySelector("#characterCount"),
  formError: document.querySelector("#formError"),
  settingsForm: document.querySelector("#settingsForm"),
  settingsStatus: document.querySelector("#settingsStatus"),
  settingsRetry: document.querySelector("#settingsRetry"),
  snoozeSetting: document.querySelector("#snoozeSetting"),
  snackbar: document.querySelector("#snackbar"),
  snackbarText: document.querySelector("#snackbarText"),
  snackbarAction: document.querySelector("#snackbarAction"),
  quickWhen: document.querySelector("#quickWhen"),
  whenHint: document.querySelector("#whenHint"),
  editHint: document.querySelector("#editHint"),
  weekdayField: document.querySelector("#weekdayField"),
  weekdayPicker: document.querySelector("#weekdayPicker"),
  appVersion: document.querySelector("#appVersion"),
  checkUpdate: document.querySelector("#checkUpdate"),
  updateStatus: document.querySelector("#updateStatus"),
  updateBanner: document.querySelector("#updateBanner"),
  updateBannerText: document.querySelector("#updateBannerText"),
  updateBannerAction: document.querySelector("#updateBannerAction"),
  updateBannerDismiss: document.querySelector("#updateBannerDismiss"),
};

// Criado já aqui (e não junto dos outros listeners) porque openModal/closeModal
// o usam e podem rodar cedo, pelo evento "open-new-reminder" da bandeja.
const reminderPicker = attachDatePicker(elements.date);

function errorMessage(error) {
  if (typeof error === "string") return error;
  if (error?.message) return error.message;
  return "Algo não saiu como esperado. Tente novamente.";
}

function storedSidebarPreference() {
  try {
    const preference = localStorage.getItem(sidebarPreferenceKey);
    return preference === "collapsed" || preference === "expanded" ? preference : null;
  } catch {
    return null;
  }
}

function sidebarIsCollapsed() {
  if (elements.appShell.classList.contains("sidebar-collapsed")) return true;
  if (elements.appShell.classList.contains("sidebar-force-expanded")) return false;
  return sidebarMedia.matches;
}

function updateSidebarControl() {
  const collapsed = sidebarIsCollapsed();
  const action = collapsed ? "Expandir menu lateral" : "Recolher menu lateral";
  elements.toggleSidebar.setAttribute("aria-expanded", String(!collapsed));
  elements.toggleSidebar.setAttribute("aria-label", action);
  elements.toggleSidebar.title = action;
}

function applySidebarPreference(preference) {
  elements.appShell.classList.remove("sidebar-collapsed", "sidebar-force-expanded");
  if (preference === "collapsed") {
    elements.appShell.classList.add("sidebar-collapsed");
  } else if (preference === "expanded") {
    elements.appShell.classList.add("sidebar-force-expanded");
  }
  updateSidebarControl();
}

function toggleSidebar() {
  const preference = sidebarIsCollapsed() ? "expanded" : "collapsed";
  try {
    localStorage.setItem(sidebarPreferenceKey, preference);
  } catch {
    // The current session still honors the choice if storage is unavailable.
  }
  applySidebarPreference(preference);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseDateTime(value) {
  return new Date(value);
}

function startOfDay(value) {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate());
}

function temporalGroup(notification, now) {
  if (notification.done) return { key: "done", label: "Concluídos", order: 5 };
  const datetime = parseDateTime(notification.datetime);
  if (datetime < now) return { key: "overdue", label: "Atrasados", order: 0 };

  const today = startOfDay(now);
  const target = startOfDay(datetime);
  const days = Math.round((target - today) / 86_400_000);
  if (days === 0) return { key: "today", label: "Hoje", order: 1 };
  if (days === 1) return { key: "tomorrow", label: "Amanhã", order: 2 };
  if (days <= 7) return { key: "week", label: "Próximos 7 dias", order: 3 };
  return { key: "later", label: "Mais tarde", order: 4 };
}

function formatDateTime(value) {
  const datetime = parseDateTime(value);
  // Data inválida (arquivo editado à mão): Intl.DateTimeFormat lança
  // RangeError, e um único cartão assim escondia a lista inteira.
  if (Number.isNaN(datetime.getTime())) return `Data inválida (${value})`;
  const now = new Date();
  const today = startOfDay(now);
  const target = startOfDay(datetime);
  const days = Math.round((target - today) / 86_400_000);
  const time = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(datetime);
  if (days === 0) return `Hoje, ${time}`;
  if (days === 1) return `Amanhã, ${time}`;
  if (days === -1) return `Ontem, ${time}`;
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: datetime.getFullYear() === now.getFullYear() ? undefined : "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(datetime);
}

function filteredNotifications() {
  const now = new Date();
  return state.notifications
    .filter((notification) => {
      const datetime = parseDateTime(notification.datetime);
      if (state.filter === "upcoming") return !notification.done && datetime >= now;
      if (state.filter === "overdue") return !notification.done && datetime < now;
      if (state.filter === "done") return notification.done;
      return true;
    })
    .filter((notification) => !state.recurringOnly || notification.repeat !== "none")
    .filter((notification) =>
      notification.text.toLocaleLowerCase("pt-BR").includes(state.query),
    )
    .sort((a, b) => {
      if (a.done !== b.done) return a.done ? 1 : -1;
      return a.datetime.localeCompare(b.datetime);
    });
}

function updateCounts() {
  const now = new Date();
  const upcoming = state.notifications.filter(
    (item) => !item.done && parseDateTime(item.datetime) >= now,
  ).length;
  const overdue = state.notifications.filter(
    (item) => !item.done && parseDateTime(item.datetime) < now,
  ).length;
  const done = state.notifications.filter((item) => item.done).length;
  const active = upcoming + overdue;

  document.querySelector("#upcomingCount").textContent = upcoming;
  document.querySelector("#overdueCount").textContent = overdue;
  document.querySelector("#doneCount").textContent = done;
  document.querySelector("#navActiveCount").textContent = active;
  elements.subtitle.textContent =
    active === 0
      ? "Tudo em dia por aqui."
      : `${active} lembrete${active === 1 ? "" : "s"} ativo${active === 1 ? "" : "s"}${overdue ? `, ${overdue} atrasado${overdue === 1 ? "" : "s"}` : ""}.`;
}

function renderEmpty() {
  const copy = {
    upcoming: ["Sem próximos lembretes", "Crie um lembrete ou aproveite um raro momento de agenda limpa."],
    overdue: ["Nada atrasado", "Boa. Seus lembretes estão no horário."],
    done: ["Nenhum concluído", "Os lembretes finalizados aparecerão aqui."],
    all: ["Nenhum lembrete encontrado", "Tente limpar a busca ou criar um novo lembrete."],
  }[state.filter];
  elements.listState.innerHTML = `
    <div class="empty-copy">
      ${icons.bell}
      <h2>${copy[0]}</h2>
      <p>${copy[1]}</p>
    </div>`;
  elements.listState.hidden = false;
  elements.groups.replaceChildren();
}

function cardHtml(notification, now) {
  const overdue = !notification.done && parseDateTime(notification.datetime) < now;
  const classes = [
    "reminder-card",
    notification.done ? "is-done" : "",
    overdue ? "is-overdue" : "",
  ]
    .filter(Boolean)
    .join(" ");
  const repeat =
    notification.repeat !== "none"
      ? `<span class="meta-badge">${escapeHtml(repeatLabels[notification.repeat] ?? notification.repeat)}</span>`
      : "";
  const status = overdue
    ? '<span class="overdue-label">Atrasado</span>'
    : notification.done
      ? '<span class="meta-badge">Concluído</span>'
      : "";

  return `
    <article class="${classes}" data-id="${escapeHtml(notification.id)}" tabindex="0">
      <span class="reminder-dot" aria-hidden="true"></span>
      <div class="reminder-content">
        <p class="reminder-text">${escapeHtml(notification.text)}</p>
        <div class="reminder-meta">
          <span>${escapeHtml(formatDateTime(notification.datetime))}</span>
          ${repeat}
          ${status}
        </div>
      </div>
      <div class="card-actions">
        <button class="icon-button" type="button" data-action="edit" aria-label="Editar">${icons.edit}</button>
        <button class="icon-button" type="button" data-action="duplicate" aria-label="Duplicar">${icons.copy}</button>
        <button class="icon-button danger" type="button" data-action="delete" aria-label="Excluir">${icons.trash}</button>
      </div>
    </article>`;
}

function render() {
  updateCounts();
  const notifications = filteredNotifications();
  if (notifications.length === 0) {
    state.lastGroupsHtml = null;
    renderEmpty();
    return;
  }

  elements.listState.hidden = true;
  const now = new Date();
  const groups = new Map();
  for (const notification of notifications) {
    const group = temporalGroup(notification, now);
    if (!groups.has(group.key)) groups.set(group.key, { ...group, notifications: [] });
    groups.get(group.key).notifications.push(notification);
  }

  const html = [...groups.values()]
    .sort((a, b) => a.order - b.order)
    .map(
      (group) => `
        <section>
          <h2 class="group-title">${escapeHtml(group.label)}</h2>
          <div class="group-list">
            ${group.notifications.map((notification) => cardHtml(notification, now)).join("")}
          </div>
        </section>`,
    )
    .join("");
  // A lista é redesenhada a cada minuto; sem mudança real, manter o DOM evita
  // tirar o foco do cartão que o usuário estava navegando pelo teclado.
  if (html === state.lastGroupsHtml) return;
  state.lastGroupsHtml = html;
  elements.groups.innerHTML = html;
}

async function loadNotifications() {
  // Eventos em sequência (ex.: disparo + adiamento) fazem buscas se
  // sobreporem; só a mais recente pode escrever no estado.
  const seq = ++state.loadSeq;
  try {
    const notifications = await invoke("get_notifications");
    if (seq !== state.loadSeq) return;
    state.notifications = notifications;
    render();
    syncEditingForm();
  } catch (error) {
    if (seq === state.loadSeq) showSnackbar(errorMessage(error));
  }
}

/// Recalcula os rótulos que dependem do relógio (Hoje/Amanhã, Atrasados,
/// contagens) sem esperar um evento do backend.
function refreshTimeLabels() {
  render();
  if (!elements.modal.hidden) {
    updateWhenHint();
    updateEditHint();
  }
}

function scheduleMinuteTick() {
  // Alinha ao virar do minuto, quando um lembrete passa a "Atrasado".
  const delay = 60_000 - (Date.now() % 60_000) + 250;
  window.setTimeout(() => {
    refreshTimeLabels();
    scheduleMinuteTick();
  }, delay);
}

function localDateParts(date) {
  return {
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    time: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
  };
}

// O seletor de dia só faz sentido para repetições semanais; nas demais, o dia
// vem da própria data escolhida.
const WEEKDAY_REPEATS = new Set(["weekly", "biweekly"]);

/// Move a data para a próxima ocorrência do dia da semana escolhido, mantendo a
/// hora. Assim o usuário escolhe "toda terça" sem precisar descobrir qual data
/// cai numa terça.
function applyWeekday(weekday) {
  const base = elements.date.value ? new Date(`${elements.date.value}T12:00:00`) : new Date();
  const shift = (weekday - base.getDay() + 7) % 7;
  // Já é o dia certo: mantém a data em vez de empurrar uma semana à frente.
  base.setDate(base.getDate() + shift);
  // Se cair hoje mas o horário já passou (escolher "terça 9h" numa terça às
  // 14h), a série começa na semana seguinte em vez de nascer atrasada.
  if (elements.time.value) {
    const candidate = new Date(`${localDateParts(base).date}T${elements.time.value}:00`);
    if (candidate < new Date()) base.setDate(base.getDate() + 7);
  }
  elements.date.value = localDateParts(base).date;
  syncWeekdayPicker();
  clearQuickChips();
  updateWhenHint();
  // O setter não dispara "input": a dica de série adiada ficaria velha.
  updateEditHint();
}

/// Marca o dia correspondente à data atual e mostra/esconde o seletor conforme
/// a repetição escolhida.
function syncWeekdayPicker() {
  const weekly = WEEKDAY_REPEATS.has(elements.repeat.value);
  elements.weekdayField.hidden = !weekly;
  if (!weekly) return;
  let current = elements.date.value
    ? new Date(`${elements.date.value}T12:00:00`).getDay()
    : null;
  // Recorrente adiado, com data/hora ainda as do adiamento: o dia que vale é
  // o da série (o mesmo que a dica "Adiado — a série continua..." descreve).
  const editing = state.editingId
    ? state.notifications.find((item) => item.id === state.editingId)
    : null;
  if (
    editing?.series_datetime &&
    editing.series_datetime !== editing.datetime &&
    formDateTimeMatches(editing.datetime)
  ) {
    const anchor = parseDateTime(editing.series_datetime);
    if (!Number.isNaN(anchor.getTime())) current = anchor.getDay();
  }
  elements.weekdayPicker.querySelectorAll(".weekday").forEach((button) => {
    const active = Number(button.dataset.weekday) === current;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function clearQuickChips() {
  elements.quickWhen
    .querySelectorAll(".quick-chip")
    .forEach((chip) => chip.classList.remove("active"));
}

function applyQuickWhen(chip) {
  const target = new Date();
  if (chip.dataset.tomorrow) {
    target.setDate(target.getDate() + 1);
    target.setHours(Number(chip.dataset.tomorrow), 0, 0, 0);
  } else {
    target.setMinutes(target.getMinutes() + Number(chip.dataset.minutes));
    target.setSeconds(0, 0);
  }
  const parts = localDateParts(target);
  elements.date.value = parts.date;
  elements.time.value = parts.time;
  clearQuickChips();
  chip.classList.add("active");
  updateWhenHint();
  updateEditHint();
}

/// Resume em texto o horário escolhido ("daqui a 2 h 30 min") e avisa quando a
/// data já passou — antes o usuário só descobria depois de salvar.
function updateWhenHint() {
  const { whenHint } = elements;
  if (!elements.date.value || !elements.time.value) {
    whenHint.hidden = true;
    return;
  }
  const target = new Date(`${elements.date.value}T${elements.time.value}:00`);
  if (Number.isNaN(target.getTime())) {
    whenHint.hidden = true;
    return;
  }
  const diffMinutes = Math.round((target - new Date()) / 60_000);
  whenHint.hidden = false;
  whenHint.classList.toggle("is-past", diffMinutes < 0);

  if (diffMinutes < 0) {
    whenHint.textContent = "Esse horário já passou — o lembrete tocará assim que for salvo.";
    return;
  }
  if (diffMinutes < 1) {
    whenHint.textContent = "Tocará em menos de um minuto.";
    return;
  }
  const days = Math.floor(diffMinutes / 1_440);
  const hours = Math.floor((diffMinutes % 1_440) / 60);
  const minutes = diffMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days} dia${days === 1 ? "" : "s"}`);
  if (hours) parts.push(`${hours} h`);
  if (minutes && !days) parts.push(`${minutes} min`);
  whenHint.textContent = `Tocará daqui a ${parts.join(" e ")}.`;
}

const WEEKDAY_NAMES = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];

function formDateTimeMatches(datetime) {
  return (
    elements.date.value === datetime.slice(0, 10) &&
    elements.time.value === datetime.slice(11, 16)
  );
}

/// Descreve a série de um lembrete recorrente adiado a partir do horário
/// oficial (`series_datetime`), que o formulário não mostra: os campos trazem
/// a data do adiamento.
function seriesDescription(notification) {
  const anchor = parseDateTime(notification.series_datetime);
  if (Number.isNaN(anchor.getTime())) return "";
  const time = notification.series_datetime.slice(11, 16);
  const weekday = WEEKDAY_NAMES[anchor.getDay()];
  const day = String(anchor.getDate()).padStart(2, "0");
  const month = String(anchor.getMonth() + 1).padStart(2, "0");
  switch (notification.repeat) {
    case "daily":
      return `todos os dias às ${time}`;
    case "weekly":
      // "todo sábado/domingo", "toda segunda-feira"...
      return `${anchor.getDay() % 6 === 0 ? "todo" : "toda"} ${weekday} às ${time}`;
    case "biweekly":
      return `a cada 2 semanas (${weekday}) às ${time}`;
    case "monthly":
      // series_day guarda o dia pretendido ("todo dia 31" parado em 28/02).
      return `todo dia ${notification.series_day || anchor.getDate()} às ${time}`;
    case "yearly":
      return `todo ${day}/${month} às ${time}`;
    default:
      return "";
  }
}

/// Dica discreta sob "Quando" no modo edição: lembrete recorrente adiado
/// (a série segue outro horário), ou mudanças feitas por fora enquanto o
/// formulário estava aberto. Só informa — não altera o que é salvo.
function updateEditHint() {
  const hint = elements.editHint;
  let message = "";
  if (state.editingId && state.editingSnapshot) {
    const current = state.notifications.find((item) => item.id === state.editingId);
    if (!current) {
      message = "Este lembrete foi excluído. Salvar vai criá-lo de novo.";
    } else if (current.done && !state.editingOpenedDone) {
      message = "Este lembrete foi concluído enquanto você editava.";
    } else if (
      current.repeat !== "none" &&
      current.series_datetime &&
      current.series_datetime !== current.datetime
    ) {
      const series = seriesDescription(current);
      // Mudar data, hora ou repetição redefine a série no backend.
      const untouched =
        formDateTimeMatches(current.datetime) && elements.repeat.value === current.repeat;
      if (series && untouched) {
        message = `Adiado — a série continua ${series}.`;
      } else if (series) {
        message = "Adiado — ao salvar, a série passa a seguir a nova data e hora.";
      }
    }
  }
  hint.textContent = message;
  hint.hidden = !message;
}

/// O lembrete em edição mudou no backend (adiado/concluído pelo toast,
/// disparou e avançou para a próxima ocorrência). Se o usuário não mexeu em
/// data/hora, os campos acompanham o valor novo — senão salvar gravaria o
/// horário velho por cima do adiamento. Se mexeu, a escolha dele prevalece.
function syncEditingForm() {
  if (elements.modal.hidden || !state.editingId || !state.editingSnapshot) return;
  const current = state.notifications.find((item) => item.id === state.editingId);
  if (current && current.datetime !== state.editingSnapshot.datetime) {
    const baseline = state.formBaseline;
    const untouched =
      baseline && elements.date.value === baseline.date && elements.time.value === baseline.time;
    if (untouched) {
      const date = current.datetime.slice(0, 10);
      const time = current.datetime.slice(11, 16);
      elements.date.value = date;
      elements.time.value = time;
      state.formBaseline = { date, time };
      clearQuickChips();
      syncWeekdayPicker();
      updateWhenHint();
    }
  }
  if (current) state.editingSnapshot = { ...current };
  updateEditHint();
}

function focusModal() {
  // Algum campo do formulário já com foco: não rouba (o usuário pode estar
  // digitando a hora quando a bandeja pede "Novo lembrete" de novo).
  if (elements.form.contains(document.activeElement)) return;
  elements.text.focus();
}

/// "Novo lembrete" (Ctrl+N, bandeja). Com o formulário já aberto — novo ou
/// editando outro lembrete — só o traz para o foco: recomeçar apagaria o que
/// foi digitado e transformaria uma edição em "Novo".
async function openNewReminder() {
  if (!(await selectView("reminders"))) return;
  if (!elements.modal.hidden) {
    focusModal();
    return;
  }
  openModal();
}

function openModal(notification = null, duplicate = false) {
  reminderPicker?.close();
  state.editingId = notification && !duplicate ? notification.id : null;
  state.editingSnapshot = state.editingId ? { ...notification } : null;
  // Abrir um lembrete já concluído não merece aviso; concluir durante a
  // edição (pelo toast), sim.
  state.editingOpenedDone = Boolean(state.editingId && notification.done);
  elements.modalTitle.textContent = duplicate
    ? "Duplicar lembrete"
    : notification
      ? "Editar lembrete"
      : "Novo lembrete";
  elements.formError.textContent = "";

  if (notification) {
    elements.text.value = notification.text;
    elements.date.value = notification.datetime.slice(0, 10);
    elements.time.value = notification.datetime.slice(11, 16);
    elements.repeat.value = notification.repeat;
  } else {
    const soon = new Date(Date.now() + 5 * 60_000);
    soon.setSeconds(0, 0);
    const parts = localDateParts(soon);
    elements.text.value = "";
    elements.date.value = parts.date;
    elements.time.value = parts.time;
    elements.repeat.value = "none";
  }

  state.formBaseline = { date: elements.date.value, time: elements.time.value };

  updateCharacterCount();
  clearQuickChips();
  syncWeekdayPicker();
  updateWhenHint();
  updateEditHint();
  elements.modal.hidden = false;
  window.setTimeout(() => elements.text.focus(), 80);
}

function closeModal() {
  reminderPicker?.close();
  elements.modal.hidden = true;
  state.editingId = null;
  state.editingSnapshot = null;
  state.formBaseline = null;
  elements.form.reset();
  elements.formError.textContent = "";
  updateEditHint();
}

function updateCharacterCount() {
  elements.characterCount.textContent = [...elements.text.value].length;
}

async function saveReminder(event) {
  event.preventDefault();
  // Sem esta guarda, um clique duplo (ou Enter + clique) entraria duas vezes e,
  // como cada entrada gera um id novo, criaria dois lembretes iguais.
  const submitButton = elements.form.querySelector('button[type="submit"]');
  if (submitButton.disabled) return;

  const text = elements.text.value.trim();
  if (!text || !elements.date.value || !elements.time.value) {
    elements.formError.textContent = "Preencha mensagem, data e hora.";
    return;
  }

  const notification = {
    id: state.editingId ?? crypto.randomUUID(),
    text,
    datetime: `${elements.date.value}T${elements.time.value}:00`,
    repeat: elements.repeat.value,
    done: false,
    last_fired: "",
  };

  const wasEditing = Boolean(state.editingId);
  submitButton.disabled = true;
  try {
    await invoke("save_notification", { notification });
    closeModal();
    await loadNotifications();
    showSnackbar(wasEditing ? "Lembrete atualizado." : "Lembrete salvo.");
  } catch (error) {
    elements.formError.textContent = errorMessage(error);
  } finally {
    submitButton.disabled = false;
  }
}

async function deleteReminder(notification) {
  try {
    await invoke("delete_notification", { id: notification.id });
    await loadNotifications();
    showSnackbar("Lembrete excluído.", "Desfazer", async () => {
      try {
        await invoke("restore_notification", { notification });
        await loadNotifications();
        showSnackbar("Lembrete restaurado.");
      } catch (error) {
        showSnackbar(errorMessage(error));
      }
    });
  } catch (error) {
    showSnackbar(errorMessage(error));
  }
}

function showSnackbar(message, actionLabel = "", action = null) {
  window.clearTimeout(state.snackbarTimer);
  elements.snackbarText.textContent = message;
  elements.snackbarAction.hidden = !action;
  elements.snackbarAction.textContent = actionLabel;
  elements.snackbarAction.onclick = action
    ? async () => {
        elements.snackbar.hidden = true;
        await action();
      }
    : null;
  elements.snackbar.hidden = false;
  state.snackbarTimer = window.setTimeout(() => {
    elements.snackbar.hidden = true;
  }, action ? 6_000 : 3_500);
}

function applyTheme(theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

// Faixa aceita pelo backend (Settings::validate) e o padrão dele.
const SNOOZE_MIN = 1;
const SNOOZE_MAX = 1_440;
const SNOOZE_DEFAULT = 15;

function validSnooze(minutes) {
  return Number.isInteger(minutes) && minutes >= SNOOZE_MIN && minutes <= SNOOZE_MAX;
}

function snoozeOptionLabel(minutes) {
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hora${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minuto${minutes === 1 ? "" : "s"}`;
}

/// Garante que o select mostre o adiamento salvo. Um valor fora das opções
/// (5/15/30/60) deixava o select vazio, Number("") virava 0 e toda mudança
/// de configuração passava a falhar na validação. Valores válidos ganham uma
/// opção própria; inválidos caem na opção mais próxima.
function showSnoozeSetting(minutes) {
  const select = elements.snoozeSetting;
  select.querySelectorAll("option[data-custom]").forEach((option) => {
    if (Number(option.value) !== minutes) option.remove();
  });
  const options = [...select.options];
  let value = minutes;
  if (!validSnooze(minutes)) {
    const target = Number.isFinite(minutes) ? minutes : SNOOZE_DEFAULT;
    value = options
      .map((option) => Number(option.value))
      .reduce((best, candidate) =>
        Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best,
      );
  } else if (!options.some((option) => Number(option.value) === minutes)) {
    const option = new Option(snoozeOptionLabel(minutes), String(minutes));
    option.dataset.custom = "true";
    const next = options.find((item) => Number(item.value) > minutes) ?? null;
    select.add(option, next);
  }
  select.value = String(value);
}

function settingsControls() {
  return elements.settingsForm.querySelectorAll('select, input, button[type="submit"]');
}

/// Sem as configurações reais, qualquer mudança gravaria os padrões do HTML
/// por cima delas. Até carregar, os controles ficam travados.
function setSettingsEnabled(enabled) {
  settingsControls().forEach((control) => {
    control.disabled = !enabled;
  });
}

async function loadSettings() {
  try {
    const settings = await invoke("get_settings");
    document.querySelector("#themeSetting").value = settings.theme;
    document.querySelector("#monitorSetting").value = settings.alert_monitor;
    showSnoozeSetting(settings.snooze_minutes);
    document.querySelector("#alwaysOnTopSetting").checked = settings.alert_always_on_top;
    document.querySelector("#soundSetting").checked = settings.alert_sound;
    document.querySelector("#autostartSetting").checked = settings.start_with_windows;
    document.querySelector("#trayClickSetting").value = settings.tray_click_action;
    applyTheme(settings.theme);
    state.settings = settings;
    state.settingsLoaded = true;
    setSettingsEnabled(true);
    elements.settingsRetry.hidden = true;
    elements.settingsStatus.textContent = "";
  } catch (error) {
    state.settingsLoaded = false;
    setSettingsEnabled(false);
    elements.settingsRetry.hidden = false;
    elements.settingsStatus.textContent = `Não foi possível carregar as configurações: ${errorMessage(error)}`;
  }
}

async function retryLoadSettings() {
  elements.settingsRetry.disabled = true;
  elements.settingsStatus.textContent = "Carregando...";
  try {
    await loadSettings();
  } finally {
    elements.settingsRetry.disabled = false;
  }
}

function currentSettings() {
  let snoozeMinutes = Number(elements.snoozeSetting.value);
  // Nunca envia 0/NaN: volta ao último valor salvo (ou ao padrão).
  if (!validSnooze(snoozeMinutes)) {
    snoozeMinutes = validSnooze(state.settings?.snooze_minutes)
      ? state.settings.snooze_minutes
      : SNOOZE_DEFAULT;
  }
  return {
    // Campos que esta tela não conhece continuam como o backend mandou.
    ...state.settings,
    theme: document.querySelector("#themeSetting").value,
    snooze_minutes: snoozeMinutes,
    alert_monitor: document.querySelector("#monitorSetting").value,
    alert_always_on_top: document.querySelector("#alwaysOnTopSetting").checked,
    alert_sound: document.querySelector("#soundSetting").checked,
    start_with_windows: document.querySelector("#autostartSetting").checked,
    tray_click_action: document.querySelector("#trayClickSetting").value,
  };
}

async function persistSettings(showConfirmation = false) {
  if (!state.settingsLoaded) return;
  const settings = currentSettings();
  applyTheme(settings.theme);
  elements.settingsStatus.textContent = "Salvando...";
  try {
    await invoke("save_user_settings", { settings });
    state.settings = settings;
    elements.settingsStatus.textContent = showConfirmation
      ? "Configurações salvas."
      : "Salvo.";
    window.setTimeout(() => {
      elements.settingsStatus.textContent = "";
    }, 1_800);
  } catch (error) {
    elements.settingsStatus.textContent = errorMessage(error);
  }
}

async function saveSettings(event) {
  event.preventDefault();
  await persistSettings(true);
}

function autoSaveSettings() {
  persistSettings(false);
}

/// Troca de aba. Resolve false quando o usuário preferiu continuar editando um
/// formulário do cofre — aí a aba não muda.
async function selectView(view) {
  if (state.activeView === "vault" && view !== "vault") {
    // O modal do cofre fica fora de #vaultView: sem fechá-lo antes, ele ficaria
    // por cima da outra aba. Com alterações, pergunta antes de descartar.
    if (!(await requestCloseVaultForms())) return false;
    vaultController.deactivate();
  }
  state.activeView = view;
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === view);
  });
  elements.remindersView.classList.toggle("active", view === "reminders");
  elements.notesView.classList.toggle("active", view === "notes");
  elements.vaultView.classList.toggle("active", view === "vault");
  elements.settingsView.classList.toggle("active", view === "settings");
  if (view === "notes") notesController.activate();
  if (view === "vault") vaultController.activate();
  return true;
}

/// A atualização nunca é instalada sozinha (isso disparava o prompt do UAC do
/// nada e podia fechar o app): o backend só avisa e o usuário decide aqui.
function showUpdateBanner(version) {
  if (!version) return;
  // Download/instalação em andamento: um novo aviso (evento ou "Verificar
  // agora") reabilitava o botão e permitia rodar o instalador duas vezes.
  if (state.installingUpdate) return;
  elements.updateBannerText.textContent = `Noast ${version} disponível`;
  elements.updateBannerAction.disabled = false;
  elements.updateBanner.hidden = false;
  elements.updateStatus.textContent = `Versão ${version} disponível. Instale pelo aviso "Atualizar e reiniciar".`;
}

async function installUpdate() {
  if (state.installingUpdate) return;
  state.installingUpdate = true;
  elements.updateBannerAction.disabled = true;
  elements.updateBannerText.textContent =
    "Baixando atualização... o Windows pode pedir permissão para instalar.";
  try {
    // O instalador encerra o processo sem avisar: grava antes o autosave
    // pendente das notas.
    await notesController.flush().catch(() => {});
    // Em caso de sucesso o app reinicia, então nada depois disto roda.
    await invoke("install_update");
  } catch (error) {
    state.installingUpdate = false;
    // Recusar o UAC não encerra mais o app: o aviso continua para tentar de novo.
    const message = errorMessage(error);
    elements.updateBannerAction.disabled = false;
    elements.updateBannerText.textContent = "Atualização não instalada.";
    elements.updateStatus.textContent = message;
    showSnackbar(message);
  }
}

async function checkForUpdate() {
  elements.checkUpdate.disabled = true;
  elements.updateStatus.textContent = "Procurando...";
  try {
    const version = await invoke("check_for_update");
    if (version) {
      showUpdateBanner(version);
    } else {
      elements.updateStatus.textContent = "Você já está na versão mais recente.";
    }
  } catch (error) {
    elements.updateStatus.textContent = errorMessage(error);
  } finally {
    elements.checkUpdate.disabled = false;
  }
}

async function loadAppVersion() {
  try {
    elements.appVersion.textContent = await invoke("app_version");
  } catch {
    elements.appVersion.textContent = "desconhecida";
  }
}

const confirmDialog = createConfirmDialog();
const notesController = createNotesController({
  invoke,
  showSnackbar,
  confirmAction: confirmDialog.open,
});
const vaultController = createVaultController({
  invoke,
  showSnackbar,
  confirmAction: confirmDialog.open,
});

applySidebarPreference(storedSidebarPreference());
elements.toggleSidebar.addEventListener("click", toggleSidebar);
sidebarMedia.addEventListener("change", updateSidebarControl);
elements.titlebar.addEventListener("pointerdown", async (event) => {
  if (event.button !== 0 || event.target.closest(".window-controls")) return;
  event.preventDefault();
  try {
    await appWindow.startDragging();
  } catch (error) {
    showSnackbar(errorMessage(error));
  }
});
document.querySelector("#newReminder").addEventListener("click", () => openNewReminder());
document.querySelector("#closeModal").addEventListener("click", closeModal);
document.querySelector("#cancelModal").addEventListener("click", closeModal);
// Minimizar/ocultar não descarta nada: o formulário de lembrete fica como
// está, e o deactivate do cofre só mascara senhas e fecha formulários sem
// alterações (os com alterações ficam abertos para quando o usuário voltar).
document.querySelector("#minimizeWindow").addEventListener("click", () => {
  vaultController.deactivate();
  invoke("minimize_main_window");
});
document.querySelector("#closeWindow").addEventListener("click", () => {
  vaultController.deactivate();
  invoke("hide_main_window");
});
elements.text.addEventListener("input", updateCharacterCount);
elements.form.addEventListener("submit", saveReminder);

elements.quickWhen.addEventListener("click", (event) => {
  const chip = event.target.closest(".quick-chip");
  if (chip) applyQuickWhen(chip);
});

// Editar data/hora na mão desmarca o atalho e atualiza o resumo.
[elements.date, elements.time].forEach((input) => {
  input.addEventListener("input", () => {
    clearQuickChips();
    syncWeekdayPicker();
    updateWhenHint();
    updateEditHint();
  });
});

elements.repeat.addEventListener("change", () => {
  syncWeekdayPicker();
  updateEditHint();
});

elements.weekdayPicker.addEventListener("click", (event) => {
  const button = event.target.closest(".weekday");
  if (button) applyWeekday(Number(button.dataset.weekday));
});
elements.settingsForm.addEventListener("submit", saveSettings);
elements.settingsRetry.addEventListener("click", retryLoadSettings);

elements.modal.addEventListener("click", (event) => {
  if (event.target === elements.modal) closeModal();
});

document.querySelectorAll(".nav-item").forEach((button) => {
  button.addEventListener("click", () => selectView(button.dataset.view));
});

document.querySelectorAll(".segment").forEach((button) => {
  button.addEventListener("click", () => {
    state.filter = button.dataset.filter;
    document.querySelectorAll(".segment").forEach((item) => {
      item.classList.toggle("active", item === button);
    });
    render();
  });
});

document.querySelector("#searchInput").addEventListener("input", (event) => {
  state.query = event.target.value.trim().toLocaleLowerCase("pt-BR");
  render();
});

document.querySelector("#recurringFilter").addEventListener("click", (event) => {
  state.recurringOnly = !state.recurringOnly;
  event.currentTarget.setAttribute("aria-pressed", String(state.recurringOnly));
  render();
});

elements.settingsForm.querySelectorAll("select, input").forEach((control) => {
  control.addEventListener("change", autoSaveSettings);
});

elements.groups.addEventListener("click", (event) => {
  const card = event.target.closest(".reminder-card");
  if (!card) return;
  const notification = state.notifications.find((item) => item.id === card.dataset.id);
  if (!notification) return;
  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "delete") {
    deleteReminder(notification);
  } else if (action === "duplicate") {
    openModal(notification, true);
  } else {
    openModal(notification);
  }
});

elements.groups.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" && event.key !== " ") return;
  if (event.target.closest("button")) return;
  const card = event.target.closest(".reminder-card");
  const notification = state.notifications.find((item) => item.id === card?.dataset.id);
  if (notification) openModal(notification);
});

// Esc com o calendário aberto nem chega aqui: o date-picker o consome na
// fase de captura e fecha só o calendário.
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.modal.hidden) closeModal();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    if (state.activeView === "notes") {
      notesController.createNote();
    } else if (state.activeView === "vault") {
      vaultController.createClient();
    } else {
      openNewReminder();
    }
  }
});

elements.checkUpdate.addEventListener("click", checkForUpdate);
elements.updateBannerAction.addEventListener("click", installUpdate);
elements.updateBannerDismiss.addEventListener("click", () => {
  elements.updateBanner.hidden = true;
});

// Rótulos que dependem do relógio (Hoje/Amanhã, Atrasados) não podem
// envelhecer com a janela aberta ou escondida na bandeja.
scheduleMinuteTick();
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  refreshTimeLabels();
  // Pode ter perdido eventos enquanto estava oculta; buscar de novo é barato.
  loadNotifications();
});
window.addEventListener("focus", refreshTimeLabels);

// Listeners ANTES do carregamento: com autostart (--minimized) a janela é
// criada pela bandeja, que emite "open-new-reminder" logo em seguida — se o
// listener só fosse registrado depois dos loads, o primeiro pedido se perdia.
// O mesmo vale para os avisos de lista alterada e de atualização.
try {
  await Promise.all([
    listen("open-new-reminder", () => {
      // O backend também guarda o pedido (caso este evento se perca durante o
      // carregamento); consumi-lo aqui evita reabrir depois.
      invoke("take_new_reminder_request").catch(() => {});
      openNewReminder();
    }),
    listen("notifications-changed", () => loadNotifications()),
    listen("update-available", (event) => showUpdateBanner(event.payload)),
    // "Sair" da bandeja: grava o autosave pendente das notas antes de o
    // backend encerrar (ele espera no máximo 2 s por esta resposta).
    listen("app-quitting", async () => {
      try {
        await notesController.flush();
      } finally {
        invoke("ready_to_quit").catch(() => {});
      }
    }),
  ]);
} catch (error) {
  showSnackbar(errorMessage(error));
}

await Promise.all([
  loadNotifications(),
  loadSettings(),
  loadAppVersion(),
  notesController.load(),
  vaultController.load(),
]);

// Pedidos feitos antes de a janela estar pronta para ouvir os eventos acima
// ficam guardados no backend; consumi-los fecha a janela de corrida. Abrir
// duas vezes (evento + pedido guardado) é inofensivo: openNewReminder só foca
// um formulário já aberto.
try {
  if (await invoke("take_new_reminder_request")) openNewReminder();
} catch {
  // Backend sem o comando (ou sem pedido): nada a fazer.
}
// Arquivo danificado ou bloqueado na abertura: o backend segue sem esses
// dados (ou sem gravar), e o usuário precisa saber disso agora, não quando
// tentar salvar.
try {
  const warnings = await invoke("get_load_warnings");
  if (warnings.length > 0) showSnackbar(warnings.join(" "), "Entendi", () => {});
} catch {
  // Backend sem o comando: nada a avisar.
}
try {
  const version = await invoke("get_available_update");
  if (version) showUpdateBanner(version);
} catch {
  // Sem versão detectada ainda; o evento "update-available" cobre o resto.
}
