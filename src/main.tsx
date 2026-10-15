import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import AiOsEntry from "./components/AiOsEntry";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    {import.meta.env.VITE_DEPDEK_OS === "1" ? <AiOsEntry><App /></AiOsEntry> : <App />}
  </React.StrictMode>,
);
