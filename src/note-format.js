// Lógica pura de formatação de notas (markdown estilo WhatsApp <-> HTML de
// preview). Sem dependência de window ou Tauri — por isso é importável tanto
// pelo app (notes.js) quanto pelos testes headless (node --test). O caminho
// DOM -> texto (visualEditorToWhatsapp) recebe o nó raiz e só usa a API
// básica de nós (nodeType, tagName, childNodes, getAttribute), então também
// roda com um DOM mínimo nos testes.
//
// Invariante: para qualquer texto t, visualEditorToWhatsapp(DOM de
// previewHtml(t)) === t. Abrir uma nota e não mexer (ou mexer em outro
// trecho) nunca pode alterar o resto do texto. Por isso tudo o que não é
// "padrão" (marcador "* ", numeração fora de sequência, mono de uma crase,
// bloco de código sem fechamento...) fica anotado em atributos data-* e volta
// exatamente como estava.

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    // O parser de HTML troca \r por \n; a referência numérica preserva o \r.
    .replaceAll("\r", "&#13;");
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

// ---------------------------------------------------------------------------
// Texto -> HTML
// ---------------------------------------------------------------------------

const EMPHASIS_TAGS = { "*": "strong", _: "em", "~": "s" };

function isSpace(ch) {
  return ch !== undefined && /\s/.test(ch);
}

function isWordChar(ch) {
  return ch !== undefined && /[\p{L}\p{N}]/u.test(ch);
}

// Texto do usuário vira HTML escapado. Espaços não separáveis (U+00A0) ficam
// num <span data-nbsp>: o editor converte os &nbsp; que o próprio navegador
// insere em espaço comum, e o span diz "este aqui era do texto original".
function textHtml(text) {
  return escapeHtml(text).replace(/\u00a0+/g, (run) => `<span data-nbsp="">${run}</span>`);
}

// Mono: ```x``` (conteúdo não vazio) ou `x`. Não há regra de limite de
// palavra para código; o conteúdo é literal (sem negrito/itálico dentro).
function matchCode(text, index, end) {
  if (text.startsWith("```", index)) {
    const close = text.indexOf("```", index + 4);
    if (close !== -1 && close + 3 <= end) {
      return { fence: "```", body: text.slice(index + 3, close), end: close + 3 };
    }
  }
  if (text[index] === "`") {
    const close = text.indexOf("`", index + 1);
    if (close > index + 1 && close < end) {
      return { fence: "`", body: text.slice(index + 1, close), end: close + 1 };
    }
  }
  return null;
}

// Regra do WhatsApp: o marcador de abertura não pode vir colado depois de
// letra/número (joao_silva não abre itálico) e precisa ter algo que não seja
// espaço logo em seguida; o de fechamento precisa vir colado no conteúdo e
// não pode ter letra/número logo depois.
function canOpen(text, index, end, marker) {
  const next = text[index + 1];
  return index + 1 < end && !isSpace(next) && next !== marker && !isWordChar(text[index - 1]);
}

function canClose(text, index, openIndex) {
  return index > openIndex + 1 && !isSpace(text[index - 1]) && !isWordChar(text[index + 1]);
}

function findClose(text, openIndex, end, marker) {
  let index = openIndex + 1;
  while (index < end) {
    const code = matchCode(text, index, end);
    if (code) {
      index = code.end;
      continue;
    }
    if (text[index] === marker && canClose(text, index, openIndex)) return index;
    index += 1;
  }
  return -1;
}

// Tokenizador recursivo: cada trecho formatado vira um nó com filhos
// analisados dentro dos seus próprios limites, então o HTML gerado é sempre
// bem aninhado (o navegador não precisa "consertar" nada).
function parseInline(text, start, end) {
  const nodes = [];
  let buffer = "";
  let index = start;

  function flush() {
    if (buffer) nodes.push({ type: "text", text: buffer });
    buffer = "";
  }

  while (index < end) {
    const ch = text[index];
    if (ch === "`") {
      const code = matchCode(text, index, end);
      if (code) {
        flush();
        nodes.push({ type: "code", fence: code.fence, text: code.body });
        index = code.end;
        continue;
      }
    } else if (EMPHASIS_TAGS[ch] && canOpen(text, index, end, ch)) {
      const close = findClose(text, index, end, ch);
      if (close !== -1) {
        flush();
        nodes.push({ type: EMPHASIS_TAGS[ch], children: parseInline(text, index + 1, close) });
        index = close + 1;
        continue;
      }
    }
    buffer += ch;
    index += 1;
  }
  flush();
  return nodes;
}

