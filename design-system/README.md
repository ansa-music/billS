# Дизайн-система TS

Копия дизайн-системы TS из артефакта https://claude.ai/artifact/EbxHQfxYGrfKH7ft1kazxH (он приватный: открыть его могут те, с кем им поделились). Описывает две поверхности: кабинет владельца (`apps/cloud-web`) и кассу (`apps/web`, включая экраны кофейни).

## Что где

- `project/README.md` — бренд-бук: принципы, голос, цвет, типографика, кофейня, компоненты.
- `project/tokens.json` — токены: 4 темы (`dark`, `light` — кабинет; `pos-dark`, `pos-light` — касса), отступы, радиусы, размеры, шрифты.
- `project/components/bundle.css` — стили обеих поверхностей. Кабинет действует по умолчанию, касса — при `<html data-surface="pos">`; экраны кофейни ещё ждут `data-business="cafe"`.
- `project/components/bundle.js` — `window.TS`: настоящие компоненты кабинета и `Pos*` из `apps/web/src/ui.tsx` (нужен React 18 на странице); `index.d.ts` — их типы.
- `project/components/<Имя>/` — карточки: `README.md` с правилами и `preview.html`. Карточки кофейни — статичные копии живых экранов.
- `project/assets/`, `project/fonts/`, `project/licenses/` — марки, иконки, шрифт Inter (OFL).
- `project/design-system.json` — индекс артефакта (id загруженных картинок).

## Пересобрать после изменений в коде

Из корня репозитория:

```bash
node design-system/scripts/build-css.cjs
node design-system/scripts/build-bundle.mjs
```

- `build-css.cjs` собирает `bundle.css` из `apps/cloud-web/src/styles.css` и всех стилей `apps/web/src` в том порядке, в каком их подключает касса. Если в `apps/web` появится новый файл стилей, добавьте его в `POS_FILES` на своё место (порядок виден в `<head>` запущенной кассы: теги `style[data-vite-dev-id]`).
- `build-bundle.mjs` собирает `bundle.js` из компонентов; список компонентов для карточек — `names` в скрипте.
- Руками обновляются `tokens.json` (если поменялись блоки `:root` в стилях) и карточки.
- Снять экраны кофейни заново: стенд `ds-cafe` из `.claude/launch.json` (чистая демо-база), вход — «Войти как директор».

Опубликовать обновление в артефакт — попросить Claude Code: «опубликуй design-system/project в артефакт дизайн-системы».
