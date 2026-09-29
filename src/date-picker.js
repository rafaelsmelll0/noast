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

/// Onde o calendário deve aparecer, em coordenadas da janela. Abre embaixo do
/// campo; se não couber e houver mais espaço em cima, abre para cima. Em
/// qualquer caso fica dentro da janela (com `margin` de folga), para nunca
/// ser cortado — antes ele morava dentro do modal com rolagem e a última
/// semana e o botão "Hoje" ficavam escondidos.
export function popoverPlacement(anchor, size, viewport, { gap = 6, margin = 8 } = {}) {
  const spaceBelow = viewport.height - anchor.bottom - gap - margin;
  const spaceAbove = anchor.top - gap - margin;
  const above = size.height > spaceBelow && spaceAbove > spaceBelow;
  const wantedTop = above ? anchor.top - gap - size.height : anchor.bottom + gap;
  const clamp = (value, max) => Math.max(margin, Math.min(value, max));
  return {
    top: clamp(wantedTop, viewport.height - size.height - margin),
    left: clamp(anchor.left, viewport.width - size.width - margin),
    above,
  };
}

/// Anexa o calendário ao campo e devolve um controle mínimo para quem o usa
/// (fechar ao resetar o formulário, saber se está aberto antes de tratar
/// Enter/Esc).
export function attachDatePicker(input) {
  if (!input || input.dataset.pickerReady === "true") return null;
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

  /// O popup é `position: fixed` para escapar do `overflow` do modal. Um
  /// ancestral com `backdrop-filter`/`transform` (o fundo do modal) vira o
  /// bloco de referência do fixed; medir o popup em (0, 0) revela esse
  /// deslocamento, e a conta funciona com ou sem ele.
  function place() {
    if (popover.hidden) return;
    popover.style.left = "0px";
    popover.style.top = "0px";
    const origin = popover.getBoundingClientRect();
    const { top, left, above } = popoverPlacement(
      field.getBoundingClientRect(),
      { width: origin.width, height: origin.height },
      {
        width: document.documentElement.clientWidth,
        height: document.documentElement.clientHeight,
      },
    );
    popover.style.left = `${left - origin.left}px`;
    popover.style.top = `${top - origin.top}px`;
    popover.classList.toggle("is-above", above);
  }

  function open() {
    const selected = parseIso(input.value) ?? new Date();
    viewYear = selected.getFullYear();
    viewMonth = selected.getMonth();
    render();
    popover.hidden = false;
    field.setAttribute("aria-expanded", "true");
    place();
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
      // Meses com uma semana a mais ou a menos mudam a altura do popup.
      place();
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

  // Esc com o calendário aberto fecha só o calendário. Escutar na fase de
  // captura em `window` garante rodar antes dos listeners de `document` do
  // app (que fechariam o formulário inteiro ou a janela Personalizar), e o
  // stopImmediatePropagation impede que eles vejam a tecla — stopPropagation
  // no próprio document não bastava, porque o listener do app rodava antes.
  window.addEventListener(
    "keydown",
    (event) => {
      if (event.key !== "Escape" || popover.hidden) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
      field.focus();
    },
    true,
  );

  // Rolar o modal ou redimensionar a janela move o campo: o popup acompanha.
  window.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);

  input.addEventListener("change", syncFieldLabel);
  input.addEventListener("input", syncFieldLabel);

  // Atribuir `input.value` por código (data inicial ao abrir o formulário,
  // atalhos "Amanhã 9h", seletor de dia da semana) não dispara evento algum —
  // o rótulo ficaria preso em "Escolher data" com o campo já preenchido.
  // Interceptar o setter mantém o componente transparente para quem o usa.
  const valueProperty = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  Object.defineProperty(input, "value", {
    configurable: true,
    get() {
      return valueProperty.get.call(this);
    },
    set(next) {
      valueProperty.set.call(this, next);
      syncFieldLabel();
    },
  });

  // form.reset() limpa o campo por dentro, sem passar pelo setter acima.
  // O atraso deixa o navegador aplicar o reset antes de reler o valor.
  // Fechar o calendário aqui evita que ele reapareça aberto na próxima vez
  // que o formulário for mostrado (ex.: salvo com Enter com o popup aberto).
  input.form?.addEventListener("reset", () => {
    close();
    window.setTimeout(syncFieldLabel, 0);
  });

  syncFieldLabel();

  return {
    field,
    close,
    isOpen: () => !popover.hidden,
  };
}
