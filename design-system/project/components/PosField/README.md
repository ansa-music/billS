# PosField

Поле с подписью, подсказкой или ошибкой — формы кассы и её диалогов. Живой компонент `TS.PosField` (`Field` из `apps/web/src/ui.tsx`).

- Потребитель даёт `label`, сам элемент ввода в `children` и одно из двух: `hint` (`.hint`, 13px, `muted`) или `error` (`.field-error`, 13px, `danger`) — ошибка заменяет подсказку.
- Подпись — `pos-label` (14px/600, цвет `text`), промежуток `space-6px`. Поле — `surface-2`, рамка `border`, радиус `radius-sm`, высота `control`; под курсором рамка `border-strong`.
- Фокус поля — не контур, а двойное кольцо `--focus-ring`: 2px цвета `bg`, затем 2px `accent`, рамка `accent`. Ошибка — `aria-invalid="true"` и рамка `danger`.
- В диалоге поле вырастает до 52px и 18px текста: в iOS шрифт меньше 16px увеличивает страницу при фокусе.
