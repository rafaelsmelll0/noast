import test from "node:test";
import assert from "node:assert/strict";

import {
  htmlToWhatsapp,
  inlineWhatsapp,
  plainTextToWhatsapp,
  previewHtml,
  visualEditorToWhatsapp,
} from "../src/note-format.js";

// DOM mínimo para rodar o serializador sem navegador. O parser é estrito de
// propósito: tag fechada fora de ordem lança erro, então um HTML mal aninhado
// (o bug antigo de <strong><em></strong></em>) quebra o teste em vez de ser
// "consertado" silenciosamente como o navegador faria.
const VOID_TAGS = new Set(["BR", "IMG", "HR", "META", "INPUT", "WBR"]);
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', nbsp: "\u00a0" };

function decode(text) {
  return text.replace(/&(#\d+|[a-z]+);/g, (match, name) => {
    if (name.startsWith("#")) return String.fromCodePoint(parseInt(name.slice(1), 10));
    if (!(name in ENTITIES)) throw new Error(`entidade desconhecida: ${match}`);
    return ENTITIES[name];
  });
}

function textNode(value) {
  return { nodeType: 3, nodeValue: value, childNodes: [] };
}

function elementNode(tagName, attributes = {}) {
  return {
    nodeType: 1,
    tagName,
    attributes,
    childNodes: [],
    getAttribute(name) {
      return name in this.attributes ? this.attributes[name] : null;
    },
  };
}

function parseHtml(html) {
  const root = elementNode("DIV");
  const stack = [root];
  const pattern = /<(\/?)([a-zA-Z0-9]+)((?:\s+[a-z-]+="[^"]*")*)\s*>|([^<]+)/g;
  let consumed = 0;
  for (const match of html.matchAll(pattern)) {
    assert.equal(match.index, consumed, `HTML inválido perto de ${html.slice(consumed, consumed + 20)}`);
    consumed += match[0].length;
    const parent = stack[stack.length - 1];
    if (match[4] !== undefined) {
      parent.childNodes.push(textNode(decode(match[4])));
      continue;
    }
    const tag = match[2].toUpperCase();
    if (match[1]) {
      const open = stack.pop();
      if (open.tagName !== tag) throw new Error(`</${tag}> fecha <${open.tagName}>: HTML mal aninhado`);
      continue;
    }
    const attributes = {};
    for (const [, name, value] of match[3].matchAll(/([a-z-]+)="([^"]*)"/g)) {
      attributes[name] = decode(value);
    }
    const element = elementNode(tag, attributes);
    parent.childNodes.push(element);
    if (!VOID_TAGS.has(tag)) stack.push(element);
  }
  assert.equal(consumed, html.length, "HTML com sobras");
  if (stack.length !== 1) throw new Error(`tags sem fechar: ${stack.map((el) => el.tagName)}`);
  return root;
}

function roundTrip(text) {
  return visualEditorToWhatsapp(parseHtml(previewHtml(text)));
}

function editorText(html) {
  return visualEditorToWhatsapp(parseHtml(html));
}

// --- Bug 1: formatação cruzada ------------------------------------------------

test("round-trip: exemplos de formatação cruzada do relatório", () => {
  for (const text of [
    "*joao_silva@x.com* e maria_souza@y.com",
    "*preço_1* e valor_2",
    "_a *b* c_ e ~d _e_~",
    "*a _b* c_",
    "_a *b_ c*",
    "~a *b~ c*",
    "*a `b* c` d*",
  ]) {
    assert.equal(roundTrip(text), text, JSON.stringify(text));
  }
});

test("inlineWhatsapp: _ dentro de palavra/e-mail não abre itálico", () => {
  assert.equal(
    inlineWhatsapp("*joao_silva@x.com* e maria_souza@y.com"),
    "<strong>joao_silva@x.com</strong> e maria_souza@y.com",
  );
  assert.equal(inlineWhatsapp("*preço_1* e valor_2"), "<strong>preço_1</strong> e valor_2");
  assert.equal(inlineWhatsapp("snake_case_nome"), "snake_case_nome");
  assert.equal(inlineWhatsapp("2*3*4"), "2*3*4");
});

