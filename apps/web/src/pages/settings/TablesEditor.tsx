import { useState } from 'react';
import type { ClubAdminView, TableAdminView, TableKind } from '@bills/domain';
import { KIND_LABEL } from '../../format.ts';
import { Empty, Field, Modal, Section } from '../../ui.tsx';
import type { SectionProps } from './shared.tsx';

const KINDS: TableKind[] = ['pool', 'russian', 'snooker'];

interface TableForm {
  name: string;
  kind: TableKind;
  lampChannel: string;
  defaultTariffId: string;
}

/** «Столы»: list, order, on/off, add and edit dialogs. */
export function TablesEditor({ club, online, isBusy, run, onSaved, reload, canEdit }: SectionProps & { canEdit: boolean }) {
  const [editing, setEditing] = useState<TableAdminView | 'new' | null>(null);
  const disabled = !canEdit || !online;
  const activeTariffs = club.tariffs.filter((t) => t.isActive);
  const tariffName = (id: string) => club.tariffs.find((t) => t.id === id)?.name ?? '—';

  // After a table command the whole club is re-read: tariff counts change too.
  const update = async (table: TableAdminView, patch: object, message = 'Сохранено') => {
    const res = await run<TableAdminView>(`table:${table.id}`, `/api/tables/${table.id}/update`, patch);
    if (res) await reload(message);
  };

  const move = async (index: number, dir: -1 | 1) => {
    const ids = club.tables.map((t) => t.id);
    const j = index + dir;
    if (j < 0 || j >= ids.length) return;
    [ids[index], ids[j]] = [ids[j]!, ids[index]!];
    const res = await run<{ tables: TableAdminView[] }>('reorder', '/api/tables/reorder', { tableIds: ids });
    if (res) onSaved({ ...club, tables: res.tables }, 'Порядок сохранён');
  };

  return (
    <Section
      title={`Столы (${club.tables.filter((t) => t.isActive).length} в зале)`}
      aside={
        <button type="button" className="btn btn-small btn-primary" disabled={disabled || activeTariffs.length === 0} onClick={() => setEditing('new')}>
          + Добавить стол
        </button>
      }
    >
      {activeTariffs.length === 0 && <p className="hint">Сначала создайте хотя бы один тариф.</p>}
      {club.tables.length === 0 ? (
        <Empty>Столов пока нет.</Empty>
      ) : (
        <div className="table-wrap">
          <table className="table tables-editor">
            <thead>
              <tr>
                <th className="num">#</th>
                <th>Стол</th>
                <th>Вид</th>
                <th>Канал лампы</th>
                <th>Тариф по умолчанию</th>
                <th>Статус</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {club.tables.map((t, i) => {
                const busy = isBusy(`table:${t.id}`) || isBusy('reorder');
                return (
                  <tr key={t.id} data-inactive={t.isActive ? undefined : ''}>
                    <td className="num">
                      <div className="reorder">
                        <button type="button" className="btn btn-small btn-ghost" aria-label="Выше" disabled={disabled || busy || i === 0} onClick={() => void move(i, -1)}>
                          ▲
                        </button>
                        <button type="button" className="btn btn-small btn-ghost" aria-label="Ниже" disabled={disabled || busy || i === club.tables.length - 1} onClick={() => void move(i, 1)}>
                          ▼
                        </button>
                      </div>
                    </td>
                    <td>
                      <strong>{t.name}</strong>
                      {t.busy && <span className="tag tag-warn tables-tag">идёт игра</span>}
                    </td>
                    <td>{KIND_LABEL[t.kind]}</td>
                    <td>
                      <code>{t.lampChannel}</code>
                    </td>
                    <td>
                      <select
                        aria-label={`Тариф для ${t.name}`}
                        value={t.defaultTariffId}
                        disabled={disabled || busy}
                        onChange={(e) => void update(t, { defaultTariffId: e.target.value })}
                      >
                        {activeTariffs.map((x) => (
                          <option key={x.id} value={x.id}>
                            {x.name}
                          </option>
                        ))}
                        {!activeTariffs.some((x) => x.id === t.defaultTariffId) && (
                          <option value={t.defaultTariffId}>{tariffName(t.defaultTariffId)} (выключен)</option>
                        )}
                      </select>
                    </td>
                    <td>
                      {t.isActive ? <span className="tag tag-ok">в зале</span> : <span className="tag tag-muted">выключен</span>}
                    </td>
                    <td>
                      <div className="actions">
                        <button type="button" className="btn btn-small" disabled={disabled || busy} onClick={() => setEditing(t)}>
                          Изменить
                        </button>
                        {t.isActive ? (
                          <button
                            type="button"
                            className="btn btn-small btn-ghost"
                            disabled={disabled || busy || t.busy}
                            title={t.busy ? 'Идёт игра — сначала остановите её' : undefined}
                            onClick={() => void update(t, { isActive: false }, `${t.name} выключен`)}
                          >
                            Выключить
                          </button>
                        ) : (
                          <button type="button" className="btn btn-small btn-primary" disabled={disabled || busy} onClick={() => void update(t, { isActive: true }, `${t.name} снова в зале`)}>
                            Включить
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="hint">
        Канал лампы — номер реле на контроллере, к которому подключён свет стола. Выключенный стол не показывается в зале, его история остаётся.
      </p>
      {editing && (
        <TableDialog
          club={club}
          table={editing === 'new' ? null : editing}
          busy={isBusy(editing === 'new' ? 'table:new' : `table:${editing.id}`)}
          onClose={() => setEditing(null)}
          onSubmit={async (form) => {
            if (editing === 'new') {
              const res = await run<TableAdminView>('table:new', '/api/tables', form);
              if (!res) return;
              setEditing(null);
              await reload(`${res.name} добавлен`);
            } else {
              const res = await run<TableAdminView>(`table:${editing.id}`, `/api/tables/${editing.id}/update`, form);
              if (!res) return;
              setEditing(null);
              await reload('Сохранено');
            }
          }}
        />
      )}
    </Section>
  );
}

function TableDialog({
  club,
  table,
  busy,
  onClose,
  onSubmit,
}: {
  club: ClubAdminView;
  table: TableAdminView | null;
  busy: boolean;
  onClose: () => void;
  onSubmit: (form: TableForm) => Promise<void>;
}) {
  const activeTariffs = club.tariffs.filter((t) => t.isActive);
  const usedChannels = new Set(club.tables.filter((t) => t.id !== table?.id).map((t) => t.lampChannel));
  const usedNames = new Set(club.tables.filter((t) => t.isActive && t.id !== table?.id).map((t) => t.name));
  const [form, setForm] = useState<TableForm>(() =>
    table
      ? { name: table.name, kind: table.kind, lampChannel: table.lampChannel, defaultTariffId: table.defaultTariffId }
      : {
          name: `Стол ${club.tables.length + 1}`,
          kind: 'pool',
          lampChannel: nextChannel(club.tables),
          defaultTariffId: activeTariffs[0]?.id ?? '',
        },
  );
  const name = form.name.trim();
  const channel = form.lampChannel.trim();
  const nameError = !name ? 'Введите название' : usedNames.has(name) ? 'Такой стол уже есть' : null;
  const channelError = !channel ? 'Укажите канал' : usedChannels.has(channel) ? 'Канал занят другим столом' : null;
  const ok = !nameError && !channelError && form.defaultTariffId;

  return (
    <Modal open title={table ? `Стол: ${table.name}` : 'Новый стол'} onClose={onClose}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault();
          if (ok) void onSubmit({ ...form, name, lampChannel: channel });
        }}
      >
        <Field label="Название" error={nameError}>
          <input autoFocus value={form.name} maxLength={40} onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))} />
        </Field>
        <div className="form-row">
          <Field label="Вид">
            <select value={form.kind} onChange={(e) => setForm((f) => ({ ...f, kind: e.target.value as TableKind }))}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Канал лампы" hint="Реле на контроллере, например relay-7" error={channelError}>
            <input value={form.lampChannel} maxLength={40} onChange={(e) => setForm((f) => ({ ...f, lampChannel: e.target.value }))} />
          </Field>
        </div>
        <Field label="Тариф по умолчанию">
          <select value={form.defaultTariffId} onChange={(e) => setForm((f) => ({ ...f, defaultTariffId: e.target.value }))}>
            {activeTariffs.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <div className="row wrap modal-actions">
          <button type="button" className="btn btn-ghost" onClick={onClose} disabled={busy}>
            Отмена
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || !ok}>
            {busy ? 'Сохраняем…' : table ? 'Сохранить' : 'Добавить'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** relay-7 after relay-1…relay-6; otherwise an empty field. */
function nextChannel(tables: TableAdminView[]): string {
  let max = 0;
  let prefix: string | null = null;
  for (const t of tables) {
    const m = /^(.*?)(\d+)$/.exec(t.lampChannel);
    if (!m) continue;
    const n = Number(m[2]);
    if (n > max) {
      max = n;
      prefix = m[1] ?? '';
    }
  }
  return prefix === null ? '' : `${prefix}${max + 1}`;
}
