import { createConfirmDialog } from "./confirm-dialog.js";
import { createNotesController } from "./notes.js";
import { createVaultController } from "./vault.js";

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
  snackbar: document.querySelector("#snackbar"),
  snackbarText: document.querySelector("#snackbarText"),
  snackbarAction: document.querySelector("#snackbarAction"),
};

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

  elements.groups.innerHTML = [...groups.values()]
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
}

async function loadNotifications() {
  try {
    state.notifications = await invoke("get_notifications");
    render();
  } catch (error) {
    showSnackbar(errorMessage(error));
  }
}

function localDateParts(date) {
  return {
    date: `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`,
    time: `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
  };
}

function openModal(notification = null, duplicate = false) {
  state.editingId = notification && !duplicate ? notification.id : null;
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

  updateCharacterCount();
  elements.modal.hidden = false;
  window.setTimeout(() => elements.text.focus(), 80);
}

function closeModal() {
  elements.modal.hidden = true;
  state.editingId = null;
  elements.form.reset();
  elements.formError.textContent = "";
}

function updateCharacterCount() {
  elements.characterCount.textContent = [...elements.text.value].length;
}

async function saveReminder(event) {
  event.preventDefault();
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
  try {
    await invoke("save_notification", { notification });
    closeModal();
    await loadNotifications();
    showSnackbar(wasEditing ? "Lembrete atualizado." : "Lembrete salvo.");
  } catch (error) {
    elements.formError.textContent = errorMessage(error);
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

async function loadSettings() {
  try {
    state.settings = await invoke("get_settings");
    document.querySelector("#themeSetting").value = state.settings.theme;
    document.querySelector("#monitorSetting").value = state.settings.alert_monitor;
    document.querySelector("#snoozeSetting").value = String(state.settings.snooze_minutes);
    document.querySelector("#alwaysOnTopSetting").checked = state.settings.alert_always_on_top;
    document.querySelector("#soundSetting").checked = state.settings.alert_sound;
    document.querySelector("#autostartSetting").checked = state.settings.start_with_windows;
    document.querySelector("#trayClickSetting").value = state.settings.tray_click_action;
    applyTheme(state.settings.theme);
  } catch (error) {
    showSnackbar(errorMessage(error));
  }
}

function currentSettings() {
  return {
    theme: document.querySelector("#themeSetting").value,
    snooze_minutes: Number(document.querySelector("#snoozeSetting").value),
    alert_monitor: document.querySelector("#monitorSetting").value,
    alert_always_on_top: document.querySelector("#alwaysOnTopSetting").checked,
    alert_sound: document.querySelector("#soundSetting").checked,
    start_with_windows: document.querySelector("#autostartSetting").checked,
    tray_click_action: document.querySelector("#trayClickSetting").value,
  };
}

async function persistSettings(showConfirmation = false) {
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

function selectView(view) {
  if (state.activeView === "vault" && view !== "vault") vaultController.deactivate();
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
document.querySelector("#newReminder").addEventListener("click", () => openModal());
document.querySelector("#closeModal").addEventListener("click", closeModal);
document.querySelector("#cancelModal").addEventListener("click", closeModal);
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
elements.settingsForm.addEventListener("submit", saveSettings);

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

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !elements.modal.hidden) closeModal();
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
    event.preventDefault();
    if (state.activeView === "notes") {
      notesController.createNote();
    } else if (state.activeView === "vault") {
      vaultController.createClient();
    } else {
      selectView("reminders");
      openModal();
    }
  }
});

await Promise.all([
  loadNotifications(),
  loadSettings(),
  notesController.load(),
  vaultController.load(),
]);
await listen("notifications-changed", loadNotifications);
await listen("open-new-reminder", () => {
  selectView("reminders");
  openModal();
});
