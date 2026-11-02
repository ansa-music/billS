# DataGrid

Таблица отчётов — смены, игры, сотрудники. CSS-паттерн `table.grid` (`apps/cloud-web/src/Shifts.tsx` и др.) в обёртке `.grid-wrap`, которая прокручивается по горизонтали и выходит к краям панели.

- Заголовки — `overline` 12px/600, `muted`, ВЕРХНИЙ РЕГИСТР; строки разделены `border` сверху; ячейка 8×10px, текст 14px. Таблица смен плотнее: `.shifts-grid`, 13px, 7×8px.
- Числа — в ячейках `.num`: по правому краю, `tabular-nums`, без переноса. Две строки в ячейке — `.cell-stack` с `.cell-sub` (12px, `muted`).
- Состояния строки: `data-open` — открытая смена, фон `lamp` 7%; `data-mismatch` — полоса `danger` 3px слева; `data-ongoing` — фон `danger` 8%. Итоги — `tfoot .total-row`: рамка 2px, `surface-2`, 650.
- Длинную заметку обрезайте `.note` (до 220px, многоточие). Сумму по способам — `MethodSplit`, расхождение — `Difference`.
