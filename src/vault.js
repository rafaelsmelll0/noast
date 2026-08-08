function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function initials(name) {
  return name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? "")
    .join("")
    .toLocaleUpperCase("pt-BR") || "C";
}

function normalizedError(error, fallback) {
  if (typeof error === "string") return error;
  return error?.message || fallback;
}

function securePassword(length = 20) {
  const groups = [
    "ABCDEFGHJKLMNPQRSTUVWXYZ",
    "abcdefghijkmnopqrstuvwxyz",
    "23456789",
    "!@#$%&*+-_=?.",
  ];
  const all = groups.join("");
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  const password = groups.map((group, index) => group[bytes[index] % group.length]);
  for (let index = groups.length; index < length; index += 1) {
    password.push(all[bytes[index] % all.length]);
  }
  for (let index = password.length - 1; index > 0; index -= 1) {
    const target = bytes[index] % (index + 1);
    [password[index], password[target]] = [password[target], password[index]];
  }
  return password.join("");
}

async function writeClipboard(value) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(value);
    return;
  }
  const fallback = document.createElement("textarea");
  fallback.value = value;
  fallback.style.position = "fixed";
  fallback.style.opacity = "0";
  document.body.append(fallback);
  fallback.select();
  const copied = document.execCommand("copy");
  fallback.remove();
  if (!copied) throw new Error("Não foi possível acessar a área de transferência.");
}

