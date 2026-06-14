import { Box, Stack, Typography } from "@mui/material";
import type { SessionSnapshot } from "@loom/sidecar/protocol";
import type { ParamDesc } from "../engine-link";
import { Palettes } from "./Palettes";
import { ParamWidget } from "./ParamWidget";

type Props = { session: SessionSnapshot; globals: Record<string, ParamDesc> };

/**
 * The input rack drawer (R6.4): every channel with a live meter and its
 * global tuning widgets. Toggled on "i" (or the header button).
 * DOM contract: .rackrow[data-name], .rackfill with inline style.width.
 */
export function Rack({ session: s, globals }: Props) {
  const names = Object.keys(s.inputs).sort();
  return (
    <Box
      id="rack"
      sx={{
        flex: "0 0 auto",
        maxHeight: "42vh",
        overflowY: "auto",
        bgcolor: "background.paper",
        borderTop: 1,
        borderColor: "divider",
        px: 1.25,
        pt: 0.75,
        pb: 1,
      }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: "0.08em" }}>
        INPUT RACK · tune channels globally · <kbd>i</kbd> toggles
      </Typography>
      {names.map((name) => (
        <RackRow key={name} name={name} level={s.inputs[name] ?? 0} globals={globals} />
      ))}
      <Palettes globals={globals} />
    </Box>
  );
}

function RackRow({
  name,
  level,
  globals,
}: {
  name: string;
  level: number;
  globals: Record<string, ParamDesc>;
}) {
  const enabled = globals[`inputs.${name}.enabled`]?.value === true;
  const params = Object.entries(globals).filter(([path]) => path.startsWith(`inputs.${name}.`));
  return (
    <Stack
      direction="row"
      className={`rackrow${enabled ? " enabled" : ""}`}
      data-name={name}
      spacing={1.25}
      alignItems="center"
      sx={{ py: 0.5, borderBottom: 1, borderColor: "divider", "&:last-child": { borderBottom: 0 } }}
    >
      <Box
        className="rackmeter"
        sx={{
          width: 70,
          height: 8,
          flex: "0 0 auto",
          bgcolor: "#0006",
          border: 1,
          borderColor: "divider",
          borderRadius: "5px",
          overflow: "hidden",
        }}
      >
        <Box
          className="rackfill"
          sx={{ height: "100%", bgcolor: enabled ? "primary.main" : "warning.main" }}
          style={{ width: `${Math.min(100, level * 100)}%` }}
        />
      </Box>
      <Typography className="rackname" sx={{ width: 70, flex: "0 0 auto", fontWeight: 700 }}>
        {name}
      </Typography>
      <Box sx={{ display: "flex", gap: 1.25, flex: 1, flexWrap: "wrap" }}>
        {params.map(([path, p]) => (
          <ParamWidget
            key={path}
            instance="globals"
            path={path}
            p={p}
            label={path.slice(`inputs.${name}.`.length)}
            dense
          />
        ))}
      </Box>
    </Stack>
  );
}
