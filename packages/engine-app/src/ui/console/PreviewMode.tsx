import { Box, Button, NativeSelect, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import type { SessionSnapshot } from "@loom/sidecar/protocol";
import type { ParamDesc } from "../engine-link";
import { useEngine, usePreviewFrame, useThumb } from "../hooks";
import { fail } from "../util";
import { ParamPanel } from "./ParamPanel";

type Props = {
  instance: string | null;
  manifest: Record<string, ParamDesc> | undefined;
  session: SessionSnapshot;
  onExit: () => void;
};

const MAX_KEY = "loom.previewmax";
// The resolution ceiling the human picks (16:9 heights). "Full" matches the
// Output's 1080p internal resolution — exactly what a commit would send live.
const RES_OPTIONS = [
  { h: 1080, label: "Full · 1080p" },
  { h: 720, label: "720p" },
  { h: 540, label: "540p" },
  { h: 360, label: "360p" },
];

const loadMax = (): number => {
  const n = Number(localStorage.getItem(MAX_KEY));
  return RES_OPTIONS.some((o) => o.h === n) ? n : 1080;
};

/**
 * Preview mode (toggled by the Header button or the "p" hotkey): the selected
 * instance blown up full-screen with only the params drawer alongside — a
 * focused "audition this candidate" view without the tile grid in the way.
 *
 * Unlike the tiles (which share the 640×360 thumbnail stream), the big image is
 * a dedicated FULL-resolution stream: while the overlay is open the engine
 * renders the selected instance at the chosen resolution (`set_preview`) and
 * streams it back — so you see exactly what would be sent to live. The human
 * picks the ceiling from the resolution dropdown; the engine auto-reduces it
 * when fps dips and climbs back when it's safe (the readout shows "· auto"
 * while reduced). Reuses ParamPanel so widgets, FX chain, and the stage/GO LIVE
 * buttons all come for free; the slim header repeats GO LIVE so sending to live
 * stays one tap even when the drawer is collapsed. DOM contract: #preview-mode,
 * #preview-image, #preview-name, #preview-res, #preview-resselect,
 * #preview-stage, #preview-golive, #preview-exit.
 */
export function PreviewMode({ instance, manifest, session: s, onExit }: Props) {
  const link = useEngine();
  const [maxHeight, setMaxHeight] = useState<number>(loadMax);
  const thumb = useThumb(instance);
  const pf = usePreviewFrame();
  const inst = instance != null ? s.instances.find((i) => i.id === instance) : undefined;
  const scene = inst?.scene;
  const name =
    instance == null ? "—" : scene && scene !== instance ? `${instance} · ${scene}` : instance;
  const isLive = instance != null && s.live === instance;
  const isStaged = instance != null && s.staged === instance;
  // globals is the rack/palette pseudo-instance, never something to project.
  const stageable = instance != null && instance !== "globals";

  // Drive the engine's full-res stream for as long as the overlay is open.
  useEffect(() => {
    if (!stageable) {
      void link.req("set_preview", { instance: null }).catch(() => {});
      return;
    }
    void link.req("set_preview", { instance, maxHeight }).catch(fail);
  }, [instance, maxHeight, stageable, link]);
  // Stop the stream when the overlay closes (unmount).
  useEffect(
    () => () => {
      void link.req("set_preview", { instance: null }).catch(() => {});
    },
    [link],
  );

  const setMaxPersist = (h: number) => {
    setMaxHeight(h);
    try {
      localStorage.setItem(MAX_KEY, String(h));
    } catch {
      // choice just won't persist across reloads
    }
  };

  // Prefer the dedicated full-res frame once it's arrived for THIS instance;
  // fall back to the tile thumbnail until then (no blank while the stream warms).
  const hiRes = pf != null && pf.instance === instance ? pf : null;
  const src = hiRes?.image ?? thumb;
  const has = stageable && src != null;

  return (
    <Box
      id="preview-mode"
      sx={{
        position: "fixed",
        inset: 0,
        zIndex: (t) => t.zIndex.modal,
        display: "flex",
        flexDirection: "column",
        bgcolor: "background.default",
      }}
    >
      <Stack
        direction="row"
        spacing={1.25}
        alignItems="center"
        component="header"
        sx={{
          px: 1.25,
          py: 0.5,
          bgcolor: "background.paper",
          borderBottom: 1,
          borderColor: "divider",
          flex: "0 0 auto",
        }}
      >
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ letterSpacing: "0.16em", fontWeight: 700 }}
        >
          PREVIEW
        </Typography>
        <Typography id="preview-name" sx={{ fontWeight: 700 }} noWrap>
          {name}
        </Typography>
        {isLive && (
          <Typography variant="caption" sx={{ color: "error.main", fontWeight: 700 }}>
            LIVE
          </Typography>
        )}
        {isStaged && (
          <Typography variant="caption" sx={{ color: "warning.main", fontWeight: 700 }}>
            STAGED
          </Typography>
        )}
        <Box sx={{ flex: 1 }} />
        {/* Resolution ceiling + the live streamed resolution (· auto when the
            engine has reduced it under fps pressure). */}
        <NativeSelect
          value={maxHeight}
          inputProps={{ id: "preview-resselect", title: "preview resolution ceiling" }}
          onChange={(e) => setMaxPersist(Number(e.target.value))}
          sx={{ fontSize: 12 }}
        >
          {RES_OPTIONS.map((o) => (
            <option key={o.h} value={o.h}>{o.label}</option>
          ))}
        </NativeSelect>
        <Typography
          id="preview-res"
          variant="caption"
          color={hiRes?.reduced ? "warning.main" : "text.secondary"}
          sx={{ fontFamily: "monospace", minWidth: 86 }}
          title={
            hiRes?.reduced
              ? "fps dipped — the engine auto-reduced the preview resolution"
              : "live preview resolution"
          }
        >
          {hiRes ? `${hiRes.width}×${hiRes.height}${hiRes.reduced ? " · auto" : ""}` : "…"}
        </Typography>
        {stageable && (
          <>
            <Button
              id="preview-stage"
              variant="outlined"
              disabled={isLive}
              onClick={() =>
                void link
                  .req(isStaged ? "unstage" : "stage", isStaged ? {} : { instance })
                  .catch(fail)
              }
              sx={{ fontSize: 12, py: 0.25 }}
            >
              {isStaged ? "unstage" : "stage"}
            </Button>
            <Button
              id="preview-golive"
              variant="contained"
              color="error"
              disabled={isLive || s.panicked}
              title="stage this scene and crossfade it LIVE now"
              onClick={() =>
                void link.req("stage", { instance }).then(() => link.req("commit", {})).catch(fail)
              }
              sx={{ fontSize: 12, fontWeight: 700, py: 0.25 }}
            >
              {isLive ? "LIVE" : "GO LIVE"}
            </Button>
          </>
        )}
        <Button
          id="preview-exit"
          onClick={onExit}
          title="exit preview (p / Esc)"
          sx={{ minWidth: 0, px: 1, fontSize: 16, lineHeight: 1 }}
        >
          ✕
        </Button>
      </Stack>
      <Box sx={{ flex: 1, display: "flex", minHeight: 0 }}>
        <Box
          id="preview-view"
          sx={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            bgcolor: "#000",
          }}
        >
          <Box
            component="img"
            id="preview-image"
            alt=""
            src={has ? src : undefined}
            // Same presentation as the Output window: fill the area, cover-scaled.
            sx={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              display: has ? "block" : "none",
            }}
          />
          <Typography id="preview-empty" color="text.secondary" sx={{ display: has ? "none" : "block" }}>
            {stageable ? "waiting for preview…" : "select an instance tile to preview"}
          </Typography>
        </Box>
        <ParamPanel instance={instance} manifest={manifest} session={s} />
      </Box>
    </Box>
  );
}
