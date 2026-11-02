# PosSegmented

Выбор одного значения чипами: «Здесь / С собой», способ, режим. Живой компонент `TS.PosSegmented` (`Segmented` из `apps/web/src/ui.tsx`) — ряд `.seg-chips` из `.chip` с `aria-pressed`.

- Потребитель даёт `value`, `options` (`{ value, label }[]`), `onChange`, необязательные `label` (для `aria-label` группы) и `disabled`.
- Вид — как у `Chip`: выбранный с кольцом `accent` на `accent-soft`; промежуток `space-6px`, с переносом.
- Переключатель-«таблетка» зала (`.segmented` из `sections.css`) — другой компонент и в систему не перенесён.
