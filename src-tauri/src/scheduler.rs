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
    let mut datetime = notification.series_anchor()?;
    let mut guard = 0;
    while datetime <= now {
        datetime = next_occurrence(datetime, notification.repeat);
        guard += 1;
        if guard > 10_000 {
            return Err("Não foi possível calcular a próxima ocorrência.".to_string());
        }
    }

    notification.datetime = datetime.format("%Y-%m-%dT%H:%M:%S").to_string();
    notification.series_datetime.clear();
    notification.done = false;
    notification.last_fired.clear();
    Ok(())
}

pub fn snooze(notification: &mut Notification, minutes: u32, now: NaiveDateTime) {
    notification.remember_series_anchor();
    notification.datetime = (now + Duration::minutes(i64::from(minutes)))
        .format("%Y-%m-%dT%H:%M:%S")
        .to_string();
    notification.done = false;
    notification.last_fired.clear();
}

pub fn snooze_until_tomorrow(
    notification: &mut Notification,
    now: NaiveDateTime,
) -> Result<(), String> {
    let original = notification.parsed_datetime()?;
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

pub fn next_occurrence(datetime: NaiveDateTime, repeat: Repeat) -> NaiveDateTime {
    match repeat {
        Repeat::Daily => datetime + Duration::days(1),
        Repeat::Weekly => datetime + Duration::weeks(1),
        Repeat::Biweekly => datetime + Duration::weeks(2),
        Repeat::Monthly => add_months_clamped(datetime, 1),
        Repeat::Yearly => add_years_clamped(datetime, 1),
        Repeat::None => datetime,
    }
}

fn add_months_clamped(datetime: NaiveDateTime, months: u32) -> NaiveDateTime {
    let zero_based = datetime.month0() + months;
    let year = datetime.year() + (zero_based / 12) as i32;
    let month = (zero_based % 12) + 1;
    build_clamped(datetime, year, month)
}

fn add_years_clamped(datetime: NaiveDateTime, years: i32) -> NaiveDateTime {
    build_clamped(datetime, datetime.year() + years, datetime.month())
}

fn build_clamped(source: NaiveDateTime, year: i32, month: u32) -> NaiveDateTime {
    let day = source.day().min(days_in_month(year, month));
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
        // Fevereiro/2026 tem 28 dias: a partir daí a série fixa no dia 28.
        assert_eq!(
            keys(&fired),
            [
                "2026-01-31T09:00",
                "2026-02-28T09:00",
                "2026-03-28T09:00",
                "2026-04-28T09:00",
            ]
        );
    }
}
