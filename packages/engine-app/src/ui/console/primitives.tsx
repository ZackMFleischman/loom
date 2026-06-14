import { Box, Stack, type StackProps, Typography } from "@mui/material";
import type { ReactNode } from "react";

/**
 * Shared console primitives (console-ui-refactor FR-3 / FR-5). One place for the
 * repeated LIVE/STAGED/SAFE state spelling and the repeated top-bar frame, so
 * their colors / weights / paddings live in a single source instead of being
 * re-typed (slightly divergently) across Header, StageStrip, PreviewMode,
 * ParamPanel and the tiles.
 */

type PillKind = "live" | "staged" | "safe";

/** The single source for state-pill color + weight (FR-3). */
const PILL_STYLE: Record<PillKind, { color: string; bg: string; fg: string; text: string }> = {
  // color = the caption/text color used inline; bg/fg = the filled tile-badge.
  live: { color: "error.main", bg: "error.main", fg: "#fff", text: "LIVE" },
  staged: { color: "warning.main", bg: "warning.main", fg: "#000", text: "STAGED" },
  safe: { color: "info.main", bg: "info.main", fg: "#000", text: "⛑ SAFE" },
};

/**
 * StatusPill — the one component for every LIVE / STAGED / SAFE label.
 *
 * Two presentations from one definition:
 *  - default ("caption"): the inline colored caption used in the stage strip,
 *    param-panel header, and preview header.
 *  - `variant="badge"`: the absolutely-positioned filled chip on a tile. It
 *    PRESERVES the DOM contract validators read: pass `badgeClass`
 *    (`live-badge` / `staged-badge` / `safe-badge`) and `show` so the
 *    `.badge.<kind>-badge` + ` show` class and exact text survive.
 *
 * `text` may be overridden (none of the validators assert this text, but the
 * stage strip already shows custom LIVE/STAGED captions); the default is the
 * canonical word for the kind.
 */
export function StatusPill({
  kind,
  variant = "caption",
  show = true,
  badgeClass,
  title,
  sx,
}: {
  kind: PillKind;
  variant?: "caption" | "badge";
  /** badge only: drives the `show` class + display, the tile contract. */
  show?: boolean;
  /** badge only: the validator class (`live-badge` | `staged-badge` | `safe-badge`). */
  badgeClass?: string;
  /** badge only: optional tooltip. */
  title?: string;
  sx?: object;
}) {
  const s = PILL_STYLE[kind];
  if (variant === "badge") {
    return (
      <Box
        component="span"
        className={`badge${badgeClass ? ` ${badgeClass}` : ""}${show ? " show" : ""}`}
        title={title}
        sx={{
          position: "absolute",
          top: 6,
          fontSize: 10,
          fontWeight: 700,
          borderRadius: "3px",
          px: 0.6,
          py: 0.2,
          lineHeight: 1.4,
          bgcolor: s.bg,
          color: s.fg,
          display: show ? "inline-block" : "none",
          ...sx,
        }}
      >
        {s.text}
      </Box>
    );
  }
  return (
    <Typography variant="caption" sx={{ color: s.color, fontWeight: 700, ...sx }}>
      {s.text}
    </Typography>
  );
}

/**
 * TopBar — the shared `px·py·borderBottom` cockpit bar (FR-5). Header,
 * StageStrip, and PreviewMode's header all draw the same row; this factors the
 * style into one place so the rhythm stays consistent. It's a horizontal Stack
 * with the canonical bar chrome; pass any Stack props (id, spacing, component).
 */
export function TopBar({ children, sx, ...rest }: { children: ReactNode; sx?: object } & StackProps) {
  return (
    <Stack
      direction="row"
      alignItems="center"
      sx={{
        px: 1.25,
        py: 0.5,
        bgcolor: "background.paper",
        borderBottom: 1,
        borderColor: "divider",
        flex: "0 0 auto",
        ...sx,
      }}
      {...rest}
    >
      {children}
    </Stack>
  );
}