function inlineNodesHtml(nodes) {
  return nodes
    .map((node) => {
      if (node.type === "text") return textHtml(node.text);
      if (node.type === "code") {
        const tick = node.fence === "`" ? ' data-tick=""' : "";
        return `<code${tick}>${textHtml(node.text)}</code>`;
      }
      return `<${node.type}>${inlineNodesHtml(node.children)}</${node.type}>`;
    })
    .join("");
}

// Converte uma linha (sem \n) de markdown estilo WhatsApp em HTML inline.
export function inlineWhatsapp(text) {
  const line = String(text);
  return inlineNodesHtml(parseInline(line, 0, line.length));
}

// Várias linhas dentro de um mesmo bloco (item de lista, código) viram <br>.
// Se a última linha é vazia, ela precisa de um <br> extra: o navegador trata
// o último <br> de um bloco como "segurador de linha" e não o exibe.
function linesHtml(lines, renderLine) {
  const html = lines.map(renderLine).join("<br>");
  return lines[lines.length - 1] === "" ? `${html}<br>` : html;
}

function dataAttr(name, value) {
  return ` ${name}="${escapeHtml(value)}"`;
}

// Continuação de item de lista (Shift+Enter): linha começando com dois
// espaços logo depois de um item.
const LIST_CONTINUATION = "  ";

