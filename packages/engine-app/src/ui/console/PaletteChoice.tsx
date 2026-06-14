import { Box, Stack, Tooltip } from "@mui/material";
import type { ParamDesc } from "../engine-link";
import { useEngine } from "../hooks";

/**
 * Visual palette chooser for a palette-index slider (a float/int param that
 * carries `swatches`): one gradient chip per selectable option, so you pick a
 * palette by SEEING its colors, never by guessing a number (R7.3). Clicking a
 * chip snaps the param to that option's integer index; the bare slider above
 * still rides fractional blends between presets. The chip nearest the current
 * value is ringed.
 *
 * DOM contract: #swatch-<path> wrapper, .swatchchip[data-swatch-index] chips.
 */
export function PaletteChoice({ instance, path, p }: { instance: string; path: string; p: ParamDesc }) {
  const link = useEngine();
  const swatches = p.swatches ?? [];
  if (swatches.length === 0) return null;
  const min = typeof p.min === "number" ? p.min : 0;
  const value = Number(p.value);
  // Options index from min upward; the live value rounds (and wraps) onto one.
  const selected = ((Math.round(value - min) % swatches.length) + swatches.length) % swatches.length;

  return (
    <Stack
      id={`swatch-${path}`}
      direction="row"
      flexWrap="wrap"
      sx={{ gap: 0.5, mt: 0.5, mb: 0.25 }}
    >
      {swatches.map((stops, i) => {
        const gradient = `linear-gradient(90deg, ${stops.join(", ")})`;
        const isSel = i === selected;
        return (
          <Tooltip key={i} title={`palette ${min + i}`} placement="top" enterDelay={300} disableInteractive>
            <Box
              className="swatchchip"
              data-swatch-index={i}
              role="button"
              aria-label={`palette ${min + i}`}
              aria-pressed={isSel}
              onClick={() => link.sendParam(instance, path, min + i)}
              sx={{
                flex: "1 1 36px",
                minWidth: 36,
                height: 18,
                borderRadius: 0.5,
                background: gradient,
                cursor: "pointer",
                boxShadow: isSel ? (t) => `0 0 0 2px ${t.palette.primary.main}` : "inset 0 0 0 1px #0006",
                outline: isSel ? "1px solid #000" : "none",
                transition: "box-shadow 80ms",
                "&:hover": { boxShadow: (t) => `0 0 0 2px ${t.palette.primary.light}` },
              }}
            />
          </Tooltip>
        );
      })}
    </Stack>
  );
}
