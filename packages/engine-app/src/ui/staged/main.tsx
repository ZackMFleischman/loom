import { CssBaseline, ThemeProvider } from "@mui/material";
import { createRoot } from "react-dom/client";
import { EngineLink } from "../engine-link";
import { EngineProvider } from "../hooks";
import { theme } from "../theme";
import { StagedApp } from "./StagedApp";

const link = new EngineLink({ prefix: `s${Math.random().toString(36).slice(2, 8)}-` });

createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <EngineProvider value={link}>
      <StagedApp />
    </EngineProvider>
  </ThemeProvider>,
);