export function createVaultController({ invoke, showSnackbar, confirmAction }) {
  const state = {
    clients: [],
    accesses: [],
    selectedClientId: null,
    query: "",
    editingClientId: null,
    editingAccessId: null,
    clipboardVersion: 0,
    revealTimers: new Map(),
    collapsedGroups: new Set(),
  };

  const elements = {
    list: document.querySelector("#vaultClientList"),
    listEmpty: document.querySelector("#vaultClientListEmpty"),
    empty: document.querySelector("#vaultEmptyState"),
    content: document.querySelector("#vaultClientContent"),
    search: document.querySelector("#vaultSearchInput"),
    count: document.querySelector("#navVaultCount"),
    clientName: document.querySelector("#vaultClientName"),
    clientAvatar: document.querySelector("#vaultClientAvatar"),
    clientSummary: document.querySelector("#vaultClientSummary"),
    clientNotes: document.querySelector("#vaultClientNotes"),
    accessList: document.querySelector("#vaultAccessList"),
    accessEmpty: document.querySelector("#vaultAccessEmpty"),
    clientModal: document.querySelector("#vaultClientModal"),
    clientModalTitle: document.querySelector("#vaultClientModalTitle"),
    clientForm: document.querySelector("#vaultClientForm"),
    clientNameInput: document.querySelector("#vaultClientNameInput"),
    clientParentInput: document.querySelector("#vaultClientParentInput"),
    clientParentHint: document.querySelector("#vaultClientParentHint"),
    clientNotesInput: document.querySelector("#vaultClientNotesInput"),
    clientError: document.querySelector("#vaultClientFormError"),
    accessModal: document.querySelector("#vaultAccessModal"),
    accessScroll: document.querySelector("#vaultAccessScroll"),
    accessScrollbar: document.querySelector("#vaultAccessScrollbar"),
    accessScrollbarThumb: document.querySelector("#vaultAccessScrollbarThumb"),
    accessModalTitle: document.querySelector("#vaultAccessModalTitle"),
    accessForm: document.querySelector("#vaultAccessForm"),
    accessClient: document.querySelector("#vaultAccessClient"),
    accessNewClient: document.querySelector("#vaultAccessNewClient"),
    accessNewClientName: document.querySelector("#vaultAccessNewClientName"),
    accessLabel: document.querySelector("#vaultAccessLabel"),
    accessService: document.querySelector("#vaultAccessService"),
    accessCustomService: document.querySelector("#vaultAccessCustomService"),
    accessUrl: document.querySelector("#vaultAccessUrl"),
    accessUsername: document.querySelector("#vaultAccessUsername"),
    accessRecovery: document.querySelector("#vaultAccessRecovery"),
    accessPassword: document.querySelector("#vaultAccessPassword"),
    accessNotes: document.querySelector("#vaultAccessNotes"),
    accessError: document.querySelector("#vaultAccessFormError"),
    togglePassword: document.querySelector("#toggleVaultPassword"),
  };
  let scrollbarDrag = null;

  const selectedClient = () =>
    state.clients.find((client) => client.id === state.selectedClientId) ?? null;

  const clientAccesses = (clientId) =>
    state.accesses
      .filter((access) => access.client_id === clientId)
      .sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));

  function accessMatches(access, query) {
    return `${access.label}\n${access.service}\n${access.url}\n${access.username}`
      .toLocaleLowerCase("pt-BR")
      .includes(query);
  }

  function filteredClients() {
    if (!state.query) return [...state.clients].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    return state.clients
      .filter(
        (client) =>
          `${client.name}\n${client.notes}`.toLocaleLowerCase("pt-BR").includes(state.query) ||
          clientAccesses(client.id).some((access) => accessMatches(access, state.query)),
      )
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }

  const childrenOf = (parentId) =>
    state.clients
      .filter((client) => client.parent_id === parentId)
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

  /// Acessos do próprio cliente somados aos de quem ele agrupa — o responsável
  /// mostra o total pelo qual responde, mesmo sem acessos diretos.
  function totalAccesses(clientId) {
    return childrenOf(clientId).reduce(
      (total, child) => total + clientAccesses(child.id).length,
      clientAccesses(clientId).length,
    );
  }

  function clientItemHtml(client, count) {
    return `
      <button class="vault-client-item${client.id === state.selectedClientId ? " active" : ""}" type="button" data-vault-client="${escapeHtml(client.id)}">
        <span class="vault-client-avatar" aria-hidden="true">${escapeHtml(initials(client.name))}</span>
        <span class="vault-client-item-copy">
          <strong>${escapeHtml(client.name)}</strong>
          <small>${count} acesso${count === 1 ? "" : "s"}</small>
        </span>
        <span class="vault-client-count">${count}</span>
      </button>`;
  }

  function renderClientList() {
    const clients = filteredClients();
    elements.count.textContent = state.accesses.length;
    elements.listEmpty.hidden = clients.length > 0;

    const visible = new Set(clients.map((client) => client.id));
    // Buscando, um filho encontrado precisa aparecer sob o responsável dele.
    const roots = clients.filter((client) => !client.parent_id);
    const orphanParents = clients
      .filter((client) => client.parent_id && !visible.has(client.parent_id))
      .map((client) => state.clients.find((item) => item.id === client.parent_id))
      .filter(Boolean);
    const allRoots = [...new Map([...roots, ...orphanParents].map((c) => [c.id, c])).values()].sort(
      (a, b) => a.name.localeCompare(b.name, "pt-BR"),
    );

    elements.list.innerHTML = allRoots
      .map((root) => {
        const children = childrenOf(root.id).filter(
          // Quando o próprio responsável casa com a busca, mostra tudo o que
          // ele agrupa; senão, só os filhos que casaram.
          (child) => !state.query || visible.has(child.id) || visible.has(root.id),
        );
        const rootHtml = clientItemHtml(root, clientAccesses(root.id).length);
        if (children.length === 0) return rootHtml;

        // Durante a busca os grupos ficam abertos, senão o resultado sumiria.
        // Um grupo também não fica fechado escondendo o cliente aberto.
        const holdsSelection =
          root.id === state.selectedClientId ||
          children.some((child) => child.id === state.selectedClientId);
        const collapsed =
          !state.query && state.collapsedGroups.has(root.id) && !holdsSelection;
        return `
          <div class="vault-group">
            <button class="vault-group-header" type="button" data-vault-group="${escapeHtml(root.id)}" aria-expanded="${!collapsed}">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
              <span class="vault-group-name">${escapeHtml(root.name)}</span>
              <span>${totalAccesses(root.id)}</span>
            </button>
            <div class="vault-group-children"${collapsed ? " hidden" : ""}>
              ${rootHtml}
              ${children.map((child) => clientItemHtml(child, clientAccesses(child.id).length)).join("")}
            </div>
          </div>`;
      })
      .join("");
  }

  function cardHtml(access) {
    const service = access.service || "Outro";
    const username = access.username || "Não informado";
    const password = access.has_password ? "••••••••••••" : "Não cadastrada";
    return `
      <article class="vault-access-card" data-vault-access="${escapeHtml(access.id)}">
        <header class="vault-card-header">
          <div class="vault-card-title">
            <h3>${escapeHtml(access.label)}</h3>
            <span class="vault-service-badge">${escapeHtml(service)}</span>
          </div>
          <div class="vault-card-menu">
            ${
              access.url
                ? `<button class="icon-button" type="button" data-vault-action="open" aria-label="Abrir site" title="Abrir site"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 3h7v7M10 14 21 3"/><path d="M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5"/></svg></button>`
                : ""
            }
            <button class="icon-button" type="button" data-vault-action="edit" aria-label="Editar acesso" title="Editar acesso"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg></button>
            <button class="icon-button danger" type="button" data-vault-action="delete" aria-label="Excluir acesso" title="Excluir acesso"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M8 6V4h8v2M19 6l-1 15H6L5 6"/><path d="M10 11v5M14 11v5"/></svg></button>
          </div>
        </header>
        <div class="vault-credential">
          <span class="vault-credential-label">Usuário</span>
          <span class="vault-credential-value">
            <code title="${escapeHtml(username)}">${escapeHtml(username)}</code>
            ${
              access.username
                ? `<button class="vault-copy-button" type="button" data-vault-action="copy-user" aria-label="Copiar usuário" title="Copiar usuário"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg></button>`
                : ""
            }
          </span>
        </div>
        <div class="vault-credential">
          <span class="vault-credential-label">Senha</span>
          <span class="vault-credential-value">
            <code class="vault-password-mask" data-password-value>${escapeHtml(password)}</code>
            ${
              access.has_password
                ? `<button class="vault-copy-button" type="button" data-vault-action="reveal" aria-label="Mostrar senha" title="Mostrar senha"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/></svg></button>
                   <button class="vault-copy-button" type="button" data-vault-action="copy-password" aria-label="Copiar senha" title="Copiar senha"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="13" height="13" rx="2"/><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3"/></svg></button>`
                : ""
            }
          </span>
        </div>
      </article>`;
  }

  function renderSelectedClient() {
    const client = selectedClient();
    elements.empty.hidden = Boolean(client);
    elements.content.hidden = !client;
    if (!client) return;

    const allAccesses = clientAccesses(client.id);
    const accesses = state.query
      ? allAccesses.filter((access) => accessMatches(access, state.query))
      : allAccesses;
    elements.clientName.textContent = client.name;
    elements.clientAvatar.textContent = initials(client.name);
    // Deixa claro de quem é o cliente aberto, ou quantos ele agrupa.
    const parent = client.parent_id
      ? state.clients.find((item) => item.id === client.parent_id)
      : null;
    const children = childrenOf(client.id);
    const context = parent
      ? ` · em ${parent.name}`
      : children.length
        ? ` · agrupa ${children.length} cliente${children.length === 1 ? "" : "s"}`
        : "";
    elements.clientSummary.textContent = `${allAccesses.length} acesso${allAccesses.length === 1 ? "" : "s"} cadastrado${allAccesses.length === 1 ? "" : "s"}${context}`;
    elements.clientNotes.textContent = client.notes;
    elements.clientNotes.hidden = !client.notes;
    elements.accessList.innerHTML = accesses.map(cardHtml).join("");
    elements.accessEmpty.hidden = accesses.length > 0;
    if (state.query && allAccesses.length > 0 && accesses.length === 0) {
      elements.accessEmpty.querySelector("h3").textContent = "Nenhum acesso corresponde à busca";
      elements.accessEmpty.querySelector("p").textContent = "Tente buscar outro serviço, usuário ou endereço.";
      elements.accessEmpty.querySelector("button").hidden = true;
    } else {
      elements.accessEmpty.querySelector("h3").textContent = "Nenhum acesso neste cliente";
      elements.accessEmpty.querySelector("p").textContent = "Adicione o primeiro login para começar a organizar as credenciais.";
      elements.accessEmpty.querySelector("button").hidden = false;
    }
  }

  function render() {
    renderClientList();
    renderSelectedClient();
  }

  function selectClient(id) {
    state.selectedClientId = state.clients.some((client) => client.id === id) ? id : null;
    render();
  }

  function closeClientModal() {
    elements.clientModal.hidden = true;
    state.editingClientId = null;
    elements.clientForm.reset();
    elements.clientError.textContent = "";
  }

  /// Monta as opções de responsável. Só clientes principais podem agrupar (a
  /// hierarquia tem dois níveis), e quem já agrupa outros não pode virar filho.
  function fillParentOptions(client) {
    const select = elements.clientParentInput;
    const hasChildren = client ? childrenOf(client.id).length > 0 : false;
    const candidates = state.clients
      .filter((item) => !item.parent_id && item.id !== client?.id)
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

    select.innerHTML = `<option value="">Nenhum — cliente principal</option>${candidates
      .map((item) => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`)
      .join("")}`;
    select.value = client?.parent_id ?? "";
    select.disabled = hasChildren;
    elements.clientParentHint.textContent = hasChildren
      ? "Este cliente agrupa outros, por isso não pode ficar dentro de alguém."
      : "Agrupe quando alguém administra as contas de vários clientes.";
  }

  function openClientModal(client = null) {
    state.editingClientId = client?.id ?? null;
    elements.clientModalTitle.textContent = client ? "Editar cliente" : "Novo cliente";
    elements.clientNameInput.value = client?.name ?? "";
    elements.clientNotesInput.value = client?.notes ?? "";
    // Criar a partir de um responsável selecionado já vem agrupado nele.
    const suggestedParent =
      !client && selectedClient() && !selectedClient().parent_id ? selectedClient().id : "";
    fillParentOptions(client);
    if (!client && suggestedParent) elements.clientParentInput.value = suggestedParent;
    elements.clientError.textContent = "";
    elements.clientModal.hidden = false;
    window.setTimeout(() => elements.clientNameInput.focus(), 50);
  }

  async function saveClient(event) {
    event.preventDefault();
    // Cada entrada gera um id novo: sem esta guarda, um clique duplo cadastra
    // o mesmo cliente duas vezes.
    const submitButton = elements.clientForm.querySelector('button[type="submit"]');
    if (submitButton.disabled) return;

    const name = elements.clientNameInput.value.trim();
    if (!name) {
      elements.clientError.textContent = "Informe o nome do cliente.";
      return;
    }
    const current = state.clients.find((client) => client.id === state.editingClientId);
    const client = {
      id: current?.id ?? crypto.randomUUID(),
      name,
      parent_id: elements.clientParentInput.value,
      notes: elements.clientNotesInput.value.trim(),
      created_at: current?.created_at ?? "",
      updated_at: current?.updated_at ?? "",
    };
    submitButton.disabled = true;
    try {
      const saved = await invoke("save_vault_client", { client });
      const index = state.clients.findIndex((item) => item.id === saved.id);
      if (index >= 0) state.clients[index] = saved;
      else state.clients.push(saved);
      closeClientModal();
      selectClient(saved.id);
      showSnackbar(current ? "Cliente atualizado." : "Cliente cadastrado.");
    } catch (error) {
      elements.clientError.textContent = normalizedError(error, "Não foi possível salvar o cliente.");
    } finally {
      submitButton.disabled = false;
    }
  }

  async function deleteClient() {
    const client = selectedClient();
    if (!client) return;
    const count = clientAccesses(client.id).length;
    const children = childrenOf(client.id);
    let warning = count
      ? `Excluir "${client.name}" e seus ${count} acesso${count === 1 ? "" : "s"}? Esta ação não pode ser desfeita.`
      : `Excluir o cliente "${client.name}"?`;
    if (children.length) {
      warning += ` Os ${children.length} cliente${children.length === 1 ? "" : "s"} agrupado${children.length === 1 ? "" : "s"} não ${children.length === 1 ? "será excluído" : "serão excluídos"} — ${children.length === 1 ? "passará" : "passarão"} a aparecer como cliente principal.`;
    }
    const confirmed = await confirmAction({
      dialogTitle: "Excluir cliente?",
      dialogMessage: warning,
      confirmLabel: count ? "Excluir cliente e acessos" : "Excluir cliente",
    });
    if (!confirmed) return;
    try {
      await invoke("delete_vault_client", { id: client.id });
      state.clients = state.clients.filter((item) => item.id !== client.id);
      state.accesses = state.accesses.filter((item) => item.client_id !== client.id);
      // Espelha a promoção feita no backend, sem precisar recarregar o cofre.
      state.clients.forEach((item) => {
        if (item.parent_id === client.id) item.parent_id = "";
      });
      selectClient(filteredClients()[0]?.id ?? null);
      showSnackbar("Cliente excluído do cofre.");
    } catch (error) {
      showSnackbar(normalizedError(error, "Não foi possível excluir o cliente."));
    }
  }

  function setPasswordVisibility(visible) {
    elements.accessPassword.type = visible ? "text" : "password";
    elements.togglePassword.setAttribute("aria-label", visible ? "Ocultar senha" : "Mostrar senha");
    elements.togglePassword.title = visible ? "Ocultar senha" : "Mostrar senha";
  }

  function updateAccessScrollbar() {
    const { scrollHeight, clientHeight, scrollTop } = elements.accessScroll;
    elements.accessScrollbar.hidden = false;
    const trackHeight = elements.accessScrollbar.clientHeight;
    const scrollable = scrollHeight > clientHeight + 1 && trackHeight > 0;
    elements.accessScrollbar.hidden = !scrollable;
    if (!scrollable) return;

    const thumbHeight = Math.max(36, (clientHeight / scrollHeight) * trackHeight);
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const maxScroll = scrollHeight - clientHeight;
    const thumbTop = maxScroll > 0 ? (scrollTop / maxScroll) * maxThumbTop : 0;
    elements.accessScrollbarThumb.style.height = `${thumbHeight}px`;
    elements.accessScrollbarThumb.style.transform = `translateY(${thumbTop}px)`;
  }

  function setServiceValue(service) {
    const known = [...elements.accessService.options].some(
      (option) => option.value === service && option.value !== "Outro",
    );
    if (!service || known) {
      elements.accessService.value = service;
      elements.accessCustomService.value = "";
      elements.accessCustomService.hidden = true;
      elements.accessCustomService.required = false;
    } else {
      elements.accessService.value = "Outro";
      elements.accessCustomService.value = service;
      elements.accessCustomService.hidden = false;
      elements.accessCustomService.required = true;
    }
  }

  function selectedServiceValue() {
    return elements.accessService.value === "Outro"
      ? elements.accessCustomService.value.trim()
      : elements.accessService.value;
  }

  function closeAccessModal() {
    elements.accessModal.hidden = true;
    state.editingAccessId = null;
    elements.accessForm.reset();
    elements.accessError.textContent = "";
    setPasswordVisibility(false);
    setServiceValue("");
    elements.accessScroll.scrollTop = 0;
    updateAccessScrollbar();
  }

  /// Lista os clientes no seletor do acesso, com o responsável no rótulo para
  /// diferenciar homônimos ("Dora" em dois grupos distintos).
  function fillAccessClientOptions(selectedId) {
    const label = (client) => {
      const parent = client.parent_id
        ? state.clients.find((item) => item.id === client.parent_id)
        : null;
      return parent ? `${parent.name} › ${client.name}` : client.name;
    };
    const options = [...state.clients]
      .sort((a, b) => label(a).localeCompare(label(b), "pt-BR"))
      .map(
        (client) =>
          `<option value="${escapeHtml(client.id)}">${escapeHtml(label(client))}</option>`,
      )
      .join("");
    elements.accessClient.innerHTML = options;
    if (selectedId) elements.accessClient.value = selectedId;
    hideNewClientField();
  }

  function hideNewClientField() {
    elements.accessNewClientName.hidden = true;
    elements.accessNewClientName.value = "";
    elements.accessClient.disabled = false;
    elements.accessNewClient.textContent = "Novo cliente";
  }

  async function openAccessModal(accessId = null) {
    const client = selectedClient();
    if (!client) return;
    state.editingAccessId = accessId;
    elements.accessModalTitle.textContent = accessId ? "Editar acesso" : "Novo acesso";
    elements.accessForm.reset();
    elements.accessError.textContent = "";
    setPasswordVisibility(false);
    setServiceValue("");
    fillAccessClientOptions(client.id);

    if (accessId) {
      try {
        const access = await invoke("get_vault_access", { id: accessId });
        fillAccessClientOptions(access.client_id);
        elements.accessLabel.value = access.label;
        setServiceValue(access.service);
        elements.accessUrl.value = access.url;
        elements.accessUsername.value = access.username;
        elements.accessRecovery.value = access.recovery_email;
        elements.accessPassword.value = access.password;
        elements.accessNotes.value = access.notes;
      } catch (error) {
        showSnackbar(normalizedError(error, "Não foi possível abrir o acesso."));
        return;
      }
    }
    elements.accessModal.hidden = false;
    window.setTimeout(() => {
      elements.accessLabel.focus();
      updateAccessScrollbar();
    }, 50);
  }

  async function saveAccess(event) {
    event.preventDefault();
    // Mesma proteção do cliente: sem ela, um clique duplo grava duas cópias da
    // credencial (com ids diferentes).
    const submitButton = elements.accessForm.querySelector('button[type="submit"]');
    if (submitButton.disabled) return;

    const client = selectedClient();
    if (!client) return;
    const label = elements.accessLabel.value.trim();
    if (!label) {
      elements.accessError.textContent = "Informe o nome do acesso.";
      return;
    }
    let current = null;
    if (state.editingAccessId) {
      try {
        current = await invoke("get_vault_access", { id: state.editingAccessId });
      } catch (error) {
        elements.accessError.textContent = normalizedError(error, "Não foi possível carregar o acesso.");
        return;
      }
    }
    // Cliente escolhido no próprio formulário: permite mover um acesso de um
    // cliente para outro sem recriá-lo, e criar o cliente aqui mesmo.
    let clientId = elements.accessClient.value;
    const newClientName = elements.accessNewClientName.hidden
      ? ""
      : elements.accessNewClientName.value.trim();
    if (!elements.accessNewClientName.hidden) {
      if (!newClientName) {
        elements.accessError.textContent = "Informe o nome do novo cliente.";
        return;
      }
      try {
        const created = await invoke("save_vault_client", {
          client: {
            id: crypto.randomUUID(),
            name: newClientName,
            parent_id: "",
            notes: "",
            created_at: "",
            updated_at: "",
          },
        });
        state.clients.push(created);
        clientId = created.id;
      } catch (error) {
        elements.accessError.textContent = normalizedError(
          error,
          "Não foi possível criar o cliente.",
        );
        return;
      }
    }
    if (!clientId) {
      elements.accessError.textContent = "Escolha o cliente deste acesso.";
      return;
    }

    const access = {
      id: current?.id ?? crypto.randomUUID(),
      client_id: clientId,
      label,
      service: selectedServiceValue(),
      url: elements.accessUrl.value.trim(),
      username: elements.accessUsername.value.trim(),
      password: elements.accessPassword.value,
      recovery_email: elements.accessRecovery.value.trim(),
      notes: elements.accessNotes.value.trim(),
      created_at: current?.created_at ?? "",
      updated_at: current?.updated_at ?? "",
    };
    submitButton.disabled = true;
    try {
      const saved = await invoke("save_vault_access", { access });
      const index = state.accesses.findIndex((item) => item.id === saved.id);
      if (index >= 0) state.accesses[index] = saved;
      else state.accesses.push(saved);
      closeAccessModal();
      // Segue o acesso se ele mudou de dono, senão ele "sumiria" da tela.
      if (saved.client_id !== state.selectedClientId) selectClient(saved.client_id);
      else render();
      const movedTo = state.clients.find((item) => item.id === saved.client_id);
      showSnackbar(
        current
          ? saved.client_id !== client.id
            ? `Acesso movido para ${movedTo?.name ?? "outro cliente"}.`
            : "Acesso atualizado."
          : "Acesso protegido no cofre.",
      );
    } catch (error) {
      elements.accessError.textContent = normalizedError(error, "Não foi possível salvar o acesso.");
    } finally {
      submitButton.disabled = false;
    }
  }

  async function deleteAccess(access) {
    const confirmed = await confirmAction({
      dialogTitle: "Excluir acesso?",
      dialogMessage: `O acesso "${access.label}" será removido permanentemente do cofre.`,
      confirmLabel: "Excluir acesso",
    });
    if (!confirmed) return;
    try {
      await invoke("delete_vault_access", { id: access.id });
      state.accesses = state.accesses.filter((item) => item.id !== access.id);
      render();
      showSnackbar("Acesso excluído.");
    } catch (error) {
      showSnackbar(normalizedError(error, "Não foi possível excluir o acesso."));
    }
  }

  async function sensitiveClipboard(value, label) {
    try {
      await writeClipboard(value);
      const version = ++state.clipboardVersion;
      showSnackbar(`${label} copiad${label === "Senha" ? "a" : "o"}. A área de transferência será limpa em 30 segundos.`);
      window.setTimeout(async () => {
        if (version !== state.clipboardVersion) return;
        let shouldClear = true;
        try {
          if (navigator.clipboard?.readText) {
            const current = await navigator.clipboard.readText();
            shouldClear = current === value;
          }
        } catch {
          // If reading is denied, prefer clearing a possibly sensitive value.
        }
        if (!shouldClear) return;
        try {
          await writeClipboard("");
        } catch {
          // Clipboard permissions can change after the app loses focus.
        }
      }, 30_000);
    } catch (error) {
      showSnackbar(normalizedError(error, "Não foi possível copiar."));
    }
  }

  async function fullAccess(id) {
    return invoke("get_vault_access", { id });
  }

  async function revealPassword(card, access) {
    const value = card.querySelector("[data-password-value]");
    const button = card.querySelector('[data-vault-action="reveal"]');
    if (button.getAttribute("aria-pressed") === "true") {
      window.clearTimeout(state.revealTimers.get(access.id));
      state.revealTimers.delete(access.id);
      value.textContent = "••••••••••••";
      value.classList.add("vault-password-mask");
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", "Mostrar senha");
      return;
    }
    try {
      const complete = await fullAccess(access.id);
      value.textContent = complete.password;
      value.classList.remove("vault-password-mask");
      button.setAttribute("aria-pressed", "true");
      button.setAttribute("aria-label", "Ocultar senha");
      const timer = window.setTimeout(() => {
        value.textContent = "••••••••••••";
        value.classList.add("vault-password-mask");
        button.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-label", "Mostrar senha");
        state.revealTimers.delete(access.id);
      }, 15_000);
      state.revealTimers.set(access.id, timer);
    } catch (error) {
      showSnackbar(normalizedError(error, "Não foi possível mostrar a senha."));
    }
  }

  async function load() {
    try {
      const catalog = await invoke("get_vault_catalog");
      state.clients = catalog.clients;
      state.accesses = catalog.accesses;
      state.selectedClientId = [...state.clients].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))[0]?.id ?? null;
      render();
    } catch (error) {
      showSnackbar(normalizedError(error, "Não foi possível abrir o cofre."));
    }
  }

  function hideRevealedPasswords() {
    for (const timer of state.revealTimers.values()) window.clearTimeout(timer);
    state.revealTimers.clear();
    elements.accessList.querySelectorAll("[data-password-value]").forEach((value) => {
      value.textContent = "••••••••••••";
      value.classList.add("vault-password-mask");
    });
    elements.accessList.querySelectorAll('[data-vault-action="reveal"]').forEach((button) => {
      button.setAttribute("aria-pressed", "false");
      button.setAttribute("aria-label", "Mostrar senha");
    });
  }

  document.querySelector("#newVaultClient").addEventListener("click", () => openClientModal());
  document.querySelector("#emptyNewVaultClient").addEventListener("click", () => openClientModal());
  document.querySelector("#editVaultClient").addEventListener("click", () => {
    const client = selectedClient();
    if (client) openClientModal(client);
  });
  document.querySelector("#deleteVaultClient").addEventListener("click", deleteClient);
  document.querySelector("#newVaultAccess").addEventListener("click", () => openAccessModal());
  document.querySelector("#emptyNewVaultAccess").addEventListener("click", () => openAccessModal());
  elements.clientForm.addEventListener("submit", saveClient);
  elements.accessForm.addEventListener("submit", saveAccess);

  document.querySelectorAll("[data-close-vault-client]").forEach((button) => {
    button.addEventListener("click", closeClientModal);
  });
  document.querySelectorAll("[data-close-vault-access]").forEach((button) => {
    button.addEventListener("click", closeAccessModal);
  });

  elements.clientModal.addEventListener("click", (event) => {
    if (event.target === elements.clientModal) closeClientModal();
  });
  elements.accessModal.addEventListener("click", (event) => {
    if (event.target === elements.accessModal) closeAccessModal();
  });

  elements.search.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLocaleLowerCase("pt-BR");
    const visible = filteredClients();
    if (!visible.some((client) => client.id === state.selectedClientId)) {
      state.selectedClientId = visible[0]?.id ?? null;
    }
    render();
  });

  // Cria o cliente sem sair do cadastro do acesso: o campo de nome aparece no
  // lugar da escolha e o cliente é criado junto ao salvar.
  elements.accessNewClient.addEventListener("click", () => {
    const creating = elements.accessNewClientName.hidden;
    elements.accessNewClientName.hidden = !creating;
    elements.accessClient.disabled = creating;
    elements.accessNewClient.textContent = creating ? "Escolher existente" : "Novo cliente";
    if (creating) elements.accessNewClientName.focus();
  });

  elements.list.addEventListener("click", (event) => {
    const group = event.target.closest("[data-vault-group]");
    if (group) {
      const id = group.dataset.vaultGroup;
      if (state.collapsedGroups.has(id)) state.collapsedGroups.delete(id);
      else state.collapsedGroups.add(id);
      renderClientList();
      return;
    }
    const item = event.target.closest("[data-vault-client]");
    if (item) selectClient(item.dataset.vaultClient);
  });

  elements.accessList.addEventListener("click", async (event) => {
    const card = event.target.closest("[data-vault-access]");
    const action = event.target.closest("[data-vault-action]")?.dataset.vaultAction;
    if (!card || !action) return;
    const access = state.accesses.find((item) => item.id === card.dataset.vaultAccess);
    if (!access) return;
    if (action === "edit") await openAccessModal(access.id);
    if (action === "delete") await deleteAccess(access);
    if (action === "open") {
      try {
        await invoke("open_external_url", { url: access.url });
      } catch (error) {
        showSnackbar(normalizedError(error, "Não foi possível abrir o site."));
      }
    }
    if (action === "copy-user") await sensitiveClipboard(access.username, "Usuário");
    if (action === "copy-password") {
      try {
        const complete = await fullAccess(access.id);
        await sensitiveClipboard(complete.password, "Senha");
      } catch (error) {
        showSnackbar(normalizedError(error, "Não foi possível copiar a senha."));
      }
    }
    if (action === "reveal") await revealPassword(card, access);
  });

  elements.togglePassword.addEventListener("click", () => {
    setPasswordVisibility(elements.accessPassword.type === "password");
  });

  elements.accessService.addEventListener("change", () => {
    const custom = elements.accessService.value === "Outro";
    elements.accessCustomService.hidden = !custom;
    elements.accessCustomService.required = custom;
    if (!custom) {
      elements.accessCustomService.value = "";
    } else {
      window.setTimeout(() => elements.accessCustomService.focus(), 0);
    }
    window.requestAnimationFrame(updateAccessScrollbar);
  });

  document.querySelector("#generateVaultPassword").addEventListener("click", () => {
    elements.accessPassword.value = securePassword();
    setPasswordVisibility(true);
    elements.accessPassword.focus();
    elements.accessPassword.select();
  });

  elements.accessScroll.addEventListener("scroll", updateAccessScrollbar);
  elements.accessScrollbar.addEventListener("pointerdown", (event) => {
    if (event.target === elements.accessScrollbarThumb) return;
    const track = elements.accessScrollbar.getBoundingClientRect();
    const thumbHeight = elements.accessScrollbarThumb.offsetHeight;
    const targetTop = Math.max(
      0,
      Math.min(track.height - thumbHeight, event.clientY - track.top - thumbHeight / 2),
    );
    const maxThumbTop = track.height - thumbHeight;
    const maxScroll = elements.accessScroll.scrollHeight - elements.accessScroll.clientHeight;
    elements.accessScroll.scrollTop = maxThumbTop > 0 ? (targetTop / maxThumbTop) * maxScroll : 0;
  });

  elements.accessScrollbarThumb.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    elements.accessScrollbarThumb.setPointerCapture(event.pointerId);
    elements.accessScrollbarThumb.classList.add("is-dragging");
    scrollbarDrag = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startScroll: elements.accessScroll.scrollTop,
    };
  });

  elements.accessScrollbarThumb.addEventListener("pointermove", (event) => {
    if (!scrollbarDrag || scrollbarDrag.pointerId !== event.pointerId) return;
    const trackHeight = elements.accessScrollbar.clientHeight;
    const thumbHeight = elements.accessScrollbarThumb.offsetHeight;
    const maxThumbTop = trackHeight - thumbHeight;
    const maxScroll = elements.accessScroll.scrollHeight - elements.accessScroll.clientHeight;
    if (maxThumbTop <= 0 || maxScroll <= 0) return;
    const scrollDelta = ((event.clientY - scrollbarDrag.startY) / maxThumbTop) * maxScroll;
    elements.accessScroll.scrollTop = scrollbarDrag.startScroll + scrollDelta;
  });

  function stopScrollbarDrag(event) {
    if (!scrollbarDrag || scrollbarDrag.pointerId !== event.pointerId) return;
    scrollbarDrag = null;
    elements.accessScrollbarThumb.classList.remove("is-dragging");
  }

  elements.accessScrollbarThumb.addEventListener("pointerup", stopScrollbarDrag);
  elements.accessScrollbarThumb.addEventListener("pointercancel", stopScrollbarDrag);
  new ResizeObserver(updateAccessScrollbar).observe(elements.accessScroll);
  new ResizeObserver(updateAccessScrollbar).observe(elements.accessForm);
  window.addEventListener("resize", updateAccessScrollbar);

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!elements.accessModal.hidden) closeAccessModal();
    else if (!elements.clientModal.hidden) closeClientModal();
  });

  return {
    load,
    activate() {
      if (!selectedClient() && state.clients.length) {
        selectClient(filteredClients()[0]?.id ?? null);
      }
    },
    createClient() {
      openClientModal();
    },
    deactivate() {
      hideRevealedPasswords();
      closeAccessModal();
      closeClientModal();
    },
  };
}
