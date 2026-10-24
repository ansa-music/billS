import { useCallback, useEffect, useState } from 'react';
import type { ClubAdminView } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { navigate, useLocation } from '../router.tsx';
import { Loading, Page, Toast, useToast } from '../ui.tsx';
import { useCommands, useHub } from '../useHub.tsx';
import { businessOf } from '../cafe/cafe.ts';
import { BusinessSection } from './settings/BusinessSection.tsx';
import { ClubSection } from './settings/ClubSection.tsx';
import { DisplaySettings } from './settings/DisplaySettings.tsx';
import { LicenseSection } from './settings/LicenseSection.tsx';
import { RulesSettings } from './settings/RulesSettings.tsx';
import { TablesEditor } from './settings/TablesEditor.tsx';
import { TariffsEditor } from './settings/TariffEditor.tsx';
import { TlsCard } from '../sections/TlsCard.tsx';
import './settings.css';

const TABS = [
  { id: 'club', title: 'Клуб' },
  { id: 'tables', title: 'Столы' },
  { id: 'tariffs', title: 'Тарифы' },
  { id: 'display', title: 'Экран зала' },
  { id: 'rules', title: 'Правила' },
  { id: 'devices', title: 'Установка на планшеты' },
  { id: 'license', title: 'Лицензия' },
] as const;
type TabId = (typeof TABS)[number]['id'];

/** A coffee shop has no tables, tariffs or table rules. */
const BILLIARDS_ONLY: readonly TabId[] = ['tables', 'tariffs', 'rules'];

function isTab(value: string | null): value is TabId {
  return TABS.some((t) => t.id === value);
}

/** #/settings?tab=tables — club, tables, tariffs, hall screen look, house rules. */
export function ClubSettingsPage() {
  const { state, online, version, license, canNow: can, can: roleCan } = useHub();
  const cafe = businessOf(state.settings) === 'cafe';
  const tabs = TABS.filter(
    (t) =>
      (t.id !== 'license' || roleCan('license.view')) &&
      (t.id !== 'devices' || can('equipment.view')) &&
      !(cafe && BILLIARDS_ONLY.includes(t.id)),
  ).map(
    (t) => (cafe && t.id === 'display' ? { ...t, title: 'Экран' } : t),
  );
  const { query } = useLocation();
  const asked = query.get('tab');
  const tab: TabId = isTab(asked) && tabs.some((t) => t.id === asked) ? asked : 'club';
  /** Tabs that need GET /api/club. */
  const standalone = tab !== 'license' && tab !== 'devices';
  const { toast, show, clear } = useToast();
  const { isBusy, run } = useCommands(show);
  const [club, setClub] = useState<ClubAdminView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setClub(await fetchJson<ClubAdminView>('/api/club'));
      setLoadError(null);
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  const reload = useCallback(
    async (message?: string) => {
      await load();
      if (message) show(message);
    },
    [load, show],
  );

  // On mount and whenever the HUB reports a change (SSE → new state): another tablet may have edited the club.
  useEffect(() => {
    void load();
  }, [load, state]);

  const onSaved = useCallback(
    (next: ClubAdminView, message = 'Сохранено') => {
      setClub(next);
      show(message);
    },
    [show],
  );

  const section = (() => {
    if (!club) return null;
    const props = { club, online, isBusy, run, onSaved, reload };
    switch (tab) {
      case 'club':
        return (
          <>
            <ClubSection {...props} canEdit={can('club.edit')} />
            <BusinessSection {...props} canEdit={can('club.edit')} />
          </>
        );
      case 'tables':
        return <TablesEditor {...props} canEdit={can('tables.edit')} canEditTariffs={can('tariffs.edit')} />;
      case 'tariffs':
        return <TariffsEditor {...props} canEdit={can('tariffs.edit')} />;
      case 'display':
        return <DisplaySettings {...props} canEdit={can('display.edit')} />;
      case 'rules':
        return <RulesSettings {...props} canEdit={can('rules.edit')} />;
      case 'license':
      case 'devices':
        return null; // rendered below: they do not need GET /api/club
    }
  })();

  return (
    <Page title={cafe ? 'Настройки' : 'Настройки клуба'} subtitle={club ? `${club.name} · ${club.companyName}` : undefined}>
      <nav className="settings-tabs" aria-label="Разделы настроек">
        {tabs.map((t) => (
          <button
            key={t.id}
            type="button"
            className="chip"
            aria-pressed={t.id === tab}
            onClick={() => navigate('/settings', t.id === 'club' ? {} : { tab: t.id })}
          >
            {t.title}
          </button>
        ))}
      </nav>
      {license?.readOnly && tab !== 'license' && tab !== 'devices' && (
        <p className="blocked-note">Только чтение: {license.message ?? 'лицензия не активна'} Настройки сейчас не сохраняются.</p>
      )}
      {tab === 'license' && (
        <LicenseSection
          version={version}
          timeZone={state.club.timezone}
          online={online}
          canInstall={roleCan('license.install')}
        />
      )}
      {tab === 'devices' && <TlsCard />}
      {standalone && !club && !loadError && <Loading online={online} />}
      {standalone && !club && loadError && <p className="empty">Не удалось загрузить настройки: {loadError}</p>}
      {club && !online && <p className="settings-offline">Нет связи с HUB — изменения пока нельзя сохранить.</p>}
      {section}
      <Toast message={toast} onClose={clear} />
    </Page>
  );
}
