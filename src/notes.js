import {
  escapeHtml,
  htmlToWhatsapp,
  inlineWhatsapp,
  noteExcerpt,
  plainTextToWhatsapp,
  previewHtml,
  visualEditorToWhatsapp,
} from "./note-format.js";

const MAX_NOTE_CHARS = 50_000;
const LIMIT_MESSAGE = "A nota deve ter no máximo 50.000 caracteres.";
const MEDIA_MESSAGE = "As notas não suportam imagens nem arquivos.";
const MEDIA_SKIPPED_MESSAGE = "As notas não suportam imagens nem arquivos; só o texto foi colado.";

// Converter o editor inteiro em texto custa alguns ms numa nota grande: é
// feito quando o usuário para de digitar (ou antes de gravar, trocar de nota,
// buscar...), não a cada tecla.
const EDITOR_SYNC_DELAY = 300;

// O resumo da lista mostra no máximo duas linhas; não precisa da nota toda.
const EXCERPT_SOURCE_CHARS = 1200;

const timeFormatter = new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" });
const dayFormatter = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" });

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
  return (sameDay ? timeFormatter : dayFormatter).format(date);
}

function compareNotes(a, b) {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const left = b.updated_at || "";
  const right = a.updated_at || "";
  return left < right ? -1 : left > right ? 1 : 0;
}

function exceedsLimit(text) {
  // Mais barato que contar code points quando claramente cabe.
  return text.length > MAX_NOTE_CHARS && [...text].length > MAX_NOTE_CHARS;
}

function excerptFor(content) {
  if (content.length <= EXCERPT_SOURCE_CHARS) return noteExcerpt(content);
  let end = EXCERPT_SOURCE_CHARS;
  const code = content.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // não corta um emoji ao meio
  const excerpt = noteExcerpt(content.slice(0, end));
  return excerpt === "Nota vazia" ? noteExcerpt(content) : excerpt;
}

// Resumo e texto de busca por nota, recalculados só quando o conteúdo muda.
const noteCaches = new WeakMap();

function noteCache(note) {
  let cache = noteCaches.get(note);
  if (!cache) {
    cache = {};
    noteCaches.set(note, cache);
  }
  return cache;
}

function cachedExcerpt(note) {
  const cache = noteCache(note);
  if (cache.excerptOf !== note.content) {
    cache.excerptOf = note.content;
    cache.excerpt = excerptFor(note.content);
  }
  return cache.excerpt;
}

