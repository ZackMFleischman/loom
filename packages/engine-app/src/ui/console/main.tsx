import { CssBaseline, GlobalStyles, ThemeProvider } from "@mui/material";
import { createRoot } from "react-dom/client";
import { captureConsole } from "../../console-capture";
import { EngineLink } from "../engine-link";
import { EngineProvider } from "../hooks";
import { theme } from "../theme";
import { ConsoleApp } from "./ConsoleApp";

// One link per tab; the random prefix keeps sibling tabs from resolving
// each other's responses on the shared channel.
const link = new EngineLink({ prefix: `c${Math.random().toString(36).slice(2, 8)}-` });

// Reverse-envelope op (Phase 2): the engine relays the agent's screenshot_console
// here; we self-capture the cockpit in THIS page and reply. Approximate fidelity
// (FR-6); never blocks the Output render loop (FR-7).
link.onConsoleOp("screenshot_console", async (payload) => {
  const maxWidth = typeof payload.maxWidth === "number" ? payload.maxWidth : undefined;
  const { dataUrl, width, height } = await captureConsole(maxWidth);
  return {
    mime: "image/png" as const,
    base64: dataUrl.slice(dataUrl.indexOf(",") + 1),
    width,
    height,
    consoleId: link.consoleId,
  };
});

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
