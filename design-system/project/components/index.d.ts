// TS — компоненты кабинета владельца (apps/cloud-web/src, ansa-music/billS@b7fa004).
// window.TS; нужен React 18 на странице, components/bundle.css поверх tokens.css.
// Касса: apps/web/src/ui.tsx — компоненты с префиксом Pos.
import type * as React from 'react';

/** Деньги в минимальных единицах (тиын): 845000 → «8 450 ₸». */
export type Minor = number;

export interface PaymentTotals { cash: Minor; card: Minor; qr: Minor; total: Minor }

export interface PeriodStats {
  /** Оплачено минус возвраты, по дню оплаты — что реально взяла касса. */
  revenue: Minor;
  /** Начислено на «Стоп», по дню остановки; отменённые игры вычтены. */
  billed: Minor;
  games: number;
  playedSeconds: number;
  /** Оплаты по способам. */
  paid: PaymentTotals;
  refunded: Minor;
  checksPaid: number;
  discounts: Minor;
  /** revenue / checksPaid, 0 если чеков нет. */
  averageCheck: Minor;
  cancelledGames: number;
}

export interface HubStatus {
  id: string;
  name: string;
  /** Unix-время в мс, null — касса ещё не выходила на связь. */
  lastSeenAt: number | null;
  online: boolean;
  lastOutboxId: number | null;
  settingsVersion: number;
  /** Кабинет отправил настройки, касса их ещё не забрала. */
  pendingSettings: boolean;
}

export interface CloudAlertView {
  id: string;
  clubId: string;
  clubName: string;
  at: number;
  kind: string;
  tableId: string | null;
  tableName: string | null;
  message: string;
  resolvedAt: number | null;
}

export type LicenseState = 'active' | 'expiring' | 'last_day' | 'expired' | 'blocked' | 'not_yet' | 'wrong_hub' | 'missing' | 'invalid';

export interface LicenseStatus {
  state: LicenseState;
  readOnly: boolean;
  message: string | null;
  plan: string | null;
  companyName: string | null;
  validUntil: number | null;
  daysLeft: number | null;
  modules: Record<string, boolean>;
  maxClubs: number | null;
  maxTables: number | null;
  maxStaff: number | null;
  licenseId: string | null;
}

export interface BrandMarkProps { className?: string }
/** Монограмма TS на плашке brand-mark; 40px через .brand-mark. */
export declare function BrandMark(props: BrandMarkProps): React.ReactElement;

export interface CabinetNavProps {
  /** Текущий маршрут; активный раздел выводится из route.kind. */
  route: { kind: 'overview' | 'club' | 'shifts' | 'tariffs' | 'bookings' | 'start' | 'company' | 'staff' | 'staff-home' | 'phone' | 'apps' | string };
}
/** Разделы кабинета: вкладки на компьютере, нижняя панель на телефоне (до 700px). */
export declare function CabinetNav(props: CabinetNavProps): React.ReactElement;

export interface SectionProps { title: string; aside?: React.ReactNode; children: React.ReactNode }
/** Панель с заголовком и правым краем шапки. */
export declare function Section(props: SectionProps): React.ReactElement;

export interface StatTileProps {
  label: string;
  stats: PeriodStats;
  /** ISO-код валюты, например 'KZT'. */
  currency: string;
  /** Крупная плитка итогов: 30px, своя тень. */
  big?: boolean;
  /** Для карточки заведения: без строки игр и среднего чека. */
  compact?: boolean;
}
/** Плитка периода: выручка, начислено, нал/карта/QR, возвраты, чеки. */
export declare function StatTile(props: StatTileProps): React.ReactElement;

export interface MethodSplitProps { totals: PaymentTotals; currency: string; total?: boolean; className?: string }
/** «нал 12 000 ₸ · карта 8 000 ₸ · QR 1 500 ₸»; нулевые способы скрыты. */
export declare function MethodSplit(props: MethodSplitProps): React.ReactElement;

export interface DifferenceProps {
  /** Расхождение Z-отчёта; null — смена открыта, показывается «—». */
  value: number | null;
  currency: string;
  /** false — только число со знаком. */
  words?: boolean;
}
/** «сходится» зелёным, «излишек +X» / «недостача −X» красным. */
export declare function Difference(props: DifferenceProps): React.ReactElement;

export interface HubBadgeProps { hub: HubStatus | null; now: number }
/** Связь с кассой: «Касса на связи» / «Нет связи с кассой 12 мин» / «Касса не подключена» + «ждёт настройки». */
export declare function HubBadge(props: HubBadgeProps): React.ReactElement;

export interface LicenseChipProps { status: LicenseStatus | null | undefined }
/** Цветной чип состояния лицензии. */
export declare function LicenseChip(props: LicenseChipProps): React.ReactElement;
/** Чип + «до 31.12.2026 · осталось 40 дней». */
export declare function LicenseLine(props: LicenseChipProps): React.ReactElement;

