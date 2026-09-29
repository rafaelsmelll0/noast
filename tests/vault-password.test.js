import test from "node:test";
import assert from "node:assert/strict";

import { PASSWORD_GROUPS, randomIndex, securePassword } from "../src/vault.js";

test("securePassword respeita o tamanho e usa só caracteres permitidos", () => {
  const allowed = new Set(PASSWORD_GROUPS.join(""));
  for (const length of [4, 12, 20, 64]) {
    const password = securePassword(length);
    assert.equal(password.length, length);
    for (const char of password) assert.ok(allowed.has(char), `caractere inesperado: ${char}`);
  }
});

test("securePassword sempre traz ao menos um caractere de cada grupo", () => {
  for (let round = 0; round < 500; round += 1) {
    const password = securePassword(20);
    for (const group of PASSWORD_GROUPS) {
      assert.ok([...password].some((char) => group.includes(char)), `faltou grupo ${group}`);
    }
  }
});

// Os caracteres obrigatórios de cada grupo não podem ficar presos às
// primeiras posições: o embaralhamento usa sorteios próprios.
test("securePassword espalha os caracteres obrigatórios pelas posições", () => {
  const digits = PASSWORD_GROUPS[2];
  const positions = new Set();
  for (let round = 0; round < 400; round += 1) {
    const password = securePassword(8);
    [...password].forEach((char, index) => {
      if (digits.includes(char)) positions.add(index);
    });
  }
  assert.equal(positions.size, 8);
});

test("randomIndex fica no intervalo e cobre todos os valores", () => {
  const seen = new Set();
  for (let round = 0; round < 2000; round += 1) {
    const value = randomIndex(7);
    assert.ok(Number.isInteger(value) && value >= 0 && value < 7);
    seen.add(value);
  }
  assert.equal(seen.size, 7);
  assert.equal(randomIndex(1), 0);
});

test("randomIndex recusa intervalos inválidos", () => {
  assert.throws(() => randomIndex(0), RangeError);
  assert.throws(() => randomIndex(-3), RangeError);
  assert.throws(() => randomIndex(2.5), RangeError);
});
