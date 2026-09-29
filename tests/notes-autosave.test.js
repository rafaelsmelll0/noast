import test from "node:test";
import assert from "node:assert/strict";

import { createNotesController } from "../src/notes.js";

// Ambiente mínimo de navegador (document/window/timers falsos) só com o que o
// controlador de notas usa; os timers avançam manualmente.
function createEnvironment() {
  const timers = new Map();
  let nextTimer = 1;
  let now = 0;

  function listenable(target = {}) {
    const listeners = new Map();
    target.addEventListener = (type, fn) => {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    };
    target.fire = (type, event = {}) => {
      for (const fn of listeners.get(type) ?? []) fn({ type, target, ...event });
    };
    return target;
  }

  function fakeElement() {
    const attributes = new Map();
    return listenable({
      hidden: false,
      value: "",
      textContent: "",
      innerHTML: "",
      style: {},
      dataset: {},
      parentElement: null,
      focus() {},
      setAttribute(name, value) {
        attributes.set(name, String(value));
      },
      getAttribute(name) {
        return attributes.get(name) ?? null;
      },
      closest() {
        return null;
      },
      contains() {
        return false;
      },
    });
  }

  const elements = new Map();
  const document = listenable({
    hidden: false,
    querySelector(selector) {
      if (!elements.has(selector)) elements.set(selector, fakeElement());
      return elements.get(selector);
    },
    createElement: fakeElement,
  });
  const window = listenable({
    setTimeout(fn, delay = 0) {
      const id = nextTimer++;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    getSelection() {
      return null;
    },
  });

  globalThis.document = document;
  globalThis.window = window;
  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  globalThis.ResizeObserver = class {
    observe() {}
  };
  globalThis.getComputedStyle = () => ({ display: "block" });

  const settle = () => new Promise((resolve) => setImmediate(resolve));

  async function advance(ms) {
    const target = now + ms;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
      await settle();
    }
    now = target;
    await settle();
  }

  return { document, window, element: (selector) => document.querySelector(selector), advance, settle };
}

// saveResults: "ok", uma mensagem de erro (a gravação falha) ou uma Promise
// (gravação em andamento até ela resolver/rejeitar).
function setup(saveResults, { content = "texto" } = {}) {
  const env = createEnvironment();
  const calls = [];
  const snackbars = [];
  const invoke = async (command, args) => {
    if (command === "get_notes") {
      return [{ id: "n1", title: "Nota", content, pinned: false, created_at: "c", updated_at: "u" }];
    }
    if (command === "save_note") {
      calls.push(args.note);
      let result = saveResults.shift() ?? "ok";
      if (result instanceof Promise) result = await result;
      if (result !== "ok") throw result;
      return { ...args.note, created_at: "c", updated_at: "u2" };
    }
    throw new Error(`comando inesperado: ${command}`);
  };
  const controller = createNotesController({
    invoke,
    showSnackbar: (message) => snackbars.push(message),
    confirmAction: async () => true,
  });
  return { env, calls, snackbars, controller };
}

async function typeTitle(env, value) {
  env.element("#noteTitle").value = value;
  env.element("#noteTitle").fire("input");
  await env.settle();
}

test("autosave: falha é repetida com backoff e avisa só uma vez", async () => {
  const { env, calls, snackbars, controller } = setup(["disco cheio", "disco cheio", "ok"]);
  await controller.load();
  await typeTitle(env, "Novo título");

  await env.advance(650);
  assert.equal(calls.length, 1);
  assert.match(env.element("#noteSaveStatus").textContent, /Não foi possível salvar/);
  assert.deepEqual(snackbars, ["disco cheio"]);

  await env.advance(1999);
  assert.equal(calls.length, 1, "espera o backoff antes de tentar de novo");
  await env.advance(1);
  assert.equal(calls.length, 2);
  assert.equal(snackbars.length, 1, "novas tentativas não repetem o aviso");

  await env.advance(4000);
  assert.equal(calls.length, 3);
  assert.equal(calls[2].title, "Novo título");
  assert.equal(env.element("#noteSaveStatus").textContent, "Salvo");

  await env.advance(120_000);
  assert.equal(calls.length, 3, "depois de salvar, não tenta mais");
});

for (const [label, trigger] of [
  ["visibilitychange (oculto)", (env) => {
    env.document.hidden = true;
    env.document.fire("visibilitychange");
  }],
  ["blur da janela", (env) => env.window.fire("blur")],
  ["pagehide", (env) => env.window.fire("pagehide")],
  ["beforeunload", (env) => env.window.fire("beforeunload")],
]) {
  test(`autosave: ${label} grava na hora o que está pendente`, async () => {
    const { env, calls, controller } = setup([]);
    await controller.load();
    await typeTitle(env, "Pendente");
    assert.equal(calls.length, 0);

    trigger(env);
    await env.settle();
    assert.equal(calls.length, 1);
    assert.equal(calls[0].title, "Pendente");

    await env.advance(5000);
    assert.equal(calls.length, 1, "o timer do autosave não grava de novo");
  });
}

test("autosave: flush sem nada pendente não grava", async () => {
  const { env, calls, controller } = setup([]);
  await controller.load();
  env.window.fire("blur");
  await env.settle();
  assert.equal(calls.length, 0);
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("flush espera a gravação em andamento e refaz uma vez a que falhar", async () => {
  const inFlight = deferred();
  const { env, calls, controller } = setup([inFlight.promise, "ok"]);
  await controller.load();
  await typeTitle(env, "Saindo");
  await env.advance(650);
  assert.equal(calls.length, 1, "a gravação do autosave começou");

  let flushed = false;
  const flushing = controller.flush().then(() => {
    flushed = true;
  });
  await env.settle();
  assert.equal(flushed, false, "flush não termina com a gravação ainda em andamento");

  inFlight.resolve("disco cheio");
  await flushing;
  assert.equal(calls.length, 2, "a gravação que falhou foi refeita antes de o flush terminar");
  assert.equal(calls[1].title, "Saindo");
  assert.equal(env.element("#noteSaveStatus").textContent, "Salvo");
});

test("flush não fica preso se a gravação continuar falhando", async () => {
  const { env, calls, controller } = setup(["erro", "erro", "erro", "erro"]);
  await controller.load();
  await typeTitle(env, "Falha");
  await controller.flush();
  assert.ok(calls.length >= 2 && calls.length <= 3, `tentativas: ${calls.length}`);
  assert.match(env.element("#noteSaveStatus").textContent, /Não foi possível salvar/);
});

test("flush grava o que mudou durante uma gravação em andamento", async () => {
  const inFlight = deferred();
  const { env, calls, controller } = setup([inFlight.promise, "ok"]);
  await controller.load();
  await typeTitle(env, "Primeiro");
  await env.advance(650);
  await typeTitle(env, "Segundo");

  const flushing = controller.flush();
  inFlight.resolve("ok");
  await flushing;
  assert.equal(calls.length, 2);
  assert.equal(calls[1].title, "Segundo");
});

test("editar só o título não altera o conteúdo (\r\n e \r preservados)", async () => {
  const { env, calls, controller } = setup([], { content: "linha1\r\nlinha2\rsolta" });
  await controller.load();
  // O <textarea> escondido normaliza as quebras; o conteúdo não pode vir dele.
  env.element("#noteContent").value = "linha1\nlinha2\nsolta";
  await typeTitle(env, "Novo título");
  await env.advance(650);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].title, "Novo título");
  assert.equal(calls[0].content, "linha1\r\nlinha2\rsolta");
});
