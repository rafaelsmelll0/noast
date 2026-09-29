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

/// Inteiro uniforme em [0, max). Cada chamada busca bytes novos, e os valores
/// do topo do intervalo de 32 bits que causariam viés no módulo são
/// descartados (rejection sampling).
export function randomIndex(max) {
  if (!Number.isInteger(max) || max <= 0 || max > 0x100000000) {
    throw new RangeError("Intervalo inválido para sorteio.");
  }
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0] >= limit);
  return buffer[0] % max;
}

export const PASSWORD_GROUPS = [
  "ABCDEFGHJKLMNPQRSTUVWXYZ",
  "abcdefghijkmnopqrstuvwxyz",
  "23456789",
  "!@#$%&*+-_=?.",
];

export function securePassword(length = 20) {
  const groups = PASSWORD_GROUPS;
  const all = groups.join("");
  // Garante ao menos um caractere de cada grupo; o restante vem do conjunto todo.
  const password = groups.map((group) => group[randomIndex(group.length)]);
  for (let index = groups.length; index < length; index += 1) {
    password.push(all[randomIndex(all.length)]);
  }
  // Fisher-Yates com sorteios próprios: reaproveitar os bytes da escolha dos
  // caracteres deixaria a posição correlacionada com o caractere.
  for (let index = password.length - 1; index > 0; index -= 1) {
    const target = randomIndex(index + 1);
    [password[index], password[target]] = [password[target], password[index]];
  }
  return password.join("");
}

/// Controlador criado pelo main.js. As funções exportadas abaixo (usadas ao
/// minimizar/ocultar a janela ou trocar de aba) falam com ele.
let activeController = null;

/// Há formulário do cofre aberto com alterações ainda não salvas?
export function vaultFormIsDirty() {
  return activeController?.formIsDirty() ?? false;
}

/// Fecha os formulários do cofre, pedindo confirmação se houver alterações.
/// Resolve true quando não sobrou formulário aberto (pode prosseguir) e false
/// quando o usuário preferiu continuar editando.
export function requestCloseVaultForms() {
  return activeController?.requestCloseForms() ?? Promise.resolve(true);
}

