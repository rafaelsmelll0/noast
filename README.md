# Noast

Noast é um aplicativo leve de lembretes para Windows, feito com Tauri 2, Rust e
HTML/CSS/JavaScript sem framework.

O aplicativo permanece na bandeja do sistema, verifica lembretes em segundo
plano e apresenta uma janela compacta com ações para concluir ou adiar.

## Instalação

Baixe o instalador mais recente em
[Releases](https://github.com/rafaelsmelll0/noast/releases/latest)
(`Noast_<versão>_x64-setup.exe`) e execute.

A partir da versão 0.5.8 o Noast se atualiza sozinho: ao abrir, ele verifica se
há versão nova publicada nos Releases e, havendo, baixa e instala. O andamento
fica registrado no log do aplicativo.

## Recursos

- Lembretes únicos ou recorrentes
- Repetição diária, semanal, quinzenal, mensal e anual
- Recuperação de lembretes vencidos enquanto o computador estava desligado
- Filtros de próximos, atrasados e concluídos
- Busca e filtro de recorrentes
- Notas locais com pesquisa, fixação e salvamento automático
- Formatação compatível com WhatsApp e visualização antes de copiar
- Cofre local de credenciais por cliente, protegido pela DPAPI do Windows
- Gerador de senhas e limpeza automática do clipboard
- Adiamento individual ou em lote
- Inicialização opcional com o Windows
- Tema claro, escuro ou igual ao sistema
- Som de notificação opcional
- Alertas no monitor principal ou no monitor onde está o cursor
- Ação configurável ao clicar no ícone da bandeja
- Persistência local com gravação atômica e backup

## Desenvolvimento

Requisitos:

- Node.js 20 ou mais recente
- Rust estável
- Microsoft Edge WebView2
- Ferramentas de compilação do Visual Studio para C++

Instale as dependências:

```powershell
npm install
```

Execute em desenvolvimento:

```powershell
npm run tauri dev
```

O arquivo `dev.bat` encerra processos de desenvolvimento antigos antes de
iniciar uma nova sessão.

## Verificação

Toda a suíte (lógica de agendamento em Rust e formatação de notas em JS):

```powershell
npm run test:all
```

Separadamente:

```powershell
npm test           # node --test tests/
npm run test:rust  # cargo test
```

Os testes do agendador usam um simulador de tempo: avançam um relógio virtual
por semanas para validar o que dispara, avança, adia e reagenda — sem esperar.

Verificações adicionais:

```powershell
cd src-tauri
cargo fmt --check
cargo clippy --all-targets -- -D warnings
```

## Build

Executável sem instalador:

```powershell
npm run tauri build -- --no-bundle
```

Instalador NSIS:

```powershell
npm run tauri build
```

## Publicação de uma nova versão

O aplicativo instalado descobre atualizações lendo `latest.json` do release mais
recente. Para publicar:

1. Suba a versão nos três arquivos: `package.json`, `src-tauri/Cargo.toml` e
   `src-tauri/tauri.conf.json` (a tag do release deve ser `v<versão>`).
2. Gere o instalador **assinado** — sem a chave privada o updater rejeita o
   pacote:

   ```powershell
   $env:TAURI_SIGNING_PRIVATE_KEY = Get-Content "$env:USERPROFILE\.tauri\noast.key" -Raw
   $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ""
   npm run tauri build
   ```

3. Publique o instalador, o `.sig` e o `latest.json` no release:

   ```powershell
   gh release create v<versão> `
     "src-tauri\target\release\bundle\nsis\Noast_<versão>_x64-setup.exe" `
     "latest.json" `
     --title "v<versão>" --notes "Descreva as mudanças."
   ```

O `latest.json` aponta a versão, a URL do instalador e a assinatura do `.sig`.

> A chave privada fica em `%USERPROFILE%\.tauri\noast.key` e **nunca** deve ser
> versionada. Sem ela não é possível publicar atualizações que o aplicativo
> aceite.

## Dados

Em desenvolvimento, os lembretes ficam em `noast_data.json` na raiz do
projeto. Notas, configurações e logs ficam no diretório local de dados do
aplicativo; em produção, os lembretes também usam esse diretório.

Cada gravação mantém a versão anterior em um arquivo `.bak`. Caso um JSON
inválido não possa ser recuperado pelo backup, ele é preservado com a extensão
`.corrupt-<data>.json`.

## Estrutura

- `src/`: janelas principal e de alerta
- `src-tauri/src/model.rs`: modelos e validação
- `src-tauri/src/repository.rs`: persistência e logs
- `src-tauri/src/scheduler.rs`: cálculo de vencimento e recorrência
- `src-tauri/src/lib.rs`: comandos, janelas, tray e ciclo da aplicação
