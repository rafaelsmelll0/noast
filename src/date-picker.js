// Calendário próprio para campos de data.
//
// O seletor nativo do WebView2 é desenhado pelo navegador: ignora o tema do
// app, não acompanha o modo escuro e não dá para estilizar. Este componente o
// substitui, mantendo o <input type="date"> original escondido como fonte do
// valor — assim todo o código que lê `input.value` continua funcionando.

const WEEKDAYS = ["D", "S", "T", "Q", "Q", "S", "S"];
const MONTHS = [
  "janeiro",
  "fevereiro",
  "março",
  "abril",
  "maio",
  "junho",
  "julho",
  "agosto",
  "setembro",
  "outubro",
  "novembro",
  "dezembro",
];

const pad = (value) => String(value).padStart(2, "0");

export function isoDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/// "2026-08-14" -> Date local ao meio-dia. O meio-dia evita que fusos negativos
/// joguem a data para o dia anterior.
export function parseIso(value) {
  if (!value) return null;
  const [year, month, day] = value.split("-").map(Number);
  if (!year || !month || !day) return null;
  const date = new Date(year, month - 1, day, 12, 0, 0, 0);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function formatBr(value) {
  const date = parseIso(value);
  return date ? `${pad(date.getDate())}/${pad(date.getMonth() + 1)}/${date.getFullYear()}` : "";
}

/// Dias mostrados no mês: começa no domingo anterior ao dia 1 e completa
/// semanas inteiras, para o grid nunca ficar torto.
export function monthGrid(year, month) {
  const first = new Date(year, month, 1, 12);
  const start = new Date(first);
  start.setDate(1 - first.getDay());
  const days = [];
  for (let index = 0; index < 42; index += 1) {
    const day = new Date(start);
    day.setDate(start.getDate() + index);
    days.push(day);
    // Para na última semana completa que ainda contém o mês corrente.
    if (index >= 27 && day.getDay() === 6) {
      const next = new Date(day);
      next.setDate(day.getDate() + 1);
      if (next.getMonth() !== month) break;
    }
  }
  return days;
}

export function attachDatePicker(input) {
  if (!input || input.dataset.pickerReady === "true") return;
  input.dataset.pickerReady = "true";

  const field = document.createElement("button");
  field.type = "button";
  field.className = "date-field";
  field.innerHTML = `
    <span class="date-field-value"></span>
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M8 3v4M16 3v4M3 10h18" />
    </svg>`;

  const popover = document.createElement("div");
  popover.className = "date-popover";
  popover.hidden = true;

  input.after(field, popover);
  input.classList.add("date-input-hidden");

  let viewYear = 0;
  let viewMonth = 0;

  function limits() {
    return { min: parseIso(input.min), max: parseIso(input.max) };
  }

  function outOfRange(date) {
    const { min, max } = limits();
    const day = new Date(date);
    day.setHours(12, 0, 0, 0);
    if (min && day < min) return true;
    if (max && day > max) return true;
    return false;
  }

  function syncFieldLabel() {
    const label = formatBr(input.value);
    field.querySelector(".date-field-value").textContent = label || "Escolher data";
    field.classList.toggle("is-empty", !label);
    field.setAttribute("aria-label", label ? `Data: ${label}` : "Escolher data");
  }

  function render() {
    const selected = parseIso(input.value);
    const today = new Date();
    today.setHours(12, 0, 0, 0);

    const days = monthGrid(viewYear, viewMonth)
      .map((day) => {
        const classes = ["date-day"];
        if (day.getMonth() !== viewMonth) classes.push("is-outside");
        if (selected && isoDate(day) === isoDate(selected)) classes.push("is-selected");
        if (isoDate(day) === isoDate(today)) classes.push("is-today");
        const disabled = outOfRange(day) ? " disabled" : "";
        return `<button type="button" class="${classes.join(" ")}" data-date="${isoDate(day)}"${disabled}>${day.getDate()}</button>`;
      })
      .join("");

    popover.innerHTML = `
      <div class="date-popover-header">
        <button type="button" class="date-nav" data-step="-1" aria-label="Mês anterior">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6" /></svg>
        </button>
        <strong>${MONTHS[viewMonth]} ${viewYear}</strong>
        <button type="button" class="date-nav" data-step="1" aria-label="Próximo mês">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6" /></svg>
        </button>
      </div>
      <div class="date-weekdays">${WEEKDAYS.map((day) => `<span>${day}</span>`).join("")}</div>
      <div class="date-grid">${days}</div>
      <div class="date-popover-footer">
        <button type="button" class="date-today">Hoje</button>
      </div>`;
  }

  function open() {
    const selected = parseIso(input.value) ?? new Date();
    viewYear = selected.getFullYear();
    viewMonth = selected.getMonth();
    render();
    popover.hidden = false;
    field.setAttribute("aria-expanded", "true");
  }

  function close() {
    popover.hidden = true;
    field.setAttribute("aria-expanded", "false");
  }

  function commit(value) {
    input.value = value;
    // O código do app escuta "input"/"change" no campo original.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    syncFieldLabel();
    close();
  }

  field.addEventListener("click", () => (popover.hidden ? open() : close()));

  popover.addEventListener("click", (event) => {
    const nav = event.target.closest("[data-step]");
    if (nav) {
      viewMonth += Number(nav.dataset.step);
      if (viewMonth < 0) {
        viewMonth = 11;
        viewYear -= 1;
      } else if (viewMonth > 11) {
        viewMonth = 0;
        viewYear += 1;
      }
      render();
      return;
    }
    if (event.target.closest(".date-today")) {
      const today = new Date();
      if (!outOfRange(today)) commit(isoDate(today));
      return;
    }
    const day = event.target.closest("[data-date]");
    if (day && !day.disabled) commit(day.dataset.date);
  });

  document.addEventListener("pointerdown", (event) => {
    if (popover.hidden) return;
    if (!popover.contains(event.target) && !field.contains(event.target)) close();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !popover.hidden) {
      event.stopPropagation();
      close();
      field.focus();
    }
  });

  // Mudanças feitas por código (atalhos "Amanhã 9h", dia da semana) precisam
  // refletir no rótulo.
  input.addEventListener("change", syncFieldLabel);
  input.addEventListener("input", syncFieldLabel);

  syncFieldLabel();
}
