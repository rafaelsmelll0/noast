# Noast

Noast é um aplicativo leve de lembretes para Windows, feito com Tauri 2, Rust e
HTML/CSS/JavaScript sem framework.

O aplicativo permanece na bandeja do sistema, verifica lembretes em segundo
plano e apresenta uma janela compacta com ações para concluir ou adiar.

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

```powershell
cd src-tauri
cargo fmt --check
cargo test
cargo clippy --all-targets -- -D warnings
```

Para validar os scripts:

```powershell
node --check src/main.js
node --check src/alert.js
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
