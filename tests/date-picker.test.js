import test from "node:test";
import assert from "node:assert/strict";

import {
  formatBr,
  isoDate,
  monthGrid,
  parseIso,
  popoverPlacement,
} from "../src/date-picker.js";

test("isoDate usa o fuso local, sem deslocar o dia", () => {
  assert.equal(isoDate(new Date(2026, 7, 14, 23, 30)), "2026-08-14");
  assert.equal(isoDate(new Date(2026, 0, 1, 0, 15)), "2026-01-01");
});

test("parseIso devolve null para valor ausente ou inválido", () => {
  assert.equal(parseIso(""), null);
  assert.equal(parseIso("nao-e-data"), null);
});

// O meio-dia protege de fusos negativos empurrarem a data para o dia anterior.
test("parseIso ancora a data ao meio-dia", () => {
  const date = parseIso("2026-08-14");
  assert.equal(date.getHours(), 12);
  assert.equal(isoDate(date), "2026-08-14");
});

test("formatBr apresenta no formato brasileiro", () => {
  assert.equal(formatBr("2026-08-14"), "14/08/2026");
  assert.equal(formatBr("2026-01-05"), "05/01/2026");
  assert.equal(formatBr(""), "");
});

test("monthGrid começa no domingo e fecha semanas inteiras", () => {
  for (const [year, month] of [
    [2026, 7],
    [2026, 1],
    [2024, 1],
    [2026, 11],
  ]) {
    const grid = monthGrid(year, month);
    assert.equal(grid[0].getDay(), 0, `${month + 1}/${year} não começa no domingo`);
    assert.equal(grid.length % 7, 0, `${month + 1}/${year} tem semana incompleta`);
  }
});

test("monthGrid inclui o primeiro e o último dia do mês", () => {
  const grid = monthGrid(2026, 7).map(isoDate);
  assert.ok(grid.includes("2026-08-01"));
  assert.ok(grid.includes("2026-08-31"));
});

test("monthGrid cobre 29 de fevereiro em ano bissexto", () => {
  assert.ok(monthGrid(2024, 1).map(isoDate).includes("2024-02-29"));
  assert.ok(!monthGrid(2026, 1).map(isoDate).includes("2026-02-29"));
});

const viewport = { width: 800, height: 600 };
const size = { width: 268, height: 300 };

test("popoverPlacement abre embaixo do campo quando cabe", () => {
  const anchor = { top: 100, bottom: 140, left: 50 };
  const placement = popoverPlacement(anchor, size, viewport);
  assert.equal(placement.above, false);
  assert.equal(placement.top, 146);
  assert.equal(placement.left, 50);
});

// O caso do bug: campo perto do rodapé do modal, calendário cortado.
test("popoverPlacement abre para cima quando não cabe embaixo", () => {
  const anchor = { top: 450, bottom: 490, left: 50 };
  const placement = popoverPlacement(anchor, size, viewport);
  assert.equal(placement.above, true);
  assert.equal(placement.top, 450 - 6 - 300);
  assert.ok(placement.top + size.height <= viewport.height);
});

test("popoverPlacement nunca sai da janela", () => {
  // Nem embaixo nem em cima cabe inteiro: fica preso dentro da janela.
  const tight = { width: 300, height: 360 };
  const placement = popoverPlacement({ top: 150, bottom: 180, left: 200 }, size, tight);
  assert.ok(placement.top >= 8);
  assert.ok(placement.top + size.height <= tight.height - 8 || placement.top === 8);
  assert.ok(placement.left >= 8);
  assert.ok(placement.left + size.width <= tight.width - 8 || placement.left === 8);
});

test("popoverPlacement encosta à esquerda quando o campo está perto da borda direita", () => {
  const placement = popoverPlacement({ top: 100, bottom: 140, left: 700 }, size, viewport);
  assert.equal(placement.left, viewport.width - size.width - 8);
});