test("inlineWhatsapp: aninhamento correto", () => {
  assert.equal(inlineWhatsapp("*a _b_ c*"), "<strong>a <em>b</em> c</strong>");
  assert.equal(inlineWhatsapp("_*a*_"), "<em><strong>a</strong></em>");
  assert.equal(inlineWhatsapp("~*_a_*~"), "<s><strong><em>a</em></strong></s>");
  // Marcadores cruzados: o de fora fecha primeiro, o de dentro fica literal.
  assert.equal(inlineWhatsapp("*a _b* c_"), "<strong>a _b</strong> c_");
  assert.equal(inlineWhatsapp("(*a*)."), "(<strong>a</strong>).");
  assert.equal(inlineWhatsapp("* a*"), "* a*");
  assert.equal(inlineWhatsapp("*a *"), "*a *");
  // Código é literal: nada de negrito dentro.
  assert.equal(inlineWhatsapp("`*a*`"), '<code data-tick="">*a*</code>');
  assert.equal(inlineWhatsapp("*a `x*` b*"), '<strong>a <code data-tick="">x*</code> b</strong>');
});

// --- Bug 2: Enter dentro do bloco de código ----------------------------------

test("bloco de código: Enter (o navegador insere <br>) mantém as quebras", () => {
  assert.equal(previewHtml("```\nx\n```"), "<pre><code><br>x<br><br></code></pre>");
  // DOM real do Chrome depois de Enter após o x e digitar "nova".
  assert.equal(editorText("<pre><code><br>x<br>nova<br><br></code></pre>"), "```\nx\nnova\n```");
  // Variações que o contenteditable também produz.
  assert.equal(editorText("<pre><code>\nx<br>nova\n</code></pre>"), "```\nx\nnova\n```");
  assert.equal(editorText("<pre>a<div>b</div><div><br></div><div>c</div></pre>"), "```a\nb\n\nc```");
});

test("bloco de código sem fechamento continua sem fechamento", () => {
  assert.equal(roundTrip("```abc\ndef"), "```abc\ndef");
  // ...a menos que deixe de ser o último bloco (senão engoliria o resto).
  assert.equal(editorText('<pre data-unclosed=""><code>abc</code></pre><p>z</p>'), "```abc```\nz");
});

// --- Bug 3: mudanças silenciosas ----------------------------------------------

test("round-trip: linhas em branco múltiplas, mono de uma crase, numeração e marcador", () => {
  for (const text of [
    "a\n\n\n\nb",
    "\n\na\n\n",
    "`x`",
    "use `x` e ```y```",
    "1. a\n3. b",
    "1. a\n1. b\n1. c",
    "5. a\n6. b\n10. c",
    "01. a\n2.  b",
    "* a\n* b\n- c",
    "-\ta",
    "- a\n  b",
    "- a\n  \n  c\n- d",
    ">a\n> b\n>  c",
    "> ",
    "- ",
    "1. ",
  ]) {
    assert.equal(roundTrip(text), text, JSON.stringify(text));
  }
});

test("Shift+Enter em item de lista: a linha continua no item ao reabrir", () => {
  const saved = editorText("<ul><li>a<br>b</li><li>c</li></ul>");
  assert.equal(saved, "- a\n  b\n- c");
  assert.equal(previewHtml(saved), "<ul><li>a<br>b</li><li>c</li></ul>");
  assert.equal(editorText("<ol><li>a<br><br></li></ol>"), "1. a\n  ");
});