export function createVaultController({ invoke, showSnackbar, confirmAction }) {
  const state = {
    clients: [],
    accesses: [],
    selectedClientId: null,
    query: "",
    editingClientId: null,
    editingAccessId: null,
    revealTimers: new Map(),
    // Mensagem do backend quando o arquivo do cofre não pôde ser aberto.
    unavailable: null,
    // Guarda do "Salvar" do acesso: ligada antes de qualquer await.
    savingAccess: false,
    // Promessas dos "Salvar" em andamento (null quando parado). Fechar o
    // formulário espera por elas: limpá-lo no meio do salvamento gravava um
    // acesso vazio, e o fim do salvamento fecharia um formulário novo.
    accessSave: null,
    clientSave: null,
    // Conta as aberturas do formulário de acesso. A resposta de uma abertura
    // anterior (outro card clicado logo em seguida) é descartada.
    accessOpenToken: 0,
    // Valores dos formulários no momento em que abriram, para saber se há
    // alterações a perder.
    accessSnapshot: null,
    clientSnapshot: null,
    // Evita abrir duas confirmações de descarte ao mesmo tempo.
    confirmingClose: false,
    collapsedGroups: new Set(),
    // null = mostrar todos os acessos do cliente; "" = os que estão fora de
    // qualquer pasta; texto = o nome da pasta escolhida.
    selectedFolder: null,
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
    folders: document.querySelector("#vaultFolders"),
    accessFolder: document.querySelector("#vaultAccessFolder"),
    folderOptions: document.querySelector("#vaultFolderOptions"),
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
    return `${access.label}\n${access.folder ?? ""}\n${access.service}\n${access.url}\n${access.username}`
      .toLocaleLowerCase("pt-BR")
      .includes(query);
  }

  const clientTextMatches = (client, query) =>
    `${client.name}\n${client.notes}`.toLocaleLowerCase("pt-BR").includes(query);

  /// O cliente foi encontrado pelo nome/observações dele ou do responsável —
  /// nesse caso todos os acessos dele interessam, não só os que casam.
  function clientMatchedByName(client, query) {
    if (clientTextMatches(client, query)) return true;
    const parent = client.parent_id
      ? state.clients.find((item) => item.id === client.parent_id)
      : null;
    return Boolean(parent && clientTextMatches(parent, query));
  }

  function filteredClients() {
    if (!state.query) return [...state.clients].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
    return state.clients
      .filter(
        (client) =>
          clientTextMatches(client, state.query) ||
          clientAccesses(client.id).some((access) => accessMatches(access, state.query)),
      )
      .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
  }

  /// Ids que aparecem na lista lateral: os encontrados e, sob um responsável
  /// encontrado, todos os que ele agrupa (ver renderClientList).
  function listedClientIds() {
    const clients = filteredClients();
    const ids = new Set(clients.map((client) => client.id));
    if (state.query) {
      for (const client of clients) {
        childrenOf(client.id).forEach((child) => ids.add(child.id));
      }
    }
    return ids;
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
            <span class="vault-badges">
              <span class="vault-service-badge">${escapeHtml(service)}</span>
              ${
                // Vendo "Todos", a pasta diz de quem é o acesso — dentro de uma
                // pasta seria repetição.
                access.folder && state.selectedFolder === null
                  ? `<span class="vault-folder-badge"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>${escapeHtml(access.folder)}</span>`
                  : ""
              }
            </span>
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

  /// Pastas existentes no cliente, na ordem em que serão exibidas. São
  /// derivadas dos próprios acessos: criar uma pasta é só digitar o nome ao
  /// salvar um acesso, e ela some sozinha quando o último acesso sai dela.
  function foldersOf(accesses) {
    const counts = new Map();
    for (const access of accesses) {
      const name = access.folder || "";
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    const named = [...counts.entries()]
      .filter(([name]) => name)
      .sort((a, b) => a[0].localeCompare(b[0], "pt-BR"));
    const loose = counts.get("") ?? 0;
    return { named, loose, total: accesses.length };
  }

  function folderButton(label, value, count, icon = true) {
    // "Todos" é representado por null no estado, mas precisa de um valor no DOM.
    const current = state.selectedFolder === null ? "__all__" : state.selectedFolder;
    const active = current === value ? " active" : "";
    const folderIcon = icon
      ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/></svg>'
      : "";
    return `<button class="vault-folder${active}" type="button" data-folder="${escapeHtml(String(value))}" role="tab" aria-selected="${Boolean(active)}">
      ${folderIcon}<span>${escapeHtml(label)}</span><span class="vault-folder-count">${count}</span>
    </button>`;
  }

  function renderFolders(client, accesses) {
    const { named, loose, total } = foldersOf(accesses);
    // A pasta escolhida pode ter deixado de existir (o último acesso dela foi
    // movido ou excluído, ou a busca não deixou nenhum nela). Sem esta
    // revalidação a lista ficaria vazia com o cliente tendo acessos.
    const folderExists =
      state.selectedFolder === null ||
      (state.selectedFolder === ""
        ? loose > 0
        : named.some(([name]) => name === state.selectedFolder));
    if (!folderExists) state.selectedFolder = null;
    // Sem nenhuma pasta criada, a barra não aparece — quem não usa o recurso
    // não ganha uma linha a mais na tela.
    if (named.length === 0) {
      elements.folders.hidden = true;
      elements.folders.innerHTML = "";
      state.selectedFolder = null;
      return;
    }
    elements.folders.hidden = false;
    elements.folders.innerHTML = [
      folderButton("Todos", "__all__", total, false),
      ...named.map(([name, count]) => folderButton(name, name, count)),
      loose ? folderButton("Sem pasta", "", loose, false) : "",
    ].join("");
  }

  function renderSelectedClient() {
    const client = selectedClient();
    elements.empty.hidden = Boolean(client);
    elements.content.hidden = !client;
    if (!client) return;

    const allAccesses = clientAccesses(client.id);
    // Buscar pelo nome do cliente (ou do responsável) é querer ver o cliente
    // inteiro; o filtro por acesso só vale quando ele veio pelos acessos.
    const searched =
      state.query && !clientMatchedByName(client, state.query)
        ? allAccesses.filter((access) => accessMatches(access, state.query))
        : allAccesses;
    renderFolders(client, searched);
    const accesses =
      state.selectedFolder === null
        ? searched
        : searched.filter((access) => (access.folder || "") === state.selectedFolder);
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
    if (state.unavailable) {
      renderUnavailable();
      return;
    }
    renderClientList();
    renderSelectedClient();
  }

  // Botões que criam ou alteram algo no cofre: ficam desligados enquanto o
  // arquivo do cofre não puder ser aberto.
  const writeControls = [
    "#newVaultClient",
    "#emptyNewVaultClient",
    "#editVaultClient",
    "#deleteVaultClient",
    "#newVaultAccess",
    "#emptyNewVaultAccess",
  ]
    .map((selector) => document.querySelector(selector))
    .filter(Boolean);
  let unavailablePanel = null;

  /// Painel mostrado no lugar do conteúdo quando o backend responde "Cofre
  /// indisponível". Montado só com textContent: a mensagem vem do sistema.
  function ensureUnavailablePanel() {
    if (unavailablePanel) return unavailablePanel;
    const panel = document.createElement("div");
    panel.className = "vault-empty-state vault-unavailable";
    panel.setAttribute("role", "alert");
    panel.hidden = true;
    panel.innerHTML = `
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="10" width="16" height="11" rx="2" />
        <path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" />
      </svg>
      <h2>Cofre indisponível</h2>
      <p data-unavailable-text>O arquivo do cofre não pôde ser aberto agora. Seus dados foram preservados: nada foi apagado nem sobrescrito. Enquanto isso, não é possível ver, criar ou editar acessos. Feche e abra o Noast novamente; se continuar, confirme que está no mesmo usuário do Windows que criou o cofre.</p>
      <p data-unavailable-detail class="field-hint"></p>
      <button class="button secondary" type="button" data-unavailable-retry>Tentar novamente</button>`;
    panel.querySelector("[data-unavailable-retry]").addEventListener("click", async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        await load();
        if (state.unavailable) showSnackbar("O cofre continua indisponível.");
      } finally {
        button.disabled = false;
      }
    });
    elements.empty.parentElement.prepend(panel);
    unavailablePanel = panel;
    return panel;
  }

  function renderUnavailable() {
    const panel = ensureUnavailablePanel();
    const detail = panel.querySelector("[data-unavailable-detail]");
    detail.textContent = state.unavailable;
    panel.hidden = false;
    elements.empty.hidden = true;
    elements.content.hidden = true;
    elements.list.innerHTML = "";
    elements.listEmpty.hidden = true;
    elements.search.disabled = true;
    writeControls.forEach((control) => {
      control.disabled = true;
    });
  }

  function leaveUnavailable() {
    state.unavailable = null;
    if (unavailablePanel) unavailablePanel.hidden = true;
    elements.search.disabled = false;
    writeControls.forEach((control) => {
      control.disabled = false;
    });
  }

  const isUnavailableError = (error) =>
    normalizedError(error, "").trimStart().startsWith("Cofre indisponível");

  function selectClient(id) {
    const changed = id !== state.selectedClientId;
    state.selectedClientId = state.clients.some((client) => client.id === id) ? id : null;
    // As pastas são de cada cliente: manter o filtro ao trocar esconderia
    // acessos sem motivo aparente.
    if (changed) state.selectedFolder = null;
    render();
  }

  function closeClientModal() {
    elements.clientModal.hidden = true;
    state.editingClientId = null;
    state.clientSnapshot = null;
    elements.clientForm.reset();
    elements.clientError.textContent = "";
  }

  // Tudo o que o usuário pode alterar em cada formulário. Comparar com a foto
  // tirada na abertura diz se fechar perderia algo.
  const clientFormValues = () =>
    JSON.stringify([
      elements.clientNameInput.value,
      elements.clientParentInput.value,
      elements.clientNotesInput.value,
    ]);

  const accessFormValues = () =>
    JSON.stringify([
      elements.accessClient.value,
      elements.accessNewClientName.hidden,
      elements.accessNewClientName.value,
      elements.accessFolder.value,
      elements.accessLabel.value,
      elements.accessService.value,
      elements.accessCustomService.value,
      elements.accessUrl.value,
      elements.accessUsername.value,
      elements.accessRecovery.value,
      elements.accessPassword.value,
      elements.accessNotes.value,
    ]);

  const clientFormIsDirty = () =>
    !elements.clientModal.hidden &&
    state.clientSnapshot !== null &&
    clientFormValues() !== state.clientSnapshot;

  const accessFormIsDirty = () =>
    !elements.accessModal.hidden &&
    state.accessSnapshot !== null &&
    accessFormValues() !== state.accessSnapshot;

  /// Pergunta antes de descartar. Resolve true se pode fechar.
  async function confirmDiscard(what) {
    if (state.confirmingClose) return false;
    state.confirmingClose = true;
    try {
      return await confirmAction({
        dialogTitle: "Descartar alterações?",
        dialogMessage: `O que foi digitado ${what} ainda não foi salvo e será perdido.`,
        confirmLabel: "Descartar",
      });
    } finally {
      state.confirmingClose = false;
    }
  }

  /// Com um "Salvar" em andamento o formulário não pode ser limpo: espera o
  /// resultado. Deu certo, o próprio salvamento já fechou o formulário; deu
  /// errado, ele continua aberto com o erro à vista (resolve false).
  async function waitPendingSave(pending, modal) {
    try {
      await pending;
    } catch {
      // O erro já foi mostrado no formulário.
    }
    return modal.hidden;
  }

  async function requestCloseClientModal() {
    if (elements.clientModal.hidden) return true;
    if (state.clientSave) return waitPendingSave(state.clientSave, elements.clientModal);
    if (clientFormIsDirty() && !(await confirmDiscard("neste cliente"))) return false;
    // O "Salvar" pode ter começado enquanto a pergunta estava aberta.
    if (state.clientSave) return waitPendingSave(state.clientSave, elements.clientModal);
    closeClientModal();
    return true;
  }

  async function requestCloseAccessModal() {
    if (elements.accessModal.hidden) return true;
    if (state.accessSave) return waitPendingSave(state.accessSave, elements.accessModal);
    if (accessFormIsDirty() && !(await confirmDiscard("neste acesso"))) return false;
    if (state.accessSave) return waitPendingSave(state.accessSave, elements.accessModal);
    closeAccessModal();
    return true;
  }

  async function requestCloseForms() {
    // O acesso fica por cima quando os dois estão abertos: fecha-o primeiro.
    if (!(await requestCloseAccessModal())) return false;
    return requestCloseClientModal();
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

  /// `parentId` só é passado por uma ação explícita de "novo cliente dentro
  /// deste". O "Novo cliente" comum (cabeçalho, Ctrl+N) nasce sem responsável:
  /// herdar o cliente aberto o transformava em filho sem o usuário perceber.
  function openClientModal(client = null, { parentId = "" } = {}) {
    if (state.unavailable || state.clientSave) return;
    state.editingClientId = client?.id ?? null;
    elements.clientModalTitle.textContent = client ? "Editar cliente" : "Novo cliente";
    elements.clientNameInput.value = client?.name ?? "";
    elements.clientNotesInput.value = client?.notes ?? "";
    fillParentOptions(client);
    const parentAllowed =
      parentId && [...elements.clientParentInput.options].some((option) => option.value === parentId);
    if (!client && parentAllowed) elements.clientParentInput.value = parentId;
    elements.clientError.textContent = "";
    state.clientSnapshot = clientFormValues();
    elements.clientModal.hidden = false;
    window.setTimeout(() => elements.clientNameInput.focus(), 50);
  }

  async function saveClient(event) {
    event.preventDefault();
    // Cada entrada gera um id novo: sem esta guarda, um clique duplo cadastra
    // o mesmo cliente duas vezes.
    const submitButton = elements.clientForm.querySelector('button[type="submit"]');
    if (submitButton.disabled || state.clientSave) return;

    // Tudo é lido do formulário aqui, antes de qualquer await.
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
    const pending = submitClient(client, current);
    state.clientSave = pending;
    try {
      await pending;
    } finally {
      state.clientSave = null;
      submitButton.disabled = false;
    }
  }

  async function submitClient(client, current) {
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
    // Uma abertura ainda esperando o backend não deve reabrir o formulário.
    state.accessOpenToken += 1;
    elements.accessModal.hidden = true;
    state.editingAccessId = null;
    state.accessSnapshot = null;
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

  /// Sugere as pastas já usadas em todo o cofre — inclusive as de outros
  /// clientes, porque o mesmo nome costuma se repetir entre eles.
  function fillFolderSuggestions() {
    const names = [...new Set(state.accesses.map((access) => access.folder).filter(Boolean))].sort(
      (a, b) => a.localeCompare(b, "pt-BR"),
    );
    elements.folderOptions.innerHTML = names
      .map((name) => `<option value="${escapeHtml(name)}"></option>`)
      .join("");
  }

  function hideNewClientField() {
    elements.accessNewClientName.hidden = true;
    elements.accessNewClientName.value = "";
    elements.accessClient.disabled = false;
    elements.accessNewClient.textContent = "Novo cliente";
  }

  async function openAccessModal(accessId = null) {
    const client = selectedClient();
    if (!client || state.unavailable || state.accessSave) return;
    // Dois "Editar" seguidos disparam duas leituras, e a do primeiro card pode
    // chegar por último: só a abertura mais recente preenche o formulário.
    const token = ++state.accessOpenToken;
    state.editingAccessId = accessId;
    elements.accessModalTitle.textContent = accessId ? "Editar acesso" : "Novo acesso";
    elements.accessForm.reset();
    elements.accessError.textContent = "";
    setPasswordVisibility(false);
    setServiceValue("");
    fillAccessClientOptions(client.id);
    fillFolderSuggestions();
    // Criar um acesso com uma pasta aberta já entra nela.
    elements.accessFolder.value = accessId ? "" : (state.selectedFolder ?? "");

    if (accessId) {
      try {
        const access = await invoke("get_vault_access", { id: accessId });
        if (token !== state.accessOpenToken) return;
        fillAccessClientOptions(access.client_id);
        elements.accessFolder.value = access.folder ?? "";
        elements.accessLabel.value = access.label;
        setServiceValue(access.service);
        elements.accessUrl.value = access.url;
        elements.accessUsername.value = access.username;
        elements.accessRecovery.value = access.recovery_email;
        elements.accessPassword.value = access.password;
        elements.accessNotes.value = access.notes;
      } catch (error) {
        if (token === state.accessOpenToken) {
          showSnackbar(normalizedError(error, "Não foi possível abrir o acesso."));
        }
        return;
      }
    }
    state.accessSnapshot = accessFormValues();
    elements.accessModal.hidden = false;
    window.setTimeout(() => {
      elements.accessLabel.focus();
      updateAccessScrollbar();
    }, 50);
  }

  async function saveAccess(event) {
    event.preventDefault();
    // Mesma proteção do cliente: sem ela, um clique duplo grava duas cópias da
    // credencial (com ids diferentes) — e, com "Novo cliente", dois clientes.
    // A guarda liga antes do primeiro await; ligá-la depois deixava o segundo
    // clique passar enquanto o primeiro ainda esperava o backend.
    const submitButton = elements.accessForm.querySelector('button[type="submit"]');
    if (state.savingAccess || state.unavailable) return;
    state.savingAccess = true;
    submitButton.disabled = true;
    // A foto do formulário é tirada aqui, de forma síncrona: daqui em diante
    // só ela é usada. Ler os campos depois de um await gravava o que o
    // formulário tivesse no momento — vazio, se tivesse sido limpo no meio.
    const pending = submitAccess(accessFormSnapshot());
    state.accessSave = pending;
    try {
      await pending;
    } finally {
      state.accessSave = null;
      state.savingAccess = false;
      submitButton.disabled = false;
    }
  }

  function accessFormSnapshot() {
    return {
      client: selectedClient(),
      editingAccessId: state.editingAccessId,
      clientId: elements.accessClient.value,
      creatingClient: !elements.accessNewClientName.hidden,
      newClientName: elements.accessNewClientName.value.trim(),
      folder: elements.accessFolder.value.trim(),
      label: elements.accessLabel.value.trim(),
      service: selectedServiceValue(),
      url: elements.accessUrl.value.trim(),
      username: elements.accessUsername.value.trim(),
      password: elements.accessPassword.value,
      recovery_email: elements.accessRecovery.value.trim(),
      notes: elements.accessNotes.value.trim(),
    };
  }

  async function submitAccess(form) {
    const { client, label } = form;
    if (!client) return;
    if (!label) {
      elements.accessError.textContent = "Informe o nome do acesso.";
      return;
    }
    if (form.creatingClient && !form.newClientName) {
      elements.accessError.textContent = "Informe o nome do novo cliente.";
      return;
    }
    let current = null;
    if (form.editingAccessId) {
      try {
        current = await invoke("get_vault_access", { id: form.editingAccessId });
      } catch (error) {
        elements.accessError.textContent = normalizedError(error, "Não foi possível carregar o acesso.");
        return;
      }
    }
    // Cliente escolhido no próprio formulário: permite mover um acesso de um
    // cliente para outro sem recriá-lo, e criar o cliente aqui mesmo.
    let clientId = form.clientId;
    if (form.creatingClient) {
      const newClientName = form.newClientName;
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
        // Daqui em diante o cliente já existe: o formulário passa a apontá-lo
        // como cliente escolhido. Se salvar o acesso falhar logo abaixo, a
        // nova tentativa usa este cliente em vez de criar outro igual.
        fillAccessClientOptions(created.id);
        renderClientList();
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
      folder: form.folder,
      label,
      service: form.service,
      url: form.url,
      username: form.username,
      password: form.password,
      recovery_email: form.recovery_email,
      notes: form.notes,
      created_at: current?.created_at ?? "",
      updated_at: current?.updated_at ?? "",
    };
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

  /// Toda cópia de credencial passa pelo backend: ele marca o conteúdo para
  /// não entrar no histórico do Win+V nem na sincronização na nuvem e o limpa
  /// após 30 s — só se ainda for o que copiamos, sem apagar o que o usuário
  /// copiou depois. Feito em JS, a limpeza falhava com a janela sem foco.
  async function copySecret(value, label) {
    try {
      await invoke("copy_secret", { value });
      showSnackbar(`${label} copiad${label === "Senha" ? "a" : "o"}. A área de transferência será limpa em 30 segundos.`);
    } catch (error) {
      showSnackbar(normalizedError(error, "Não foi possível copiar."));
    }
  }

  /// Texto selecionado dentro de um campo de texto, ou "" se não houver.
  function selectedFieldText(input) {
    const { selectionStart: start, selectionEnd: end } = input;
    if (start === null || end === null || end <= start) return "";
    return input.value.slice(start, end);
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
      if (state.unavailable) leaveUnavailable();
      state.clients = catalog.clients;
      state.accesses = catalog.accesses;
      state.selectedClientId = [...state.clients].sort((a, b) => a.name.localeCompare(b.name, "pt-BR"))[0]?.id ?? null;
      state.selectedFolder = null;
      render();
    } catch (error) {
      if (isUnavailableError(error)) {
        // Só o cofre fica fora do ar; o resto do app segue funcionando.
        state.unavailable = normalizedError(error, "Cofre indisponível.");
        state.clients = [];
        state.accesses = [];
        state.selectedClientId = null;
        closeAccessModal();
        closeClientModal();
        render();
        return;
      }
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

  // Cancelar, o X e o clique fora pedem confirmação se houver algo digitado.
  document.querySelectorAll("[data-close-vault-client]").forEach((button) => {
    button.addEventListener("click", () => requestCloseClientModal());
  });
  document.querySelectorAll("[data-close-vault-access]").forEach((button) => {
    button.addEventListener("click", () => requestCloseAccessModal());
  });

  elements.clientModal.addEventListener("click", (event) => {
    if (event.target === elements.clientModal) requestCloseClientModal();
  });
  elements.accessModal.addEventListener("click", (event) => {
    if (event.target === elements.accessModal) requestCloseAccessModal();
  });

  elements.search.addEventListener("input", (event) => {
    state.query = event.target.value.trim().toLocaleLowerCase("pt-BR");
    const listed = listedClientIds();
    const keep = listed.has(state.selectedClientId);
    // selectClient zera o filtro de pasta quando o cliente muda; trocar o id
    // direto herdava a pasta do cliente anterior.
    selectClient(keep ? state.selectedClientId : (filteredClients()[0]?.id ?? null));
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

  elements.folders.addEventListener("click", (event) => {
    const button = event.target.closest("[data-folder]");
    if (!button) return;
    const value = button.dataset.folder;
    state.selectedFolder = value === "__all__" ? null : value;
    renderSelectedClient();
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
    if (action === "copy-user") await copySecret(access.username, "Usuário");
    if (action === "copy-password") {
      try {
        const complete = await fullAccess(access.id);
        await copySecret(complete.password, "Senha");
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

  // Ctrl+C (ou recortar) no campo de senha também vai pelo copy_secret: pela
  // área de transferência comum a senha gerada ficaria no histórico do Win+V
  // e nunca seria limpa.
  elements.accessPassword.addEventListener("copy", (event) => {
    const selected = selectedFieldText(elements.accessPassword);
    if (!selected) return;
    event.preventDefault();
    copySecret(selected, "Senha");
  });
  elements.accessPassword.addEventListener("cut", (event) => {
    const input = elements.accessPassword;
    const selected = selectedFieldText(input);
    if (!selected) return;
    event.preventDefault();
    copySecret(selected, "Senha");
    input.setRangeText("", input.selectionStart, input.selectionEnd, "end");
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });

  // O mesmo para a senha revelada num card, se o usuário a selecionar e copiar.
  elements.accessList.addEventListener("copy", (event) => {
    const selection = document.getSelection();
    const text = selection?.toString() ?? "";
    if (!text || !selection.rangeCount) return;
    const node = selection.getRangeAt(0).commonAncestorContainer;
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const revealed = element?.closest("[data-password-value]");
    if (!revealed || revealed.classList.contains("vault-password-mask")) return;
    event.preventDefault();
    copySecret(text, "Senha");
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
    // O Esc que fecha o diálogo de confirmação chega aqui já tratado; sem esta
    // checagem ele reabriria a pergunta.
    if (event.key !== "Escape" || event.defaultPrevented || state.confirmingClose) return;
    if (!elements.accessModal.hidden) requestCloseAccessModal();
    else if (!elements.clientModal.hidden) requestCloseClientModal();
  });

  const controller = {
    load,
    activate() {
      if (state.unavailable) return;
      if (!selectedClient() && state.clients.length) {
        selectClient(filteredClients()[0]?.id ?? null);
      }
    },
    createClient() {
      if (state.unavailable) {
        showSnackbar("O cofre está indisponível no momento.");
        return;
      }
      // Ctrl+N com um formulário aberto não empilha outro por baixo dele.
      if (!elements.accessModal.hidden || !elements.clientModal.hidden) return;
      openClientModal();
    },
    /// Há formulário do cofre aberto com alterações não salvas?
    formIsDirty() {
      return accessFormIsDirty() || clientFormIsDirty();
    },
    /// Fecha os formulários, confirmando o descarte se preciso. Resolve true
    /// quando nenhum ficou aberto.
    requestCloseForms,
    /// Esconde as senhas reveladas e fecha os formulários sem alterações.
    /// Formulário com alterações nunca é descartado aqui: fica aberto (com a
    /// senha mascarada) para o usuário decidir ao voltar. Para fechar
    /// perguntando, use requestCloseForms antes.
    deactivate() {
      hideRevealedPasswords();
      // Formulário salvando também fica: o fim do salvamento o fecha.
      if (accessFormIsDirty() || state.accessSave) setPasswordVisibility(false);
      else closeAccessModal();
      if (!clientFormIsDirty() && !state.clientSave) closeClientModal();
    },
  };
  activeController = controller;
  return controller;
}
