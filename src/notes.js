import { escapeHtml, noteExcerpt, previewHtml } from "./note-format.js";

function noteLabel(note) {
  return note.title.trim() || "Sem título";
}

function noteTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Agora";
  const today = new Date();
  const sameDay =
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate();
  return new Intl.DateTimeFormat("pt-BR", sameDay
    ? { hour: "2-digit", minute: "2-digit" }
    : { day: "2-digit", month: "short" }).format(date);
}

function inlineHtmlToWhatsapp(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent.replaceAll("\u00a0", " ");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return "";

  const tag = node.tagName;
  if (tag === "BR") return "\n";
  const content = [...node.childNodes].map(inlineHtmlToWhatsapp).join("");
  if (!content) return "";
  if (tag === "STRONG" || tag === "B") return `*${content}*`;
  if (tag === "EM" || tag === "I") return `_${content}_`;
  if (tag === "S" || tag === "STRIKE" || tag === "DEL") return `~${content}~`;
  if (tag === "CODE" && node.parentElement?.tagName !== "PRE") return `\`\`\`${content}\`\`\``;
  return content;
}

function visualEditorToWhatsapp(root) {
  const blocks = [];

  function serializeBlock(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent;
    if (node.nodeType !== Node.ELEMENT_NODE) return "";
    const tag = node.tagName;

    if (tag === "UL" || tag === "OL") {
      const startAttr = parseInt(node.getAttribute("start") ?? "1", 10);
      const base = Number.isNaN(startAttr) ? 1 : startAttr;
      return [...node.children]
        .filter((child) => child.tagName === "LI")
        .map((item, index) => `${tag === "UL" ? "-" : `${base + index}.`} ${inlineHtmlToWhatsapp(item)}`)
        .join("\n");
    }
    if (tag === "BLOCKQUOTE") {
      return inlineHtmlToWhatsapp(node)
        .split("\n")
        .map((line) => `> ${line}`)
        .join("\n");
    }
    if (tag === "PRE") return `\`\`\`${node.textContent.replaceAll("\u00a0", " ")}\`\`\``;
    return inlineHtmlToWhatsapp(node);
  }

  for (const child of root.childNodes) {
    blocks.push(serializeBlock(child));
  }
  return blocks.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "");
}

async function writeClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // WebView2 may expose the API while denying it; use the local fallback below.
    }
  }

  const fallback = document.createElement("textarea");
  fallback.value = text;
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  document.body.append(fallback);
  fallback.select();
  const copied = document.execCommand("copy");
  fallback.remove();
  if (!copied) throw new Error("Não foi possível acessar a área de transferência.");
}