test("numeração fora de sequência: clone do Enter segue a sequência", () => {
  assert.equal(previewHtml("1. a\n3. b"), '<ol><li>a</li><li value="3">b</li></ol>');
  // fixClonedListItem remove os atributos do item novo; o serializador numera.
  assert.equal(editorText('<ol><li>a</li><li value="3">b</li><li>c</li></ol>'), "1. a\n3. b\n4. c");
  // data-prefix inválido para o tipo de lista (lista convertida) é ignorado.
  assert.equal(editorText('<ol><li data-prefix="* ">a</li></ol>'), "1. a");
});

test("editar um trecho não altera o resto da nota", () => {
  const text = "`x`\n\n\n* item\n3. três\n\n```\ncódigo\n```\n*joao_silva@x.com*";
  const dom = parseHtml(previewHtml(text));
  // "Digita" no primeiro parágrafo (o <code> de uma crase).
  dom.childNodes[0].childNodes[0].childNodes[0].nodeValue = "xy";
  assert.equal(visualEditorToWhatsapp(dom), text.replace("`x`", "`xy`"));
});

// --- DOM gerado pela edição (contenteditable) --------------------------------

test("serializador: DOM típico do contenteditable", () => {
  assert.equal(editorText("abc<div>def</div><div><br></div>"), "abc\ndef\n");
  assert.equal(editorText("<p>a</p><br><p>b</p>"), "a\n\nb");
  assert.equal(editorText("<p><br></p>"), "");
  assert.equal(editorText(""), "");
  assert.equal(editorText("<p>a&nbsp; b</p>"), "a  b");
  assert.equal(editorText("<p><b>a<br>b</b></p>"), "*a*\n*b*");
  assert.equal(editorText("<p><b>palavra </b>x</p>"), "*palavra* x");
  assert.equal(editorText("<p><b>a<b>b</b></b></p>"), "*ab*");
  assert.equal(editorText("<p><code>x</code></p>"), "```x```");
  assert.equal(editorText('<p><code data-tick="">a`b</code></p>'), "```a`b```");
  assert.equal(editorText("<blockquote>a<br>b</blockquote>"), "> a\n> b");
  assert.equal(editorText("<blockquote><br></blockquote>"), "> ");
});

// --- Segurança e caracteres especiais ----------------------------------------

test("previewHtml escapa HTML em todos os blocos e atributos", () => {
  const html = previewHtml('<img src=x onerror=alert(1)>\n- <b>\n* "a"\n```\n<script>\n```\n`<i>`');
  assert.ok(!/<(img|script|b>|i>)/.test(html), html);
  assert.equal(roundTrip('<img src=x onerror="alert(1)">'), '<img src=x onerror="alert(1)">');
});

test("round-trip preserva \\r e espaço não separável", () => {
  for (const text of ["a\r\nb", "a\u00a0b", "- a\u00a0\u00a0b", "-\u00a0x", "```\na\u00a0\n```"]) {
    assert.equal(roundTrip(text), text, JSON.stringify(text));
  }
});

// --- Fuzz: identidade para qualquer texto ------------------------------------

function seededRandom(seed) {
  let value = seed;
  return () => {
    value = (value * 1103515245 + 12345) % 2 ** 31;
    return value / 2 ** 31;
  };
}

test("round-trip é a identidade para textos aleatórios", () => {
  const random = seededRandom(20260929);
  const pieces = [
    "*", "_", "~", "`", "```", " ", "  ", "\n", "\n\n", "a", "ç", "joao_silva", "@x.com", "1. ",
    "3. ", "- ", "* ", "> ", ">", "\t", "\u00a0", "<", "&", "\"", "'", "2", ".", "(", ")", "\r",
  ];
  for (let run = 0; run < 5000; run += 1) {
    let text = "";
    const length = 1 + Math.floor(random() * 14);
    for (let i = 0; i < length; i += 1) text += pieces[Math.floor(random() * pieces.length)];
    assert.equal(roundTrip(text), text, JSON.stringify(text));
  }
});

