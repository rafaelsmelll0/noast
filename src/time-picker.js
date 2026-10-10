// Seletor de hora próprio para campos <input type="time">.
//
// O seletor nativo do WebView2 abre uma lista desenhada pelo Windows: ignora
// o tema do app, sai do tamanho da janela e não dá para estilizar. Como no
// calendário (date-picker.js), o input original fica escondido como fonte do
// valor — todo o código que lê ou atribui `input.value` continua funcionando.
// O campo visível aceita digitação ("830", "8:30", "08:30") e um botão abre a
// lista de horas e minutos.

import { popoverPlacement } from "./date-picker.js";

const pad = (value) => String(value).padStart(2, "0");

/// Minutos oferecidos na lista. Valores fora do passo (ex.: 08:07) continuam
/// valendo pela digitação e aparecem na lista enquanto estiverem escolhidos.
const MINUTE_STEP = 5;

/// Interpreta o que foi digitado: "8", "830", "0830", "8:30", "8h30", "8h".
/// Devolve "HH:MM" ou null se não for uma hora válida.
export function parseTyped(text) {
  const raw = String(text ?? "").trim().toLowerCase();
  if (!raw) return null;
  let hours;
  let minutes;
  const separated = raw.match(/^(\d{1,2})\s*[:h.]\s*(\d{0,2})$/);
  if (separated) {
    hours = Number(separated[1]);
    minutes = separated[2] ? Number(separated[2]) : 0;
    if (separated[2] && separated[2].length === 1) minutes *= 10;
  } else if (/^\d{1,4}$/.test(raw)) {
    if (raw.length <= 2) {
      hours = Number(raw);
      minutes = 0;
    } else {
      hours = Number(raw.slice(0, raw.length - 2));
      minutes = Number(raw.slice(-2));
    }
  } else {
    return null;
  }
  if (hours > 23 || minutes > 59) return null;
  return `${pad(hours)}:${pad(minutes)}`;
}

