/**
 * «Купили»: the reminder before a paid term ends (Supabase only: migration 20261104000000_trial_cloud.sql; the rules
 * are packages/domain/src/trial-paid.ts, the action itself is markTrialPaid in apps/cloud/src/trial.ts).
 * TRIAL_PAID_REMIND_DAYS before the end of the paid day the platform owner — and only the platform owner, never the
 * café — is told in Telegram and by Web Push of the platform cabinet; once per paid term (a new payment resets it).
 * The `notify` function runs it every 5 minutes. Runtime-neutral.
 */
import { TRIAL_PAID_REMIND_DAYS, paidDaysLeft, trialTimeZone } from '@bills/domain';
import type { PlatformNotifyDeps } from './platform-notify.ts';
import { notifyPlatform, trialDayText } from './platform-notify.ts';

const DAY_MS = 86_400_000;
const iso = (ms: number): string => new Date(ms).toISOString();
const ms = (column: string): string => `(extract(epoch FROM ${column}) * 1000)::bigint`;

/** Where the reminder leads: «Клиенты» of the platform cabinet, with the «Купили» list. */
export const PAID_CLIENTS_PATH = '#/platform';
export const PAID_SOON_TITLE = 'Скоро конец оплаты';

function daysWord(n: number): string {
  const d = n % 10;
  const dd = n % 100;
  if (d === 1 && dd !== 11) return 'день';
  if (d >= 2 && d <= 4 && (dd < 12 || dd > 14)) return 'дня';
  return 'дней';
}

/** «Кофейня «Утро» — оплачено до 12 ноября (осталось 5 дней)». */
export function paidSoonText(t: { venue: string; endsAt: number; timezone: string | null }, now: number): string {
  const left = paidDaysLeft(t.endsAt, now);
  return `«${t.venue}» — оплачено до ${trialDayText(trialTimeZone(t.timezone))(t.endsAt)} (осталось ${left} ${daysWord(left)})`;
}

/**
 * Tells the platform owner about every paid café whose term ends within TRIAL_PAID_REMIND_DAYS and was not told about
 * yet in this term; marks them told. Returns how many cafés were announced. Never throws for a delivery.
 */
export async function runPaidReminders(deps: PlatformNotifyDeps, now: number): Promise<number> {
  const due = await deps.db.all<{ id: string; venue: string; ends_at: number | string; timezone: string | null }>(
    `SELECT id::text AS id, venue, ${ms('ends_at')} AS ends_at, timezone FROM trials
      WHERE status = 'paid' AND paid_reminded_at IS NULL AND ends_at > ?::timestamptz AND ends_at <= ?::timestamptz
      ORDER BY ends_at, id`,
    [iso(now), iso(now + TRIAL_PAID_REMIND_DAYS * DAY_MS)],
  );
  if (!due.length) return 0;
  const owners = await deps.db.all<{ id: string }>("SELECT id FROM platform_staff WHERE role = 'owner' AND is_active = 1 ORDER BY created_at, id");
  for (const t of due) {
    // Marked first: a slow Telegram must not make the next run tell it twice.
    const marked = await deps.db.run('UPDATE trials SET paid_reminded_at = ?::timestamptz WHERE id = ?::uuid AND paid_reminded_at IS NULL', [iso(now), t.id]);
    if (!marked) continue;
    const notice = { title: PAID_SOON_TITLE, body: paidSoonText({ venue: t.venue, endsAt: Number(t.ends_at), timezone: t.timezone }, now), url: PAID_CLIENTS_PATH };
    for (const owner of owners) await notifyPlatform(deps, notice, owner.id);
    deps.log(`Купили: напоминание о конце оплаты, пробная версия ${t.id} «${t.venue}»`);
  }
  return due.length;
}
