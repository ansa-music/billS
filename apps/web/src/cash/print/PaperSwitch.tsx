import { useId } from 'react';
import { PAPERS, setPaper, usePaper } from './paper.ts';
import './print.css';

/** «Принтер: 58 мм / 80 мм» — remembered on this device. */
export function PaperSwitch() {
  const paper = usePaper();
  const labelId = useId();
  return (
    <div className="paper-switch" role="group" aria-labelledby={labelId}>
      <span id={labelId} className="hint">
        Принтер:
      </span>
      {PAPERS.map((p) => (
        <button
          key={p}
          type="button"
          className="paper-opt"
          aria-pressed={paper === p}
          title={`Чековая лента ${p} мм`}
          onClick={() => setPaper(p)}
        >
          {p} мм
        </button>
      ))}
    </div>
  );
}