test("round-trip é a identidade também com letras coladas nos marcadores, U+200B e recuos", () => {
  const random = seededRandom(424242);
  const pieces = [
    "*", "_", "~", "`", "```", " ", "  ", "    ", "\n", "\n  ", "abc", "é", "1", "\u200b",
    "\u00a0", "- ", "1. ", "2.  ", "01. ", "> ", "\t", "*a*", "_b_", "x*y*z", "\r\n", "&",
  ];
  for (let run = 0; run < 20000; run += 1) {
    let text = "";
    const length = 1 + Math.floor(random() * 16);
    for (let i = 0; i < length; i += 1) text += pieces[Math.floor(random() * pieces.length)];
    assert.equal(roundTrip(text), text, JSON.stringify(text));
  }
});

// --- Espaços, recuos e Shift+Enter (editor com white-space: pre-wrap) -------

test("espaços repetidos e recuos ficam no HTML como texto (pre-wrap os mostra)", () => {
  for (const text of ["Nome:    Joao", "    recuado", "a    b   c", "\tcom tab", "fim   "]) {
    assert.equal(roundTrip(text), text, JSON.stringify(text));
    assert.ok(previewHtml(text).includes(escapeText(text)), text);
  }
});

function escapeText(text) {
  return text.replaceAll("&", "&amp;");
}

test("pre-wrap: \\n no texto (Shift+Enter do navegador) é quebra de linha, como <br>", () => {
  assert.equal(editorText("<p>a\nb</p>"), "a\nb");
  // O último \n do bloco só segura a linha (igual ao último <br>).
  assert.equal(editorText("<p>a\n</p>"), "a");
  assert.equal(editorText("a\nb\n\nc\n\n"), "a\nb\n\nc\n");
  assert.equal(editorText("<ul><li>b\ncont</li></ul><div>after</div>"), "- b\n  cont\nafter");
  assert.equal(editorText("<ul><li>a\n\n</li></ul>"), "- a\n  ");
  assert.equal(editorText("<p><b>a\nb</b></p>"), "*a*\n*b*");
  assert.equal(editorText("<p><code>a\nb</code></p>"), "```a```\n```b```");
  // Dentro de <pre> continua como antes.
  assert.equal(editorText("<pre><code>\nx\n</code></pre>"), "```\nx\n```");
});

test("parágrafo com recuo logo depois de uma lista não vira continuação do item", () => {
  const saved = editorText("<ul><li>a</li></ul><div>  indentado</div>");
  assert.equal(saved, "- a\n\u00a0 indentado");
  assert.equal(
    previewHtml(saved),
    '<ul><li>a</li></ul><p><span data-nbsp="">\u00a0</span> indentado</p>',
  );
  assert.equal(roundTrip(saved), saved);
  assert.equal(editorText("<ul><li>a</li></ul>  b"), "- a\n\u00a0 b");
  assert.equal(editorText("<div><ol><li>a</li></ol>  b</div>"), "1. a\n\u00a0 b");
  assert.equal(editorText("<div><ol><li>a</li></ol><p>  b</p></div>"), "1. a\n\u00a0 b");
  // Um espaço só, ou depois de uma linha em branco, não é ambíguo.
  assert.equal(editorText("<ul><li>a</li></ul><p> b</p>"), "- a\n b");
  assert.equal(editorText("<ul><li>a</li></ul><p><br></p><p>  b</p>"), "- a\n\n  b");
  // Continuação de verdade (Shift+Enter no item) continua sendo continuação.
  assert.equal(editorText("<ul><li>a<br>  b</li></ul>"), "- a\n    b");
  assert.equal(roundTrip("- a\n    b"), "- a\n    b");
});

test("numeração com grafia própria segue a sequência quando um item é inserido", () => {
  assert.equal(
    editorText('<ol><li data-prefix="1.  ">a</li><li>x</li><li data-prefix="2.  ">b</li></ol>'),
    "1.  a\n2. x\n3.  b",
  );
  assert.equal(editorText('<ol><li data-prefix="01. ">a</li><li data-prefix="2.  ">b</li></ol>'), "01. a\n2.  b");
  assert.equal(
    editorText('<ol><li>x</li><li data-prefix="01. ">a</li></ol>'),
    "1. x\n2. a",
  );
});

