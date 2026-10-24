import React, { Component, type ErrorInfo, type ReactNode } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AiOsEntry from "./components/AiOsEntry";
import { DebugCaptureControls, RootErrorFallback } from "./components/DebugCapture";
import { captureDebugError, installGlobalErrorCapture } from "./lib/debugCapture";
import "./styles.css";

type BoundaryState = { error: Error | null; componentStack: string };
class RootErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null, componentStack: "" };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error, componentStack: "" };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    this.setState({ componentStack: info.componentStack ?? "" });
    captureDebugError("react.render", error, `${error.stack ?? ""}\n${info.componentStack ?? ""}`);
  }

  render(): ReactNode {
    if (this.state.error) return <RootErrorFallback error={this.state.error} componentStack={this.state.componentStack} onRetry={() => this.setState({ error: null, componentStack: "" })} />;
    return this.props.children;
  }
}

installGlobalErrorCapture();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RootErrorBoundary>
      {import.meta.env.VITE_DEPDEK_OS === "1" ? <AiOsEntry><App /></AiOsEntry> : <App />}
    </RootErrorBoundary>
    {import.meta.env.VITE_DEPDEK_DEBUG === "1" && <DebugCaptureControls />}
  </React.StrictMode>,
);
