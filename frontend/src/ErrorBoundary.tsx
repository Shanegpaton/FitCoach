import { Component, type ReactNode } from 'react';

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) return <div className="startup" role="alert"><h1>Couldn’t open your training space.</h1><p>Check browser storage permissions and available space, then reload. Your saved data has not been cleared.</p><details><summary>Error details</summary>{this.state.error.message}</details><button className="button primary" onClick={() => window.location.reload()}>Reload app</button></div>;
    return this.props.children;
  }
}
