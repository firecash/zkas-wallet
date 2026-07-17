import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { initDesktop } from "./desktop";
import "./styles.css";

// On desktop the embedded daemon's port/token must be installed BEFORE the app
// mounts (api.ts reads them at call time from localStorage). In the browser
// this resolves immediately to null.
initDesktop()
  .catch(() => null)
  .then(() => {
    createRoot(document.getElementById("root")!).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  });
