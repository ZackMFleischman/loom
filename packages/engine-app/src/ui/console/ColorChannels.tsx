import { Box, ToggleButton, ToggleButtonGroup } from "@mui/material";
import type { ParamDesc } from "../engine-link";
import { useEngine } from "../hooks";
import { fail } from "../util";
import { ParamWidget } from "./ParamWidget";

type Space = "hex" | "hsv" | "rgb";

/**
 * The expand control for a color param (R7.4): a hex / HSV / RGB switch that
 * decomposes the color into three 0..1 channel sliders (set_color_space).
 * Once decomposed, each channel is an ordinary float widget — modulatable (∿)
 * and MIDI-bindable (M) — and the color recomposes from them live. Used both
 * inline under an instance color param and under each global palette stop.
 *
 * DOM contract: [data-colorspace=<path>] toggle group, channels carry their
 * own data-path via ParamWidget.
 */
export function ColorChannels({
  instance,
  path,
  p,
  channels,
}: {
  instance: string;
  path: string;
  p: ParamDesc;
  /** The 3 channel [path, desc] pairs in order, or [] when collapsed (hex). */
  channels: Array<[string, ParamDesc]>;
}) {
  const link = useEngine();
  const space = (p.colorSpace ?? "hex") as Space;

  return (
    <Box sx={{ pl: 1, mt: 0.25 }}>
      <ToggleButtonGroup
        exclusive
        size="small"
        data-colorspace={path}
        value={space}
        onChange={(_, v: Space | null) => {
          if (v != null) void link.req("set_color_space", { instance, path, space: v }).catch(fail);
        }}
        sx={{ mb: space === "hex" ? 0 : 0.5 }}
      >
        {(["hex", "hsv", "rgb"] as const).map((s) => (
          <ToggleButton key={s} value={s} data-space-option={s} sx={{ py: 0, px: 1, fontSize: 10 }}>
            {s === "hex" ? "flat" : s.toUpperCase()}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {space !== "hex" &&
        channels.map(([cp, cd]) => (
          <ParamWidget
            key={cp}
            instance={instance}
            path={cp}
            p={cd}
            label={(cd.channel ?? cp).toUpperCase()}
            fill
            dense
          />
        ))}
    </Box>
  );
}

/** Ordered channel [path, desc] pairs for a decomposed color, from a manifest snapshot. */
export function gatherChannels(
  manifest: Record<string, ParamDesc> | undefined,
  path: string,
): Array<[string, ParamDesc]> {
  if (!manifest) return [];
  const out: Array<[string, ParamDesc]> = [];
  for (const ch of ["h", "s", "v", "r", "g", "b"]) {
    const cp = `${path}.${ch}`;
    const d = manifest[cp];
    if (d && d.channelOf === path) out.push([cp, d]);
  }
  return out;
}
