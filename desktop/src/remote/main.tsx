import React from "react";
import ReactDOM from "react-dom/client";
import { connect } from "./client";
import { RemoteApp } from "./RemoteApp";
import "./remote.css";

// A phone has no console to read, so anything that breaks the page is shown on it.
function showError(error: unknown) {
  const box = document.getElementById("remoteError") ?? document.body.appendChild(Object.assign(document.createElement("pre"), { id: "remoteError" }));
  box.textContent += `${error instanceof Error ? `${error.message}\n${error.stack ?? ""}` : String(error)}\n\n`;
}
window.addEventListener("error", event => showError(event.error ?? event.message));
window.addEventListener("unhandledrejection", event => showError(event.reason));

class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: unknown) { showError(error); }
  render() { return this.state.failed ? null : this.props.children; }
}

try {
  connect();
  ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
    <React.StrictMode>
      <ErrorBoundary>
        <RemoteApp />
      </ErrorBoundary>
    </React.StrictMode>,
  );
} catch (error) {
  showError(error);
}
