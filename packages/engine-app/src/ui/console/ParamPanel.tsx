import { Accordion, AccordionDetails, AccordionSummary, Box, Button, Stack, Typography } from "@mui/material";
import { memo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { useEngine, useManifest, useStagePointers, useStructure } from "../hooks";
import { countRender, fail } from "../util";
import { toggleAdvanced as toggleAdvancedStore, useAdvanced } from "./advanced-store";
import { gatherChannels } from "./ColorChannels";
import { FxChain } from "./FxChain";
import { groupParams, splitRig } from "./param-groups";
import { ParamWidget } from "./ParamWidget";
import { StatusPill } from "./primitives";

// Each contiguous run of param widgets is a CSS grid with a shared label
// column: `fit-content(--label-max)` makes column 1 exactly as wide as the
// widest label in THAT run BUT CAPPED at the max — i.e. "max-content up to the
// cap, then wrap". This is the load-bearing difference from `min(max-content,
// <length>)`, which resolves as an intrinsic size and does NOT actually clamp:
// at a wide panel it lets the column grow unbounded and long names stop
// wrapping. `fit-content(120px)` truly holds the cap at any panel width so long
// labels wrap inside the column. Column 2 (`1fr`) holds the control cluster, so
// every slider/toggle/value lines up down the run. Per-run grids = per-section
// columns (FR-5): each accordion / transform sub-group / the flat top run sizes
// independently.
const LABEL_MAX = "120px";
const sectionGrid = {
  display: "grid",
  gridTemplateColumns: `fit-content(var(--label-max)) 1fr`,
  columnGap: 1,
  rowGap: 0.75,
  alignItems: "center",
  "--label-max": LABEL_MAX,
} as const;

const GROUP_OPEN_KEY = "loom.pgroups.open";
const PANEL_W_KEY = "loom.panelw";
const PANEL_COLLAPSED_KEY = "loom.panelcollapsed";

function loadOpen(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(GROUP_OPEN_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

type Props = {
  instance: string | null;
};

/**
 * Dotted param paths form collapsible groups: "logo.tiltX" lands in a "logo"
 * accordion labeled "tiltX"; dotless params stay flat on top. Open state
 * persists per group name (collapsed until the human opens it).
 *
 * Reads its data via narrow selector stores (FR-1): the selected instance's
 * manifest + slice + the stage pointers — so it re-renders on its own data, not
 * on every 10 Hz state broadcast. Memoized on `instance` (the only prop).
 */
function ParamPanelImpl({ instance }: Props) {
  countRender("ParamPanel");
  const link = useEngine();
  const manifest = useManifest(instance);
  // Structure slice (scene/nodes — no telemetry) so the panel doesn't re-render
  // (and cascade into every ParamWidget) on the per-tick frameMs wiggle (FR-1).
  const inst = useStructure(instance);
  const pointers = useStagePointers();
  const [open, setOpen] = useState<Record<string, boolean>>(loadOpen);
  // Shared with the `a` hotkey (keyboard-shortcuts FR-4) via the advanced-store.
  const showAdvanced = useAdvanced();
  const toggleAdvanced = toggleAdvancedStore;
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem(PANEL_COLLAPSED_KEY) === "1");
  const setCollapsedPersist = (next: boolean) => {
    setCollapsed(next);
    try {
      localStorage.setItem(PANEL_COLLAPSED_KEY, next ? "1" : "0");
    } catch {
      // collapse state just won't persist across reloads
    }
  };
  const [w, setW] = useState(() => {
    const n = Number(localStorage.getItem(PANEL_W_KEY));
    return Number.isFinite(n) && n >= 240 ? n : 320;
  });
  const wRef = useRef(w);
  wRef.current = w;

  // The drawer resizes by its left edge; width persists across sessions.
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = wRef.current;
    const move = (ev: PointerEvent) =>
      setW(Math.min(Math.max(240, startW + (startX - ev.clientX)), window.innerWidth * 0.6));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      try {
        localStorage.setItem(PANEL_W_KEY, String(wRef.current));
      } catch {
        // width just won't persist
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const toggle = (group: string, isOpen: boolean) => {
    setOpen((o) => {
      const next = { ...o, [group]: isOpen };
      try {
        localStorage.setItem(GROUP_OPEN_KEY, JSON.stringify(next));
      } catch {
        // storage unavailable — groups just default closed each load
      }
      return next;
    });
  };

  // Layer nodes (Layers): each gets a node-marked group with its own FX chain;
  // its chain knobs (<node>.fx.*) render inside that chain, not as widgets. The
  // bucketing is pure (param-groups.ts); this component owns only the rendering.
  const nodes = inst?.nodes ?? [];
  const { flat, groups, nodeIds, parentOf, hiddenCount } = groupParams(manifest, nodes, showAdvanced);
  const ready = instance != null && manifest != null;
  const isLive = ready && pointers.live === instance;
  const isStaged = ready && pointers.staged === instance;

  // Collapsed: a thin tap target (one-handed on mobile) that reveals the
  // drawer. Keeps #panel mounted so layout/contract holds; widgets unmount.
  if (collapsed) {
    return (
      <Box
        component="aside"
        id="panel"
        data-collapsed="1"
        onClick={() => setCollapsedPersist(false)}
        title="show params"
        sx={{
          flex: "0 0 auto",
          width: 30,
          bgcolor: "background.paper",
          borderLeft: 1,
          borderColor: "divider",
          cursor: "pointer",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: 1,
          pt: 1,
          "&:hover": { bgcolor: "action.hover" },
        }}
      >
        <Typography sx={{ fontSize: 16, lineHeight: 1, color: "text.secondary" }}>‹</Typography>
        <Typography
          variant="caption"
          sx={{ writingMode: "vertical-rl", color: "text.secondary", letterSpacing: "0.08em", mt: 0.5 }}
        >
          PARAMS{ready ? ` · ${instance}` : ""}
        </Typography>
      </Box>
    );
  }

  return (
    <Stack direction="row" sx={{ flex: "0 0 auto" }}>
      <Box
        onPointerDown={startResize}
        title="drag to resize"
        sx={{
          width: 5,
          cursor: "col-resize",
          flex: "0 0 auto",
          bgcolor: "transparent",
          "&:hover": { bgcolor: "primary.main", opacity: 0.5 },
        }}
      />
      <Box
        component="aside"
        id="panel"
        sx={{
          flex: `0 0 ${w}px`,
          width: w,
          bgcolor: "background.paper",
          borderLeft: 1,
          borderColor: "divider",
          p: 1.25,
          overflowY: "auto",
        }}
      >
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mb: 1 }}>
          <Typography id="paneltitle" variant="subtitle2" noWrap sx={{ minWidth: 0 }}>
            {ready ? instance : "no instance selected"}
          </Typography>
          {ready && (
            <Typography variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
              {inst?.scene ?? ""}
            </Typography>
          )}
          <Box sx={{ flex: 1 }} />
          {isLive && <StatusPill kind="live" />}
          {isStaged && <StatusPill kind="staged" />}
          <Button
            variant="ghost"
            onClick={() => setCollapsedPersist(true)}
            title="hide params"
            sx={{ px: 0.5, py: 0, fontSize: 16, lineHeight: 1 }}
          >
            ›
          </Button>
        </Stack>
        {/* Stage actions for the selected scene — no hunting for the tile's tiny
          buttons. GO LIVE stages + crossfades in one tap (human-sourced, ungated). */}
        {instance != null && instance !== "globals" && (
          <Stack direction="row" spacing={0.75} sx={{ mb: 1.5 }}>
            <Button
              id="panel-stage"
              variant="outlined"
              fullWidth
              disabled={isLive}
              onClick={() => void link.req(isStaged ? "unstage" : "stage", isStaged ? {} : { instance }).catch(fail)}
              sx={{ py: 0.25 }}
            >
              {isStaged ? "unstage" : "stage"}
            </Button>
            <Button
              id="panel-golive"
              // GO LIVE is a commit-path verb → primary taxonomy (FR-2).
              variant="primary"
              fullWidth
              disabled={isLive || pointers.panicked}
              title="stage this scene and crossfade it LIVE now"
              onClick={() =>
                void link
                  .req("stage", { instance })
                  .then(() => link.req("commit", {}))
                  .catch(fail)
              }
              sx={{ py: 0.25 }}
            >
              {isLive ? "LIVE" : "GO LIVE"}
            </Button>
          </Stack>
        )}
        <Box id="widgets">
          {ready && (
            <>
              {flat.length > 0 && (
                <Box sx={sectionGrid}>
                  {flat.map(([path, p]) => (
                    <ParamWidget
                      key={path}
                      instance={instance}
                      path={path}
                      p={p}
                      grid
                      colorChannels={p.type === "color" ? gatherChannels(manifest, path) : []}
                    />
                  ))}
                </Box>
              )}
              {[...groups.entries()].map(([group, entries]) => {
                const isNode = nodeIds.has(group);
                const parent = parentOf.get(group);
                // A node's rig params (<node>.layer.x/y/scale/rotate/opacity) fold
                // into a nested "transform" sub-group so the section stays scannable.
                const { rig, rest } = splitRig(entries, group);
                return (
                  <Accordion
                    key={group}
                    data-node={isNode ? group : undefined}
                    variant="outlined"
                    disableGutters
                    expanded={open[group] ?? false}
                    onChange={(_, x) => toggle(group, x)}
                    sx={{ mb: 1.5, bgcolor: "transparent" }}
                  >
                    <AccordionSummary
                      sx={{
                        minHeight: 36,
                        fontSize: 12,
                        letterSpacing: "0.08em",
                        textTransform: "uppercase",
                        color: "text.secondary",
                      }}
                    >
                      {isNode ? "⬚ " : ""}
                      {group}
                      {isNode && parent != null && (
                        <Typography component="span" variant="caption" sx={{ ml: 0.5, opacity: 0.6 }}>
                          ⊂ {parent}
                        </Typography>
                      )}
                    </AccordionSummary>
                    <AccordionDetails>
                      {rest.length > 0 && (
                        <Box sx={sectionGrid}>
                          {rest.map(([path, p]) => (
                            <ParamWidget
                              key={path}
                              instance={instance}
                              path={path}
                              p={p}
                              grid
                              label={path.slice(group.length + 1)}
                              colorChannels={p.type === "color" ? gatherChannels(manifest, path) : []}
                            />
                          ))}
                        </Box>
                      )}
                      {rig.length > 0 && (
                        <Accordion
                          variant="outlined"
                          disableGutters
                          expanded={open[`${group}.layer`] ?? false}
                          onChange={(_, x) => toggle(`${group}.layer`, x)}
                          sx={{ mb: 1, bgcolor: "transparent" }}
                        >
                          <AccordionSummary
                            data-transform={group}
                            sx={{
                              minHeight: 30,
                              fontSize: 11,
                              letterSpacing: "0.08em",
                              textTransform: "uppercase",
                              color: "text.secondary",
                            }}
                          >
                            ⤡ transform
                          </AccordionSummary>
                          <AccordionDetails>
                            <Box sx={sectionGrid}>
                              {rig.map(([path, p]) => (
                                <ParamWidget
                                  key={path}
                                  instance={instance}
                                  path={path}
                                  p={p}
                                  grid
                                  label={path.slice(group.length + 1 + "layer.".length)}
                                />
                              ))}
                            </Box>
                          </AccordionDetails>
                        </Accordion>
                      )}
                      {isNode && instance !== "globals" && (
                        <FxChain instance={instance} manifest={manifest} node={group} />
                      )}
                    </AccordionDetails>
                  </Accordion>
                );
              })}
              {instance !== "globals" && <FxChain instance={instance} manifest={manifest} />}
              {hiddenCount > 0 && (
                <Button
                  id="panel-advanced"
                  variant="ghost"
                  onClick={toggleAdvanced}
                  title={showAdvanced ? "hide advanced params" : "show advanced params (input trims)"}
                  sx={{
                    mt: 1,
                    fontSize: 11,
                    letterSpacing: "0.08em",
                    textTransform: "uppercase",
                  }}
                >
                  {showAdvanced ? "▾ hide advanced" : `▸ advanced (${hiddenCount})`}
                </Button>
              )}
            </>
          )}
        </Box>
      </Box>
    </Stack>
  );
}

/** Memoized: re-renders only when the selected instance id changes; its manifest/
 *  slice/pointers arrive via selector stores (FR-1). */
export const ParamPanel = memo(ParamPanelImpl);
