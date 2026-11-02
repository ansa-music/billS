# Field

Поле с подписью, флажок и ошибки формы. CSS-паттерны `.field`, `.check`, `.form-errors`, `.form-error` и базовые `input`/`select` из `bundle.css`.

- `label.field` — подпись `span` (14px, `muted`) над полем, промежуток `space-1`. Поле — `surface-2`, рамка `border`, радиус `radius-sm`, высота `control-input` (40px), текст `text`. Растягивается — `.field.grow` (от 200px).
- `label.check` — флажок 18px с `accent-color: accent` и подпись 14px строчными.
- Ошибки: под полем — `.form-error` (`danger`, 14px); над кнопкой — список `ul.form-errors` на `danger-soft`. Ошибка говорит, что сделать: «Укажите почту — на неё будет вход».
- Подсказка под полями — `p.hint` (13px, `muted`). Фокус — кольцо `accent` 2px с отступом 2px. Рамка поля слабее 3:1 — поле узнаётся по заливке.
- Группа полей — `fieldset.lic-fieldset` с `legend` 13px `muted`, рамка `border`, радиус `radius-md`.
