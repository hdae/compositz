import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { App } from "./App";
import { ThemeProvider } from "./theme/ThemeProvider";
import { applyThemeClass, readStoredTheme } from "./theme/theme";

// Apply the saved theme before the first paint so there is no light-then-dark flash.
applyThemeClass(readStoredTheme());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </StrictMode>,
);