// --- Formatação no meio da palavra --------------------------------------------

test("negrito/itálico colado em letras reabre igual (separador invisível U+200B)", () => {
  const saved = editorText("<p>abc<b>def</b>ghi</p>");
  assert.equal(saved, "abc\u200b*def*\u200bghi");
  assert.equal(inlineWhatsapp(saved), "abc\u200b<strong>def</strong>\u200bghi");
  assert.equal(roundTrip(saved), saved);
  assert.equal(editorText("<p>x<i>a<b>b</b></i>y</p>"), "x\u200b_a\u200b*b*_\u200by");
  assert.equal(editorText("<p><b>a</b>b</p>"), "*a*\u200bb");
  assert.equal(editorText("<p>a<s>b</s></p>"), "a\u200b~b~");
  // Sem letra colada, nada muda.
  assert.equal(editorText("<p>a <b>b</b> c</p>"), "a *b* c");
  assert.equal(editorText("<p>(<b>b</b>).</p>"), "(*b*).");
  assert.equal(editorText("<p><b>a</b><i>b</i></p>"), "*a*_b_");
  assert.equal(editorText("<p><b>palavra </b>x</p>"), "*palavra* x");
  // Mono não tem regra de limite de palavra.
  assert.equal(editorText("<p>a<code>b</code>c</p>"), "a```b```c");
});

// Árvores aleatórias de formatação (como o contenteditable cria): o texto
// gravado reabre com a mesma formatação em cada caractere visível.
function randomInlineTree(random, depth) {
  const letters = ["a", "b", "ç", "Z", "9", " ", "  ", ",", "é"];
  const count = 1 + Math.floor(random() * 3);
  const nodes = [];
  for (let i = 0; i < count; i += 1) {
    const roll = random();
    if (depth < 3 && roll < 0.45) {
      const tag = ["B", "STRONG", "I", "EM", "S", "CODE"][Math.floor(random() * 6)];
      const element = elementNode(tag);
      element.childNodes = randomInlineTree(random, depth + 1);
      nodes.push(element);
    } else if (roll < 0.5) {
      nodes.push(elementNode("BR"));
    } else {
      let text = "";
      const size = 1 + Math.floor(random() * 4);
      for (let j = 0; j < size; j += 1) text += letters[Math.floor(random() * letters.length)];
      nodes.push(textNode(text));
    }
  }
  return nodes;
}

const FLAG_BY_TAG = { B: "b", STRONG: "b", I: "i", EM: "i", S: "s", CODE: "code" };

function styledChars(node, flags = new Set(), out = []) {
  if (node.nodeType === 3) {
    for (const ch of node.nodeValue) {
      if (/\s|\u200b/.test(ch)) continue;
      out.push(`${ch}:${flags.has("code") ? "code" : [...flags].sort().join("+")}`);
    }
    return out;
  }
  const flag = FLAG_BY_TAG[node.tagName];
  const next = flag ? new Set([...flags, flag]) : flags;
  for (const child of node.childNodes) styledChars(child, next, out);
  return out;
}

test("formatação aleatória no editor reabre com a mesma formatação", () => {
  const random = seededRandom(777);
  for (let run = 0; run < 5000; run += 1) {
    const root = elementNode("DIV");
    const paragraphs = 1 + Math.floor(random() * 2);
    for (let i = 0; i < paragraphs; i += 1) {
      const p = elementNode("P");
      p.childNodes = randomInlineTree(random, 0);
      root.childNodes.push(p);
    }
    const text = visualEditorToWhatsapp(root);
    const reopened = parseHtml(previewHtml(text));
    assert.equal(visualEditorToWhatsapp(reopened), text, JSON.stringify(text));
    assert.deepEqual(styledChars(reopened), styledChars(root), JSON.stringify(text));
  }
});

// --- Colar / soltar -------------------------------------------------------------

