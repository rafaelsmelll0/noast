use chrono::{Datelike, Duration, NaiveDate, NaiveDateTime, Timelike};

use crate::model::{Notification, Repeat};

pub fn occurrence_key(datetime: &NaiveDateTime) -> String {
    datetime.format("%Y-%m-%dT%H:%M").to_string()
}

pub fn is_due(notification: &Notification, now: NaiveDateTime, include_fired: bool) -> bool {
    if notification.done {
        return false;
    }
    let Ok(datetime) = notification.parsed_datetime() else {
        return false;
    };
    if datetime > now {
        return false;
    }
    include_fired || notification.last_fired != occurrence_key(&datetime)
}

pub fn advance_after(notification: &mut Notification, now: NaiveDateTime) -> Result<(), String> {
    if notification.repeat == Repeat::None {
        notification.done = true;
        return Ok(());
    }

    // Parte do horário da série, não de onde o lembrete foi parar por
    // adiamento: concluir um "toda terça 9h" adiado para quinta mantém a
    // série na terça. O laço avança quantas ocorrências forem necessárias,
    // então adiar além da próxima terça também cai na terça seguinte.
    let anchor = notification.series_anchor()?;
    let day = if notification.series_day > 0 {
        notification.series_day
    } else {
        anchor.day()
    };
    let mut datetime = skip_whole_periods(anchor, notification.repeat, now);
    let mut guard = 0;
    while datetime <= now {
        datetime = next_occurrence_on_day(datetime, notification.repeat, day);
        guard += 1;
        if guard > 100_000 {
            return Err("Não foi possível calcular a próxima ocorrência.".to_string());
        }
    }

    notification.datetime = datetime.format("%Y-%m-%dT%H:%M:%S").to_string();
    notification.series_day = match notification.repeat {
        Repeat::Monthly | Repeat::Yearly => day,
        _ => 0,
    };
    notification.series_datetime.clear();
    notification.done = false;
    notification.last_fired.clear();
    Ok(())
}

pub fn snooze(notification: &mut Notification, minutes: u32, now: NaiveDateTime) {
    notification.remember_series_anchor();
    // Minuto cheio: o formulário edita só HH:MM, e segundos no horário faziam
    // uma edição de texto parecer troca de data (e soltar a série).
    let target = now + Duration::minutes(i64::from(minutes));
    notification.datetime = target
        .with_second(0)
        .unwrap_or(target)
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    notification.done = false;
    notification.last_fired.clear();
}

pub fn snooze_until_tomorrow(
    notification: &mut Notification,
    now: NaiveDateTime,
) -> Result<(), String> {
    // Horário da série, não o do adiamento: "toda terça 9h" adiado para 9h15 e
    // depois para amanhã deve tocar amanhã às 9h.
    let original = notification.series_anchor()?;
    notification.remember_series_anchor();
    let tomorrow = now.date() + Duration::days(1);
    notification.datetime = tomorrow
        .and_time(original.time())
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    notification.done = false;
    notification.last_fired.clear();
    Ok(())
}

pub fn reschedule_to(
    notification: &mut Notification,
    target: NaiveDateTime,
    now: NaiveDateTime,
) -> Result<(), String> {
    if target <= now {
        return Err("Escolha uma data e hora no futuro.".to_string());
    }
    // Reagendar pelo toast é um adiamento pontual: a série continua no horário
    // programado (editar o lembrete na janela principal é que a redefine).
    notification.remember_series_anchor();
    notification.datetime = target.format("%Y-%m-%dT%H:%M:%S").to_string();
    notification.done = false;
    notification.last_fired.clear();
    Ok(())
}

/// Mesmo horário para o formulário, que só edita até o minuto: lembretes
/// adiados por versões antigas guardavam segundos.
fn same_minute(left: &str, right: &str) -> bool {
    left.get(..16)
        .is_some_and(|prefix| Some(prefix) == right.get(..16))
}

/// Lembrete novo vindo do formulário: nada do que o agendador sabe vale.
pub fn prepare_new(mut notification: Notification) -> Notification {
    notification.done = false;
    notification.last_fired.clear();
    notification.series_datetime.clear();
    notification.series_day = 0;
    notification
}

