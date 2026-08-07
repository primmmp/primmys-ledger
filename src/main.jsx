import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
// Single source of truth: the app lives in the root ledger-prototype-v3.jsx
// (which exports the App component as default), so there's no duplicate copy.
import App from "../ledger-prototype-v3.jsx";

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <App />
  </StrictMode>
);
