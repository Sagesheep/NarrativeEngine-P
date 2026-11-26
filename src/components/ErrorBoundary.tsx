import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props { children: ReactNode; }
interface State { hasError: boolean; error: Error | null; }

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, error: null };

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info.componentStack);
  }

  handleReload = () => {
    this.setState({ hasError: false, error: null });
    window.location.reload();
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    return (
      <div className="flex flex-col items-center justify-center h-screen bg-void text-text-primary gap-4 p-8">
        <div className="text-terminal text-lg font-bold tracking-widest">SOMETHING WENT WRONG</div>
        <p className="text-text-dim text-xs max-w-md text-center leading-relaxed">
          The application hit an unexpected error. Your campaign data is safe on disk.
        </p>
        <pre className="text-danger text-[10px] bg-void-darker border border-border p-3 max-w-lg overflow-auto max-h-40 w-full">
          {this.state.error?.message}
        </pre>
        <button
          onClick={this.handleReload}
          className="px-4 py-2 bg-terminal/20 border border-terminal text-terminal text-xs
                     hover:bg-terminal/30 transition-colors tracking-wider"
        >
          RELOAD APPLICATION
        </button>
      </div>
    );
  }
}
