const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const MAX_VISIBLE = 3;
const state = {
  queue: [],
  settings: {
    theme: "system",
    snooze_minutes: 15,
  },
  presenting: false,
  lastHeight: 0,
  presentationVersion: 0,
  snoozeMenuOpen: false,
  refreshSeq: 0,
};

const elements = {
  card: document.querySelector("#alertCard"),
  list: document.querySelector("#alertList"),
  count: document.querySelector("#alertCount"),
  footer: document.querySelector("#alertFooter"),
  remaining: document.querySelector("#remainingCount"),
  error: document.querySelector("#alertError"),
};

function errorMessage(error) {
  if (typeof error === "string") return error;
  if (error?.message) return error.message;
  return "Não foi possível concluir esta ação.";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDateTime(value) {
  const date = new Date(value);
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = new Intl.DateTimeFormat("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
  if (sameDay) return `Hoje, ${time}`;
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function applyTheme(theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

function showError(message) {
  elements.error.textContent = message;
  elements.error.hidden = false;
  schedulePresent();
}

function clearError() {
  elements.error.hidden = true;
  elements.error.textContent = "";
}

function itemHtml(notification) {
  const defaultMinutes = state.settings.snooze_minutes;
  return `
    <article class="alert-item" data-id="${escapeHtml(notification.id)}">
      <div class="item-copy">
        <p class="item-text">${escapeHtml(notification.text)}</p>
        <time class="item-time">${escapeHtml(formatDateTime(notification.datetime))}</time>
      </div>
      <div class="item-actions">
        <button class="action-button complete" type="button" data-action="complete">Concluir</button>
        <div class="snooze-group">
          <button class="action-button" type="button" data-action="snooze" data-minutes="${defaultMinutes}">
            +${defaultMinutes} min
          </button>
          <button class="menu-toggle" type="button" data-action="menu" aria-label="Outras opções de adiamento">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
          </button>
        </div>
      </div>
    </article>`;
}

function render() {
  const visible = state.queue.slice(0, MAX_VISIBLE);
  elements.count.textContent = `${state.queue.length} ${state.queue.length === 1 ? "lembrete" : "lembretes"}`;
  elements.list.innerHTML = visible.map(itemHtml).join("");
  const remaining = Math.max(0, state.queue.length - MAX_VISIBLE);
  elements.remaining.textContent = remaining
    ? `+${remaining} na fila`
    : state.queue.length > 1
      ? "Ações em lote"
      : "";
  elements.footer.hidden = state.queue.length === 0;
  schedulePresent(true);
}

async function refreshQueue(animate = false) {
  const seq = ++state.refreshSeq;
  try {
    state.settings = await invoke("get_settings");
    applyTheme(state.settings.theme);
    const queue = (await invoke("get_pending_alerts")) ?? [];
    // Outra atualização começou enquanto buscávamos: este resultado é obsoleto.
    if (seq !== state.refreshSeq) return;
    state.queue = queue;
    if (state.queue.length === 0) {
      state.presentationVersion += 1;
      elements.card.classList.remove("visible");
      await new Promise((resolve) => window.setTimeout(resolve, 130));
      // A fila pode ter recebido itens durante a espera (corrida no startup:
      // o webview carrega antes do lembrete atrasado ser enfileirado) — só
      // esconde se este ainda for o refresh mais recente.
      if (seq !== state.refreshSeq) return;
      await invoke("hide_toast");
      return;
    }
    if (animate) elements.card.classList.remove("visible");
    render();
  } catch (error) {
    showError(errorMessage(error));
  }
}

async function present() {
  if (state.queue.length === 0 || state.presenting) return;
  const version = state.presentationVersion;
  const height = Math.ceil(elements.card.getBoundingClientRect().height + 2);
  if (height < 50) return;
  state.presenting = true;
  try {
    await invoke("present_toast", { height });
    if (version !== state.presentationVersion || state.queue.length === 0) {
      await invoke("hide_toast");
      return;
    }
    state.lastHeight = height;
    window.setTimeout(() => elements.card.classList.add("visible"), 16);
  } catch (error) {
    showError(errorMessage(error));
  } finally {
    state.presenting = false;
  }
}

function schedulePresent(force = false) {
  const version = state.presentationVersion;
  // setTimeout, não requestAnimationFrame: o WebView2 congela rAF em janela
  // oculta ou ainda não composta (ex.: startup), e a apresentação travaria
  // para sempre. Timers continuam rodando nesses estados.
  window.setTimeout(() => {
    if (version !== state.presentationVersion || state.queue.length === 0) return;
    const height = Math.ceil(elements.card.getBoundingClientRect().height + 2);
    if (force || Math.abs(height - state.lastHeight) > 1) present();
  }, 30);
}

async function actOnItem(item, action, minutes = null) {
  if (item.classList.contains("busy")) return;
  clearError();
  item.classList.add("busy");
  const id = item.dataset.id;
  try {
    if (action === "complete") {
      await invoke("mark_done", { id });
    } else {
      await invoke("snooze_notification", { id, minutes });
    }
    item.classList.add("leaving");
    await new Promise((resolve) => window.setTimeout(resolve, 130));
    await refreshQueue();
  } catch (error) {
    item.classList.remove("busy", "leaving");
    showError(errorMessage(error));
  }
}

elements.list.addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  const item = event.target.closest(".alert-item");
  if (!button || !item) return;
  const action = button.dataset.action;

  if (action === "menu") {
    const group = button.closest(".snooze-group");
    const rect = group.getBoundingClientRect();
    invoke("open_snooze_menu", {
      id: item.dataset.id,
      anchor: {
        x: rect.left,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
      },
    })
      .then((opened) => {
        state.snoozeMenuOpen = opened;
      })
      .catch((error) => showError(errorMessage(error)));
    return;
  }

  if (state.snoozeMenuOpen) {
    state.snoozeMenuOpen = false;
    invoke("hide_snooze_menu");
  }
  actOnItem(item, action, Number(button.dataset.minutes));
});

document.addEventListener("pointerdown", (event) => {
  if (!state.snoozeMenuOpen || event.target.closest('[data-action="menu"]')) return;
  state.snoozeMenuOpen = false;
  invoke("hide_snooze_menu");
});

document.querySelector("#openNoast").addEventListener("click", async () => {
  try {
    await invoke("open_main_from_toast");
  } catch (error) {
    showError(errorMessage(error));
  }
});

document.querySelector("#snoozeAll").addEventListener("click", async () => {
  clearError();
  try {
    await invoke("snooze_all", { minutes: state.settings.snooze_minutes });
    await refreshQueue();
  } catch (error) {
    showError(errorMessage(error));
  }
});

document.querySelector("#completeAll").addEventListener("click", async () => {
  clearError();
  try {
    await invoke("mark_all_done");
    await refreshQueue();
  } catch (error) {
    showError(errorMessage(error));
  }
});

new ResizeObserver(() => schedulePresent()).observe(elements.card);

try {
  state.settings = await invoke("get_settings");
  applyTheme(state.settings.theme);
} catch (error) {
  showError(errorMessage(error));
}

await listen("queue-updated", () => refreshQueue(true));
await listen("settings-changed", (event) => {
  state.settings = event.payload;
  applyTheme(state.settings.theme);
  render();
});
await refreshQueue();
