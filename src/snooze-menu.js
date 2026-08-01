const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

function applyTheme(theme) {
  if (theme === "system") {
    document.documentElement.removeAttribute("data-theme");
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

const settings = await invoke("get_settings");
applyTheme(settings.theme);
await listen("settings-changed", (event) => applyTheme(event.payload.theme));

document.querySelectorAll("button").forEach((button) => {
  button.addEventListener("click", async () => {
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
    } finally {
      button.disabled = false;
    }
  });
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") invoke("hide_snooze_menu");
});
