/**
 * «Смотреть с телефона»: the coffee-shop owner's page, #/v/<token>. No sign-in, read-only, phone
 * first: today's revenue big, then 7 and 30 days, checks and the average check, best sellers, money
 * by payment method, whether the shift is open — and how fresh the numbers are. Refreshes every
 * minute and when the phone wakes the page.
 */
import { useCallback, useEffect, useReducer, useState } from 'react';
import type { TrialPublicView } from './trial-view.ts';
import {
  METHOD_LABEL,
  VIEW_REFRESH_MS,
  ViewError,
  checksText,
  fetchTrialView,
  isStale,
  lastActivityText,
  updatedText,
  viewMoney,
  weekdayOf,
} from './trial-view.ts';
import { BrandMark } from './BrandMark.tsx';
import './trial-view.css';

export function TrialViewPage({ token }: { token: string }) {
  const [data, setData] = useState<TrialPublicView | null>(null);
  const [error, setError] = useState<ViewError | null>(null);
  const [, tick] = useReducer((n: number) => n + 1, 0);

  const load = useCallback(async () => {
    try {
      setData(await fetchTrialView(token));
      setError(null);
    } catch (e) {
      setError(e as ViewError);
    }
  }, [token]);

  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), VIEW_REFRESH_MS);
    const c = setInterval(tick, 20_000);
    const wake = () => {
      if (document.visibilityState === 'visible') void load();
    };
    document.addEventListener('visibilitychange', wake);
    return () => {
      clearInterval(t);
      clearInterval(c);
      document.removeEventListener('visibilitychange', wake);
    };
  }, [load]);

  useEffect(() => {
    if (data) document.title = `${data.venue} — выручка`;
  }, [data]);

  const now = Date.now();
  const s = data?.summary ?? null;
  const cur = s?.currency ?? 'KZT';
  const maxDay = s ? Math.max(1, ...s.days.map((d) => d.revenue)) : 1;
  const methods = s ? (Object.keys(METHOD_LABEL) as Array<keyof typeof METHOD_LABEL>).filter((k) => s.methodsToday[k] !== 0) : [];
  const methodsTotal = s ? Math.max(1, methods.reduce((sum, k) => sum + Math.max(0, s.methodsToday[k]), 0)) : 1;

  return (
    <main className="tv-page">
      <header className="tv-head">
        <BrandMark className="tv-mark" />
        <div className="tv-head-text">
          <h1>{data?.venue ?? 'Выручка'}</h1>
          {data && (
            <p className="tv-updated" data-stale={s && isStale(s.at, now) ? '' : undefined}>
              {s ? updatedText(s.at, now) : 'касса ещё не прислала цифры'}
              {s && (
                <span className="tv-shift" data-open={s.shiftOpen || undefined}>
                  {s.shiftOpen ? 'смена открыта' : 'смена закрыта'}
                </span>
              )}
            </p>
          )}
        </div>
      </header>

      {error && !data && (
        <p className="tv-error" role="alert">
          {error.message}
        </p>
      )}
      {error && data && <p className="tv-note">Нет связи — показаны последние цифры.</p>}
      {!data && !error && <p className="tv-note">Загружаем…</p>}
      {data && data.status !== 'active' && <p className="tv-note">Касса сейчас в режиме «только чтение».</p>}

      {data && !s && <p className="tv-empty">Цифры появятся через несколько минут после того, как касса откроется с интернетом.</p>}

      {s && (
        <>
          <section className="tv-today" aria-label="Сегодня">
            <span className="tv-label">Сегодня</span>
            <strong className="tv-big" data-testid="revenue-today">{viewMoney(s.revenueToday, cur)}</strong>
            <span className="tv-sub">
              {checksText(s.checksToday)} · средний чек {viewMoney(s.avgCheckToday, cur)}
            </span>
            <span className="tv-sub muted">{lastActivityText(s.lastActivityAt, now, s.timezone)}</span>
          </section>

          <section className="tv-row" aria-label="Неделя и месяц">
            <div className="tv-card">
              <span className="tv-label">7 дней</span>
              <strong className="tv-mid">{viewMoney(s.revenue7, cur)}</strong>
            </div>
            <div className="tv-card">
              <span className="tv-label">30 дней</span>
              <strong className="tv-mid">{viewMoney(s.revenue30, cur)}</strong>
            </div>
          </section>

          <section className="tv-card" aria-label="По дням">
            <h2>По дням</h2>
            <div className="tv-bars" role="img" aria-label={`Выручка за 7 дней: ${s.days.map((d) => viewMoney(d.revenue, cur)).join(', ')}`}>
              {s.days.map((d, i) => (
                <div key={d.day} className="tv-bar" data-today={i === s.days.length - 1 || undefined}>
                  <span className="tv-bar-track">
                    <span className="tv-bar-fill" style={{ height: `${Math.max((d.revenue / maxDay) * 100, d.revenue > 0 ? 3 : 0)}%` }} />
                  </span>
                  <span className="tv-bar-label">{i === s.days.length - 1 ? 'сег.' : weekdayOf(d.day)}</span>
                </div>
              ))}
            </div>
          </section>

          <section className="tv-card" aria-label="Лучшие позиции сегодня">
            <h2>Лучшие сегодня</h2>
            {s.topToday.length === 0 ? (
              <p className="muted">Сегодня продаж ещё не было.</p>
            ) : (
              <ol className="tv-top">
                {s.topToday.map((p) => (
                  <li key={p.name}>
                    <span className="tv-top-name">{p.name}</span>
                    <span className="tv-top-qty">{p.qty} шт.</span>
                    <span className="tv-top-sum">{viewMoney(p.revenue, cur)}</span>
                  </li>
                ))}
              </ol>
            )}
          </section>

          <section className="tv-card" aria-label="Оплата сегодня">
            <h2>Оплата сегодня</h2>
            {methods.length === 0 ? (
              <p className="muted">Оплат сегодня ещё не было.</p>
            ) : (
              <ul className="tv-methods">
                {methods.map((k) => (
                  <li key={k}>
                    <span className="tv-method-name">{METHOD_LABEL[k]}</span>
                    <span className="tv-method-track">
                      <span className="tv-method-fill" style={{ width: `${(Math.max(0, s.methodsToday[k]) / methodsTotal) * 100}%` }} />
                    </span>
                    <span className="tv-method-sum">{viewMoney(s.methodsToday[k], cur)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}

      <footer className="tv-foot muted">
        <p>Только просмотр. Страница обновляется сама.</p>
        <p>Чтобы открывать как приложение: меню браузера → «На экран „Домой“».</p>
      </footer>
    </main>
  );
}
