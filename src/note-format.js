// Lógica pura de formatação de notas (markdown estilo WhatsApp <-> HTML de
// preview). Sem dependência de DOM, window ou Tauri — por isso é importável
// tanto pelo app (notes.js) quanto pelos testes headless (node --test).

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function noteExcerpt(content) {
  const plain = content
    .replaceAll("```", "")
    .replace(/[*_~`]/g, "")
    .replace(/^(?:>\s?|[-*]\s+|\d+\.\s+)/gm, "")
    .replace(/\s+/g, " ")
    .trim();
  return plain || "Nota vazia";
}

export function inlineWhatsapp(text) {
  const parts = String(text).split(/(```[\s\S]*?```|`[^`\n]+`)/g);
  return parts
    .map((part) => {
      if (part.startsWith("```") && part.endsWith("```")) {
        return `<code>${escapeHtml(part.slice(3, -3))}</code>`;
      }
      if (part.startsWith("`") && part.endsWith("`")) {
        return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
      }
      return escapeHtml(part)
        .replace(/\*([^*\n]+)\*/g, "<strong>$1</strong>")
        .replace(/_([^_\n]+)_/g, "<em>$1</em>")
        .replace(/~([^~\n]+)~/g, "<s>$1</s>");
    })
    .join("");
}

export function previewHtml(content) {
  if (!content) return "";

  const html = [];
  const codeLines = [];
  let inCodeBlock = false;
  let listType = null;
  let listItems = [];
  let listStart = 1;

  function flushList() {
    if (!listType) return;
    const open =
      listType === "ol" && listStart !== 1 ? `<ol start="${listStart}">` : `<${listType}>`;
    html.push(
      `${open}${listItems.map((item) => `<li>${inlineWhatsapp(item)}</li>`).join("")}</${listType}>`,
    );
    listType = null;
    listItems = [];
    listStart = 1;
  }

  for (const line of content.split("\n")) {
    if (inCodeBlock) {
      if (line.endsWith("```")) {
        codeLines.push(line.slice(0, -3));
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines.length = 0;
        inCodeBlock = false;
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (line.startsWith("```") && !line.slice(3).includes("```")) {
      flushList();
      codeLines.push(line.slice(3));
      inCodeBlock = true;
      continue;
    }

    const quote = line.match(/^>\s?(.*)$/);
    const bullet = line.match(/^(?:-|\*)\s+(.*)$/);
    const numbered = line.match(/^(\d+)\.\s+(.*)$/);
    if (quote) {
      flushList();
      html.push(`<blockquote>${inlineWhatsapp(quote[1]) || "<br>"}</blockquote>`);
    } else if (bullet) {
      if (listType !== "ul") flushList();
      listType = "ul";
      listItems.push(bullet[1]);
    } else if (numbered) {
      if (listType !== "ol") {
        flushList();
        // Preserva o número inicial da sequência (ex.: começar do 5).
        listStart = parseInt(numbered[1], 10);
      }
      listType = "ol";
      listItems.push(numbered[2]);
    } else {
      flushList();
      html.push(`<p>${inlineWhatsapp(line) || "<br>"}</p>`);
    }
  }

  flushList();
  if (inCodeBlock) {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }
  return html.join("");
}
