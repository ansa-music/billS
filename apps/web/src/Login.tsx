import { useEffect, useState } from 'react';
import type { Role, StaffListResponse, StaffView } from '@bills/domain';
import { ROLE_LABEL, ROLES } from '@bills/domain';
import { fetchJson } from './api.ts';
import type { CurrentStaff } from './auth.ts';
import { navigate } from './router.tsx';
import { Empty, Loading, Page } from './ui.tsx';

/**
 * Stand-in for PIN login (stage 3): pick yourself from the club's staff list.
 * The HUB gets the name as X-Actor; the role drives what the UI shows.
 */
export function LoginPage({ onLogin, next }: { onLogin: (s: CurrentStaff) => void; next: string }) {
  const [staff, setStaff] = useState<StaffView[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetchJson<StaffListResponse>('/api/staff')
        .then((r) => alive && (setStaff(r.staff.filter((s) => s.isActive)), setError(null)))
        .catch((e: Error) => alive && setError(e.message));
    void load();
    const t = setInterval(() => void load(), 5000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  const pick = (s: StaffView) => {
    onLogin({ id: s.id, name: s.name, role: s.role });
    navigate(next || '/');
  };

  const byRole = new Map<Role, StaffView[]>();
  for (const s of staff ?? []) byRole.set(s.role, [...(byRole.get(s.role) ?? []), s]);

  return (
    <Page title="Кто за планшетом?" subtitle="Выберите себя из списка. Вход по PIN появится на этапе 3.">
      {error && <p className="field-error">{error}</p>}
      {!staff && !error && <Loading />}
      {staff && staff.length === 0 && <Empty>В клубе ещё нет сотрудников</Empty>}
      <div className="login-groups">
        {ROLES.filter((r) => byRole.has(r)).map((role) => (
          <section key={role} className="login-group">
            <h2 className="muted">{ROLE_LABEL[role]}</h2>
            <div className="login-list">
              {byRole.get(role)!.map((s) => (
                <button key={s.id} type="button" className="btn login-btn" onClick={() => pick(s)}>
                  <span className="avatar" aria-hidden="true">
                    {initials(s.name)}
                  </span>
                  <span>{s.name}</span>
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
    </Page>
  );
}

function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0] ?? '')
    .join('')
    .toUpperCase();
}
