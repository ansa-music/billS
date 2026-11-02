# StatusChip

Состояние игры за столом: «Включается», «Идёт», «На паузе», «Ждёт оплаты», «Оплачено», «Отменено», «Не началась». CSS-паттерн `.status-chip[data-status]`, подписи — `STATUS_LABEL` в `apps/cloud-web/src/format.ts`.

- Потребитель ставит `data-status` из `OPENING | ACTIVE | PAUSED | AWAITING_PAYMENT | CLOSED | CANCELLED | FAILED` и подпись.
- Цвета: идёт и включается — `lamp` с рамкой; пауза — `lamp` с пунктирной рамкой; ждёт оплаты — `warn`; оплачено — `accent`; отменено и не началась — `danger`.
- 12px/600, `radius-pill`, `surface-2`, рамка `border`. Используется в таблице игр.
