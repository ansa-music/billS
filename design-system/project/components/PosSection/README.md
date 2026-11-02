# PosSection

Панель раздела кассы с заголовком. Живой компонент `TS.PosSection` (`Section` из `apps/web/src/ui.tsx`) рисует `section.panel.section` со строкой `.panel-head`.

- Потребитель даёт необязательные `title` и `aside` (правый край шапки: тег, счётчик, маленькая кнопка), `id` и содержимое. Без заголовка и `aside` шапки нет.
- Панель кассы: `surface`, рамка `border`, радиус `radius`, тень `shadow-sm` (почти плоская), отступ `space-18px`, промежуток `space-3`. Заголовок — `pos-panel-title` (17px/700).
- Две панели в ряд — `.grid-2` (с 900px).
