import {
  DndContext,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  Popover,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ChainStepInfo } from "@loom/sidecar/protocol";
import type { ParamDesc } from "../engine-link";
import { useEngine, useEngineState } from "../hooks";
import {
  chainSteps,
  insertStep,
  loadCollapsed,
  removeStep,
  reorderStep,
  saveCollapsed,
  stepKnobs,
  toggleCollapsed,
} from "./chain-ops";
import { ParamWidget } from "./ParamWidget";

type Props = {
  instance: string;
  manifest: Record<string, ParamDesc>;
  /** A layer node id (Layers) — the chain edits that node; omitted = the root chain. */
  node?: string;
};

/**
 * The per-instance post-effect chain (M6): ordered step cards (source→output),
 * each with a wet/dry mix you can ride or MIDI-bind, drag-to-reorder, insertion
 * points between steps, a "+ effect" picker fed by the library (code primitives
 * + saved chains), restore-default, and "save as effect". Structural edits go
 * through one full-list set_chain; knob/mix rides are plain set_param.
 */
export function FxChain({ instance, manifest, node }: Props) {
  const link = useEngine();
  const { session } = useEngineState();
  const [pick, setPick] = useState<{ anchor: HTMLElement; index: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [saveOpen, setSaveOpen] = useState(false);
  const [saveName, setSaveName] = useState("");

  // Per-step collapse state (UI only — never touches the engine). Keyed by the
  // step's full `<prefix><id>` so the root chain and each layer node collapse
  // independently; persisted across reloads via localStorage.
  const [collapsed, setCollapsed] = useState<Set<string>>(loadCollapsed);
  const toggleStep = (key: string) =>
    setCollapsed((c) => {
      const next = toggleCollapsed(c, key);
      saveCollapsed(next);
      return next;
    });

  // A node's chain params live at <node>.fx.*; the root chain keeps fx.* (M6).
  const prefix = node != null ? `${node}.fx.` : "fx.";
  const chain: ChainStepInfo[] = useMemo(() => {
    const info = session?.instances.find((i) => i.id === instance);
    if (node != null) return info?.nodes.find((n) => n.id === node)?.chain ?? [];
    return info?.chain ?? [];
  }, [session, instance, node]);
  const effects = session?.availableEffects ?? [];
  const primitives = effects.filter((e) => e.kind === "primitive");
  const composites = effects.filter((e) => e.kind === "composite");

  // Hover-lazy picker previews: render the effect over THIS instance's current
  // output. Cached per effect; invalidated when the selected instance changes.
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const inflight = useRef(new Set<string>());
  useEffect(() => {
    setPreviews({});
    inflight.current.clear();
  }, [instance]);
  const requestPreview = (name: string) => {
    if (previews[name] != null || inflight.current.has(name)) return;
    inflight.current.add(name);
    void link
      .req("preview_effect", { instance, effect: name })
      .then((r) => setPreviews((p) => ({ ...p, [name]: (r as { image: string }).image })))
      .catch(() => {})
      .finally(() => inflight.current.delete(name));
  };

  // Every structural edit is a full-list set_chain; ids are kept so surviving
  // steps keep their knobs (params/mix omitted → the engine carries them forward).
  const apply = (steps: Array<{ id?: string; effect: string }>) => {
    setErr(null);
    void link
      .req("set_chain", { instance, steps, ...(node != null ? { node } : {}) })
      .catch((e: Error) => setErr(e.message));
  };
  const insert = (effect: string, index: number) => {
    apply(insertStep(chainSteps(chain), effect, index));
    setPick(null);
  };
  const remove = (id: string) => apply(removeStep(chainSteps(chain), id));
  const reorder = (from: number, to: number) => {
    if (from === to) return;
    apply(reorderStep(chainSteps(chain), from, to));
  };

  // Step cards reorder via dnd-kit (handle-only — the cards are full of
  // sliders). This DndContext nests inside ConsoleApp's tile context; the
  // handles register only here, so a step drag never arms the stage zone.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const onDragEnd = (e: DragEndEvent) => {
    const from = chain.findIndex((s) => s.id === e.active.id);
    const to = e.over != null ? chain.findIndex((s) => s.id === e.over!.id) : -1;
    if (from >= 0 && to >= 0) reorder(from, to);
  };
  const restore = () => {
    setErr(null);
    void link
      .req("set_chain", { instance, restoreDefault: true, ...(node != null ? { node } : {}) })
      .catch((e: Error) => setErr(e.message));
  };
  const save = () => {
    const name = saveName.trim();
    if (!name) return;
    setErr(null);
    void link
      .req("save_chain", { instance, name })
      .then(() => {
        setSaveOpen(false);
        setSaveName("");
      })
      .catch((e: Error) => setErr(e.message));
  };

  // One sortable step card; hands its drag-handle props to the children so
  // only the ⠿ grip starts a drag.
  function SortableStep({
    id,
    dim,
    children,
  }: {
    id: string;
    dim: boolean;
    children: (handleProps: Record<string, unknown>) => ReactNode;
  }) {
    const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
      id,
    });
    return (
      <Box
        data-fxstep={id}
        ref={setNodeRef}
        style={{ transform: CSS.Transform.toString(transform), transition }}
        sx={{
          border: 1,
          borderColor: isDragging ? "primary.main" : "divider",
          borderRadius: 1,
          p: 0.75,
          mb: 0.25,
          bgcolor: "background.default",
          opacity: isDragging ? 0.8 : dim ? 0.55 : 1,
          position: "relative",
          zIndex: isDragging ? 2 : undefined,
        }}
      >
        {children({ ...attributes, ...listeners })}
      </Box>
    );
  }

  // A thin insertion affordance between/around cards.
  const inserter = (index: number) => (
    <Box
      data-fxinsert={index}
      onClick={(e) => setPick({ anchor: e.currentTarget, index })}
      sx={{
        height: 16,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "text.secondary",
        cursor: "pointer",
        opacity: 0.5,
        "&:hover": { opacity: 1, color: "primary.main" },
        "&::before, &::after": { content: '""', flex: 1, borderTop: 1, borderColor: "divider", mx: 1 },
      }}
    >
      <Typography variant="caption">+ insert</Typography>
    </Box>
  );

  return (
    <Box id={node != null ? undefined : "fxchain"} data-fxnode={node ?? "root"} sx={{ mt: 1 }}>
      <Stack direction="row" alignItems="center" sx={{ mb: 0.5 }}>
        <Typography
          variant="caption"
          sx={{ flex: 1, letterSpacing: "0.08em", textTransform: "uppercase", color: "text.secondary" }}
        >
          FX chain{chain.length > 0 ? ` · ${chain.length}` : ""}
        </Typography>
        {node == null && chain.length > 0 && (
          <Tooltip title="save this chain as a reusable effect">
            <Button
              data-fxsave
              size="small"
              onClick={() => setSaveOpen(true)}
              sx={{ minWidth: 0, px: 0.75, py: 0, fontSize: 11, color: "text.secondary" }}
            >
              ⌑ save as…
            </Button>
          </Tooltip>
        )}
        <Tooltip title="restore the scene's default chain">
          <Button
            data-fxrestore
            size="small"
            onClick={restore}
            sx={{ minWidth: 0, px: 0.75, py: 0, fontSize: 11, color: "text.secondary" }}
          >
            ⟳ restore
          </Button>
        </Tooltip>
      </Stack>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5, opacity: 0.7 }}>
        signal flows ↓ source → output
      </Typography>

      {err != null && (
        <Typography variant="caption" sx={{ display: "block", color: "error.main", mb: 0.5 }}>
          {err}
        </Typography>
      )}

      {inserter(0)}
      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <SortableContext items={chain.map((s) => s.id)} strategy={verticalListSortingStrategy}>
      {chain.map((step, i) => {
        const stepKey = `${prefix}${step.id}`;
        const mix = manifest[`${stepKey}.mix`];
        const enabledP = manifest[`${stepKey}.enabled`];
        const en = enabledP?.value !== false;
        const dim = (typeof mix?.value === "number" && mix.value < 0.02) || !en;
        const isCollapsed = collapsed.has(stepKey);
        return (
          <Box key={step.id}>
            <SortableStep id={step.id} dim={dim}>
              {(handleProps) => (
                <>
              {/* Step HEADER: drag · collapse · name · enable · remove. The
                  enable control and remove stay reachable while collapsed. */}
              <Stack direction="row" alignItems="center" spacing={0.5}>
                <Box
                  {...handleProps}
                  title="drag to reorder"
                  sx={{ cursor: "grab", touchAction: "none", color: "text.secondary", fontSize: 14, px: 0.25 }}
                >
                  ⠿
                </Box>
                <Tooltip title={isCollapsed ? "expand step" : "collapse step"}>
                  <IconButton
                    size="small"
                    data-fxcollapse={step.id}
                    aria-expanded={!isCollapsed}
                    onClick={() => toggleStep(stepKey)}
                    sx={{ color: "text.secondary", fontSize: 12, p: 0.25, lineHeight: 1 }}
                  >
                    {isCollapsed ? "▸" : "▾"}
                  </IconButton>
                </Tooltip>
                <Typography
                  variant="body2"
                  sx={{ flex: 1, fontWeight: 600, cursor: "pointer", minWidth: 0 }}
                  noWrap
                  title={step.effect}
                  onClick={() => toggleStep(stepKey)}
                >
                  {step.kind === "composite" ? "✦ " : ""}
                  {step.effect}
                </Typography>
                {/* The ONE enable/disable control: a bool toggle + MIDI-learn,
                    hoisted into the header so it works while collapsed. */}
                {enabledP != null && (
                  <Box data-fxenable={step.id} sx={{ flex: "0 0 auto" }}>
                    <ParamWidget
                      instance={instance}
                      path={`${stepKey}.enabled`}
                      p={enabledP}
                      label=""
                      dense
                      fill
                    />
                  </Box>
                )}
                <Tooltip title="remove from chain">
                  <IconButton
                    size="small"
                    data-fxremove={step.id}
                    onClick={() => remove(step.id)}
                    sx={{ color: "text.secondary", fontSize: 14, p: 0.25 }}
                  >
                    ✕
                  </IconButton>
                </Tooltip>
              </Stack>
              {!isCollapsed && (
                <>
                  {mix != null && (
                    <ParamWidget instance={instance} path={`${stepKey}.mix`} p={mix} label="mix" dense fill />
                  )}
                  {stepKnobs(manifest, prefix, step.id).map(([path, p]) => (
                    <ParamWidget
                      key={path}
                      instance={instance}
                      path={path}
                      p={p}
                      label={path.slice(`${stepKey}.`.length)}
                      dense
                      fill
                    />
                  ))}
                </>
              )}
                </>
              )}
            </SortableStep>
            {i < chain.length - 1 && inserter(i + 1)}
          </Box>
        );
      })}
      </SortableContext>
      </DndContext>

      {chain.length === 0 && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 0.5 }}>
          No effects. Add one to post-process this instance.
        </Typography>
      )}

      <Button
        data-fxadd
        size="small"
        variant="outlined"
        fullWidth
        onClick={(e) => setPick({ anchor: e.currentTarget, index: chain.length })}
        sx={{ mt: 0.5, fontSize: 11, py: 0.25 }}
      >
        + effect
      </Button>

      <Popover
        open={pick != null}
        anchorEl={pick?.anchor ?? null}
        onClose={() => setPick(null)}
        anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
      >
        <Box sx={{ p: 1, width: 300 }}>
          {[
            { label: "primitives", items: primitives, mark: "" },
            { label: "saved chains", items: composites, mark: "✦ " },
          ]
            .filter((g) => g.items.length > 0)
            .map((g) => (
              <Box key={g.label} sx={{ mb: 1, "&:last-of-type": { mb: 0 } }}>
                <Typography
                  variant="caption"
                  sx={{ color: "text.secondary", textTransform: "uppercase", letterSpacing: "0.08em" }}
                >
                  {g.label}
                </Typography>
                <Box sx={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0.75, mt: 0.5 }}>
                  {g.items.map((e) => (
                    <Box
                      key={e.name}
                      data-fxpick={e.name}
                      onClick={() => insert(e.name, pick!.index)}
                      onMouseEnter={() => requestPreview(e.name)}
                      title={e.description ?? e.name}
                      sx={{
                        border: 1,
                        borderColor: "divider",
                        borderRadius: 1,
                        p: 0.5,
                        cursor: "pointer",
                        bgcolor: "background.default",
                        "&:hover": { borderColor: "primary.main", bgcolor: "action.hover" },
                      }}
                    >
                      <Box
                        sx={{
                          aspectRatio: "16 / 9",
                          borderRadius: 0.5,
                          mb: 0.5,
                          bgcolor: "#000",
                          backgroundImage: previews[e.name] != null ? `url(${previews[e.name]})` : undefined,
                          backgroundSize: "cover",
                          backgroundPosition: "center",
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                        }}
                      >
                        {previews[e.name] == null && (
                          <Typography variant="caption" sx={{ color: "text.disabled", fontSize: 9 }}>
                            hover ▸ preview
                          </Typography>
                        )}
                      </Box>
                      <Typography variant="body2" noWrap sx={{ fontWeight: 600 }}>
                        {g.mark}
                        {e.name}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              </Box>
            ))}
        </Box>
      </Popover>

      <Dialog open={saveOpen} onClose={() => setSaveOpen(false)}>
        <DialogTitle sx={{ fontSize: 16 }}>Save chain as effect</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            size="small"
            margin="dense"
            label="name (lowerCamelCase)"
            fullWidth
            value={saveName}
            onChange={(e) => setSaveName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            helperText="writes content/modules/effects/chains/<name>.chain.json"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSaveOpen(false)}>cancel</Button>
          <Button onClick={save} variant="contained" disabled={saveName.trim() === ""}>
            save
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