export function previewHtml(content) {
  if (!content) return "";

  const html = [];
  const codeLines = [];
  let inCodeBlock = false;
  let listType = null;
  let listItems = [];

  function flushList() {
    if (!listType) return;
    const start = listItems[0].number;
    const open =
      listType === "ol" && start !== 1 ? `<ol start="${start}">` : `<${listType}>`;
    let expected = start;
    const items = listItems.map((item) => {
      let attrs = "";
      if (listType === "ol") {
        if (item.number !== expected) attrs += dataAttr("value", String(item.number));
        if (item.prefix !== `${item.number}. `) attrs += dataAttr("data-prefix", item.prefix);
        expected = item.number + 1;
      } else if (item.prefix !== "- ") {
        attrs += dataAttr("data-prefix", item.prefix);
      }
      return `<li${attrs}>${linesHtml(item.lines, inlineWhatsapp)}</li>`;
    });
    html.push(`${open}${items.join("")}</${listType}>`);
    listType = null;
    listItems = [];
  }

  function flushCode(closed) {
    const attr = closed ? "" : ' data-unclosed=""';
    html.push(`<pre${attr}><code>${linesHtml(codeLines, textHtml)}</code></pre>`);
    codeLines.length = 0;
  }

  for (const line of content.split("\n")) {
    if (inCodeBlock) {
      if (line.endsWith("```")) {
        codeLines.push(line.slice(0, -3));
        flushCode(true);
        inCodeBlock = false;
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (listType && line.startsWith(LIST_CONTINUATION)) {
      listItems[listItems.length - 1].lines.push(line.slice(LIST_CONTINUATION.length));
      continue;
    }

    if (line.startsWith("```") && !line.slice(3).includes("```")) {
      flushList();
      codeLines.push(line.slice(3));
      inCodeBlock = true;
      continue;
    }

    const quote = line.match(/^(>\s?)(.*)$/);
    const bullet = line.match(/^([-*]\s+)(.*)$/);
    const numbered = line.match(/^((\d+)\.\s+)(.*)$/);
    if (quote) {
      flushList();
      const attr = quote[1] === "> " ? "" : dataAttr("data-prefix", quote[1]);
      html.push(`<blockquote${attr}>${inlineWhatsapp(quote[2]) || "<br>"}</blockquote>`);
    } else if (bullet) {
      if (listType !== "ul") flushList();
      listType = "ul";
      listItems.push({ prefix: bullet[1], lines: [bullet[2]] });
    } else if (numbered) {
      if (listType !== "ol") flushList();
      listType = "ol";
      listItems.push({
        prefix: numbered[1],
        number: parseInt(numbered[2], 10),
        lines: [numbered[3]],
      });
    } else {
      flushList();
      html.push(`<p>${inlineWhatsapp(line) || "<br>"}</p>`);
    }
  }

  flushList();
  if (inCodeBlock) flushCode(false);
  return html.join("");
}

// ---------------------------------------------------------------------------
// DOM do editor -> texto
// ---------------------------------------------------------------------------

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

const BLOCK_TAGS = new Set([
  "P", "DIV", "UL", "OL", "LI", "BLOCKQUOTE", "PRE",
  "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "HEADER", "FOOTER",
]);

const MARKER_BY_TAG = {
  STRONG: "*", B: "*",
  EM: "_", I: "_",
  S: "~", STRIKE: "~", DEL: "~",
};

function attr(node, name) {
  return node.getAttribute?.(name) ?? null;
}

// Aplica o marcador linha a linha (um trecho formatado que atravessa um <br>
// vira "*a*\n*b*") e deixa espaços das pontas fora do marcador — "*a *" não
// seria reconhecido como negrito ao reabrir.
//
// Devolve também se o marcador abre logo no início (sem espaço antes) e fecha
// bem no fim (sem espaço depois), para o chamador checar as letras vizinhas.
function wrapLines(content, marker, literal) {
  const lines = content.split("\n");
  let opensAtStart = false;
  let closesAtEnd = false;
  const text = lines
    .map((line, index) => {
      if (literal) return line ? `${marker}${line}${marker}` : line;
      const [, lead, body, trail] = line.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!body) return line;
      if (index === 0) opensAtStart = !lead;
      if (index === lines.length - 1) closesAtEnd = !trail;
      return `${lead}${marker}${body}${marker}${trail}`;
    })
    .join("\n");
  return { text, opensAtStart, closesAtEnd };
}

// Separador invisível entre um marcador e uma letra colada nele.
const WORD_SEPARATOR = "\u200b";

function codeFence(node, content) {
  const single = attr(node, "data-tick") !== null && !content.includes("`");
  return single ? "`" : "```";
}

// Serializa o conteúdo de um bloco (parágrafo, item, citação, código),
// tratando o que o contenteditable cria: <br>, <div>/<p> aninhados e o <br>
// final que só segura a linha vazia.
function flowText(nodes, { pre = false } = {}) {
  const st = {
    out: "",
    started: false, // já saiu alguma linha neste bloco
    pendingBreak: false, // um bloco filho terminou; próximo conteúdo vai para a linha de baixo
    trailingBr: false, // a última coisa foi um <br>
    pre, // dentro de <pre>: \n do texto conta, sem marcadores
    literal: pre, // dentro de código: sem marcadores
    nbsp: 0, // dentro de <span data-nbsp>
    active: new Set(), // marcadores já abertos (evita "**a**" com <b><b>)
    needSep: false, // acabou de fechar um marcador sem espaço depois
    afterList: false, // o último bloco filho foi uma lista
  };
  for (const node of nodes) walk(node, st);
  // O último <br> de um bloco é só o "segurador" da linha: não vira \n.
  if (st.trailingBr) st.out = st.out.slice(0, -1);
  return st.out;
}

function breakIfPending(st) {
  if (st.pendingBreak) {
    st.out += "\n";
    st.pendingBreak = false;
    st.needSep = false;
  }
}

function lineBreak(st) {
  breakIfPending(st);
  st.out += "\n";
  st.started = true;
  st.trailingBr = true;
  st.needSep = false;
  st.afterList = false;
}

// Um par\ágrafo logo depois de uma lista que come\ça com dois espa\ços seria lido
// como continua\ç\ão do \último item ao reabrir. O primeiro espa\ço vira espa\ço
// n\ão separ\ável (visualmente igual), que n\ão \é continua\ç\ão.
function escapeListContinuation(text) {
  return text.startsWith(LIST_CONTINUATION) ? `\u00a0${text.slice(1)}` : text;
}

function appendText(st, text) {
  breakIfPending(st);
  // Negrito/it\álico/tachado fechado colado numa letra ("abc*def*ghi") n\ão seria
  // reconhecido ao reabrir; o espa\ço de largura zero separa sem aparecer.
  if (st.needSep && isWordChar(text[0])) st.out += WORD_SEPARATOR;
  st.needSep = false;
  st.afterList = false;
  st.out += text;
  st.started = true;
  st.trailingBr = false;
}

function walk(node, st) {
  if (node.nodeType === TEXT_NODE) {
    let text = node.nodeValue ?? node.textContent ?? "";
    if (!st.nbsp) text = text.replaceAll("\u00a0", " ");
    if (!text) return;
    if (st.pre || (!text.includes("\n") && !st.afterList)) {
      appendText(st, text);
      return;
    }
    // Com white-space: pre-wrap o Shift+Enter do navegador insere "\n" no
    // texto (em vez de <br>): conta como quebra de linha, igual ao <br>.
    text.split("\n").forEach((part, index) => {
      if (index > 0) lineBreak(st);
      if (!part) return;
      if (st.afterList && st.pendingBreak) part = escapeListContinuation(part);
      appendText(st, part);
    });
    return;
  }
  if (node.nodeType !== ELEMENT_NODE) return;

  const tag = node.tagName;
  if (tag === "BR") {
    lineBreak(st);
    return;
  }

  if (BLOCK_TAGS.has(tag)) {
    if (st.started && !st.trailingBr) st.out += "\n";
    st.pendingBreak = false;
    let text = st.pre ? flowText(node.childNodes, { pre: true }) : blockText(node, false);
    if (st.afterList && !st.pre) text = escapeListContinuation(text);
    st.out += text;
    st.afterList = !st.pre && (tag === "UL" || tag === "OL");
    st.started = true;
    st.pendingBreak = true;
    st.trailingBr = false;
    st.needSep = false;
    return;
  }

  if (tag === "SPAN" && attr(node, "data-nbsp") !== null) {
    st.nbsp += 1;
    for (const child of node.childNodes) walk(child, st);
    st.nbsp -= 1;
    return;
  }

  const isCode = tag === "CODE";
  const marker = st.literal ? null : isCode ? "code" : MARKER_BY_TAG[tag];
  if (!marker || st.active.has(marker)) {
    for (const child of node.childNodes) walk(child, st);
    return;
  }

  const outer = st.out;
  const sepBefore = st.needSep;
  st.out = "";
  st.needSep = false;
  st.active.add(marker);
  if (isCode) st.literal = true;
  for (const child of node.childNodes) walk(child, st);
  if (isCode) st.literal = false;
  st.active.delete(marker);
  const content = st.out;
  const fence = isCode ? codeFence(node, content) : marker;
  const wrapped = wrapLines(content, fence, isCode);
  // Mesma regra do parser (canOpen/canClose), que olha a unidade UTF-16
  // vizinha ao marcador: letra/número colado impede o reconhecimento.
  const sep = !isCode && wrapped.opensAtStart && isWordChar(outer[outer.length - 1]);
  st.out = outer + (sep ? WORD_SEPARATOR : "") + wrapped.text;
  st.needSep = wrapped.text ? !isCode && wrapped.closesAtEnd : sepBefore;
}

function listText(node) {
  const ordered = node.tagName === "OL";
  const startAttr = parseInt(attr(node, "start") ?? "", 10);
  let number = Number.isNaN(startAttr) ? 1 : startAttr;
  let first = true;
  const lines = [];

  for (const child of node.childNodes) {
    if (child.nodeType !== ELEMENT_NODE) continue;
    if (child.tagName !== "LI") {
      lines.push(blockText(child, false));
      continue;
    }
    const prefixAttr = attr(child, "data-prefix");
    let prefix;
    if (ordered) {
      const value = parseInt(attr(child, "value") ?? "", 10);
      if (!Number.isNaN(value)) number = value;
      else if (!first) number += 1;
      prefix = `${number}. `;
      // data-prefix guarda a grafia original ("01. ", "2.  "). Só vale se o
      // número ainda for o desta posição; senão (item inserido antes) segue
      // a sequência, mantendo o espaçamento.
      const custom = prefixAttr?.match(/^(\d+)\.(\s+)$/);
      if (custom) {
        prefix = parseInt(custom[1], 10) === number ? prefixAttr : `${number}.${custom[2]}`;
      }
    } else {
      prefix = prefixAttr && /^[-*]\s+$/.test(prefixAttr) ? prefixAttr : "- ";
    }
    first = false;
    const [head, ...rest] = flowText(child.childNodes).split("\n");
    lines.push([`${prefix}${head}`, ...rest.map((line) => `${LIST_CONTINUATION}${line}`)].join("\n"));
  }
  return lines.join("\n");
}

function blockText(node, isLast) {
  const tag = node.tagName;
  if (tag === "UL" || tag === "OL") return listText(node);
  if (tag === "BLOCKQUOTE") {
    const prefixAttr = attr(node, "data-prefix");
    const prefix = prefixAttr && /^>\s?$/.test(prefixAttr) ? prefixAttr : "> ";
    return flowText(node.childNodes)
      .split("\n")
      .map((line) => `${prefix}${line}`)
      .join("\n");
  }
  if (tag === "PRE") {
    // Bloco sem fechamento só continua aberto se ainda for o último da nota;
    // caso contrário engoliria as linhas seguintes ao reabrir.
    const closing = attr(node, "data-unclosed") !== null && isLast ? "" : "```";
    return `\`\`\`${flowText(node.childNodes, { pre: true })}${closing}`;
  }
  return flowText(node.childNodes);
}

// Espaço de formatação entre blocos (ex.: "\n  " de HTML colado) não é linha.
function isLayoutWhitespace(nodes) {
  return nodes.every(
    (node) =>
      node.nodeType !== ELEMENT_NODE &&
      (node.nodeType !== TEXT_NODE || /^[ \t\r\n]*\n[ \t\r\n]*$/.test(node.nodeValue ?? "")),
  );
}

export function visualEditorToWhatsapp(root) {
  // Cada bloco é uma linha (ou várias); nós soltos na raiz (texto digitado
  // num editor vazio, <br>, negrito...) formam um parágrafo anônimo.
  const entries = [];
  let group = [];
  const flushGroup = () => {
    if (group.length && !isLayoutWhitespace(group)) entries.push({ group });
    group = [];
  };
  for (const child of root.childNodes) {
    if (child.nodeType === ELEMENT_NODE && BLOCK_TAGS.has(child.tagName)) {
      flushGroup();
      entries.push({ block: child });
    } else {
      group.push(child);
    }
  }
  flushGroup();

  let afterList = false;
  return entries
    .map((entry, index) => {
      let text = entry.block
        ? blockText(entry.block, index === entries.length - 1)
        : flowText(entry.group);
      if (afterList) text = escapeListContinuation(text);
      afterList = entry.block?.tagName === "UL" || entry.block?.tagName === "OL";
      return text;
    })
    .join("\n");
}

// ---------------------------------------------------------------------------
// Conteúdo colado/solto -> texto
// ---------------------------------------------------------------------------
//
// O HTML de fora (página, Word, Google Docs...) é reduzido ao que a nota sabe
// guardar: linhas, listas, citação, bloco de código, negrito, itálico, tachado
// e mono. O resultado é texto no formato da nota; o editor insere
// previewHtml(texto), então o que aparece é exatamente o que será gravado.
// Imagens, vídeos, iframes etc. são descartados (e contados, para o aviso).
// Como o serializador, só usa a API básica de nós (roda nos testes headless).

const PASTE_SKIP_TAGS = new Set([
  "SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "HEAD", "TITLE", "META", "LINK", "BASE",
  "INPUT", "SELECT", "OPTION", "OPTGROUP", "DATALIST", "TEXTAREA", "MATH", "RP",
]);

const PASTE_MEDIA_TAGS = new Set([
  "IMG", "PICTURE", "VIDEO", "AUDIO", "CANVAS", "SVG", "IFRAME", "FRAME", "FRAMESET",
  "OBJECT", "EMBED",
]);

const PASTE_BLOCK_TAGS = new Set([
  "P", "DIV", "H1", "H2", "H3", "H4", "H5", "H6", "SECTION", "ARTICLE", "HEADER",
  "FOOTER", "NAV", "ASIDE", "MAIN", "FIGURE", "FIGCAPTION", "ADDRESS", "CENTER", "FORM",
  "FIELDSET", "LEGEND", "DETAILS", "SUMMARY", "DL", "DT", "DD", "TABLE", "THEAD", "TBODY",
  "TFOOT", "TR", "CAPTION", "HR", "BODY", "HTML",
]);

const PASTE_PRE_TAGS = new Set(["PRE", "XMP", "LISTING", "PLAINTEXT"]);

const PASTE_FLAG_TAGS = {
  B: "b", STRONG: "b",
  I: "i", EM: "i",
  S: "s", STRIKE: "s", DEL: "s",
  CODE: "code", KBD: "code", SAMP: "code", TT: "code",
};

// Negrito por fora, mono por dentro (dentro de código não há marcadores).
const PASTE_FLAG_ORDER = ["b", "i", "s", "code"];
const PASTE_FLAG_ELEMENT = { b: "STRONG", i: "EM", s: "S", code: "CODE" };

function styleMap(node) {
  const style = attr(node, "style");
  if (!style) return null;
  const map = {};
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon === -1) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    map[name] = declaration.slice(colon + 1).replace(/!important/i, "").trim().toLowerCase();
  }
  return map;
}

