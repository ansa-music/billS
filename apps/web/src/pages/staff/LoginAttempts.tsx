import { useCallback, useEffect, useState } from 'react';
import type { LoginAttemptView, LoginAttemptsResponse } from '@bills/domain';
import { fetchJson } from '../../api.ts';
import { Empty, Loading, Section, formatDateTime } from '../../ui.tsx';

const RESULT_LABEL: Record<string, string> = {
  ok: 'вход',
  wrong_key: 'неверный ключ',
  revoked: 'ключ отозван',
  expired: 'ключ истёк',
  inactive: 'сотрудник уволен',
  locked: 'пауза: много ошибок',
  branch_locked: 'пауза для филиала',
};

/**
 * «Попытки входа» (GET /api/auth/attempts, staff.view): who tried to sign in,
 * from which device and address, and what came of it. The key itself is never
 * stored — only the prefix of a known key. Loaded when opened.
 */
export function LoginAttempts({ timeZone }: { timeZone: string }) {
  const [open, setOpen] = useState(false);
  const [onlyFailed, setOnlyFailed] = useState(false);
  const [attempts, setAttempts] = useState<LoginAttemptView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchJson<LoginAttemptsResponse>('/api/auth/attempts');
      setAttempts(r.attempts);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const shown = attempts?.filter((a) => !onlyFailed || !a.ok) ?? null;
  const failed = attempts?.filter((a) => !a.ok).length ?? 0;

  return (
    <Section
      title="Попытки входа"
      aside={
        <button type="button" className="btn btn-small" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
          {open ? 'Скрыть' : 'Показать'}
        </button>
      }
    >
      {!open && <p className="hint">Кто и откуда входил по ключу, неудачные попытки и паузы после ошибок.</p>}
      {open && (
        <div className="attempts">
          <div className="attempts-bar">
            <label className="role-option">
              <input type="checkbox" checked={onlyFailed} onChange={(e) => setOnlyFailed(e.target.checked)} />
              <span>Только неудачные{attempts ? ` (${failed})` : ''}</span>
            </label>
            <button type="button" className="btn btn-small btn-ghost" disabled={loading} onClick={() => void load()}>
              {loading ? 'Обновляем…' : 'Обновить'}
            </button>
          </div>
          {error && <p className="field-error">{error}</p>}
          {!shown && !error && <Loading />}
          {shown && shown.length === 0 && <Empty>{onlyFailed ? 'Неудачных попыток нет' : 'Попыток входа ещё не было'}</Empty>}
          {shown && shown.length > 0 && (
            <div className="attempts-scroll">
              <table className="attempts-table">
                <thead>
                  <tr>
                    <th>Время</th>
                    <th>Результат</th>
                    <th>Ключ</th>
                    <th>Устройство</th>
                    <th>IP</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((a) => (
                    <tr key={a.id} data-ok={a.ok || undefined}>
                      <td className="attempts-time">{formatDateTime(a.at, timeZone)}</td>
                      <td>
                        <span className={`tag ${a.ok ? 'tag-ok' : a.result === 'wrong_key' ? 'tag-warn' : 'tag-danger'}`}>
                          {RESULT_LABEL[a.result] ?? a.result}
                        </span>
                      </td>
                      <td>
                        {a.staffName ?? <span className="muted">—</span>}
                        {a.prefix && <span className="muted"> · {a.prefix}</span>}
                        {!a.prefix && a.kind && <span className="muted"> · {a.kind === 'short' ? '6 цифр' : 'длинный'}</span>}
                      </td>
                      <td>{a.device ?? <span className="muted">—</span>}</td>
                      <td>
                        <code>{a.ip ?? '—'}</code>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </Section>
  );
}
