import { useState } from 'react';
import type { ClubAdminView } from '@bills/domain';
import { isValidTimeZone } from '@bills/domain';
import { Field, Section } from '../../ui.tsx';
import type { SectionProps } from './shared.tsx';
import { CURRENCIES, CURRENCY_LABEL, SaveBar, TIME_ZONE_LABEL, TIME_ZONES, useDraft } from './shared.tsx';

const OTHER = '__other__';

/** «Клуб»: name, time zone, currency. Only the owner may change them. */
export function ClubSection({ club, online, isBusy, run, onSaved, canEdit }: SectionProps & { canEdit: boolean }) {
  const { draft, setDraft, dirty, reset } = useDraft({ name: club.name, timezone: club.timezone, currency: club.currency });
  const [customZone, setCustomZone] = useState(!(TIME_ZONES as readonly string[]).includes(club.timezone));
  const busy = isBusy('club');
  const disabled = !canEdit || !online;

  const name = draft.name.trim();
  const nameError = name.length === 0 ? 'Введите название' : name.length > 80 ? 'Не больше 80 символов' : null;
  const zoneError = draft.timezone.trim() && !isValidTimeZone(draft.timezone.trim()) ? 'Неизвестный часовой пояс' : null;
  const canSave = dirty && !nameError && !zoneError && draft.timezone.trim().length > 0;

  const save = async () => {
    const res = await run<ClubAdminView>('club', '/api/club', {
      name,
      timezone: draft.timezone.trim(),
      currency: draft.currency,
    });
    if (res) {
      setDraft({ name: res.name, timezone: res.timezone, currency: res.currency });
      onSaved(res);
    }
  };

  return (
    <Section title="Клуб">
      {!canEdit && <p className="hint">Название, часовой пояс и валюту меняет управляющий.</p>}
      <div className="form">
        <div className="form-row">
          <Field label="Название клуба" error={dirty ? nameError : null}>
            <input
              value={draft.name}
              maxLength={80}
              disabled={disabled}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            />
          </Field>
          <Field label="Валюта" hint="В ней задаются все цены и считаются отчёты">
            <select
              value={draft.currency}
              disabled={disabled}
              onChange={(e) => setDraft((d) => ({ ...d, currency: e.target.value }))}
            >
              {[...CURRENCIES, ...((CURRENCIES as readonly string[]).includes(draft.currency) ? [] : [draft.currency])].map((c) => (
                <option key={c} value={c}>
                  {CURRENCY_LABEL[c] ?? c}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="form-row">
          <Field label="Часовой пояс (город)" hint="По нему считаются цены по времени суток и отчёты за день" error={zoneError}>
            <select
              value={customZone ? OTHER : draft.timezone}
              disabled={disabled}
              onChange={(e) => {
                if (e.target.value === OTHER) setCustomZone(true);
                else {
                  setCustomZone(false);
                  setDraft((d) => ({ ...d, timezone: e.target.value }));
                }
              }}
            >
              {TIME_ZONES.map((z) => (
                <option key={z} value={z}>
                  {TIME_ZONE_LABEL[z] ?? z}
                </option>
              ))}
              <option value={OTHER}>Другой город…</option>
            </select>
          </Field>
          {customZone && (
            <Field label="Часовой пояс вручную" hint="Латиницей, как в настройках компьютера: Europe/Berlin">
              <input
                value={draft.timezone}
                disabled={disabled}
                placeholder="Region/City"
                onChange={(e) => setDraft((d) => ({ ...d, timezone: e.target.value }))}
              />
            </Field>
          )}
        </div>
        <SaveBar dirty={dirty} canSave={canSave} busy={busy} disabled={disabled} onSave={() => void save()} onReset={reset} />
      </div>
    </Section>
  );
}
