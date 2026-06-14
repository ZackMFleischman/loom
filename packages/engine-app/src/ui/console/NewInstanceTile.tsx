import { Box, ButtonBase, Card, Fade, Popover, Typography } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useEngine, useThumb } from "../hooks";
import { sceneThumb, snapshotScene } from "../scene-thumbs";
import { fail } from "../util";

type Props = {
  scenes: string[];
  onCreated: (id: string) => void;
  /** A preview instance was created — the grid must hide its tile for good. */
  onPreviewSpawn: (id: string) => void;
  /** The human picked this preview — the grid shows its tile from now on. */
  onPreviewAdopt: (id: string) => void;
};

/**
 * Ghost "+" tile (#newinstance) at the end of the grid: click → a grid of
 * scene cards pops out to the right (.scenerow[data-scene]), each showing its
 * last-run snapshot. The TILE ITSELF is the preview surface: hovering a card
 * shows that scene's snapshot instantly, builds a REAL sandbox instance after
 * a 250 ms debounce, and swaps in its live pixels when they arrive — the tile
 * never blanks mid-swap. Picking keeps the instance (the tile reverts to "+"),
 * any other close destroys the orphan. Never more than one preview alive.
 */
export function NewInstanceTile({ scenes, onCreated, onPreviewSpawn, onPreviewAdopt }: Props) {
  const link = useEngine();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [hoveredScene, setHoveredScene] = useState<string | null>(null);
  const preview = useRef<{ scene: string; id: string } | null>(null);
  const hovered = useRef<string | null>(null); // mirrors hoveredScene for async guards
  const openRef = useRef(false);
  const timer = useRef<number | undefined>(undefined);
  const liveThumb = useThumb(previewId);
  const open = anchor != null;

  // The live preview is the freshest pixels a scene has — keep its snapshot hot.
  useEffect(() => {
    if (preview.current != null && liveThumb != null) snapshotScene(preview.current.scene, liveThumb);
  }, [liveThumb]);

  const setPreview = (p: { scene: string; id: string } | null) => {
    preview.current = p;
    setPreviewId(p?.id ?? null);
  };

  const destroyPreview = () => {
    const p = preview.current;
    setPreview(null);
    // No grid notification: the id stays hidden while the instance dies.
    if (p) void link.req("destroy_instance", { instance: p.id }).catch(fail);
  };

  const close = () => {
    openRef.current = false;
    hovered.current = null;
    setHoveredScene(null);
    window.clearTimeout(timer.current);
    setAnchor(null);
    destroyPreview();
  };

  const hover = (scene: string) => {
    hovered.current = scene;
    setHoveredScene(scene); // snapshot shows immediately; live pixels follow
    window.clearTimeout(timer.current);
    if (preview.current?.scene === scene) return;
    timer.current = window.setTimeout(() => {
      destroyPreview();
      void link
        .req("create_instance", { scene })
        .then((r) => {
          const id = (r as { instance: string }).instance;
          onPreviewSpawn(id); // hidden from the grid before it can flash in
          // The picker may have closed (or the hover moved on) mid-build.
          if (!openRef.current || hovered.current !== scene) {
            void link.req("destroy_instance", { instance: id }).catch(fail);
            return;
          }
          setPreview({ scene, id });
        })
        .catch(fail);
    }, 250);
  };

  const pick = (scene: string) => {
    window.clearTimeout(timer.current);
    if (preview.current?.scene === scene) {
      const { id } = preview.current;
      setPreview(null); // hand it to the grid — close() must not destroy it
      close();
      onPreviewAdopt(id);
      onCreated(id);
      return;
    }
    void link
      .req("create_instance", { scene })
      .then((r) => onCreated((r as { instance: string }).instance))
      .catch(fail);
    close();
  };

  // Live pixels when the built preview matches the hover; else the hovered
  // scene's last-run snapshot; else nothing (placeholder below).
  const live = preview.current != null && preview.current.scene === hoveredScene ? liveThumb : undefined;
  const snap = hoveredScene != null ? sceneThumb(hoveredScene) : undefined;
  const showing = live ?? snap;

  return (
    <>
      <Card
        id="newinstance"
        variant="outlined"
        onClick={(e) => {
          if (openRef.current) return;
          openRef.current = true;
          setAnchor(e.currentTarget);
        }}
        sx={{
          cursor: "pointer",
          position: "relative",
          borderStyle: "dashed",
          color: "text.secondary",
          bgcolor: "transparent",
          borderColor: open ? "primary.main" : "divider",
          "&:hover": { color: "primary.main", borderColor: "primary.main" },
        }}
      >
        {/* Same geometry as a real tile: 16/9 face + slim name row. The
            snapshot sits underneath and the live stream fades in over it, so
            a build's first (possibly dark) frame never pops. While nothing is
            previewing, the face/footer are just an invisible height skeleton
            and the +/hint overlays the WHOLE card, dead-centered. */}
        <Box sx={{ aspectRatio: "16/9", position: "relative", bgcolor: open && showing != null ? "#000" : "transparent", overflow: "hidden" }}>
          {open && showing != null && (
            <>
              {snap != null && (
                <Box
                  component="img"
                  src={snap}
                  alt=""
                  sx={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                />
              )}
              {live != null && (
                <Fade in appear timeout={250} key={previewId ?? "none"}>
                  <Box
                    component="img"
                    src={live}
                    alt=""
                    sx={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
                  />
                </Fade>
              )}
            </>
          )}
        </Box>
        <Typography variant="body2" noWrap sx={{ px: 1, py: 0.5, visibility: open && showing != null ? "visible" : "hidden" }}>
          {open && showing != null && hoveredScene != null
            ? `${live != null ? "live preview" : "last run"} · ${hoveredScene}`
            : " "}
        </Typography>
        {!(open && showing != null) && (
          <Box
            sx={{
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <Typography sx={{ fontSize: 34, lineHeight: 1 }}>+</Typography>
            <Typography variant="caption">
              {open
                ? hoveredScene != null
                  ? `building ${hoveredScene}…`
                  : "hover a scene to preview it here"
                : "new instance"}
            </Typography>
          </Box>
        )}
      </Card>
      <Popover
        open={open}
        anchorEl={anchor}
        onClose={close}
        anchorOrigin={{ vertical: "top", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "left" }}
        sx={{ ml: 0.5 }}
      >
        <Box
          sx={{
            display: "grid",
            gridTemplateColumns: "repeat(3, 132px)",
            gap: 0.5,
            p: 0.75,
            maxHeight: 360,
            overflowY: "auto",
          }}
        >
          {scenes.map((scene) => {
            const card = sceneThumb(scene);
            const active = scene === hoveredScene;
            return (
              <ButtonBase
                key={scene}
                className="scenerow"
                data-scene={scene}
                onMouseEnter={() => hover(scene)}
                onClick={() => pick(scene)}
                sx={{
                  display: "block",
                  textAlign: "left",
                  borderRadius: 1,
                  overflow: "hidden",
                  border: 1,
                  borderColor: active ? "primary.main" : "divider",
                }}
              >
                <Box sx={{ width: "100%", aspectRatio: "16/9", bgcolor: "#000" }}>
                  {card != null && (
                    <Box
                      component="img"
                      src={card}
                      alt=""
                      sx={{ width: "100%", height: "100%", objectFit: "cover", display: "block" }}
                    />
                  )}
                </Box>
                <Typography
                  variant="caption"
                  noWrap
                  sx={{ display: "block", px: 0.75, py: 0.25, color: active ? "primary.main" : "text.primary" }}
                >
                  {scene}
                </Typography>
              </ButtonBase>
            );
          })}
        </Box>
      </Popover>
    </>
  );
}
