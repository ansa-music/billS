import { MODULE_LABEL } from '@bills/domain';
import { Link } from '../router.tsx';
import { Page } from '../ui.tsx';
import { CABINET_URL } from './setup.ts';
import './onboarding.css';

/**
 * A coffee shop whose license lacks the «bar» module: the counter, the barista screen and the
 * order board all need it, so instead of a silent «Нет доступа» on each the POS explains once
 * what is missing and where to get it.
 */
export function CafeNeedsCounterModule({ canSeeLicense }: { canSeeLicense: boolean }) {
  return (
    <Page title="Касса кофейни не включена" subtitle="В лицензии заведения нет модуля, на котором работает касса.">
      <div className="license-hint">
        <p>
          Касса, экран бариста и экран заказов кофейни работают на модуле «{MODULE_LABEL.bar}». В лицензии вашего заведения его нет,
          поэтому принимать заказы пока нельзя.
        </p>
        <p>
          Пробный период и лицензия для кофейни включают этот модуль. Откройте кабинет и проверьте лицензию — или напишите в
          поддержку TS, мы включим модуль.
        </p>
        <div className="onboarding-actions">
          <a className="btn btn-primary" href={CABINET_URL} target="_blank" rel="noreferrer">
            Открыть кабинет
          </a>
          {canSeeLicense && (
            <Link className="btn" to="/settings" query={{ tab: 'license' }}>
              Лицензия на этой кассе
            </Link>
          )}
        </div>
      </div>
    </Page>
  );
}
