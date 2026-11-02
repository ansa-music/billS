# PosButton

Кнопки кассы: обычная, главная, опасная (заливкой и контуром), прозрачная и жёлтая; маленькая, обычная и большая. CSS-паттерн `.btn` из `apps/web/src/styles.css` — в `bundle.css` под `data-surface="pos"`.

- `.btn` — `surface-2`, рамка `border`, 15px/650, высота `control` (44px; на сенсорном экране 52px), бока 18px, радиус `radius-md`. Под курсором — `surface-3` и `border-strong`.
- `.btn-primary` — одно главное действие: `accent`, текст `accent-text`, под курсором `accent-hover`. Растягивается (`flex: 1`), как и `btn-danger`, `btn-outline-danger` и `btn-ghost`. Чтобы не растягивалась — `.btn-narrow`.
- `.btn-danger` — необратимое (`danger`, текст `on-danger`); `.btn-outline-danger` — отмена заказа, контур `danger` 70%. `.btn-ghost` — «Отмена» рядом с главной. `.btn.btn-warn` — `warn`, текст `on-warn`.
- Размеры: `.btn-small` — `control-sm`, 14px, радиус `radius-sm`; `.btn-large` — `control-lg` (56px; 60px на сенсорном экране), 17px. В диалоге каждая кнопка не ниже `control-lg`.
- Под пальцем кнопка проседает до 97% за `--dur-fast` (90 мс); при reduced motion вместо этого темнеет. Недоступная — `opacity-disabled`.
- `.link` — подчёркнутая ссылка-кнопка цвета `text-2`, 14px/550. Подпись — глагол и сумма, если речь о деньгах: «Оплатить 2 950 ₸».
