import type { InsightCard, InsightSeverity, InsightsView } from '@bills/domain';
import { INSIGHTS_MIN_HISTORY_DAYS } from '@bills/domain';
import type { IconName } from '../icons.tsx';
import { Icon } from '../icons.tsx';
import { useInsights } from './useInsights.ts';
import './insights.css';

const ICON: Record<InsightSeverity, IconName> = { warn: 'alert', tip: 'lamp', good: 'check' };
const LABEL: Record<InsightSeverity, string> = { warn: 'Внимание', tip: 'Совет', good: 'Хорошая новость' };

/**
 * «Умные подсказки» block: up to five cards from GET /api/insights, each with an icon by
 * severity, a one-line title, the numbers behind it and an optional button. `frame` picks
 * the look of the page it sits on: `card` (sections: Stats, cafe Reports) or `panel` (Owner).
 * Renders nothing for staff who may not see it.
 */
export function InsightsPanel({ frame = 'card' }: { frame?: 'card' | 'panel' }) {
  const { allowed, data, error, reload } = useInsights();
  if (!allowed) return null;
  return (
    <section className={frame === 'card' ? 'section-card insights' : 'panel section insights'} aria-labelledby="insights-title">
      <header className="insights-head">
        <h2 id="insights-title">Умные подсказки</h2>
        <span className="insights-note">по продажам за 4 недели · без интернета</span>
      </header>
      {data ? (
        <InsightsBody view={data} />
      ) : error ? (
        <p className="insights-error" role="alert">
          Не удалось загрузить подсказки: {error}{' '}
          <button type="button" className="btn btn-small" onClick={() => void reload()}>
            Повторить
          </button>
        </p>
      ) : (
        <p className="insights-empty">Загрузка…</p>
      )}
    </section>
  );
}

function InsightsBody({ view }: { view: InsightsView }) {
  if (view.cards.length === 0) {
    const early = view.historyDays < INSIGHTS_MIN_HISTORY_DAYS;
    return (
      <div className="insights-empty">
        <Icon name="lamp" size={24} />
        <div>
          <p className="insights-empty-title">
            {early ? 'Подсказки появятся, когда накопится неделя продаж' : 'Всё идёт ровно — подсказок пока нет'}
          </p>
          <p className="insights-empty-text">
            {early
              ? 'TS сам смотрит на часы пик, меню, средний чек и кассу и подскажет, что поправить.'
              : 'TS проверяет часы пик, меню, средний чек, отмены и кассу — как только что-то изменится, здесь появится совет.'}
          </p>
        </div>
      </div>
    );
  }
  return (
    <ul className="insights-list">
      {view.cards.map((c) => (
        <InsightItem key={c.id} card={c} />
      ))}
    </ul>
  );
}

function InsightItem({ card }: { card: InsightCard }) {
  return (
    <li className="insight" data-severity={card.severity}>
      <span className="insight-icon" aria-hidden="true">
        <Icon name={ICON[card.severity]} size={20} />
      </span>
      <div className="insight-body">
        <p className="insight-title">
          <span className="sr-only">{LABEL[card.severity]}: </span>
          {card.title}
        </p>
        <p className="insight-detail">{card.detail}</p>
      </div>
      {card.action && (
        <a className="btn btn-small insight-action" href={`#${card.action.route}`}>
          {card.action.label}
        </a>
      )}
    </li>
  );
}
