import { Box, Button, IconButton, NativeSelect, Stack, Typography } from "@mui/material";
import { useState, type ChangeEvent } from "react";
import type { ParamDesc } from "../engine-link";
import { useEngine } from "../hooks";
import { getPreset, listPresets, matchPreset, savePreset, type PaletteStops } from "../palette-presets";
import { ColorChannels, gatherChannels } from "./ColorChannels";

/**
 * The two global palettes as rows of five bare color swatches (R7) — no index
 * labels, no hex text; the hex lives in the native tooltip. Each row carries a
 * preset dropdown (applies a named 5-stop palette live) and "save as…" (names
 * the current stops). Editing writes "globals" params like everything else.
 * DOM contract: #palettes, .paletterow[data-name], input[type=color][data-path].
 */
export function Palettes({ globals }: { globals: Record<string, ParamDesc> }) {
  return (
    <Box id="palettes" sx={{ pt: 1 }}>
      <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: "0.08em" }}>
        GLOBAL PALETTES
      </Typography>
      {(["primary", "secondary"] as const).map((source) => (
        <PaletteRow key={source} source={source} globals={globals} />
      ))}
    </Box>
  );
}

function PaletteRow({
  source,
  globals,
}: {
  source: "primary" | "secondary";
  globals: Record<string, ParamDesc>;
}) {
  const link = useEngine();
  const [open, setOpen] = useState<Set<number>>(new Set());
  const stops = [0, 1, 2, 3, 4].map((i) => globals[`palette.${source}.${i}`]);
  if (stops.some((p) => p == null)) return null;
  const hexes = stops.map((p) => String(p!.value));
  const current = matchPreset(hexes);
  // A stop shows its channels when toggled open, or whenever it's decomposed.
  const isOpen = (i: number) => open.has(i) || (stops[i]!.colorSpace ?? "hex") !== "hex";
  const toggle = (i: number) =>
    setOpen((s) => {
      const next = new Set(s);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  const apply = (name: string) => {
    const preset = getPreset(name);
    if (!preset) return;
    preset.forEach((hex, i) => link.sendParam("globals", `palette.${source}.${i}`, hex));
  };
  const saveAs = () => {
    const name = window.prompt(`Save the ${source} palette as…`, current ?? "")?.trim();
    if (name) savePreset(name, hexes as PaletteStops);
  };

  return (
    <Box className="paletterow" data-name={source} sx={{ py: 0.5 }}>
      <Stack direction="row" spacing={0.75} alignItems="center">
        <Typography sx={{ width: 70, flex: "0 0 auto", fontWeight: 700 }}>{source}</Typography>
        {[0, 1, 2, 3, 4].map((i) => (
          <Stack key={i} alignItems="center" spacing={0.25}>
            <Swatch path={`palette.${source}.${i}`} p={stops[i]!} />
            <IconButton
              size="small"
              data-expand={`palette.${source}.${i}`}
              title={isOpen(i) ? "hide channels" : "split into HSV / RGB channels (modulate · MIDI)"}
              onClick={() => toggle(i)}
              sx={{
                p: 0,
                fontSize: 12,
                lineHeight: 1,
                color: (stops[i]!.colorSpace ?? "hex") !== "hex" ? "warning.main" : "text.secondary",
              }}
            >
              ∿
            </IconButton>
          </Stack>
        ))}
        <NativeSelect
          value={current ?? ""}
          sx={{ ml: 1, fontSize: 12 }}
          inputProps={{ title: "apply a named palette" }}
          onChange={(e) => apply(e.target.value)}
        >
          <option value="" disabled>
            {current ?? "custom…"}
          </option>
          {listPresets().map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </NativeSelect>
        <Button onClick={saveAs} title="name the current stops as a preset" sx={{ fontSize: 11 }}>
          save as…
        </Button>
      </Stack>
      {[0, 1, 2, 3, 4].filter(isOpen).map((i) => {
        const path = `palette.${source}.${i}`;
        return (
          <Box key={i} sx={{ mt: 0.5 }}>
            <Typography variant="caption" color="text.secondary">
              {source} · stop {i}
            </Typography>
            <ColorChannels
              instance="globals"
              path={path}
              p={stops[i]!}
              channels={gatherChannels(globals, path)}
            />
          </Box>
        );
      })}
    </Box>
  );
}

function Swatch({ path, p }: { path: string; p: ParamDesc }) {
  const link = useEngine();
  const hex = String(p.value);
  return (
    <Box
      component="input"
      type="color"
      value={hex}
      data-path={path}
      title={`${path} · ${hex}`}
      onChange={(e: ChangeEvent<HTMLInputElement>) => link.sendParam("globals", path, e.target.value)}
      sx={{
        width: 30,
        height: 30,
        p: 0,
        border: 1,
        borderColor: "divider",
        borderRadius: 1,
        bgcolor: "transparent",
        cursor: "pointer",
        "&::-webkit-color-swatch-wrapper": { p: "3px" },
        "&::-webkit-color-swatch": { border: "none", borderRadius: "2px" },
      }}
    />
  );
}