function pasted(html) {
  const result = htmlToWhatsapp(parseHtml(html));
  // O que é inserido no editor é previewHtml(texto): tem de reabrir igual.
  assert.equal(roundTrip(result.text), result.text, JSON.stringify(result.text));
  return result;
}

test("colar HTML: formatação suportada vira marcadores do WhatsApp", () => {
  assert.deepEqual(pasted("<p>Texto <b>forte</b> e <i>it</i> e <s>x</s> e <code>c</code></p>"), {
    text: "Texto *forte* e _it_ e ~x~ e ```c```",
    media: 0,
  });
  // Google Docs: tudo dentro de <b style="font-weight:normal">; o estilo manda.
  assert.equal(
    pasted(
      '<b style="font-weight:normal;"><p><span style="font-weight:700;">Neg</span><span> normal</span></p>' +
        '<br><p><span style="font-style:italic">it</span></p></b>',
    ).text,
    "*Neg* normal\n\n_it_",
  );
  assert.equal(pasted('<p><span style="text-decoration: line-through">r</span></p>').text, "~r~");
  assert.equal(pasted("<p>abc<b>def</b>ghi</p>").text, "abc\u200b*def*\u200bghi");
});

test("colar HTML: imagens, iframes e scripts são descartados (e contados)", () => {
  assert.deepEqual(
    pasted('<p>x</p><img src="a"><script>alert(1)</script><style>p{}</style><iframe src="b"></iframe>'),
    { text: "x", media: 2 },
  );
  assert.deepEqual(pasted('<img src="data:image/png;base64,AAAA">'), { text: "", media: 1 });
  assert.equal(pasted('<p>a<span style="display:none">oculto</span></p>').text, "a");
});

test("colar HTML: blocos, listas, citação, tabela e código", () => {
  assert.equal(pasted('<h1 style="color:red">Título</h1><p><a href="https://x">link</a></p>').text, "Título\nlink");
  assert.equal(pasted("<ul><li>um</li><li>dois<ul><li>sub</li></ul></li><li>tres</li></ul>").text, "- um\n- dois\n- sub\n- tres");
  assert.equal(pasted('<ol start="3"><li>a</li><li>b</li></ol>').text, "3. a\n4. b");
  assert.equal(pasted("<ul><li><p>a</p><p>b</p></li></ul>").text, "- a\n  b");
  assert.equal(pasted("<blockquote><p>a</p><p>b</p></blockquote>").text, "> a\n> b");
  assert.equal(
    pasted("<table><tr><td>c1</td><td>c2</td></tr><tr><td>d1</td><td>d2</td></tr></table>").text,
    "c1\tc2\nd1\td2",
  );
  // <pre>: cercas em linhas próprias, espaços e quebras preservados.
  assert.equal(
    pasted("<pre><code>function x() {\n  return 1;\n}\n</code></pre><p>depois</p>").text,
    "```\nfunction x() {\n  return 1;\n}\n```\ndepois",
  );
  assert.equal(pasted("<pre>a<br>b</pre>").text, "```\na\nb\n```");
});

test("colar HTML: espaços como o navegador mostraria", () => {
  assert.equal(pasted("<p>  a \n  b  </p><p>Linha&nbsp;&nbsp;&nbsp;com</p>").text, "a b\nLinha   com");
  assert.equal(pasted("<p>a <b> b</b> c</p>").text, "a *b* c");
  assert.equal(pasted('<span style="white-space: pre-wrap;">a   b\nc</span>').text, "a   b\nc");
  assert.equal(pasted("<p>a</p>\n  <p>b</p>").text, "a\nb");
  assert.equal(pasted("<p>a<br>b<br></p>").text, "a\nb");
});

test("colar texto simples: \\r\\n e \\r viram \\n", () => {
  assert.equal(plainTextToWhatsapp("l1\r\nl2\r\n\r\nl4\rl5"), "l1\nl2\n\nl4\nl5");
});
