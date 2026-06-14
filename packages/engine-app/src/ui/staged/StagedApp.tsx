import { Box, Button, Stack, Typography } from "@mui/material";
import { Disconnected } from "../Disconnected";
import { PaletteSourceToggle } from "../PaletteSourceToggle";
import { useEngine, useEngineState, useThumb } from "../hooks";
import { fail } from "../util";

/**
 * /staged.html — a focused second-tab/-display view of the currently staged
 * instance (R9.3): big preview, COMMIT, unstage. DOM contract: #stagedname,
 * #fadeinfo, #unstage, #commit, #preview, #empty (display toggles, both
 * always rendered).
 */
export function StagedApp() {
  const { session: s, manifests, connected } = useEngineState();
  const link = useEngine();
  const staged = s?.staged ?? null;
  const thumb = useThumb(staged);
  const scene = staged != null ? s?.instances.find((i) => i.id === staged)?.scene : undefined;
  const name = staged == null ? "—" : scene && scene !== staged ? `${staged} · ${scene}` : staged;
  const has = staged != null;

  return (
    <Box sx={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <Stack
        direction="row"
        spacing={2}
        alignItems="center"
        component="header"
        sx={{ px: 1.75, py: 1, bgcolor: "background.paper", borderBottom: 1, borderColor: "divider", flex: "0 0 auto" }}
      >
        <Typography variant="caption" color="text.secondary">STAGED</Typography>
        <Typography id="stagedname" sx={{ fontWeight: 700 }}>{name}</Typography>
        <Typography id="fadeinfo" variant="caption" color="text.secondary">
          {s?.mix != null ? `crossfading ${(s.mix * 100).toFixed(0)}%` : ""}
        </Typography>
        {staged != null && manifests[staged]?.["palette.source"] != null && (
          <PaletteSourceToggle instance={staged} p={manifests[staged]!["palette.source"]!} />
        )}
        <Box sx={{ flex: 1 }} />
        <Button id="unstage" disabled={!has} onClick={() => void link.req("unstage").catch(fail)}>
          unstage
        </Button>
        <Button
          id="commit"
          color="primary"
          disabled={!has || s?.panicked === true}
          onClick={() => void link.req("commit", {}).catch(fail)}
          sx={{ fontWeight: 700, fontSize: 15, px: 2.5 }}
        >
          COMMIT
        </Button>
      </Stack>
      <Box
        id="view"
        sx={{ flex: 1, minHeight: 0, display: "flex", alignItems: "center", justifyContent: "center", bgcolor: "#000" }}
      >
        <Box
          component="img"
          id="preview"
          alt=""
          src={has ? thumb : undefined}
          sx={{
            // Same presentation as the Output window: fill the viewport,
            // cover-scaled (the stream is 16/9; edges crop on other ratios).
            width: "100%",
            height: "100%",
            objectFit: "cover",
            display: has && thumb ? "block" : "none",
          }}
        />
        <Typography id="empty" color="text.secondary" sx={{ display: has ? "none" : "block" }}>
          nothing staged — stage an instance from the Console
        </Typography>
      </Box>
      <Disconnected connected={connected} />
    </Box>
  );
}