export function createNotesController({ invoke, showSnackbar, confirmAction }) {
  const state = {
    notes: [],
    selectedId: null,
    query: "",
    mode: "preview",
    dirtyIds: new Set(),
    saveTimers: new Map(),
    saving: new Map(),
  };

  const elements = {
    view: document.querySelector("#notesView"),
    list: document.querySelector("#notesList"),
    listEmpty: document.querySelector("#notesListEmpty"),
    empty: document.querySelector("#noteEmptyState"),
    editor: document.querySelector("#noteEditor"),
    title: document.querySelector("#noteTitle"),
    content: document.querySelector("#noteContent"),
    preview: document.querySelector("#notePreview"),
    status: document.querySelector("#noteSaveStatus"),
    meta: document.querySelector("#noteMeta"),
    pin: document.querySelector("#pinNote"),
    count: document.querySelector("#navNotesCount"),
    search: document.querySelector("#notesSearchInput"),
    toolbar: document.querySelector("#noteToolbar"),
    overflowButton: document.querySelector("#formatOverflowButton"),
    overflowMenu: document.querySelector("#formatOverflowMenu"),
  };

  function selectedNote() {
    return state.notes.find((note) => note.id === state.selectedId) ?? null;
  }

  function sortedNotes() {
    return [...state.notes].sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return (b.updated_at || "").localeCompare(a.updated_at || "");
    });
  }

  function filteredNotes() {
    const query = state.query;
    return sortedNotes().filter((note) =>
      `${note.title}\n${note.content}`.toLocaleLowerCase("pt-BR").includes(query),
    );
  }

  function renderList() {
    const notes = filteredNotes();
    elements.count.textContent = state.notes.length;
    elements.listEmpty.hidden = notes.length > 0;
    elements.list.innerHTML = notes
      .map(
        (note) => `
          <button class="note-list-item${note.id === state.selectedId ? " active" : ""}" type="button" data-note-id="${escapeHtml(note.id)}">
            <span class="note-list-title-row">
              <span class="note-list-title">${escapeHtml(noteLabel(note))}</span>
              ${
                note.pinned
                  ? '<svg class="note-list-pin" viewBox="0 0 24 24" aria-label="Fixada"><path d="m14 4 6 6-3 1-4 4-1 5-3-3-4 4-1-1 4-4-3-3 5-1 4-4Z"/></svg>'
                  : ""
              }
            </span>
            <span class="note-list-preview">${escapeHtml(noteExcerpt(note.content))}</span>
            <span class="note-list-date">${escapeHtml(noteTime(note.updated_at))}</span>
          </button>`,
      )
      .join("");
  }

  function updateMeta(note) {
    const count = [...note.content].length;
    elements.meta.textContent = `${count.toLocaleString("pt-BR")} caractere${count === 1 ? "" : "s"}`;
  }

  function setMode() {
    setOverflowOpen(false);
    state.mode = "preview";
    elements.content.hidden = true;
    elements.preview.hidden = false;
    elements.preview.innerHTML = previewHtml(selectedNote()?.content ?? "");
    window.setTimeout(() => elements.preview.focus(), 0);
  }

  function setOverflowOpen(open) {
    elements.overflowMenu.hidden = !open;
    elements.overflowButton.setAttribute("aria-expanded", String(open));
  }

  function renderEditor({ focusTitle = false } = {}) {
    const note = selectedNote();
    elements.empty.hidden = Boolean(note);
    elements.editor.hidden = !note;
    if (!note) return;

    elements.title.value = note.title;
    elements.content.value = note.content;
    elements.pin.setAttribute("aria-pressed", String(note.pinned));
    elements.pin.setAttribute("aria-label", note.pinned ? "Desafixar nota" : "Fixar nota");
    elements.status.textContent = "";
    updateMeta(note);
    setMode();
    if (focusTitle) {
      window.setTimeout(() => elements.title.focus(), 50);
    }
  }

  function selectNote(id, options) {
    setOverflowOpen(false);
    state.selectedId = state.notes.some((note) => note.id === id) ? id : null;
    renderList();
    renderEditor(options);
  }

  function setSaveStatus(id, text) {
    if (state.selectedId === id) elements.status.textContent = text;
  }

  async function saveById(id) {
    const timer = state.saveTimers.get(id);
    if (timer) window.clearTimeout(timer);
    state.saveTimers.delete(id);

    if (state.saving.has(id)) {
      await state.saving.get(id);
      if (state.dirtyIds.has(id)) return saveById(id);
      return state.notes.find((note) => note.id === id);
    }
    if (!state.dirtyIds.has(id)) return state.notes.find((note) => note.id === id);

    const note = state.notes.find((item) => item.id === id);
    if (!note) return null;
    state.dirtyIds.delete(id);
    setSaveStatus(id, "Salvando...");
    const snapshot = { ...note };

    let saveFailed = false;
    const saving = invoke("save_note", { note: snapshot })
      .then((saved) => {
        const current = state.notes.find((item) => item.id === id);
        if (current) {
          current.created_at = saved.created_at;
          current.updated_at = saved.updated_at;
          if (!state.dirtyIds.has(id)) {
            current.title = saved.title;
            current.content = saved.content;
            current.pinned = saved.pinned;
          }
        }
        setSaveStatus(id, state.dirtyIds.has(id) ? "Alterações pendentes" : "Salvo");
        renderList();
        return saved;
      })
      .catch((error) => {
        saveFailed = true;
        state.dirtyIds.add(id);
        setSaveStatus(id, "Não foi possível salvar");
        showSnackbar(typeof error === "string" ? error : "Não foi possível salvar a nota.");
        return null;
      })
      .finally(() => {
        state.saving.delete(id);
        if (
          !saveFailed &&
          state.dirtyIds.has(id) &&
          state.notes.some((item) => item.id === id)
        ) {
          scheduleSave(id, 800);
        }
      });

    state.saving.set(id, saving);
    return saving;
  }

  function scheduleSave(id, delay = 650) {
    state.dirtyIds.add(id);
    const currentTimer = state.saveTimers.get(id);
    if (currentTimer) window.clearTimeout(currentTimer);
    setSaveStatus(id, "Alterações pendentes");
    state.saveTimers.set(id, window.setTimeout(() => saveById(id), delay));
  }

  async function createNote() {
    state.query = "";
    elements.search.value = "";
    const id = crypto.randomUUID();
    const note = {
      id,
      title: "",
      content: "",
      pinned: false,
      created_at: "",
      updated_at: new Date().toISOString(),
    };
    state.notes.push(note);
    state.mode = "preview";
    selectNote(id, { focusTitle: true });
    scheduleSave(id, 0);
  }

  async function deleteSelected() {
    const note = selectedNote();
    if (!note) return;

    const confirmed = await confirmAction({
      dialogTitle: "Excluir nota?",
      dialogMessage: `A nota "${noteLabel(note)}" será excluída. Você ainda poderá desfazer logo após a exclusão.`,
      confirmLabel: "Excluir nota",
    });
    if (!confirmed) return;

    const timer = state.saveTimers.get(note.id);
    if (timer) window.clearTimeout(timer);
    state.saveTimers.delete(note.id);
    await saveById(note.id);

    if (!note.created_at) {
      state.dirtyIds.delete(note.id);
      state.notes = state.notes.filter((item) => item.id !== note.id);
      selectNote(filteredNotes()[0]?.id ?? null);
      showSnackbar("Nota local descartada.");
      return;
    }

    try {
      await invoke("delete_note", { id: note.id });
      state.dirtyIds.delete(note.id);
      state.notes = state.notes.filter((item) => item.id !== note.id);
      const next = filteredNotes()[0]?.id ?? null;
      selectNote(next);
      showSnackbar("Nota excluída.", "Desfazer", async () => {
        try {
          const restored = await invoke("restore_note", { note });
          state.notes.push(restored);
          selectNote(restored.id);
          showSnackbar("Nota restaurada.");
        } catch (error) {
          showSnackbar(typeof error === "string" ? error : "Não foi possível restaurar a nota.");
        }
      });
    } catch (error) {
      showSnackbar(typeof error === "string" ? error : "Não foi possível excluir a nota.");
    }
  }

  function updateSelectedFromInputs() {
    const note = selectedNote();
    if (!note) return;
    note.title = elements.title.value;
    note.content = elements.content.value;
    note.updated_at = new Date().toISOString();
    updateMeta(note);
    renderList();
    scheduleSave(note.id);
  }

  function syncVisualEditor() {
    const note = selectedNote();
    if (!note) return;
    const content = visualEditorToWhatsapp(elements.preview);
    if ([...content].length > 50_000) {
      elements.preview.innerHTML = previewHtml(note.content);
      showSnackbar("A nota deve ter no máximo 50.000 caracteres.");
      return;
    }
    note.content = content;
    note.updated_at = new Date().toISOString();
    elements.content.value = content;
    updateMeta(note);
    renderList();
    scheduleSave(note.id);
  }

  function applyInlineFormat(prefix, suffix, placeholder) {
    if (state.mode !== "edit") return;
    const textarea = elements.content;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const selected = textarea.value.slice(start, end);
    const inner = selected || placeholder;
    const replacement = `${prefix}${inner}${suffix}`;
    textarea.setRangeText(replacement, start, end, "end");
    textarea.focus();
    textarea.setSelectionRange(start + prefix.length, start + prefix.length + inner.length);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function applyLineFormat(kind) {
    if (state.mode !== "edit") return;
    const textarea = elements.content;
    const value = textarea.value;
    const start = value.lastIndexOf("\n", textarea.selectionStart - 1) + 1;
    const nextBreak = value.indexOf("\n", textarea.selectionEnd);
    const end = nextBreak === -1 ? value.length : nextBreak;
    const lines = value.slice(start, end).split("\n");
    const matchers = {
      bullet: /^-\s/,
      numbered: /^\d+\.\s/,
      quote: /^>\s/,
    };
    const allFormatted = lines.filter(Boolean).every((line) => matchers[kind].test(line));
    const replacement = lines
      .map((line, index) => {
        if (!line) return line;
        if (allFormatted) return line.replace(matchers[kind], "");
        if (kind === "bullet") return `- ${line}`;
        if (kind === "numbered") return `${index + 1}. ${line}`;
        return `> ${line}`;
      })
      .join("\n");
    textarea.setRangeText(replacement, start, end, "select");
    textarea.focus();
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function applyVisualFormat(format) {
    elements.preview.focus();
    const commands = {
      bold: "bold",
      italic: "italic",
      strike: "strikeThrough",
      bullet: "insertUnorderedList",
      numbered: "insertOrderedList",
    };

    if (commands[format]) {
      document.execCommand(commands[format], false);
    } else if (format === "quote") {
      document.execCommand("formatBlock", false, "blockquote");
    } else if (format === "mono") {
      const selection = window.getSelection();
      if (!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if (!elements.preview.contains(range.commonAncestorContainer)) return;
      const code = document.createElement("code");
      if (range.collapsed) {
        code.textContent = "texto";
      } else {
        code.append(range.extractContents());
      }
      range.insertNode(code);
      selection.removeAllRanges();
      const nextRange = document.createRange();
      nextRange.selectNodeContents(code);
      selection.addRange(nextRange);
    }
    syncVisualEditor();
  }

  function applyFormat(format) {
    if (state.mode === "preview") {
      applyVisualFormat(format);
      return;
    }
    if (format === "bold") applyInlineFormat("*", "*", "texto");
    if (format === "italic") applyInlineFormat("_", "_", "texto");
    if (format === "strike") applyInlineFormat("~", "~", "texto");
    if (format === "mono") applyInlineFormat("```", "```", "texto");
    if (["bullet", "numbered", "quote"].includes(format)) applyLineFormat(format);
  }

  async function copySelected() {
    const note = selectedNote();
    if (!note) {
      showSnackbar("A nota está vazia.");
      return;
    }
    const markdown = visualEditorToWhatsapp(elements.preview);
    if (!markdown.trim()) {
      showSnackbar("A nota está vazia.");
      return;
    }
    try {
      await writeClipboard(markdown);
      showSnackbar("Texto copiado com a formatação do WhatsApp.");
    } catch (error) {
      showSnackbar(error?.message ?? "Não foi possível copiar a nota.");
    }
  }

  function handleAutoList(event) {
    if (event.inputType !== "insertText" || event.data !== " ") return;

    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE) return;

    if (node.parentElement?.closest("li")) return;

    const textBefore = node.textContent.slice(0, range.startOffset);
    const bulletMatch = /^[-*]\s$/.test(textBefore);
    const numberMatch = textBefore.match(/^(\d+)\.\s$/);
    if (!bulletMatch && !numberMatch) return;
    const startNumber = numberMatch ? parseInt(numberMatch[1], 10) : 1;

    const block = currentBlock(node);
    if (!blockStartsWithNode(block, node)) return;

    event.preventDefault?.();

    const listTag = numberMatch ? "ol" : "ul";
    const list = document.createElement(listTag);
    if (numberMatch && startNumber !== 1) {
      list.setAttribute("start", String(startNumber));
    }
    const li = document.createElement("li");

    // Descarta só o gatilho digitado ("1. " ou "- "), preservando o restante da
    // linha — inclusive trechos em outros nós, como negrito, que seriam
    // perdidos se o bloco inteiro fosse substituído.
    node.textContent = node.textContent.slice(range.startOffset);
    if (!block || block === elements.preview) {
      elements.preview.insertBefore(list, node);
      li.appendChild(node);
    } else {
      block.replaceWith(list);
      while (block.firstChild) li.appendChild(block.firstChild);
    }
    if (!li.firstChild) li.appendChild(document.createElement("br"));
    list.appendChild(li);

    const r = document.createRange();
    r.setStart(li.firstChild ?? li, 0);
    r.collapse(true);
    selection.removeAllRanges();
    selection.addRange(r);

    syncVisualEditor();
  }

  function currentBlock(node) {
    let el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    while (el && el.parentElement !== elements.preview && el !== elements.preview) {
      el = el.parentElement;
    }
    return el;
  }

  function blockStartsWithNode(block, node) {
    if (!block || block === elements.preview) {
      const probe = document.createRange();
      probe.setStart(elements.preview, 0);
      probe.setEnd(node, 0);
      const before = probe.toString();
      return before.length === 0 || before.endsWith("\n");
    }
    const probe = document.createRange();
    probe.selectNodeContents(block);
    probe.setEnd(node, 0);
    return probe.toString().length === 0;
  }

  async function load() {
    try {
      state.notes = await invoke("get_notes");
      const first = sortedNotes()[0]?.id ?? null;
      selectNote(first);
    } catch (error) {
      showSnackbar(typeof error === "string" ? error : "Não foi possível carregar as notas.");
    }
  }

  document.querySelector("#newNote").addEventListener("click", createNote);
  document.querySelector("#emptyNewNote").addEventListener("click", createNote);
  document.querySelector("#deleteNote").addEventListener("click", deleteSelected);
  document.querySelector("#copyNote").addEventListener("click", copySelected);

  elements.search.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLocaleLowerCase("pt-BR");
    renderList();
  });

  elements.list.addEventListener("click", (event) => {
    const item = event.target.closest("[data-note-id]");
    if (item) selectNote(item.dataset.noteId);
  });

  elements.title.addEventListener("input", updateSelectedFromInputs);
  elements.content.addEventListener("input", updateSelectedFromInputs);
  elements.preview.addEventListener("input", (event) => {
    handleAutoList(event);
    syncVisualEditor();
  });

  elements.pin.addEventListener("click", () => {
    const note = selectedNote();
    if (!note) return;
    note.pinned = !note.pinned;
    note.updated_at = new Date().toISOString();
    elements.pin.setAttribute("aria-pressed", String(note.pinned));
    elements.pin.setAttribute("aria-label", note.pinned ? "Desafixar nota" : "Fixar nota");
    renderList();
    scheduleSave(note.id, 0);
  });

  elements.toolbar.addEventListener("click", (event) => {
    if (event.target.closest("#formatOverflowButton")) {
      const open = elements.overflowButton.getAttribute("aria-expanded") !== "true";
      setOverflowOpen(open);
      return;
    }
    const button = event.target.closest("[data-format]");
    if (button) {
      applyFormat(button.dataset.format);
      setOverflowOpen(false);
    }
  });
  elements.toolbar.addEventListener("pointerdown", (event) => {
    if (event.target.closest("[data-format], #formatOverflowButton")) event.preventDefault();
  });

  elements.content.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "b" || key === "i") {
      event.preventDefault();
      applyFormat(key === "b" ? "bold" : "italic");
    }
  });

  elements.preview.addEventListener("keydown", (event) => {
    if (!(event.ctrlKey || event.metaKey)) return;
    const key = event.key.toLowerCase();
    if (key === "b" || key === "i") {
      event.preventDefault();
      applyVisualFormat(key === "b" ? "bold" : "italic");
    }
  });

  document.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".format-overflow")) setOverflowOpen(false);
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") setOverflowOpen(false);
  });

  new ResizeObserver(() => {
    if (getComputedStyle(elements.overflowButton.parentElement).display === "none") {
      setOverflowOpen(false);
    }
  }).observe(elements.toolbar);

  return {
    load,
    createNote,
    activate() {
      if (selectedNote()) return;
      const first = filteredNotes()[0]?.id ?? null;
      if (first) selectNote(first);
    },
  };
}