export interface OfflineBannerProps { online: boolean }
/** Жёлтый баннер, пока нет связи с облаком; при online — ничего. */
export declare function OfflineBanner(props: OfflineBannerProps): React.ReactElement | null;

export interface AlertListProps {
  alerts: CloudAlertView[];
  /** IANA-зона для времени, по умолчанию UTC. */
  timezone?: string;
  /** Показывать название заведения перед текстом. */
  showClub?: boolean;
  emptyText?: string;
}
/** Список тревог: открытые — на danger-soft, закрытые — серые. */
export declare function AlertList(props: AlertListProps): React.ReactElement;

export interface CopyValueProps { value: string; label?: string; big?: boolean }
/** Значение моноширинным шрифтом и кнопка «Скопировать». */
export declare function CopyValue(props: CopyValueProps): React.ReactElement;

export interface CopyButtonProps { text: string; children: React.ReactNode }
/** Кнопка, которая копирует длинный текст, не показывая его. */
export declare function CopyButton(props: CopyButtonProps): React.ReactElement;

export interface ShownOnceProps { children: React.ReactNode; onDone: () => void; note?: React.ReactNode }
/** Секрет, который показывается один раз: предупреждение, значения, «Готово». */
export declare function ShownOnce(props: ShownOnceProps): React.ReactElement;

// ---- Касса (apps/web/src/ui.tsx). Нужен <html data-surface="pos"> и тема pos-dark / pos-light. ----

export interface PosSectionProps { title?: React.ReactNode; aside?: React.ReactNode; children: React.ReactNode; id?: string }
/** Панель раздела кассы (.panel.section); шапка — только если есть title или aside. */
export declare function PosSection(props: PosSectionProps): React.ReactElement;

export interface PosEmptyProps { children: React.ReactNode }
/** Пустой список одной строкой (.empty). */
export declare function PosEmpty(props: PosEmptyProps): React.ReactElement;

export interface PosSkeletonListProps { rows?: number; label?: string }
/** Заглушка загрузки размером со список. */
export declare function PosSkeletonList(props: PosSkeletonListProps): React.ReactElement;

export interface PosLoadingProps { online?: boolean }
/** Скелетон, а без связи — «Нет связи с кассой — ждём, данные появятся сами.» */
export declare function PosLoading(props: PosLoadingProps): React.ReactElement;

export interface PosFieldProps { label: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode; children: React.ReactNode }
/** Поле с подписью; error заменяет hint. */
export declare function PosField(props: PosFieldProps): React.ReactElement;

export interface PosSegmentedProps<T extends string> { value: T; options: Array<{ value: T; label: React.ReactNode }>; onChange: (value: T) => void; disabled?: boolean; label?: string }
/** Один из нескольких — ряд чипов с aria-pressed. */
export declare function PosSegmented<T extends string>(props: PosSegmentedProps<T>): React.ReactElement;

export interface PosToastProps { message: string | null; onClose: () => void }
/** Строка внизу по центру; тап закрывает. */
export declare function PosToast(props: PosToastProps): React.ReactElement | null;

export interface PosModalProps { open: boolean; title: React.ReactNode; onClose: () => void; children: React.ReactNode }
/** Нативный <dialog>: Escape и клик по фону закрывают. */
export declare function PosModal(props: PosModalProps): React.ReactElement;

export interface PosConfirmProps { open: boolean; title: React.ReactNode; text?: React.ReactNode; confirmLabel?: string; danger?: boolean; busy?: boolean; onConfirm: () => void; onCancel: () => void }
/** Подтверждение: «Отмена» и действие (красное при danger). */
export declare function PosConfirm(props: PosConfirmProps): React.ReactElement;

declare global {
  interface Window {
    TS: {
      BrandMark: typeof BrandMark;
      CabinetNav: typeof CabinetNav;
      Section: typeof Section;
      StatTile: typeof StatTile;
      MethodSplit: typeof MethodSplit;
      Difference: typeof Difference;
      HubBadge: typeof HubBadge;
      LicenseChip: typeof LicenseChip;
      LicenseLine: typeof LicenseLine;
      OfflineBanner: typeof OfflineBanner;
      AlertList: typeof AlertList;
      CopyValue: typeof CopyValue;
      CopyButton: typeof CopyButton;
      ShownOnce: typeof ShownOnce;
      PosSection: typeof PosSection;
      PosEmpty: typeof PosEmpty;
      PosSkeletonList: typeof PosSkeletonList;
      PosLoading: typeof PosLoading;
      PosField: typeof PosField;
      PosSegmented: typeof PosSegmented;
      PosToast: typeof PosToast;
      PosModal: typeof PosModal;
      PosConfirm: typeof PosConfirm;
    };
  }
}
