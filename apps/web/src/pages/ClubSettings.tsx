import { useCallback, useEffect, useState } from 'react';
import type { ClubAdminView } from '@bills/domain';
import { fetchJson } from '../api.ts';
import { navigate, useLocation } from '../router.tsx';
import { Loading, Page, Toast, useToast } from '../ui.tsx';
import { useCommands, useHub } from '../useHub.tsx';
import { ClubSection } from './settings/ClubSection.tsx';
import { DisplaySettings } from './settings/DisplaySettings.tsx';
import { LicenseSection } from './settings/LicenseSection.tsx';
import { RulesSettings } from './settings/RulesSettings.tsx';
import { TablesEditor } from './settings/TablesEditor.tsx';
import { TariffsEditor } from './settings/TariffEditor.tsx';
import './settings.css';

const TABS = [
  { id: 'club', title: 'Клуб' },
  { id: 'tables', title: 'Столы' },
  { id: 'tariffs', title: 'Тарифы' },
  { id: 'display', title: 'Экран зала' },
  { id: 'rules', title: 'Правила' },
  { id: 'license', title: 'Лицензия' },
] as const;
type TabId = (typeof TABS)[number]['id'];

function isTab(value: string | null): value is TabId {
  return TABS.some((t) => t.id === value);
}

/** #/settings?tab=tables — club, tables, tariffs, hall screen look, house rules. */
export function ClubSettingsPage() {
  const { state, online, version, license, canNow: can, can: roleCan } = useHub();
  const tabs = TABS.filter((t) => t.id !== 'license' || roleCan('license.view'));
  const { query } = useLocation();
  const asked = query.get('tab');
  const tab: TabId = isTab(asked) && tabs.some((t) => t.id === asked) ? asked : 'club';
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
        return <ClubSection {...props} canEdit={can('club.edit')} />;
      case 'tables':
        return <TablesEditor {...props} canEdit={can('tables.edit')} />;
      case 'tariffs':
        return <TariffsEditor {...props} canEdit={can('tariffs.edit')} />;
      case 'display':
        return <DisplaySettings {...props} canEdit={can('display.edit')} />;
      case 'rules':
        return <RulesSettings {...props} canEdit={can('rules.edit')} />;
      case 'license':
        return null; // rendered below: it does not need GET /api/club
    }
  })();

  return (
    <Page title="Настройки клуба" subtitle={club ? `${club.name} · ${club.companyName}` : undefined}>
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
      {license?.readOnly && tab !== 'license' && (
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
      {tab !== 'license' && !club && !loadError && <Loading online={online} />}
      {tab !== 'license' && !club && loadError && <p className="empty">Не удалось загрузить настройки: {loadError}</p>}
      {club && !online && <p className="settings-offline">Нет связи с HUB — изменения пока нельзя сохранить.</p>}
      {section}
      <Toast message={toast} onClose={clear} />
    </Page>
  );
}
