import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./scrollbars.css";

document.documentElement.dataset.platform = navigator.userAgent.includes(
  "Windows",
)
  ? "windows"
  : "other";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