/// Aplica a edição do formulário sobre o lembrete salvo. Devolve `true` quando
/// só o texto mudou (mesmo horário, mesma repetição): aí o lembrete mantém tudo
/// que o agendador sabe dele — disparo, horário oficial da série (um
/// recorrente adiado continua voltando ao horário original) e dia da série.
/// O formulário não conhece esses campos, então nunca os sobrescreve.
pub fn apply_edit(existing: &mut Notification, mut incoming: Notification) -> bool {
    let kept =
        same_minute(&existing.datetime, &incoming.datetime) && existing.repeat == incoming.repeat;
    if kept {
        existing.text = incoming.text;
        return true;
    }
    // Data ou repetição novas: a âncora antiga da série não vale mais. Só a
    // hora mudou (mesmo dia, mesma repetição): o dia pretendido da série
    // mensal continua valendo — um "todo dia 31" parado em 28/02 não pode
    // virar "dia 28".
    let same_day = existing.datetime.get(..10).is_some()
        && existing.datetime.get(..10) == incoming.datetime.get(..10)
        && existing.repeat == incoming.repeat;
    incoming.series_day = if same_day { existing.series_day } else { 0 };
    incoming.done = false;
    incoming.last_fired.clear();
    incoming.series_datetime.clear();
    *existing = incoming;
    false
}

#[cfg(test)]
fn next_occurrence(datetime: NaiveDateTime, repeat: Repeat) -> NaiveDateTime {
    next_occurrence_on_day(datetime, repeat, datetime.day())
}

/// Próxima ocorrência mirando `day` nas séries mensais/anuais (limitado ao
/// último dia do mês); as de período fixo ignoram o dia.
fn next_occurrence_on_day(datetime: NaiveDateTime, repeat: Repeat, day: u32) -> NaiveDateTime {
    match repeat {
        Repeat::Daily => datetime + Duration::days(1),
        Repeat::Weekly => datetime + Duration::weeks(1),
        Repeat::Biweekly => datetime + Duration::weeks(2),
        Repeat::Monthly => {
            let zero_based = datetime.month0() + 1;
            let year = datetime.year() + (zero_based / 12) as i32;
            build_clamped(datetime, year, zero_based % 12 + 1, day)
        }
        Repeat::Yearly => build_clamped(datetime, datetime.year() + 1, datetime.month(), day),
        Repeat::None => datetime,
    }
}

/// Pula de uma vez os períodos inteiros já vencidos das séries de período
/// fixo: uma âncora com o ano digitado errado (décadas atrás) não pode
/// esgotar o laço de `advance_after` e travar a conclusão.
fn skip_whole_periods(anchor: NaiveDateTime, repeat: Repeat, now: NaiveDateTime) -> NaiveDateTime {
    let period = match repeat {
        Repeat::Daily => Duration::days(1),
        Repeat::Weekly => Duration::weeks(1),
        Repeat::Biweekly => Duration::weeks(2),
        _ => return anchor,
    };
    if anchor > now {
        return anchor;
    }
    let behind = (now - anchor).num_seconds() / period.num_seconds();
    let skip = i32::try_from(behind.saturating_sub(1)).unwrap_or(i32::MAX);
    anchor.checked_add_signed(period * skip).unwrap_or(anchor)
}

fn build_clamped(source: NaiveDateTime, year: i32, month: u32, day: u32) -> NaiveDateTime {
    let day = day.clamp(1, days_in_month(year, month));
    NaiveDate::from_ymd_opt(year, month, day)
        .expect("valid clamped date")
        .and_hms_opt(source.hour(), source.minute(), source.second())
        .expect("valid source time")
}

