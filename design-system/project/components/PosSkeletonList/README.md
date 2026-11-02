# PosSkeletonList

Заглушка загрузки размером со список: страница не прыгает, когда приходят данные. Живой компонент `TS.PosSkeletonList` (`SkeletonList` из `apps/web/src/ui.tsx`); рядом — `TS.PosLoading` и `TS.PosEmpty`.

- `PosSkeletonList` — `rows` строк (по умолчанию 3) и `label` для экранного диктора («Загрузка…»). Строка: квадрат 40px (`radius-md`), две линии 14px (`radius-xs`), короткая линия справа.
- Заливка — переход `skeleton` → `skeleton-hi` → `skeleton`, бежит за 1.3 с; при reduced motion стоит на месте.
- `PosLoading` — скелетон, а без связи (`online={false}`) — фраза «Нет связи с кассой — ждём, данные появятся сами.»
- `PosEmpty` — пустой список одной строкой `.empty` (`muted`): «Попыток входа ещё не было».
