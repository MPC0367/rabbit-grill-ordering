// Keeps one failing page or sheet (or a chunk that could not load on a weak
// network) from blanking the whole guest interface.
import { Component, type ErrorInfo, type ReactNode } from 'react';

interface Props {
  /** Rendered instead of the children after an error. `reset` tries again. */
  fallback: (reset: () => void, error: unknown) => ReactNode;
  /** Changing this value clears the error (e.g. the route path). */
  resetKey?: unknown;
  children: ReactNode;
}

interface State {
  error: unknown;
  key: unknown;
}

export class ErrorBoundary extends Component<Props, State> {
  override state: State = { error: null, key: this.props.resetKey };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error ?? new Error('unknown') };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.key) return { error: null, key: props.resetKey };
    return null;
  }

  override componentDidCatch(error: unknown, info: ErrorInfo): void {
    console.error('[guest]', error, info.componentStack);
  }

  reset = () => this.setState({ error: null });

  override render(): ReactNode {
    if (this.state.error) return this.props.fallback(this.reset, this.state.error);
    return this.props.children;
  }
}
