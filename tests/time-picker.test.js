import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTyped } from "../src/time-picker.js";

test("aceita os jeitos comuns de digitar a hora", () => {
  assert.equal(parseTyped("8"), "08:00");
  assert.equal(parseTyped("08"), "08:00");
  assert.equal(parseTyped("830"), "08:30");
  assert.equal(parseTyped("0830"), "08:30");
  assert.equal(parseTyped("8:30"), "08:30");
  assert.equal(parseTyped("08:30"), "08:30");
  assert.equal(parseTyped("8h30"), "08:30");
  assert.equal(parseTyped("8h"), "08:00");
  assert.equal(parseTyped("8:3"), "08:30");
  assert.equal(parseTyped(" 23:59 "), "23:59");
  assert.equal(parseTyped("0"), "00:00");
});

test("recusa horas inválidas", () => {
  for (const text of ["", "24", "2400", "8:60", "abc", "12345", "-1", "8:30:00"]) {
    assert.equal(parseTyped(text), null, text);
  }
});
