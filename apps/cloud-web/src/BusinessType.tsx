/** «Тип: Кофейня · изменить» on a venue's page (POST /owner/clubs/:id/business). */
import { useEffect, useState } from 'react';
import type { BusinessType, ClubSummary } from '@bills/domain';
import { BUSINESS_TYPES, BUSINESS_TYPE_LABEL } from '@bills/domain';
import { CloudRequestError, fetchOnboarding, setBusinessType } from './api.ts';
import { parseOnboarding } from './onboarding.ts';
import { rememberVenueType, storedVenueType } from './signup.ts';

/** The venue type as far as the cabinet knows: the report (newer clouds), the checklist route, this browser. */
async function knownType(club: ClubSummary): Promise<BusinessType | null> {
  const own = (club as ClubSummary & { businessType?: unknown }).businessType;
  if (own === 'cafe' || own === 'billiards') return own;
  try {
    const found = parseOnboarding(await fetchOnboarding())?.find((c) => c.clubId === club.id);
    if (found?.businessType) return found.businessType;
  } catch {
    // older cloud: what this browser remembers from signup
  }
  return storedVenueType(club.id);
}

function errorText(e: unknown): string {
  const err = e as CloudRequestError;
  if (err.code === 'OFFLINE') return 'Нет связи с интернетом — попробуйте ещё раз.';
  if (err.status === 404 || err.status === 405) return 'Сменить тип здесь пока нельзя: сервер TS ещё не обновился.';
  return `Не получилось сохранить: ${err.message || 'попробуйте ещё раз'}`;
}

export function BusinessTypeLine({ club }: { club: ClubSummary }) {
  const [type, setType] = useState<BusinessType | null | undefined>(undefined);
  const [editing, setEditing] = useState(false);
  const [choice, setChoice] = useState<BusinessType>('cafe');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let live = true;
    void knownType(club).then((t) => {
      if (live) setType(t);
    });
    return () => {
      live = false;
    };
    // The type does not change with every report refresh: once per venue.
  }, [club.id]);

  async function save() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await setBusinessType(club.id, choice);
      rememberVenueType(club.id, choice);
      setType(choice);
      setEditing(false);
      setSaved(true);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  }

  if (type === undefined) return null;

  if (!editing) {
    return (
      <p className="biz-line">
        <span className="muted">Тип:</span> {type ? BUSINESS_TYPE_LABEL[type] : 'не указан'} ·{' '}
        <button
          type="button"
          className="link-inline"
          onClick={() => {
            setChoice(type ?? 'cafe');
            setEditing(true);
            setSaved(false);
          }}
        >
          {type ? 'изменить' : 'указать'}
        </button>
        {saved && <span className="saved"> · сохранено, касса получит его при следующей связи</span>}
      </p>
    );
  }

  return (
    <div className="biz-edit">
      <div className="seg" role="radiogroup" aria-label="Тип заведения">
        {BUSINESS_TYPES.map((t) => (
          <button key={t} type="button" role="radio" aria-checked={choice === t} aria-selected={choice === t} onClick={() => setChoice(t)}>
            {BUSINESS_TYPE_LABEL[t]}
          </button>
        ))}
      </div>
      <p className="hint">
        От типа зависит экран кассы: у кофейни — меню и заказы, у бильярдного клуба — столы и время игры.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap">
        <button type="button" className="btn btn-small btn-primary" disabled={busy || choice === type} onClick={() => void save()}>
          {busy ? 'Сохраняем…' : 'Сохранить'}
        </button>
        <button type="button" className="btn btn-small" disabled={busy} onClick={() => setEditing(false)}>
          Отмена
        </button>
      </div>
    </div>
  );
}