export function attachTimePicker(input) {
  if (!input || input.dataset.pickerReady === "true") return null;
  input.dataset.pickerReady = "true";

  const wrapper = document.createElement("div");
  wrapper.className = "time-field";
  wrapper.innerHTML = `
    <input class="time-field-input" type="text" inputmode="numeric" maxlength="5"
      autocomplete="off" spellcheck="false" placeholder="--:--" aria-label="Hora" />
    <button type="button" class="time-field-toggle" aria-label="Escolher hora" aria-expanded="false">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    </button>`;
  const field = wrapper.querySelector(".time-field-input");
  const toggle = wrapper.querySelector(".time-field-toggle");

  const popover = document.createElement("div");
  popover.className = "time-popover";
  popover.hidden = true;

  input.after(wrapper, popover);
  input.classList.add("time-input-hidden");

  const valueProperty = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  const readValue = () => valueProperty.get.call(input);

  function syncField() {
    // Não sobrescreve o que o usuário está digitando agora.
    if (document.activeElement === field) return;
    field.value = readValue();
  }

  function commit(value, { keepOpen = false } = {}) {
    valueProperty.set.call(input, value);
    field.value = value;
    // O código do app escuta "input"/"change" no campo original.
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    if (keepOpen) render();
    else close();
  }

  function current() {
    const [hours, minutes] = (readValue() || "").split(":").map(Number);
    return {
      hours: Number.isFinite(hours) ? hours : null,
      minutes: Number.isFinite(minutes) ? minutes : null,
    };
  }

  function render() {
    const { hours, minutes } = current();
    const hourItems = Array.from({ length: 24 }, (_, hour) => hour);
    const minuteItems = Array.from({ length: 60 / MINUTE_STEP }, (_, i) => i * MINUTE_STEP);
    if (minutes !== null && !minuteItems.includes(minutes)) {
      minuteItems.push(minutes);
      minuteItems.sort((a, b) => a - b);
    }
    const item = (kind, value, selected) =>
      `<button type="button" class="time-option${selected ? " is-selected" : ""}" data-${kind}="${value}">${pad(value)}</button>`;
    popover.innerHTML = `
      <div class="time-columns">
        <div class="time-column" data-column="hours" aria-label="Horas">
          ${hourItems.map((hour) => item("hour", hour, hour === hours)).join("")}
        </div>
        <div class="time-column" data-column="minutes" aria-label="Minutos">
          ${minuteItems.map((minute) => item("minute", minute, minute === minutes)).join("")}
        </div>
      </div>`;
  }

  /// Rola cada coluna para deixar o valor escolhido no meio.
  function revealSelection() {
    popover.querySelectorAll(".time-column").forEach((column) => {
      const selected = column.querySelector(".is-selected");
      if (!selected) return;
      const offset =
        selected.getBoundingClientRect().top - column.getBoundingClientRect().top;
      column.scrollTop += offset - (column.clientHeight - selected.offsetHeight) / 2;
    });
  }

  /// Mesmo esquema do calendário: `position: fixed` com a posição calculada
  /// (onde o CSS o deixa em fluxo, como no Personalizar, top/left não valem).
  function place() {
    if (popover.hidden) return;
    popover.style.left = "0px";
    popover.style.top = "0px";
    const origin = popover.getBoundingClientRect();
    if (getComputedStyle(popover).position !== "fixed") return;
    const { top, left, above } = popoverPlacement(
      wrapper.getBoundingClientRect(),
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
    render();
    popover.hidden = false;
    toggle.setAttribute("aria-expanded", "true");
    place();
    revealSelection();
  }

  function close() {
    if (popover.hidden) return;
    popover.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  }

  toggle.addEventListener("click", () => (popover.hidden ? open() : close()));

  popover.addEventListener("click", (event) => {
    const { hours, minutes } = current();
    const hourButton = event.target.closest("[data-hour]");
    if (hourButton) {
      // Escolher a hora mantém a lista aberta para escolher os minutos.
      commit(`${pad(hourButton.dataset.hour)}:${pad(minutes ?? 0)}`, { keepOpen: true });
      return;
    }
    const minuteButton = event.target.closest("[data-minute]");
    if (minuteButton) {
      const hour = hours ?? new Date().getHours();
      commit(`${pad(hour)}:${pad(minuteButton.dataset.minute)}`);
      field.focus();
    }
  });

  // Digitação: só vira valor quando forma uma hora válida; ao sair do campo,
  // volta ao último valor válido (ou normaliza "830" para "08:30").
  field.addEventListener("input", () => {
    const parsed = parseTyped(field.value);
    if (parsed && field.value.length >= 4) {
      valueProperty.set.call(input, parsed);
      input.dispatchEvent(new Event("input", { bubbles: true }));
      if (!popover.hidden) render();
    }
  });
  field.addEventListener("blur", () => {
    const parsed = parseTyped(field.value);
    if (parsed && parsed !== readValue()) {
      commit(parsed, { keepOpen: !popover.hidden });
    }
    field.value = readValue();
  });
  field.addEventListener("focus", () => field.select());
  field.addEventListener("keydown", (event) => {
    // Enter confirma o que foi digitado antes de quem usa o campo (formulário,
    // Personalizar) tratar a tecla.
    if (event.key === "Enter") {
      const parsed = parseTyped(field.value);
      if (parsed && parsed !== readValue()) commit(parsed);
      field.value = readValue();
    }
    if (event.key === "ArrowDown" && event.altKey) {
      event.preventDefault();
      open();
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (popover.hidden) return;
    if (!popover.contains(event.target) && !wrapper.contains(event.target)) close();
  });

  // Esc com a lista aberta fecha só a lista (mesma razão do calendário: na
  // captura em `window`, antes dos listeners do app que fechariam a janela).
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

  window.addEventListener("scroll", place, true);
  window.addEventListener("resize", place);

  // Atribuir `input.value` por código (atalhos, abrir o formulário) atualiza o
  // campo visível; ler continua devolvendo o valor do input original.
  Object.defineProperty(input, "value", {
    configurable: true,
    get() {
      return readValue();
    },
    set(next) {
      valueProperty.set.call(this, next);
      field.value = readValue();
      if (!popover.hidden) render();
    },
  });

  input.form?.addEventListener("reset", () => {
    close();
    window.setTimeout(() => {
      field.value = readValue();
    }, 0);
  });

  syncField();

  return {
    field,
    close,
    isOpen: () => !popover.hidden,
  };
}
