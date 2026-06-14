import { Box, Button, NativeSelect, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import type { SessionSnapshot } from "@loom/sidecar/protocol";
import { tileFps } from "../fps-meter";
import { useEngine, usePreviewFrame, useThumb } from "../hooks";
import { fail } from "../util";
import { ParamPanel } from "./ParamPanel";
import { StatusPill, TopBar } from "./primitives";

type Props = {
  instance: string | null;
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
 * renders the selected instance at the LIVE resolution (`set_preview`) and
 * streams it back — so you see exactly what a commit would send live (the render
 * is always full-res; the resolution dropdown only caps the streamed JPEG, which
 * the engine auto-reduces under fps pressure — the readout shows "· auto" while
 * reduced). Reuses ParamPanel so widgets, FX chain, and the stage/GO LIVE
 * buttons (#panel-stage / #panel-golive) all come for free — those are the
 * single source for staging from preview, so the slim header no longer repeats
 * them. DOM contract: #preview-mode, #preview-image, #preview-name,
 * #preview-res, #preview-resselect, #preview-exit.
 */
export function PreviewMode({ instance, session: s, onExit }: Props) {
  const link = useEngine();
  const [maxHeight, setMaxHeight] = useState<number>(loadMax);
  const thumb = useThumb(instance);
  const pf = usePreviewFrame();
  const inst = instance != null ? s.instances.find((i) => i.id === instance) : undefined;
  const scene = inst?.scene;
  const name = instance == null ? "—" : scene && scene !== instance ? `${instance} · ${scene}` : instance;
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
      <TopBar component="header" spacing={1.25}>
        <Typography variant="caption" color="text.secondary" sx={{ letterSpacing: "0.16em", fontWeight: 700 }}>
          PREVIEW
        </Typography>
        <Typography id="preview-name" sx={{ fontWeight: 700 }} noWrap>
          {name}
        </Typography>
        {isLive && <StatusPill kind="live" />}
        {isStaged && <StatusPill kind="staged" />}
        <Box sx={{ flex: 1 }} />
        {/* Per-tile render rate for the previewed instance (engine fps capped by
            its CPU budget) + its smoothed frame cost — same meters as the grid
            tiles, surfaced here because the tile is hidden in preview mode. */}
        {inst && (
          <Typography
            id="preview-fps"
            data-fps={tileFps(inst.frameMs, s.fps, inst.status !== "ok")}
            variant="caption"
            color={inst.status !== "ok" ? "error.main" : "text.secondary"}
            sx={{ fontFamily: "monospace" }}
            title="previewed tile render rate · per-frame CPU cost"
          >
            {tileFps(inst.frameMs, s.fps, inst.status !== "ok").toFixed(0)}fps · {inst.frameMs.toFixed(1)}ms
          </Typography>
        )}
        {/* Resolution ceiling + the live streamed resolution (· auto when the
            engine has reduced it under fps pressure). */}
        <NativeSelect
          value={maxHeight}
          inputProps={{ id: "preview-resselect", title: "preview resolution ceiling" }}
          onChange={(e) => setMaxPersist(Number(e.target.value))}
          sx={{ fontSize: 12 }}
        >
          {RES_OPTIONS.map((o) => (
            <option key={o.h} value={o.h}>
              {o.label}
            </option>
          ))}
        </NativeSelect>
        <Typography
          id="preview-res"
          variant="caption"
          color={hiRes?.reduced ? "warning.main" : "text.secondary"}
          sx={{ fontFamily: "monospace", minWidth: 86 }}
          title={
            hiRes?.reduced ? "fps dipped — the engine auto-reduced the preview resolution" : "live preview resolution"
          }
        >
          {hiRes ? `${hiRes.width}×${hiRes.height}${hiRes.reduced ? " · auto" : ""}` : "…"}
        </Typography>
        {/* Stage / GO LIVE used to be repeated here, but they already live in the
            ParamPanel (#panel-stage / #panel-golive) rendered in this same
            overlay — one source of truth, less header clutter. */}
        <Button
          id="preview-exit"
          variant="ghost"
          onClick={onExit}
          title="exit preview (p / Esc)"
          sx={{ px: 1, fontSize: 16, lineHeight: 1 }}
        >
          ✕
        </Button>
      </TopBar>
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
        <ParamPanel instance={instance} />
      </Box>
    </Box>
  );
}
