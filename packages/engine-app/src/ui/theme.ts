import { createTheme } from "@mui/material/styles";

/** Numbers, wordmark, readouts — the instrument face is monospace. */
export const mono = "ui-monospace, 'Cascadia Mono', Consolas, monospace";

/**
 * Button taxonomy (console-ui-refactor FR-2). A custom `intent` prop selects one
 * of four named control weights so importance reads at a glance and per-button
 * `sx` sizing disappears from call sites. This is the whole vocabulary — keep it
 * to four:
 *
 *  - **default** — everyday controls (RACK, PREVIEW resting, tap, projects,
 *    stage/unstage, nav). The theme default; what you get with no intent.
 *  - **primary** — the commit-path verbs (COMMIT, GO LIVE): filled accent, heavy.
 *  - **ghost** — out-of-flow nav links (`output ⧉`, `staged ⧉`): borderless,
 *    secondary text, clearly lighter than a real verb.
 *  - **danger** — PANIC: the error palette, heavy; `contained` while engaged.
 *
 * Q2 (how loud should danger/primary read): defaulting to weight + outline at
 * rest and FILL only on the active/engaged state (COMMIT/GO LIVE are filled
 * because they're one-shot verbs; PANIC fills only while panicked). Flagged for
 * the performer to dial louder if they want resting fills.
 */
declare module "@mui/material/Button" {
  interface ButtonPropsVariantOverrides {
    primary: true;
    ghost: true;
    danger: true;
  }
}

/** Dark cockpit theme — palette carried over from the old console.html CSS vars. */
export const theme = createTheme({
  palette: {
    mode: "dark",
    background: { default: "#0b0c10", paper: "#14161c" },
    divider: "#262a33",
    text: { primary: "#c8cdd8", secondary: "#6b7280" },
    primary: { main: "#3ddc97" }, // accent
    warning: { main: "#f3c969" },
    error: { main: "#e6455a" },
  },
  typography: {
    fontFamily: "system-ui, sans-serif",
    fontSize: 12,
  },
  components: {
    MuiButton: {
      defaultProps: { variant: "outlined", size: "small", color: "inherit" },
      // Validators compare button textContent ("stage"/"unstage"/"cc21") —
      // uppercase/weight styling is CSS-only and harmless, but keep labels
      // readable and NEVER change the text itself.
      styleOverrides: { root: { textTransform: "none", padding: "1px 8px", minWidth: 0, lineHeight: 1.6 } },
      // The taxonomy. Encoded ONCE here; call sites pass `variant="primary|ghost|
      // danger"` (or nothing for default) instead of hand-tuned sizing sx.
      variants: [
        {
          props: { variant: "primary" },
          style: {
            border: "1px solid",
            borderColor: "rgba(61,220,151,0.5)",
            color: "#3ddc97",
            fontWeight: 700,
            padding: "2px 14px",
            "&:hover": { borderColor: "#3ddc97", backgroundColor: "rgba(61,220,151,0.08)" },
            "&.Mui-disabled": { border: "1px solid rgba(61,220,151,0.18)", color: "rgba(61,220,151,0.35)" },
          },
        },
        {
          props: { variant: "ghost" },
          style: {
            border: "1px solid transparent",
            color: "#6b7280",
            fontWeight: 400,
            "&:hover": { color: "#c8cdd8", backgroundColor: "rgba(255,255,255,0.04)" },
          },
        },
        {
          props: { variant: "danger" },
          style: {
            border: "1px solid",
            borderColor: "rgba(230,69,90,0.6)",
            color: "#e6455a",
            fontWeight: 700,
            "&:hover": { borderColor: "#e6455a", backgroundColor: "rgba(230,69,90,0.1)" },
          },
        },
      ],
    },
    MuiTextField: { defaultProps: { size: "small" } },
  },
});
