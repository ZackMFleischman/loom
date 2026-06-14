import { CssBaseline, GlobalStyles, ThemeProvider } from "@mui/material";
import { createRoot } from "react-dom/client";
import { EngineLink } from "../engine-link";
import { EngineProvider } from "../hooks";
import { theme } from "../theme";
import { ConsoleApp } from "./ConsoleApp";

// One link per tab; the random prefix keeps sibling tabs from resolving
// each other's responses on the shared channel.
const link = new EngineLink({ prefix: `c${Math.random().toString(36).slice(2, 8)}-` });

createRoot(document.getElementById("root")!).render(
  <ThemeProvider theme={theme}>
    <CssBaseline />
    <GlobalStyles
      styles={{
        "@keyframes learnpulse": { from: { opacity: 1 }, to: { opacity: 0.45 } },
      }}
    />
    <EngineProvider value={link}>
      <ConsoleApp />
    </EngineProvider>
  </ThemeProvider>,
);
