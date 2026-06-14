import { ToggleButton, ToggleButtonGroup } from "@mui/material";
import type { ParamDesc } from "./engine-link";
import { useEngine } from "./hooks";

/**
 * primary/secondary/own switch for the staged instance's palette.source
 * (R7.2). Rendered only when the staged manifest declares the param.
 * DOM contract: #palettesource with one <button> per label.
 */
export function PaletteSourceToggle({ instance, p }: { instance: string; p: ParamDesc }) {
  const link = useEngine();
  const labels = p.labels ?? ["primary", "secondary", "own"];
  return (
    <ToggleButtonGroup
      id="palettesource"
      exclusive
      size="small"
      value={Number(p.value)}
      onChange={(_, v) => {
        if (typeof v === "number") link.sendParam(instance, "palette.source", v);
      }}
    >
      {labels.map((l, i) => (
        <ToggleButton key={l} value={i} sx={{ py: 0, px: 1, fontSize: 11 }}>
          {l}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}