fn days_in_month(year: i32, month: u32) -> u32 {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let next = NaiveDate::from_ymd_opt(next_year, next_month, 1).expect("valid month");
    (next - Duration::days(1)).day()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at(value: &str) -> NaiveDateTime {
        NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S").expect("datetime")
    }

    #[test]
    fn monthly_repeat_clamps_to_last_day() {
        assert_eq!(
            next_occurrence(at("2025-01-31T09:30:00"), Repeat::Monthly),
            at("2025-02-28T09:30:00")
        );
        assert_eq!(
            next_occurrence(at("2024-01-31T09:30:00"), Repeat::Monthly),
            at("2024-02-29T09:30:00")
        );
    }

    #[test]
    fn yearly_repeat_clamps_leap_day() {
        assert_eq!(
            next_occurrence(at("2024-02-29T10:00:00"), Repeat::Yearly),
            at("2025-02-28T10:00:00")
        );
    }

    #[test]
    fn due_check_respects_last_fired_except_during_recovery() {
        let notification = Notification {
            id: "1".into(),
            text: "Teste".into(),
            datetime: "2026-01-10T10:00:00".into(),
            repeat: Repeat::None,
            done: false,
            last_fired: "2026-01-10T10:00".into(),
            series_datetime: String::new(),
            series_day: 0,
        };
        let now = at("2026-01-10T10:01:00");
        assert!(!is_due(&notification, now, false));
        assert!(is_due(&notification, now, true));
    }

    #[test]
    fn recurring_notification_advances_past_now() {
        let mut notification = Notification {
            id: "1".into(),
            text: "Teste".into(),
            datetime: "2026-01-01T10:00:00".into(),
            repeat: Repeat::Daily,
            done: false,
            last_fired: "2026-01-01T10:00".into(),
            series_datetime: String::new(),
            series_day: 0,
        };
        advance_after(&mut notification, at("2026-01-03T12:00:00")).expect("advance");
        assert_eq!(notification.datetime, "2026-01-04T10:00:00");
        assert!(notification.last_fired.is_empty());
    }

    #[test]
    fn snooze_tomorrow_preserves_original_time() {
        let mut notification = Notification {
            id: "1".into(),
            text: "Teste".into(),
            datetime: "2026-06-13T08:45:00".into(),
            repeat: Repeat::None,
            done: false,
            last_fired: "2026-06-13T08:45".into(),
            series_datetime: String::new(),
            series_day: 0,
        };
        snooze_until_tomorrow(&mut notification, at("2026-06-13T22:10:00"))
            .expect("snooze tomorrow");
        assert_eq!(notification.datetime, "2026-06-14T08:45:00");
        assert!(notification.last_fired.is_empty());
    }

    #[test]
    fn reschedule_rejects_past_and_sets_future() {
        let mut notification = Notification {
            id: "1".into(),
            text: "Teste".into(),
            datetime: "2026-06-13T08:45:00".into(),
            repeat: Repeat::None,
            done: false,
            last_fired: "2026-06-13T08:45".into(),
            series_datetime: String::new(),
            series_day: 0,
        };
        let now = at("2026-06-13T22:10:00");
        assert!(reschedule_to(&mut notification, at("2026-06-13T20:00:00"), now).is_err());
        reschedule_to(&mut notification, at("2026-06-15T09:00:00"), now).expect("reschedule");
        assert_eq!(notification.datetime, "2026-06-15T09:00:00");
        assert!(notification.last_fired.is_empty());
        assert!(!notification.done);
    }

    // ---------------------------------------------------------------------
    // Simulador de tempo: reproduz o loop real do scheduler avançando um
    // relógio virtual, para validar de forma determinística o que dispara,
    // avança, adia e reagenda ao longo de dias/semanas — sem esperar de verdade.
    // ---------------------------------------------------------------------

    fn note(id: &str, datetime: &str, repeat: Repeat) -> Notification {
        Notification {
            id: id.into(),
            text: id.into(),
            datetime: datetime.into(),
            repeat,
            done: false,
            last_fired: String::new(),
            series_datetime: String::new(),
            series_day: 0,
        }
    }

    // 2026-07-07 é uma terça-feira; usada como âncora nos testes de série.
    #[test]
    fn snoozing_a_weekly_keeps_the_series_on_the_original_slot() {
        let mut weekly = note("semanal", "2026-07-07T09:00:00", Repeat::Weekly);

        // Adiado três vezes ao longo da terça, terminando às 14h.
        snooze(&mut weekly, 60, at("2026-07-07T09:05:00"));
        snooze(&mut weekly, 60, at("2026-07-07T10:10:00"));
        snooze(&mut weekly, 180, at("2026-07-07T11:15:00"));
        assert_eq!(weekly.datetime, "2026-07-07T14:15:00");
        // A âncora da série permanece na terça 9h, mesmo após vários adiamentos.
        assert_eq!(weekly.series_datetime, "2026-07-07T09:00:00");

        advance_after(&mut weekly, at("2026-07-07T14:20:00")).expect("advance");
        // Próxima terça, 9h — e não terça 14h15.
        assert_eq!(weekly.datetime, "2026-07-14T09:00:00");
        assert!(weekly.series_datetime.is_empty());
    }

    // Caso-limite: adiar tanto que passa da próxima ocorrência programada.
    #[test]
    fn snoozing_past_the_next_occurrence_skips_to_a_future_one() {
        let mut weekly = note("semanal", "2026-07-07T09:00:00", Repeat::Weekly);

        // Adia 9 dias: cai depois da terça seguinte (14/07).
        snooze(&mut weekly, 9 * 24 * 60, at("2026-07-07T09:05:00"));
        assert_eq!(weekly.datetime, "2026-07-16T09:05:00");

        advance_after(&mut weekly, at("2026-07-16T09:10:00")).expect("advance");
        // A ocorrência de 14/07 já passou; a série segue na terça 21/07.
        assert_eq!(weekly.datetime, "2026-07-21T09:00:00");
    }

    #[test]
    fn custom_reschedule_also_preserves_the_series() {
        let mut weekly = note("semanal", "2026-07-07T09:00:00", Repeat::Weekly);
        reschedule_to(
            &mut weekly,
            at("2026-07-09T15:30:00"),
            at("2026-07-07T09:05:00"),
        )
        .expect("reschedule");
        assert_eq!(weekly.series_datetime, "2026-07-07T09:00:00");

        advance_after(&mut weekly, at("2026-07-09T15:35:00")).expect("advance");
        assert_eq!(weekly.datetime, "2026-07-14T09:00:00");
    }

    #[test]
    fn snooze_until_tomorrow_preserves_the_series_too() {
        let mut weekly = note("semanal", "2026-07-07T09:00:00", Repeat::Weekly);
        snooze_until_tomorrow(&mut weekly, at("2026-07-07T22:00:00")).expect("tomorrow");
        assert_eq!(weekly.datetime, "2026-07-08T09:00:00");
        assert_eq!(weekly.series_datetime, "2026-07-07T09:00:00");

        advance_after(&mut weekly, at("2026-07-08T09:05:00")).expect("advance");
        assert_eq!(weekly.datetime, "2026-07-14T09:00:00");
    }

    // Adiar um lembrete sem repetição não deve inventar âncora de série.
    #[test]
    fn snoozing_a_one_off_keeps_no_series_anchor() {
        let mut once = note("pontual", "2026-07-07T09:00:00", Repeat::None);
        snooze(&mut once, 30, at("2026-07-07T09:05:00"));
        assert!(once.series_datetime.is_empty());
        assert_eq!(once.datetime, "2026-07-07T09:35:00");
    }

    /// Ação que o "usuário" (ou o app) toma quando um lembrete dispara.
    #[derive(Clone, Copy)]
    enum Act {
        /// Marca como concluído (recorrentes avançam para a próxima ocorrência).
        Complete,
        /// Adia por N minutos a partir do instante do disparo.
        Snooze(u32),
        /// Ignora: fecha sem agir (equivale a não tocar no toast).
        Ignore,
    }

    /// Espelha o núcleo de `collect_due` (include_fired = false) mais a resposta
    /// do usuário, avançando o relógio de `start` até `end` em passos de `step`.
    /// Retorna a sequência de disparos como (id, chave-da-ocorrência), em ordem.
    fn simulate(
        notifications: &mut [Notification],
        start: NaiveDateTime,
        end: NaiveDateTime,
        step: Duration,
        mut respond: impl FnMut(&Notification) -> Act,
    ) -> Vec<(String, String)> {
        let mut fired = Vec::new();
        let mut clock = start;
        while clock <= end {
            for notification in notifications.iter_mut() {
                if is_due(notification, clock, false) {
                    let key = occurrence_key(&notification.parsed_datetime().expect("datetime"));
                    notification.last_fired = key.clone();
                    fired.push((notification.id.clone(), key));
                    match respond(notification) {
                        Act::Complete => advance_after(notification, clock).expect("advance"),
                        Act::Snooze(minutes) => snooze(notification, minutes, clock),
                        Act::Ignore => {}
                    }
                }
            }
            clock += step;
        }
        fired
    }

    fn keys(fired: &[(String, String)]) -> Vec<String> {
        fired.iter().map(|(_, key)| key.clone()).collect()
    }

    #[test]
    fn weekly_fires_every_week_when_completed() {
        let mut list = [note("cinema", "2026-07-02T09:31:00", Repeat::Weekly)];
        let fired = simulate(
            &mut list,
            at("2026-07-01T00:00:00"),
            at("2026-07-23T23:59:00"),
            Duration::hours(1),
            |_| Act::Complete,
        );
        assert_eq!(
            keys(&fired),
            [
                "2026-07-02T09:31",
                "2026-07-09T09:31",
                "2026-07-16T09:31",
                "2026-07-23T09:31",
            ]
        );
    }

    #[test]
    fn daily_fires_every_day_when_completed() {
        let mut list = [note("agua", "2026-07-01T08:00:00", Repeat::Daily)];
        let fired = simulate(
            &mut list,
            at("2026-07-01T00:00:00"),
            at("2026-07-04T23:59:00"),
            Duration::minutes(30),
            |_| Act::Complete,
        );
        assert_eq!(
            keys(&fired),
            [
                "2026-07-01T08:00",
                "2026-07-02T08:00",
                "2026-07-03T08:00",
                "2026-07-04T08:00",
            ]
        );
    }

    // Este é o comportamento que explica "o recorrente não aparece mais":
    // se o lembrete dispara e o usuário NÃO conclui (nem adia), ele NÃO volta a
    // tocar, porque o datetime só avança na conclusão. Fica disparado uma vez só.
    #[test]
    fn unattended_recurring_fires_only_once() {
        let mut list = [note("semanal", "2026-07-02T09:31:00", Repeat::Weekly)];
        let fired = simulate(
            &mut list,
            at("2026-07-01T00:00:00"),
            at("2026-07-30T23:59:00"),
            Duration::hours(1),
            |_| Act::Ignore,
        );
        assert_eq!(keys(&fired), ["2026-07-02T09:31"]);
        // datetime permanece na ocorrência original (não avançou sozinho).
        assert_eq!(list[0].datetime, "2026-07-02T09:31:00");
    }

    #[test]
    fn snooze_refires_after_the_delay() {
        let mut list = [note("pontual", "2026-07-01T10:00:00", Repeat::None)];
        let fired = simulate(
            &mut list,
            at("2026-07-01T09:00:00"),
            at("2026-07-01T12:00:00"),
            Duration::minutes(5),
            // Adia 15 min só na primeira vez; depois conclui.
            {
                let mut first = true;
                move |_| {
                    if first {
                        first = false;
                        Act::Snooze(15)
                    } else {
                        Act::Complete
                    }
                }
            },
        );
        assert_eq!(keys(&fired), ["2026-07-01T10:00", "2026-07-01T10:15"]);
    }

    #[test]
    fn reschedule_moves_the_next_fire() {
        let mut list = [note("mudar", "2026-07-01T10:00:00", Repeat::None)];
        // Antes de disparar, reagenda para dois dias depois.
        reschedule_to(
            &mut list[0],
            at("2026-07-03T15:00:00"),
            at("2026-07-01T09:00:00"),
        )
        .expect("reschedule");
        let fired = simulate(
            &mut list,
            at("2026-07-01T00:00:00"),
            at("2026-07-04T23:59:00"),
            Duration::hours(1),
            |_| Act::Complete,
        );
        assert_eq!(keys(&fired), ["2026-07-03T15:00"]);
    }

    // Se o app fica fechado (nenhum tick) e a hora passa, o disparo perdido é
    // recuperado na abertura via collect_due(include_fired = true).
    #[test]
    fn missed_occurrence_recovers_on_startup() {
        let notification = note("perdido", "2026-07-01T10:00:00", Repeat::None);
        // Durante o "offline" nenhum tick rodou; abre o app às 14h.
        let startup = at("2026-07-01T14:00:00");
        assert!(is_due(&notification, startup, true));
    }

    #[test]
    fn monthly_end_of_month_sequence_when_completed() {
        let mut list = [note("mensal", "2026-01-31T09:00:00", Repeat::Monthly)];
        let fired = simulate(
            &mut list,
            at("2026-01-01T00:00:00"),
            at("2026-04-30T23:59:00"),
            Duration::hours(6),
            |_| Act::Complete,
        );
        // Fevereiro/2026 tem 28 dias, mas a série continua sendo "dia 31":
        // março volta ao 31 e abril (30 dias) cai no último dia.
        assert_eq!(
            keys(&fired),
            [
                "2026-01-31T09:00",
                "2026-02-28T09:00",
                "2026-03-31T09:00",
                "2026-04-30T09:00",
            ]
        );
    }

    #[test]
    fn monthly_catch_up_after_pc_off_keeps_the_intended_day() {
        let mut monthly = note("mensal", "2026-01-31T09:00:00", Repeat::Monthly);
        // PC desligado de 31/01 a 01/04: concluir pula para a próxima ocorrência.
        advance_after(&mut monthly, at("2026-04-01T10:00:00")).expect("advance");
        assert_eq!(monthly.datetime, "2026-04-30T09:00:00");
        advance_after(&mut monthly, at("2026-04-30T09:05:00")).expect("advance");
        assert_eq!(monthly.datetime, "2026-05-31T09:00:00");
    }

    #[test]
    fn yearly_leap_day_returns_on_leap_years() {
        let mut yearly = note("bissexto", "2024-02-29T08:00:00", Repeat::Yearly);
        let mut seen = Vec::new();
        for year in 2024..2028 {
            let now = at(&format!("{year}-03-01T00:00:00"));
            advance_after(&mut yearly, now).expect("advance");
            seen.push(yearly.datetime.clone());
        }
        assert_eq!(
            seen,
            [
                "2025-02-28T08:00:00",
                "2026-02-28T08:00:00",
                "2027-02-28T08:00:00",
                "2028-02-29T08:00:00",
            ]
        );
    }

    #[test]
    fn very_old_anchor_still_completes() {
        let mut daily = note("ano-errado", "1990-01-01T07:00:00", Repeat::Daily);
        advance_after(&mut daily, at("2026-09-29T12:00:00")).expect("advance");
        assert_eq!(daily.datetime, "2026-09-30T07:00:00");

        let mut biweekly = note("quinzenal", "2000-01-03T07:00:00", Repeat::Biweekly);
        advance_after(&mut biweekly, at("2026-09-29T12:00:00")).expect("advance");
        let next = biweekly.parsed_datetime().expect("datetime");
        assert!(next > at("2026-09-29T12:00:00"));
        assert!(next <= at("2026-10-13T12:00:00"));
        assert_eq!((next - at("2000-01-03T07:00:00")).num_days() % 14, 0);
    }

    #[test]
    fn snooze_lands_on_a_whole_minute() {
        let mut once = note("pontual", "2026-07-07T09:00:00", Repeat::None);
        snooze(&mut once, 15, at("2026-07-07T09:00:37"));
        assert_eq!(once.datetime, "2026-07-07T09:15:00");
    }

    #[test]
    fn tomorrow_after_a_snooze_uses_the_series_time() {
        let mut weekly = note("semanal", "2026-07-07T09:00:00", Repeat::Weekly);
        snooze(&mut weekly, 15, at("2026-07-07T09:00:10"));
        snooze_until_tomorrow(&mut weekly, at("2026-07-07T09:20:00")).expect("tomorrow");
        assert_eq!(weekly.datetime, "2026-07-08T09:00:00");
    }

    /// O relato do usuário: "toda quarta 8h", adiado ~10 vezes pelo toast e
    /// concluído às 15h. A próxima tem de ser na quarta seguinte às 8h — não
    /// às 15h. Cobre também os outros jeitos de adiar, reiniciar o app no meio
    /// (o arquivo é regravado e relido) e editar só o texto enquanto adiado.
    #[test]
    fn weekly_snoozed_all_day_and_completed_late_returns_to_its_slot() {
        let fire = at("2026-09-30T08:00:00");
        let form_edit = |current: &Notification, text: &str| Notification {
            // O que o formulário manda: sem campos do agendador, hora sem segundos.
            text: text.into(),
            datetime: format!("{}:00", &current.datetime[..16]),
            last_fired: String::new(),
            series_datetime: String::new(),
            series_day: 0,
            ..current.clone()
        };

        let mut weekly = note("cinema", "2026-09-30T08:00:00", Repeat::Weekly);
        weekly.last_fired = occurrence_key(&fire);
        let mut clock = fire;
        for round in 0..10 {
            clock += Duration::minutes(40) + Duration::seconds(17);
            match round % 4 {
                0 => snooze(&mut weekly, 15, clock),
                1 => snooze(&mut weekly, 60, clock),
                2 => reschedule_to(&mut weekly, clock + Duration::minutes(20), clock)
                    .expect("personalizar"),
                _ => {
                    // Reinicia o app: grava e relê o arquivo.
                    let json = serde_json::to_string(&weekly).expect("save");
                    weekly = serde_json::from_str(&json).expect("load");
                    snooze(&mut weekly, 30, clock);
                }
            }
            if round == 5 {
                // Corrige o texto na janela principal enquanto está adiado.
                let edit = form_edit(&weekly, "Cinema | Subir conteúdo!");
                assert!(apply_edit(&mut weekly, edit), "só o texto mudou");
            }
            assert_eq!(
                weekly.series_datetime, "2026-09-30T08:00:00",
                "round {round}"
            );
        }

        advance_after(&mut weekly, at("2026-09-30T15:00:00")).expect("concluir");
        assert_eq!(weekly.datetime, "2026-10-07T08:00:00");
        assert!(weekly.series_datetime.is_empty());
        assert_eq!(weekly.text, "Cinema | Subir conteúdo!");
    }

    /// Dados gravados pela v0.8.0: adiamento com segundos no horário. Abrir no
    /// formulário e salvar sem mexer (o formulário manda HH:MM:00) não pode
    /// soltar a série — era o caminho que ainda fazia a série "andar".
    #[test]
    fn saving_an_old_snoozed_reminder_unchanged_keeps_the_series() {
        let mut weekly = note("cinema", "2026-09-30T14:47:33", Repeat::Weekly);
        weekly.series_datetime = "2026-09-30T08:00:00".into();
        let mut untouched = weekly.clone();
        untouched.datetime = "2026-09-30T14:47:00".into();
        untouched.series_datetime.clear();

        assert!(apply_edit(&mut weekly, untouched));
        assert_eq!(weekly.series_datetime, "2026-09-30T08:00:00");
        advance_after(&mut weekly, at("2026-09-30T15:00:00")).expect("concluir");
        assert_eq!(weekly.datetime, "2026-10-07T08:00:00");
    }

    /// Mudar a hora no formulário redefine a série, de propósito.
    #[test]
    fn changing_the_time_in_the_form_redefines_the_series() {
        let mut weekly = note("cinema", "2026-09-30T14:47:00", Repeat::Weekly);
        weekly.series_datetime = "2026-09-30T08:00:00".into();
        let mut edited = weekly.clone();
        edited.datetime = "2026-09-30T10:00:00".into();

        assert!(!apply_edit(&mut weekly, edited));
        assert!(weekly.series_datetime.is_empty());
        advance_after(&mut weekly, at("2026-09-30T15:00:00")).expect("concluir");
        assert_eq!(weekly.datetime, "2026-10-07T10:00:00");
    }
}