function plainElement(tagName, childNodes = [], attributes = {}) {
  return {
    nodeType: ELEMENT_NODE,
    tagName,
    childNodes,
    getAttribute: (name) => (name in attributes ? attributes[name] : null),
  };
}

function plainText(value) {
  return { nodeType: TEXT_NODE, nodeValue: value, childNodes: [] };
}

function nestPieces(pieces, order) {
  if (!order.length) {
    return pieces.map((piece) => (piece.br ? plainElement("BR") : plainText(piece.text)));
  }
  const [flag, ...rest] = order;
  const nodes = [];
  let index = 0;
  while (index < pieces.length) {
    const on = !pieces[index].br && Boolean(pieces[index].flags[flag]);
    let next = index + 1;
    if (!pieces[index].br) {
      while (next < pieces.length && !pieces[next].br && Boolean(pieces[next].flags[flag]) === on) {
        next += 1;
      }
    }
    const group = pieces.slice(index, next);
    if (on) nodes.push(plainElement(PASTE_FLAG_ELEMENT[flag], nestPieces(group, rest)));
    else nodes.push(...nestPieces(group, rest));
    index = next;
  }
  return nodes;
}

// Tira os espaços do fim de cada linha (o HTML não os mostraria) e troca os
// espaços não separáveis de fora por espaço comum.
function finishPieces(pieces) {
  const lines = [[]];
  for (const piece of pieces) {
    if (piece.br) lines.push([]);
    else lines[lines.length - 1].push({ ...piece });
  }
  const result = [];
  lines.forEach((line, index) => {
    while (line.length) {
      const last = line[line.length - 1];
      last.text = last.text.replace(/[ \t\u00a0]+$/, "");
      if (last.text) break;
      line.pop();
    }
    if (index > 0) result.push({ br: true });
    for (const piece of line) result.push({ ...piece, text: piece.text.replaceAll("\u00a0", " ") });
  });
  return result;
}

