export function createConfirmDialog() {
  const overlay = document.querySelector("#confirmDialog");
  const title = document.querySelector("#confirmDialogTitle");
  const message = document.querySelector("#confirmDialogMessage");
  const cancel = document.querySelector("#confirmDialogCancel");
  const confirm = document.querySelector("#confirmDialogConfirm");
  let resolveCurrent = null;
  let previousFocus = null;

  function finish(result) {
    if (!resolveCurrent) return;
    const resolve = resolveCurrent;
    resolveCurrent = null;
    overlay.hidden = true;
    previousFocus?.focus?.();
    previousFocus = null;
    resolve(result);
  }

  function open({
    dialogTitle = "Confirmar exclusão",
    dialogMessage,
    confirmLabel = "Excluir",
  }) {
    if (resolveCurrent) finish(false);
    previousFocus = document.activeElement;
    title.textContent = dialogTitle;
    message.textContent = dialogMessage;
    confirm.textContent = confirmLabel;
    overlay.hidden = false;
    window.setTimeout(() => cancel.focus(), 30);
    return new Promise((resolve) => {
      resolveCurrent = resolve;
    });
  }

  cancel.addEventListener("click", () => finish(false));
  confirm.addEventListener("click", () => finish(true));
  overlay.addEventListener("click", (event) => {
    if (event.target === overlay) finish(false);
  });
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      finish(false);
    }
    if (event.key !== "Tab") return;
    if (!event.shiftKey && document.activeElement === confirm) {
      event.preventDefault();
      cancel.focus();
    } else if (event.shiftKey && document.activeElement === cancel) {
      event.preventDefault();
      confirm.focus();
    }
  });

  return { open };
}
