# Noast no celular — plano

Objetivo: receber os alertas do Noast no Android como notificação do sistema e
poder ler, cadastrar e editar pelo celular. Decisão tomada: **sincronizar por um
servidor na nuvem**, para funcionar longe de casa e com o PC desligado.

Este documento é o plano; nada aqui está implementado ainda.

## Por que um servidor muda tudo

Hoje os dados vivem em arquivos locais (`noast_data.json`, `notes.json`,
`vault.dat`) e o agendador roda dentro do app. Só isso já entrega o desktop.

Para o celular tocar um lembrete às 9h **sem depender do PC**, alguém precisa
saber a hora do lembrete e avisar o aparelho. Esse "alguém" é o servidor. Ele
passa a ser a fonte da verdade, e o desktop deixa de ser o dono dos dados para
virar mais um cliente.

Consequência importante: aparece um problema que hoje não existe — **conflito**.
Editar o mesmo lembrete no PC e no celular enquanto um deles está offline exige
uma regra de desempate.

## Arquitetura proposta

```
   PC (Tauri)                Servidor                  Android (Tauri)
  ┌──────────┐            ┌────────────┐              ┌──────────────┐
  │ lembretes│◄──sync────►│  API REST  │◄────sync────►│  lembretes   │
  │ notas    │            │  + agenda  │              │  notas       │
  │ cofre    │            └─────┬──────┘              └──────────────┘
  └──────────┘                  │                            ▲
                                └────── push (FCM) ──────────┘
```

- **API REST**: CRUD de lembretes e notas + autenticação.
- **Agendador no servidor**: quando um lembrete vence, dispara um push.
- **FCM (Firebase Cloud Messaging)**: entrega a notificação ao aparelho. Gratuito.
- **App Android em Tauri 2**: reaproveita o frontend atual (HTML/CSS/JS).

### Escolhas técnicas sugeridas

| Peça | Sugestão | Por quê |
| --- | --- | --- |
| Servidor | Rust + Axum | Mesma linguagem do backend atual; dá para reusar `scheduler.rs` inteiro |
| Banco | SQLite (litefs) ou Postgres | Volume é pequeno; SQLite basta |
| Hospedagem | Fly.io / Railway | Plano gratuito suficiente para uso pessoal |
| Push | FCM | Padrão do Android, gratuito |
| App | Tauri 2 Android | Reusa o frontend; evita reescrever a UI |

O `scheduler.rs` já é lógica pura e testada (25 testes) — ele roda igual no
servidor. Esse é o maior ativo que temos para essa migração.

## Fases

### Fase 1 — Servidor e sincronização de lembretes
- API com autenticação (uso pessoal: uma conta basta)
- Modelo de sincronização com `updated_at` e resolução de conflito
  (regra inicial: a edição mais recente vence)
- Desktop passa a sincronizar em segundo plano, **sem perder o modo offline**
- Entrega: os lembretes do PC existem no servidor

### Fase 2 — App Android
- Build Tauri para Android (exige Android SDK + NDK + JDK)
- Notificação local agendada, para tocar mesmo sem internet no momento
- Push (FCM) para lembretes criados em outro dispositivo
- Ler, criar e editar lembretes e notas
- Entrega: o Noast no celular, com notificação padrão do Android

### Fase 3 — Cofre no celular (decidir depois)
Só entra se o item de segurança abaixo for resolvido.

## Riscos e pontos de atenção

**O cofre é o ponto mais delicado.** Hoje as senhas são cifradas pela DPAPI do
Windows: só a sua conta do Windows abre aquele arquivo, e ele nunca sai da
máquina. Colocar isso na nuvem remove essa proteção. Só faz sentido com
criptografia ponta a ponta: o servidor guardaria bytes que ele mesmo não
consegue ler, e uma **senha mestra** (que não vai para o servidor) abriria o
cofre em cada aparelho. Se a senha mestra for perdida, os dados são
irrecuperáveis — não existe "esqueci minha senha".

Por isso a recomendação é **deixar o cofre de fora nas fases 1 e 2**.

**Outros pontos:**
- *Entrega de notificação*: Android mata apps em segundo plano (Doze). Alertas
  confiáveis exigem push de alta prioridade e, para o formato "alarme em tela
  cheia", a permissão `USE_FULL_SCREEN_INTENT` — que o Google audita.
- *Ligação telefônica*: descartada. Exige permissões sensíveis e reprovação na
  loja é provável. O substituto é a notificação em tela cheia, que toca e ocupa
  a tela como um despertador.
- *Distribuição*: instalar o APK direto no aparelho não custa nada. Publicar na
  Play Store custa US$ 25 (pagamento único) e passa por revisão.
- *Custo corrente*: os planos gratuitos de Fly.io/Railway atendem uso pessoal,
  mas exigem manutenção (o serviço é seu agora).
- *Fuso horário*: os horários hoje são "naive" (sem fuso). Com servidor no meio,
  isso precisa virar UTC + fuso do usuário, senão um lembrete toca na hora
  errada quando você viaja.

## Esforço estimado

| Fase | Estimativa |
| --- | --- |
| 1 — Servidor + sync | ~1 semana de trabalho focado |
| 2 — App Android | ~1 a 2 semanas |
| 3 — Cofre E2E | ~1 semana |

São estimativas de desenvolvimento, sem contar a validação em uso real.

## Pré-requisitos para começar a fase 2

- Android Studio (SDK + NDK) e JDK 17 instalados
- Conta no Firebase (para o FCM)
- Aparelho Android para testes com depuração USB
