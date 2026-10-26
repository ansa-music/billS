-- TS on Supabase: «Онлайн-бронь столов» (packages/domain/src/booking.ts, apps/cloud/src/booking.ts).
-- Supabase only: the self-hosted cloud (apps/cloud, SQLite) has no public booking page.
-- A guest books on the cabinet's public page (#/book/<slug or clubId>) through the Edge Function
-- `booking` (verify_jwt = false); the owner sees and manages bookings through `owner`; the HUB pulls
-- them with GET /sync/bookings. Every table is for the service connection of the functions only:
-- RLS on, no policies, no grants — the cabinet never reads them through PostgREST.

-- One row per club that ever opened the settings. Off by default. `version` grows with every change
-- the HUB must see (a new booking, confirm, cancel, settings); /sync/events reports it as bookingsVersion.
CREATE TABLE IF NOT EXISTS public.club_booking (
  club_id TEXT PRIMARY KEY REFERENCES public.clubs(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  opens_at TEXT NOT NULL DEFAULT '12:00',
  closes_at TEXT NOT NULL DEFAULT '02:00',
  slot_minutes INTEGER NOT NULL DEFAULT 60,
  hold_minutes INTEGER NOT NULL DEFAULT 15,
  slug TEXT UNIQUE,
  version BIGINT NOT NULL DEFAULT 0,
  updated_at BIGINT NOT NULL
);

-- A guest's booking. table_kind NULL = «любой» стол; table_id is set by the HUB when the guest arrives.
-- status: PENDING (new) → CONFIRMED by the owner, CANCELLED by the owner, ARRIVED / NO_SHOW from the HUB.
-- The phone is personal data: shown to the owner and the club's staff only, never pushed.
CREATE TABLE IF NOT EXISTS public.bookings (
  id TEXT PRIMARY KEY,
  club_id TEXT NOT NULL REFERENCES public.clubs(id) ON DELETE CASCADE,
  starts_at BIGINT NOT NULL,
  minutes INTEGER NOT NULL,
  table_kind TEXT,
  guest_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING',
  table_id TEXT,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  status_at BIGINT,
  CONSTRAINT bookings_status CHECK (status IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'ARRIVED', 'NO_SHOW')),
  CONSTRAINT bookings_minutes CHECK (minutes > 0 AND minutes <= 720)
);
CREATE INDEX IF NOT EXISTS ix_bookings_club_start ON public.bookings (club_id, starts_at);
CREATE INDEX IF NOT EXISTS ix_bookings_club_phone ON public.bookings (club_id, phone);

-- Rate limit of the public function: one row per attempt, keyed by sha256 of 'ip:<address>' or
-- 'phone:<club>:<number>'; rows older than a day are deleted.
CREATE TABLE IF NOT EXISTS public.booking_attempts (
  id TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_booking_attempts_key_at ON public.booking_attempts (key_hash, at);

ALTER TABLE public.club_booking ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bookings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.booking_attempts ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.club_booking, public.bookings, public.booking_attempts FROM PUBLIC, anon, authenticated;

-- The owner's push rules know the new kind (PUSH_KINDS of packages/domain/src/push.ts, in order).
CREATE OR REPLACE FUNCTION ts_internal.push_kinds() RETURNS jsonb
LANGUAGE sql IMMUTABLE SET search_path = '' AS $$
  SELECT '[
    {"kind": "LIGHT_WITHOUT_GAME", "label": "Свет горит без игры", "defaultOn": true},
    {"kind": "LAMP_DARK_DURING_GAME", "label": "Игра идёт без света", "defaultOn": true},
    {"kind": "POWER_ON_BATTERY", "label": "Нет электричества, клуб на ИБП", "defaultOn": true},
    {"kind": "POWER_CRITICAL", "label": "Батарея ИБП почти разряжена", "defaultOn": true},
    {"kind": "HUB_OFFLINE", "label": "HUB клуба пропал со связи", "defaultOn": true},
    {"kind": "SHIFT_NOT_CLOSED", "label": "Кассовая смена не закрыта", "defaultOn": true},
    {"kind": "UPS_UNREACHABLE", "label": "ИБП не отвечает", "defaultOn": false},
    {"kind": "LAMP_FAILED", "label": "Лампа не включилась или не выключилась", "defaultOn": false},
    {"kind": "PREPAID_NOT_STARTED", "label": "Оплаченная игра не началась", "defaultOn": false},
    {"kind": "REFUND_SUSPICIOUS", "label": "Крупный или поздний возврат", "defaultOn": true, "guard": true},
    {"kind": "CANCELS_ABOVE_NORMAL", "label": "Много отмен за смену", "defaultOn": true, "guard": true},
    {"kind": "CASH_DISCREPANCY", "label": "Расхождение кассы при закрытии смены", "defaultOn": true, "guard": true},
    {"kind": "MANUAL_MODE_LONG", "label": "Ручной режим ламп включён давно", "defaultOn": true, "guard": true},
    {"kind": "DISCOUNTS_ABOVE_NORMAL", "label": "Большая скидка или много скидок", "defaultOn": true, "guard": true},
    {"kind": "TABLE_REOPENED_QUICKLY", "label": "Стол закрыли и сразу открыли снова", "defaultOn": true, "guard": true},
    {"kind": "BOOKING_NEW", "label": "Новая онлайн-бронь", "defaultOn": true},
    {"kind": "OTHER", "label": "Прочие тревоги", "defaultOn": false}
  ]'::jsonb
$$;
