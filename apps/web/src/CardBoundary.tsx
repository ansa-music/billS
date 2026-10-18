import { Component } from 'react';
import type { ReactNode } from 'react';

interface Props {
  name: string;
  /** A new value (fresh HUB state) retries rendering. */
  resetKey: unknown;
  children: ReactNode;
}

/** One broken table card must not blank the whole hall screen. */
export class CardBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: unknown): void {
    console.error(error);
  }

  override componentDidUpdate(prev: Props): void {
    if (this.state.failed && prev.resetKey !== this.props.resetKey) this.setState({ failed: false });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <article className="card" data-state="error" aria-label={this.props.name}>
        <div className="felt">
          <div className="felt-title">
            <h2>{this.props.name}</h2>
          </div>
        </div>
        <div className="card-body">
          <p className="status">Не удалось показать стол</p>
          <p className="hint">Игра и лампа продолжают работать в HUB. Обновите страницу.</p>
        </div>
      </article>
    );
  }
}
