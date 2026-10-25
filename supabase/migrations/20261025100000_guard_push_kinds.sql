-- «Сторож»: alert kinds about suspicious operations at the till (apps/hub/src/guard.ts).
-- PUSH_KINDS of packages/domain/src/push.ts, in the cabinet's order; `guard` marks the «Сторож» kinds.
-- The HUB raises them like any alert (`alert.raised`), the sync projection queues them for push and Telegram.

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
    {"kind": "OTHER", "label": "Прочие тревоги", "defaultOn": false}
  ]'::jsonb
$$;
