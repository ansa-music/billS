# PosTag

Короткая метка состояния: «открыта», «частично», «нет в наличии», «выключен». CSS-паттерн `.tag` кассы из `bundle.css`.

- `.tag` — `surface-3`, текст `text-2`; `.tag-ok` — `accent-soft` и `accent-ink`; `.tag-warn` — `warn-soft` и `warn` с примесью `text`; `.tag-danger` — `danger-soft` и `danger`; `.tag-muted` — `surface-2` и `muted`.
- `pos-tag`: 12px/650, межстрочный 1.4, 2×8px, `radius-pill`, без переноса. Одно-три слова строчными.
- Цвет тега всегда дублирует слово: в светлой теме жёлтый и зелёный различаются хуже, чем в тёмной.
