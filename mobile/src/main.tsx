import React, { Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";

class ErrorBoundary extends Component<
  { children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(_error: Error, _info: ErrorInfo) {
    /* Do not log private props, drafts or credential-bearing requests. */
  }
  render() {
    return this.state.failed ? (
      <main className="fatal-error">
        <h1>这次没能展开。</h1>
        <p>
          界面出现问题，没有自动重试任何操作。可以重新打开页面；未发送的输入会丢失。
        </p>
        <button onClick={() => window.location.reload()}>重新打开家合</button>
        <small>家合手机版 {__APP_VERSION__}</small>
      </main>
    ) : (
      this.props.children
    );
  }
}
createRoot(document.getElementById("root")!).render(
  <React.Fragment>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.Fragment>,
);