// Converte o <body> de um HTML colado (já parseado, inerte) em texto da nota.
// Devolve { text, media }: media = quantos elementos de imagem/vídeo/iframe
// foram descartados.
export function htmlToWhatsapp(root) {
  const blocks = [];
  let current = null;
  let media = 0;

  function newBlock(kind, extra = {}) {
    current = { kind, pieces: [], ...extra };
    blocks.push(current);
    return current;
  }

  function atLineStart() {
    const last = current?.pieces[current.pieces.length - 1];
    return !last || Boolean(last.br);
  }

  function inlineBlock(ctx) {
    if (!current) newBlock(ctx.quote ? "quote" : "p");
    return current;
  }

  // Fim/início de um bloco do HTML: a próxima coisa vai para outra linha.
  function blockBoundary(ctx) {
    if (ctx.pre) {
      const last = current?.pieces[current.pieces.length - 1];
      if (current?.kind === "pre" && last && !last.text.endsWith("\n")) {
        current.pieces.push({ text: "\n", flags: {} });
      }
      return;
    }
    // Dentro de um item de lista, blocos viram linhas do mesmo item.
    if (ctx.item && current === ctx.item) {
      if (!atLineStart()) current.pieces.push({ br: true });
      return;
    }
    current = null;
  }

  function addText(value, ctx) {
    if (ctx.pre) {
      const text = value.replace(/\r\n?/g, "\n");
      if (!text) return;
      if (current?.kind !== "pre") newBlock("pre");
      current.pieces.push({ text, flags: {} });
      return;
    }
    let text = value;
    if (ctx.keepSpaces) text = text.replace(/\r\n?/g, "\n");
    else if (ctx.keepNewlines) text = text.replace(/\r\n?/g, "\n").replace(/[ \t\f]+/g, " ");
    else text = text.replace(/[ \t\n\r\f]+/g, " ");
    text.split("\n").forEach((part, index) => {
      if (index > 0) inlineBlock(ctx).pieces.push({ br: true });
      let chunk = part;
      if (!ctx.keepSpaces) {
        // Espaço colapsável no começo da linha ou depois de outro espaço some.
        const previous = current?.pieces[current.pieces.length - 1];
        if (atLineStart() || previous?.text?.endsWith(" ")) chunk = chunk.replace(/^ /, "");
      }
      if (!chunk) return;
      inlineBlock(ctx).pieces.push({ text: chunk, flags: ctx.flags });
    });
  }

  function visit(node, ctx) {
    if (node.nodeType === TEXT_NODE) {
      addText(node.nodeValue ?? node.textContent ?? "", ctx);
      return;
    }
    if (node.nodeType !== ELEMENT_NODE) return;
    const tag = String(node.tagName).toUpperCase();
    if (PASTE_MEDIA_TAGS.has(tag)) {
      media += 1;
      return;
    }
    if (PASTE_SKIP_TAGS.has(tag)) return;

    const style = styleMap(node);
    if (style && (style.display === "none" || style.visibility === "hidden")) return;

    let next = ctx;
    const setFlag = (name, on) => {
      next = { ...next, flags: { ...next.flags, [name]: on } };
    };
    if (!ctx.pre) {
      if (PASTE_FLAG_TAGS[tag]) setFlag(PASTE_FLAG_TAGS[tag], true);
      // O estilo do próprio elemento manda (o Google Docs embrulha tudo num
      // <b style="font-weight:normal">).
      const weight = style?.["font-weight"];
      if (weight) setFlag("b", weight === "bold" || weight === "bolder" || parseInt(weight, 10) >= 600);
      const fontStyle = style?.["font-style"];
      if (fontStyle) setFlag("i", /italic|oblique/.test(fontStyle));
      const decoration = style?.["text-decoration"] ?? style?.["text-decoration-line"];
      if (decoration?.includes("line-through")) setFlag("s", true);
      const whiteSpace = style?.["white-space"];
      if (whiteSpace) {
        next = {
          ...next,
          keepSpaces: /^(pre|pre-wrap|break-spaces)$/.test(whiteSpace),
          keepNewlines: /^(pre|pre-wrap|pre-line|break-spaces)$/.test(whiteSpace),
        };
      }
    }

    const children = node.childNodes ?? [];
    if (tag === "BR") {
      if (ctx.pre) {
        addText("\n", ctx);
      } else if (current && (!ctx.item || current === ctx.item)) {
        current.pieces.push({ br: true });
      } else {
        // <br> solto entre blocos: linha em branco.
        newBlock(ctx.quote ? "quote" : "p");
        current = null;
      }
      return;
    }

    if (PASTE_PRE_TAGS.has(tag)) {
      if (!ctx.pre) {
        blockBoundary(ctx);
        newBlock("pre");
      }
      for (const child of children) visit(child, { ...next, pre: true });
      if (!ctx.pre) current = null;
      return;
    }
    if (ctx.pre) {
      const block = PASTE_BLOCK_TAGS.has(tag) || tag === "LI" || tag === "BLOCKQUOTE";
      if (block) blockBoundary(ctx);
      for (const child of children) visit(child, next);
      if (block) blockBoundary(ctx);
      return;
    }

    if (tag === "UL" || tag === "OL" || tag === "MENU") {
      current = null;
      const start = parseInt(attr(node, "start") ?? "", 10);
      const list = { ordered: tag === "OL", number: Number.isNaN(start) ? 1 : start };
      for (const child of children) visit(child, { ...next, list, item: null });
      current = null;
      return;
    }

    if (tag === "LI") {
      current = null;
      const list = ctx.list ?? { ordered: false, number: 1 };
      const value = parseInt(attr(node, "value") ?? "", 10);
      if (!Number.isNaN(value)) list.number = value;
      const item = newBlock("li", { ordered: list.ordered, number: list.number });
      list.number += 1;
      for (const child of children) visit(child, { ...next, item });
      current = null;
      return;
    }

    if (tag === "BLOCKQUOTE") {
      current = null;
      for (const child of children) visit(child, { ...next, quote: true, item: null });
      current = null;
      return;
    }

    if (tag === "TD" || tag === "TH") {
      // Células da mesma linha da tabela ficam separadas por tabulação.
      if (current && !atLineStart()) current.pieces.push({ text: "\t", flags: {} });
      for (const child of children) visit(child, next);
      return;
    }

    if (PASTE_BLOCK_TAGS.has(tag)) {
      blockBoundary(ctx);
      for (const child of children) visit(child, next);
      blockBoundary(ctx);
      return;
    }

    for (const child of children) visit(child, next);
  }

  visit(root, {
    flags: {}, pre: false, keepSpaces: false, keepNewlines: false, quote: false, list: null, item: null,
  });

  const tree = [];
  let list = null;
  for (const block of blocks) {
    if (block.kind === "pre") {
      list = null;
      // Formato "```\ncódigo\n```": as cercas ficam em linhas próprias (e o
      // editor não junta a primeira/última linha do código ao texto vizinho).
      const text = block.pieces.map((piece) => piece.text).join("").replace(/^\n/, "").replace(/\n$/, "");
      if (text.trim()) {
        tree.push(plainElement("PRE", [plainElement("CODE", [plainText(`\n${text}\n`)])]));
      }
      continue;
    }
    const inline = nestPieces(finishPieces(block.pieces), PASTE_FLAG_ORDER);
    if (block.kind === "li") {
      const tag = block.ordered ? "OL" : "UL";
      if (list?.tagName !== tag) {
        const attrs = block.ordered && block.number !== 1 ? { start: String(block.number) } : {};
        list = plainElement(tag, [], attrs);
        list.expected = block.number;
        tree.push(list);
      }
      const attrs = {};
      if (block.ordered && block.number !== list.expected) attrs.value = String(block.number);
      list.expected = block.number + 1;
      list.childNodes.push(plainElement("LI", inline, attrs));
      continue;
    }
    list = null;
    tree.push(plainElement(block.kind === "quote" ? "BLOCKQUOTE" : "P", inline));
  }

  return { text: visualEditorToWhatsapp(plainElement("DIV", tree)), media };
}

// Texto simples colado: só normaliza as quebras de linha (\r\n do Windows e
// \r solto viram \n — é assim que o usuário as vê).
export function plainTextToWhatsapp(text) {
  return String(text).replace(/\r\n?/g, "\n");
}
