/**
 * «Получать в Telegram» (Supabase mode): alerts and the evening summary in the owner's Telegram.
 * One big button → a one-time link `t.me/<bot>?start=<code>` (15 minutes) → the bot links the chat.
 * While the link is shown the status is re-read every few seconds, so «Подключено» appears by itself.
 * Without a bot on the server the section only says «Telegram пока не подключён к TS».
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { TelegramChatView, TelegramLinkResponse, TelegramStatusView } from '@bills/domain';
import { fetchTelegram, linkTelegram, unlinkTelegram } from './api.ts';
import { QrImage } from './QrImage.tsx';
import { Section } from './shared.tsx';

const POLL_MS = 4000;

function isDesktop(): boolean {
  return typeof navigator !== 'undefined' && !/Android|iPhone|iPad|Mobile/i.test(navigator.userAgent);
}

function chatLabel(c: TelegramChatView): string {
  return c.muted ? `${c.name} (пауза — в чате отправьте /unmute)` : c.name;
}

export function TelegramSection() {
  const [status, setStatus] = useState<TelegramStatusView | null>(null);
  const [link, setLink] = useState<TelegramLinkResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Chats before the link was made: a bigger count means the bot linked a new one. */
  const chatsBefore = useRef(0);

  const reload = useCallback(async () => {
    try {
      const next = await fetchTelegram();
      setStatus(next);
      return next;
    } catch (e) {
      setError(`Не удалось узнать состояние Telegram: ${(e as Error).message}`);
      return null;
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Waiting for the owner to press «Запустить» in Telegram: poll until a new chat shows up or the link expires.
  useEffect(() => {
    if (!link) return;
    const timer = setInterval(() => {
      if (Date.now() > link.expiresAt) {
        setLink(null);
        return;
      }
      void reload().then((next) => {
        if (next && next.chats.length > chatsBefore.current) setLink(null);
      });
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [link, reload]);

  async function start() {
    setBusy(true);
    setError(null);
    try {
      const res = await linkTelegram();
      chatsBefore.current = status?.chats.length ?? 0;
      setLink(res);
      // On a phone Telegram opens straight away; a blocked pop-up still leaves the button below.
      if (!isDesktop()) window.open(res.url, '_blank', 'noopener');
    } catch (e) {
      setError(`Не получилось: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  async function unlink(c: TelegramChatView) {
    if (!confirm(`Отключить Telegram ${c.name}? Тревоги и сводка перестанут приходить в этот чат.`)) return;
    setBusy(true);
    setError(null);
    try {
      await unlinkTelegram(c.chatId);
      await reload();
    } catch (e) {
      setError(`Не удалось отключить: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  if (status === null) {
    return error ? (
      <Section title="Telegram">
        <p className="hint">{error}</p>
      </Section>
    ) : null;
  }

  if (!status.configured) {
    return (
      <Section title="Telegram">
        <p className="phone-status" data-tone="muted">
          Telegram пока не подключён к TS.
        </p>
      </Section>
    );
  }

  const chats = status.chats;
  return (
    <Section title="Telegram">
      <p className="hint alerts-lead">Тревоги из заведений и в 21:00 — итоги дня: выручка, заказы, средний чек и сравнение с прошлой неделей.</p>

      {chats.map((c) => (
        <p key={c.chatId} className="phone-status" data-tone={c.muted ? 'warn' : 'ok'}>
          ✓ Подключено: {chatLabel(c)} ·{' '}
          <button type="button" className="btn-link" disabled={busy} onClick={() => void unlink(c)}>
            отключить
          </button>
        </p>
      ))}

      {!link && (
        <button
          type="button"
          className={chats.length ? 'btn' : 'btn btn-primary btn-big-text alerts-main'}
          disabled={busy}
          onClick={() => void start()}
        >
          {busy ? 'Готовим ссылку…' : chats.length ? 'Подключить ещё один чат' : 'Получать в Telegram'}
        </button>
      )}

      {link && (
        <ol className="alerts-steps">
          <li>
            <strong>Откройте Telegram и нажмите «Запустить»</strong>
            <span className="hint">Ссылка одноразовая и действует 15 минут. Здесь появится «Подключено», как только бот ответит.</span>
            <div className="row wrap">
              <a className="btn btn-primary" href={link.url} target="_blank" rel="noreferrer">
                Открыть Telegram
              </a>
              <button type="button" className="btn" onClick={() => setLink(null)}>
                Отмена
              </button>
            </div>
            {isDesktop() && (
              <div className="alerts-qr">
                <QrImage text={link.url} alt="QR-код: подключить Telegram с телефона" />
                <span className="hint">Telegram на телефоне? Отсканируйте QR камерой телефона.</span>
              </div>
            )}
          </li>
        </ol>
      )}

      {error && (
        <p className="phone-status" data-tone="warn" role="alert">
          {error}
        </p>
      )}
      {chats.length > 0 && <p className="hint">В чате: /today — сводка за сегодня, /mute — пауза, /stop — отключить.</p>}
    </Section>
  );
}
