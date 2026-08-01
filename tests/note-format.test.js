import test from "node:test";
import assert from "node:assert/strict";

import { escapeHtml, inlineWhatsapp, noteExcerpt, previewHtml } from "../src/note-format.js";

test("escapeHtml neutraliza os 5 caracteres perigosos", () => {
  assert.equal(escapeHtml(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#039;");
});

test("inlineWhatsapp converte negrito, itálico, tachado e mono", () => {
  assert.equal(inlineWhatsapp("*a*"), "<strong>a</strong>");
  assert.equal(inlineWhatsapp("_a_"), "<em>a</em>");
  assert.equal(inlineWhatsapp("~a~"), "<s>a</s>");
  assert.equal(inlineWhatsapp("`a`"), "<code>a</code>");
});

test("previewHtml: vazio vira string vazia", () => {
  assert.equal(previewHtml(""), "");
});

test("previewHtml: lista com marcadores vira <ul>", () => {
  assert.equal(previewHtml("- um\n- dois"), "<ul><li>um</li><li>dois</li></ul>");
});

test("previewHtml: lista numerada começando do 1 não ganha atributo start", () => {
  assert.equal(previewHtml("1. um\n2. dois"), "<ol><li>um</li><li>dois</li></ol>");
});

// Regressão: uma lista salva como "5. 6." precisa reabrir mostrando 5, 6
// (antes o previewHtml ignorava o número inicial e renderizava 1, 2).
test("previewHtml: lista numerada preserva o número inicial", () => {
  assert.equal(previewHtml("5. um\n6. dois"), '<ol start="5"><li>um</li><li>dois</li></ol>');
});

test("previewHtml: parágrafo escapa HTML (sem XSS)", () => {
  assert.equal(previewHtml("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
});

test("previewHtml: citação e bloco de código", () => {
  assert.equal(previewHtml("> nota"), "<blockquote>nota</blockquote>");
  assert.equal(previewHtml("```\ncode\n```"), "<pre><code>\ncode\n</code></pre>");
});

test("previewHtml: duas listas de tipos diferentes não se fundem", () => {
  assert.equal(
    previewHtml("- a\n1. b"),
    "<ul><li>a</li></ul><ol><li>b</li></ol>",
  );
});

test("noteExcerpt remove marcações e colapsa espaços", () => {
  assert.equal(noteExcerpt("# *oi*\n\n- item"), "# oi item");
  assert.equal(noteExcerpt(""), "Nota vazia");
});