function searchText(note) {
  const cache = noteCache(note);
  if (cache.searchTitle !== note.title || cache.searchContent !== note.content) {
    cache.searchTitle = note.title;
    cache.searchContent = note.content;
    cache.search = `${note.title}\n${note.content}`
      .toLocaleLowerCase("pt-BR")
      .replaceAll("\u200b", "");
  }
  return cache.search;
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

function transferHasFiles(data) {
  if (!data) return false;
  if ((data.files?.length ?? 0) > 0) return true;
  return Array.from(data.items ?? []).some((item) => item.kind === "file");
}

// Conteúdo de um paste/drop já no formato da nota.
function transferToText(data, { plainOnly = false } = {}) {
  const media = transferHasFiles(data);
  const plain = data.getData("text/plain");
  if (plainOnly) return { text: plainTextToWhatsapp(plain), media };
  const html = data.getData("text/html");
  let htmlMedia = false;
  if (html) {
    // DOMParser cria um documento inerte: nada de script, imagem ou iframe
    // é carregado/executado.
    const doc = new DOMParser().parseFromString(html, "text/html");
    const converted = htmlToWhatsapp(doc.body);
    htmlMedia = converted.media > 0;
    if (converted.text.trim() || !plain) {
      return { text: converted.text, media: media || htmlMedia };
    }
  }
  return { text: plainTextToWhatsapp(plain), media: media || htmlMedia };
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
    // Falhas seguidas de gravação por nota, para o backoff das novas tentativas.
    saveFailures: new Map(),
    // Botões da lista por id da nota, para atualizar só o item editado.
    listItems: new Map(),
  };

  // Nota cujo conteúdo está no editor visual e se o DOM do editor tem
  // alterações ainda não convertidas para note.content.
  const editor = { noteId: null, dirty: false, timer: null };
  let dragFromEditor = false;

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

  function noteById(id) {
    return state.notes.find((note) => note.id === id) ?? null;
  }

  function selectedNote() {
    return noteById(state.selectedId);
  }

  function sortedNotes() {
    return [...state.notes].sort(compareNotes);
  }

  function matchesQuery(note) {
    return !state.query || searchText(note).includes(state.query);
  }

  function filteredNotes() {
    syncEditorNow();
    const notes = sortedNotes();
    return state.query ? notes.filter(matchesQuery) : notes;
  }

  function listItemHtml(note) {
    return `
          <button class="note-list-item${note.id === state.selectedId ? " active" : ""}" type="button" data-note-id="${escapeHtml(note.id)}">
            <span class="note-list-title-row">
              <span class="note-list-title">${escapeHtml(noteLabel(note))}</span>
              ${
                note.pinned
                  ? '<svg class="note-list-pin" viewBox="0 0 24 24" aria-label="Fixada"><path d="m14 4 6 6-3 1-4 4-1 5-3-3-4 4-1-1 4-4-3-3 5-1 4-4Z"/></svg>'
                  : ""
              }
            </span>
            <span class="note-list-preview">${escapeHtml(cachedExcerpt(note))}</span>
            <span class="note-list-date">${escapeHtml(noteTime(note.updated_at))}</span>
          </button>`;
  }

  function renderList() {
    const notes = filteredNotes();
    elements.count.textContent = state.notes.length;
    elements.listEmpty.hidden = notes.length > 0;
    elements.list.innerHTML = notes.map(listItemHtml).join("");
    state.listItems.clear();
    for (const item of elements.list.children ?? []) {
      state.listItems.set(item.dataset.noteId, item);
    }
  }

  function setText(element, text) {
    if (element && element.textContent !== text) element.textContent = text;
  }

  // Atualiza só o botão da nota na lista (título, resumo, data). Se a nota
  // mudou de posição ou deixou de casar com a busca, refaz a lista.
  function refreshListItem(note) {
    const item = state.listItems.get(note.id);
    if (!item || !elements.list.contains?.(item) || !matchesQuery(note)) {
      renderList();
      return;
    }
    const previous = noteById(item.previousElementSibling?.dataset.noteId);
    const next = noteById(item.nextElementSibling?.dataset.noteId);
    if ((previous && compareNotes(previous, note) > 0) || (next && compareNotes(note, next) > 0)) {
      renderList();
      return;
    }
    setText(item.querySelector(".note-list-title"), noteLabel(note));
    setText(item.querySelector(".note-list-preview"), cachedExcerpt(note));
    setText(item.querySelector(".note-list-date"), noteTime(note.updated_at));
  }

  function updateMeta(note) {
    const count = [...note.content].length;
    setText(elements.meta, `${count.toLocaleString("pt-BR")} caractere${count === 1 ? "" : "s"}`);
  }

  // O histórico de desfazer do navegador é do documento, não do elemento: sem
  // isto, Ctrl+Z/Ctrl+Y numa nota refaz passos (Enter, colar, lista) da nota
  // aberta antes, dentro da nota atual. Um elemento novo por nota deixa os
  // passos antigos apontando para o elemento descartado. Os eventos do editor
  // são escutados no contêiner (#noteEditor), então nada precisa ser religado.
  function replacePreviewElement() {
    const old = elements.preview;
    if (typeof old.cloneNode !== "function" || typeof old.replaceWith !== "function") return;
    const fresh = old.cloneNode(false);
    old.replaceWith(fresh);
    elements.preview = fresh;
  }

  function setMode() {
    setOverflowOpen(false);
    state.mode = "preview";
    elements.content.hidden = true;
    replacePreviewElement();
    elements.preview.hidden = false;
    elements.preview.innerHTML = previewHtml(selectedNote()?.content ?? "");
    window.setTimeout(() => elements.preview.focus(), 0);
  }

  function setOverflowOpen(open) {
    elements.overflowMenu.hidden = !open;
    elements.overflowButton.setAttribute("aria-expanded", String(open));
  }

  function renderEditor({ focusTitle = false } = {}) {
    syncEditorNow();
    const note = selectedNote();
    editor.noteId = note?.id ?? null;
    editor.dirty = false;
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
    syncEditorNow();
    state.selectedId = state.notes.some((note) => note.id === id) ? id : null;
    renderList();
    renderEditor(options);
  }

  function setSaveStatus(id, text) {
    if (state.selectedId === id) setText(elements.status, text);
  }

  // O editor mudou (tecla, colar, formatação): só marca e agenda. A conversão
  // DOM -> texto acontece em syncEditorNow.
  function markEditorChanged() {
    const id = editor.noteId;
    if (!id) return;
    editor.dirty = true;
    if (editor.timer) window.clearTimeout(editor.timer);
    editor.timer = window.setTimeout(syncEditorNow, EDITOR_SYNC_DELAY);
    scheduleSave(id);
  }

  // Passa o que está no editor para note.content. Chamada antes de qualquer
  // leitura do conteúdo (gravar, trocar de nota, buscar, flush).
  function syncEditorNow() {
    if (editor.timer) {
      window.clearTimeout(editor.timer);
      editor.timer = null;
    }
    if (!editor.dirty) return;
    editor.dirty = false;
    const note = noteById(editor.noteId);
    if (!note) return;
    const content = visualEditorToWhatsapp(elements.preview);
    if (content === note.content) return;
    if (exceedsLimit(content)) {
      elements.preview.innerHTML = previewHtml(note.content);
      showSnackbar(LIMIT_MESSAGE);
      return;
    }
    note.content = content;
    note.updated_at = new Date().toISOString();
    updateMeta(note);
    refreshListItem(note);
  }

  async function saveById(id) {
    if (id === editor.noteId) syncEditorNow();
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
          refreshListItem(current);
        }
        state.saveFailures.delete(id);
        setSaveStatus(id, state.dirtyIds.has(id) ? "Alterações pendentes" : "Salvo");
        return saved;
      })
      .catch((error) => {
        saveFailed = true;
        state.dirtyIds.add(id);
        const failures = (state.saveFailures.get(id) ?? 0) + 1;
        state.saveFailures.set(id, failures);
        setSaveStatus(id, "Não foi possível salvar. Tentando novamente...");
        // Só avisa na primeira falha; as novas tentativas seguem em silêncio
        // (o status do editor continua mostrando o erro).
        if (failures === 1) {
          showSnackbar(typeof error === "string" ? error : "Não foi possível salvar a nota.");
        }
        return null;
      })
      .finally(() => {
        state.saving.delete(id);
        if (!state.dirtyIds.has(id) || !state.notes.some((item) => item.id === id)) return;
        if (!saveFailed) {
          scheduleSave(id, 800);
        } else if (!state.saveTimers.has(id)) {
          // Nova tentativa com backoff (2s, 4s, 8s... até 60s). Se o usuário
          // digitar antes disso, o autosave normal já tenta de novo.
          const failures = state.saveFailures.get(id) ?? 1;
          const delay = Math.min(2000 * 2 ** (failures - 1), 60_000);
          state.saveTimers.set(id, window.setTimeout(() => saveById(id), delay));
        }
      });

    state.saving.set(id, saving);
    return saving;
  }

  // Grava já tudo o que está pendente (app ocultado, janela perdeu o foco,
  // página sendo descarregada, app saindo) em vez de esperar o timer do
  // autosave. Espera também as gravações que já estavam em andamento e tenta
  // de novo, uma vez, as que falharem — quem chama (ex.: app-quitting) só
  // segue depois que tudo terminou.
  async function flushPendingSaves() {
    syncEditorNow();
    const pending = new Set([...state.dirtyIds, ...state.saving.keys()]);
    if (!pending.size) return;
    await Promise.all([...pending].map((id) => saveById(id)));
    const failed = [...state.dirtyIds].filter(
      (id) => pending.has(id) && state.notes.some((note) => note.id === id),
    );
    await Promise.all(failed.map((id) => saveById(id)));
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
      const retryTimer = state.saveTimers.get(note.id);
      if (retryTimer) window.clearTimeout(retryTimer);
      state.saveTimers.delete(note.id);
      state.saveFailures.delete(note.id);
      state.dirtyIds.delete(note.id);
      state.notes = state.notes.filter((item) => item.id !== note.id);
      selectNote(filteredNotes()[0]?.id ?? null);
      showSnackbar("Nota local descartada.");
      return;
    }

    try {
      await invoke("delete_note", { id: note.id });
      const retryTimer = state.saveTimers.get(note.id);
      if (retryTimer) window.clearTimeout(retryTimer);
      state.saveTimers.delete(note.id);
      state.saveFailures.delete(note.id);
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

  // Só o título muda. O conteúdo NÃO é relido do <textarea>: ele normaliza
  // \r\n e \r em \n, o que alteraria a nota sem o usuário mexer nela.
  function updateTitleFromInput() {
    const note = selectedNote();
    if (!note) return;
    note.title = elements.title.value;
    note.updated_at = new Date().toISOString();
    refreshListItem(note);
    scheduleSave(note.id);
  }

  // Modo texto (textarea), hoje sem uso na interface.
  function updateContentFromTextarea() {
    const note = selectedNote();
    if (!note) return;
    note.content = elements.content.value;
    note.updated_at = new Date().toISOString();
    updateMeta(note);
    refreshListItem(note);
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
    markEditorChanged();
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

  // Fim da linha que começa em `node`: o primeiro <br>/"\n"/bloco depois dele,
  // ou o fim do bloco (ou do editor, para texto solto na raiz).
  function lineEndRange(node, offset, block) {
    const container = block && block !== elements.preview ? block : elements.preview;
    const end = document.createRange();
    end.selectNodeContents(container);
    end.collapse(false);
    const newline = node.nodeValue.indexOf("\n", offset);
    if (newline !== -1) {
      end.setStart(node, newline);
      return end;
    }
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_ALL);
    walker.currentNode = node;
    for (let current = walker.nextNode(); current; current = walker.nextNode()) {
      const isBreak =
        current.nodeType === Node.ELEMENT_NODE &&
        (current.tagName === "BR" || /^(P|DIV|UL|OL|LI|BLOCKQUOTE|PRE|H[1-6])$/.test(current.tagName));
      if (isBreak) {
        end.setStartBefore(current);
        return end;
      }
      if (current.nodeType === Node.TEXT_NODE && current.nodeValue.includes("\n")) {
        end.setStart(current, current.nodeValue.indexOf("\n"));
        return end;
      }
    }
    return end;
  }

  // "- ", "* " ou "1. " no início de uma linha vira lista, levando a linha
  // inteira (inclusive negrito etc.) para o item. Um único insertHTML (e não
  // mexer no DOM direto) entra no histórico de desfazer como um passo só:
  // Ctrl+Z volta exatamente ao "- texto" digitado.
  function handleAutoList(event) {
    if (event.inputType !== "insertText" || event.data !== " ") return;

    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed) return;
    const range = selection.getRangeAt(0);
    const node = range.startContainer;
    if (node.nodeType !== Node.TEXT_NODE || !elements.preview.contains(node)) return;

    if (node.parentElement?.closest("li, pre, code, blockquote")) return;

    const textBefore = node.textContent.slice(0, range.startOffset);
    const bulletMatch = /^[-*]\s$/.test(textBefore);
    const numberMatch = textBefore.match(/^(\d+)\.\s$/);
    if (!bulletMatch && !numberMatch) return;
    const startNumber = numberMatch ? parseInt(numberMatch[1], 10) : 1;

    const block = currentBlock(node);
    if (!blockStartsWithNode(block, node)) return;

    const end = lineEndRange(node, range.startOffset, block);
    const rest = document.createRange();
    rest.setStart(node, range.startOffset);
    rest.setEnd(end.startContainer, end.startOffset);
    const holder = document.createElement("div");
    holder.append(rest.cloneContents());
    const restHtml = holder.innerHTML || "<br>";

    const listTag = numberMatch ? "ol" : "ul";
    const listAttr = numberMatch && startNumber !== 1 ? ` start="${startNumber}"` : "";
    // Mantém o marcador digitado: "* " continua "* " no texto salvo.
    const itemAttr = bulletMatch && textBefore.startsWith("*") ? ' data-prefix="* "' : "";

    const line = document.createRange();
    line.setStart(node, 0);
    line.setEnd(end.startContainer, end.startOffset);
    selection.removeAllRanges();
    selection.addRange(line);
    document.execCommand(
      "insertHTML",
      false,
      `<${listTag}${listAttr}><li${itemAttr}>${restHtml}</li></${listTag}>`,
    );

    // O cursor volta para onde estava: logo depois do marcador digitado.
    const li = closestInEditor(window.getSelection()?.anchorNode, "li");
    if (!li) return;
    const caret = document.createRange();
    const first = li.firstChild;
    if (first?.nodeType === Node.TEXT_NODE) caret.setStart(first, 0);
    else caret.setStart(li, 0);
    caret.collapse(true);
    const current = window.getSelection();
    current.removeAllRanges();
    current.addRange(caret);
  }

  function closestInEditor(node, selector) {
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement;
    const found = element?.closest(selector);
    return found && elements.preview.contains(found) ? found : null;
  }

  // Enter num item de lista numerada: o navegador clona o <li> com os
  // atributos (value/data-prefix de uma numeração fora de sequência), o que
  // repetiria o número. O item novo perde os atributos e segue a sequência.
  function fixClonedListItem(event) {
    if (event.inputType !== "insertParagraph") return;
    const selection = window.getSelection();
    if (!selection?.rangeCount) return;
    const start = selection.getRangeAt(0).startContainer;
    const element = start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
    const li = element?.closest("li");
    if (!li || !elements.preview.contains(li) || li.parentElement?.tagName !== "OL") return;
    const previous = li.previousElementSibling;
    if (previous?.tagName !== "LI") return;
    const sameAttrs = ["value", "data-prefix"].every(
      (name) => previous.getAttribute(name) === li.getAttribute(name),
    );
    if (!sameAttrs || !(li.hasAttribute("value") || li.hasAttribute("data-prefix"))) return;
    // Enter no início do item deixa o clone vazio antes do cursor.
    const clone = previous.textContent === "" ? previous : li;
    clone.removeAttribute("value");
    clone.removeAttribute("data-prefix");
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

  // --- Colar / soltar --------------------------------------------------------

  const LINE_BLOCKS = "p, div, li, blockquote, pre, h1, h2, h3, h4, h5, h6";

  function lineContainer(node) {
    const found = closestInEditor(node, LINE_BLOCKS);
    return found ?? elements.preview;
  }

  // O cursor está no começo (ou fim) da linha? Texto antes/depois dele no
  // mesmo bloco, até uma quebra de linha.
  function caretAtLineEdge(range, edge) {
    const container = lineContainer(range.startContainer);
    const probe = document.createRange();
    probe.selectNodeContents(container);
    if (edge === "start") probe.setEnd(range.startContainer, range.startOffset);
    else probe.setStart(range.endContainer, range.endOffset);
    const text = probe.toString();
    if (edge === "start") return text === "" || text.endsWith("\n");
    return text === "" || text.startsWith("\n");
  }

  // Insere texto no formato da nota onde está o cursor, como HTML do próprio
  // editor (previewHtml): o que aparece é o que será gravado. execCommand
  // mantém o Ctrl+Z funcionando.
  function insertNoteText(text) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !text) return false;
    const range = selection.getRangeAt(0);
    if (!elements.preview.contains(range.commonAncestorContainer)) return false;

    // Dentro de código tudo é literal: cola o texto puro.
    if (closestInEditor(range.startContainer, "pre, code")) {
      document.execCommand("insertText", false, text);
      return true;
    }

    let source = text;
    let html = previewHtml(source);
    if (!source.includes("\n") && html.startsWith("<p>")) {
      document.execCommand("insertHTML", false, inlineWhatsapp(source));
      return true;
    }
    // Parágrafos colados se juntam à linha do cursor (como em qualquer
    // editor); listas e citações ficam em linhas próprias. Já o bloco de
    // código teria a primeira/última linha puxada para o parágrafo vizinho
    // (com estilo inline que não é gravado) — a menos que ela seja vazia,
    // como no formato "```\n...\n```". Se não for, abre uma linha antes/depois.
    const unsafeStart = /^<pre[^>]*><code>(?!<br>)/.test(html);
    const unsafeEnd = html.endsWith("</pre>") && !html.endsWith("<br><br></code></pre>");
    if (unsafeStart && !caretAtLineEdge(range, "start")) source = `\n${source}`;
    if (unsafeEnd && !caretAtLineEdge(range, "end")) source = `${source}\n`;
    if (source !== text) html = previewHtml(source);
    document.execCommand("insertHTML", false, html);
    return true;
  }

  function pasteTransfer(data, { plainOnly = false } = {}) {
    const { text, media } = transferToText(data, { plainOnly });
    if (!text) {
      if (media) showSnackbar(MEDIA_MESSAGE);
      return;
    }
    const note = noteById(editor.noteId);
    if (!note) return;
    syncEditorNow();
    const selected = [...(window.getSelection()?.toString() ?? "")].length;
    if ([...note.content].length - selected + [...text].length > MAX_NOTE_CHARS) {
      showSnackbar(LIMIT_MESSAGE);
      return;
    }
    if (insertNoteText(text)) {
      markEditorChanged();
      syncEditorNow();
    }
    if (media) showSnackbar(MEDIA_SKIPPED_MESSAGE);
  }

  function handlePaste(event) {
    const data = event.clipboardData;
    if (!data) return;
    event.preventDefault();
    const range = window.getSelection()?.rangeCount ? window.getSelection().getRangeAt(0) : null;
    const inCode = range && closestInEditor(range.startContainer, "pre, code");
    pasteTransfer(data, { plainOnly: Boolean(inCode) });
  }

  function handleDrop(event) {
    const data = event.dataTransfer;
    if (!data) return;
    if (transferHasFiles(data)) {
      event.preventDefault();
      showSnackbar(MEDIA_MESSAGE);
      return;
    }
    // Arrastar um trecho dentro da própria nota: o navegador move o
    // conteúdo (já no formato do editor).
    const internal = dragFromEditor;
    dragFromEditor = false;
    if (internal) return;
    event.preventDefault();
    const target = document.caretRangeFromPoint?.(event.clientX, event.clientY);
    elements.preview.focus();
    if (target && elements.preview.contains(target.startContainer)) {
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(target);
    }
    const inCode = target && closestInEditor(target.startContainer, "pre, code");
    pasteTransfer(data, { plainOnly: Boolean(inCode) });
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

  elements.title.addEventListener("input", updateTitleFromInput);
  elements.content.addEventListener("input", updateContentFromTextarea);
  // Eventos do editor visual, escutados no contêiner (o elemento do editor é
  // trocado a cada nota aberta; ver replacePreviewElement).
  const onPreview = (type, handler) => {
    elements.editor.addEventListener(type, (event) => {
      if (event.target === elements.preview || elements.preview.contains?.(event.target)) {
        handler(event);
      }
    });
  };
  onPreview("input", (event) => {
    handleAutoList(event);
    fixClonedListItem(event);
    // Trecho arrastado dentro da nota: o navegador pode copiar estilos
    // computados (cor da citação, fonte do código...) para style="", que não
    // são gravados. O HTML do editor nunca tem style, então sai tudo.
    if (event.inputType === "insertFromDrop") {
      for (const styled of elements.preview.querySelectorAll("[style]")) styled.removeAttribute("style");
    }
    markEditorChanged();
  });
  onPreview("paste", handlePaste);
  onPreview("drop", handleDrop);
  onPreview("dragstart", () => {
    dragFromEditor = true;
  });
  // No documento: o trecho arrastado pode já ter saído do editor.
  document.addEventListener("dragend", () => {
    dragFromEditor = false;
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) flushPendingSaves();
  });
  window.addEventListener("blur", flushPendingSaves);
  window.addEventListener("pagehide", flushPendingSaves);
  window.addEventListener("beforeunload", flushPendingSaves);

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

  onPreview("keydown", (event) => {
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
    flush: flushPendingSaves,
    activate() {
      if (selectedNote()) return;
      const first = filteredNotes()[0]?.id ?? null;
      if (first) selectNote(first);
    },
  };
}
