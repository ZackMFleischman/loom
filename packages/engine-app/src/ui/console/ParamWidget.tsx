import {
  Box,
  Button,
  IconButton,
  Slider,
  Stack,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import {
  memo,
  useState,
  type ChangeEvent,
  type InputHTMLAttributes,
  type KeyboardEvent,
  type MouseEvent,
} from "react";
import type { ParamDesc } from "../engine-link";
import { useControls, useEngine } from "../hooks";
import { countRender, fail, primeMidiPermission } from "../util";
import { BindPopover } from "./BindPopover";
import { ColorChannels } from "./ColorChannels";
import { ModPopover } from "./ModPopover";
import { PaletteChoice } from "./PaletteChoice";
import { RangePopover } from "./RangePopover";

type Props = {
  instance: string;
  path: string;
  p: ParamDesc;
  /** Display label (group-stripped); defaults to the full path. */
  label?: string;
  /** Rack rows: fixed-width compact variant. */
  dense?: boolean;
  /** Fill the parent's width instead of the fixed dense rack width (FX-chain rows). */
  fill?: boolean;
  /**
   * Main param-list mode: emit the row as cells of the parent section CSS grid
   * (shared label column + aligned controls) instead of a self-contained flex
   * row. The parent (`ParamPanel`) supplies the grid + `--label-max`; the label
   * lands in column 1, the control cluster in column 2. Off for dense rack /
   * FX-chain rows, which keep their compact flex layout.
   */
  grid?: boolean;
  /** A color param's channel widgets (when decomposed) — rendered inline below. */
  colorChannels?: Array<[string, ParamDesc]>;
};

/**
 * One param, ONE row: name · modulator button (instances only) · MIDI-learn ·
 * control (slider / toggle button / selector / color) · value. The param
 * description lives in the label's tooltip. Double-click the value to type an
 * exact number (the slider range widens to swallow an out-of-bounds value).
 * DOM contract for validators: data-path lands on the slider's real <input>
 * (float/int), the labelled ToggleButtonGroup, the color <input>, or the bool
 * ToggleButton; data-learn on the learn button with exact text "M" / "···" /
 * "cc<N>"; data-value on the numeric readout.
 */
function ParamWidgetImpl({ instance, path, p, label, dense, fill, grid, colorChannels }: Props) {
  countRender("ParamWidget");
  const link = useEngine();
  // FR-1: read the narrow controls slice (bindings/midi/scene-map), NOT the full
  // 10 Hz snapshot — a param panel mounts one of these per param, so subscribing
  // to the frame-churning snapshot here re-rendered the whole list 10×/s.
  const controls = useControls();
  const [drag, setDrag] = useState<number | null>(null);
  const [edit, setEdit] = useState<string | null>(null);
  const [modAnchor, setModAnchor] = useState<HTMLElement | null>(null);
  const [bindAnchor, setBindAnchor] = useState<HTMLElement | null>(null);
  const [rangeAnchor, setRangeAnchor] = useState<HTMLElement | null>(null);

  // A modulator can be attached-but-paused (enabled:false): the param is
  // hand-drivable again while the wave waits to resume.
  const modulated = p.modulator != null;
  const modOn = modulated && (p.modulator as { enabled?: boolean }).enabled !== false;
  // Modulators attach to numeric/bool instance params — and now to decomposed
  // global palette color CHANNELS (channelOf set), which live on "globals".
  const canModulate = p.type !== "color" && (instance !== "globals" || p.channelOf != null);
  const min = typeof p.min === "number" ? p.min : 0;
  const max = typeof p.max === "number" ? p.max : 1;
  // A plain slider (float or unlabelled int) has an editable range; toggles,
  // bools and colors don't.
  const isSlider = (p.type === "float" || p.type === "int") && p.labels == null;
  const rangeOverridden = p.defaultRange != null;
  const openRange = (e: MouseEvent) => {
    e.stopPropagation();
    setRangeAnchor((a) => (a ? null : (e.currentTarget as HTMLElement)));
  };

  // Bindings are keyed by scene engine-side; resolve this instance to its scene.
  const scene = instance === "globals" ? "globals" : (controls.scenes[instance] ?? null);
  const bindingsFor =
    scene != null ? controls.bindings.filter((b) => b.scene === scene && b.path === path) : [];
  const binding = bindingsFor[0] ?? null;
  // Bools and ints have button semantics (toggle/cycle/radio) — M opens the
  // mode popover. Floats keep the one-click absolute learn.
  const hasModes = p.type === "bool" || p.type === "int";
  const learning =
    scene != null &&
    controls.midi.learning != null &&
    controls.midi.learning.scene === scene &&
    controls.midi.learning.path === path;

  const valueText =
    p.type === "bool" || p.type === "color"
      ? String(p.value)
      : (drag ?? Number(p.value)).toFixed(p.type === "int" ? 0 : 3);

  // Commit a typed value (inline edit): bad input reverts; an out-of-bounds
  // number widens the slider range first (same contract as the range popover).
  const commitEdit = () => {
    if (edit == null) return;
    const v = Number(edit);
    setEdit(null);
    if (edit.trim() === "" || !Number.isFinite(v)) return;
    const lo = Math.min(min, v);
    const hi = Math.max(max, v);
    const send = () => link.sendParam(instance, path, p.type === "int" ? Math.round(v) : v);
    if (lo < min || hi > max) {
      void link.sendParamRange(instance, path, { min: lo, max: hi }).then(send).catch(fail);
    } else {
      send();
    }
  };

  const onLearn = (e: MouseEvent) => {
    e.stopPropagation();
    // No MIDI access yet? This click IS the user gesture — pop the prompt here.
    if (controls.midi.status !== "ready") primeMidiPermission();
    if (hasModes) {
      setBindAnchor((a) => (a ? null : (e.currentTarget as HTMLElement)));
      return;
    }
    // bound → unbind; learning → cancel (engine toggles); unbound → arm
    const action = binding != null && !learning ? "midi_unbind" : "midi_learn";
    void link.req(action, { instance, path }).catch(fail);
  };

  const inputAttrs = { "data-path": path } as InputHTMLAttributes<HTMLInputElement>;

  // Grid mode (main param list): the label is a grid cell in the section's
  // shared column (sized by the parent grid, wrapping past --label-max), and
  // the control cluster is a second cell. Dense rack / FX-chain rows keep the
  // self-contained flex row. The label tooltip + full text are preserved both
  // ways (FR-4).
  const labelEl = (
    <Tooltip
      title={
        p.description != null && p.description !== ""
          ? `${label ?? path} — ${p.description}`
          : (label ?? path)
      }
      placement="top"
      enterDelay={350}
      disableInteractive
    >
      <Typography
        variant="body2"
        noWrap={!grid}
        sx={
          grid
            ? {
                // Column 1 of the section grid: top-aligned to the first line,
                // wraps inside the capped column instead of truncating (FR-2).
                gridColumn: 1,
                alignSelf: "start",
                minWidth: 0,
                pt: "3px",
                overflowWrap: "anywhere",
                wordBreak: "break-word",
              }
            : isSlider
              ? { flex: "0 0 auto", maxWidth: 96, minWidth: 0 }
              : { flex: 1, minWidth: 0 }
        }
      >
        {label ?? path}
      </Typography>
    </Tooltip>
  );

  // The control cluster: modulator/learn/range buttons, the control itself, and
  // the numeric readout. In grid mode this is column 2; otherwise it sits inline
  // after the label inside the row's flex stack.
  const cluster = (
    <>
        {canModulate && (
          <IconButton
            size="small"
            data-modbtn={path}
            title={
              modulated
                ? `modulated: ${String((p.modulator as { type?: unknown }).type)}${modOn ? "" : " (paused)"}`
                : "attach a modulator"
            }
            onClick={(e) => {
              e.stopPropagation();
              setModAnchor((a) => (a ? null : e.currentTarget));
            }}
            sx={{
              color: modOn ? "warning.main" : modulated ? "#8a702fcc" : "text.secondary",
              fontSize: 14,
              p: 0.25,
            }}
          >
            ∿
          </IconButton>
        )}
        {p.type !== "color" && (
        <Button
          className="learnbtn"
          data-learn={path}
          onClick={onLearn}
          title={
            learning
              ? "move a controller… (click to cancel)"
              : bindingsFor.length > 0
                ? `${bindingsFor
                    .map((b) => `cc${b.cc} ${b.mode}${b.mode === "set" ? ` ${b.value}` : ""}`)
                    .join(" · ")}${hasModes ? " — click to edit" : " — click to unbind"}`
                : hasModes
                  ? "MIDI-learn: click to choose absolute / cycle / set"
                  : "MIDI-learn: click, then move a knob"
          }
          sx={{
            minWidth: 0,
            px: 0.75,
            py: 0,
            fontSize: 11,
            lineHeight: "18px",
            ...(learning
              ? {
                  bgcolor: "warning.main",
                  color: "#000",
                  borderColor: "warning.main",
                  animation: "learnpulse 0.9s infinite alternate",
                }
              : binding
                ? { color: "primary.main", borderColor: "primary.main" }
                : { color: "text.secondary" }),
          }}
        >
          {learning ? "···" : bindingsFor.length > 1 ? `cc×${bindingsFor.length}` : binding ? `cc${binding.cc}` : "M"}
        </Button>
        )}
        {isSlider && (
          <IconButton
            size="small"
            data-range={path}
            title={
              rangeOverridden
                ? `range ${min}–${max} (overridden) — click to edit`
                : "edit slider range (widen / narrow)"
            }
            onClick={openRange}
            sx={{ color: rangeOverridden ? "warning.main" : "text.secondary", fontSize: 13, p: 0.25 }}
          >
            ⟷
          </IconButton>
        )}
        {p.type === "bool" ? (
          <ToggleButton
            size="small"
            value="on"
            selected={p.value === true}
            disabled={modOn}
            data-path={path}
            onChange={() => link.sendParam(instance, path, !(p.value === true))}
            sx={{ py: 0, px: 1.25, fontSize: 11, lineHeight: "18px", textTransform: "none" }}
          >
            {p.value === true ? "on" : "off"}
          </ToggleButton>
        ) : p.type === "color" ? (
          <Box
            component="input"
            type="color"
            value={String(p.value)}
            onChange={(e: ChangeEvent<HTMLInputElement>) =>
              link.sendParam(instance, path, e.target.value)
            }
            {...inputAttrs}
            sx={{
              width: dense ? 44 : 64,
              height: 24,
              p: 0,
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              bgcolor: "transparent",
              cursor: "pointer",
            }}
          />
        ) : p.labels != null ? (
          <ToggleButtonGroup
            exclusive
            size="small"
            data-path={path}
            value={Number(drag ?? p.value)}
            onChange={(_, v) => {
              if (typeof v === "number") link.sendParam(instance, path, v);
            }}
          >
            {p.labels.map((l, i) => (
              <ToggleButton key={l} value={i + (p.min ?? 0)} sx={{ py: 0, px: 1, fontSize: 11 }}>
                {l}
              </ToggleButton>
            ))}
          </ToggleButtonGroup>
        ) : (
          <Slider
            size="small"
            min={min}
            max={max}
            step={p.type === "int" ? 1 : (p.step ?? (max - min) / 200)}
            value={drag ?? Number(p.value)}
            disabled={modOn}
            color={modOn ? "warning" : "primary"}
            onChange={(_, v) => {
              const n = v as number;
              setDrag(n); // local value wins over the 10 Hz broadcast mid-drag
              link.sendParam(instance, path, n);
            }}
            onChangeCommitted={() => setDrag(null)}
            slotProps={{ input: inputAttrs }}
            sx={{ flex: 1, minWidth: 56, mx: 0.5, py: 0.75 }}
          />
        )}
        {isSlider &&
          (edit != null ? (
            <Box
              component="input"
              autoFocus
              value={edit}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setEdit(e.target.value)}
              onFocus={(e: ChangeEvent<HTMLInputElement>) => e.currentTarget.select()}
              onKeyDown={(e: KeyboardEvent<HTMLInputElement>) => {
                if (e.key === "Enter") commitEdit();
                if (e.key === "Escape") setEdit(null);
              }}
              onBlur={commitEdit}
              sx={{
                width: 52,
                flex: "0 0 auto",
                font: "inherit",
                textAlign: "right",
                color: "inherit",
                bgcolor: "#0006",
                border: 1,
                borderColor: "primary.main",
                borderRadius: "3px",
                px: 0.25,
                py: 0,
                outline: "none",
              }}
            />
          ) : (
            <Typography
              variant="body2"
              data-value={path}
              onDoubleClick={() => setEdit(valueText)}
              title="double-click to type an exact value (widens the range if needed)"
              sx={{
                minWidth: 48,
                textAlign: "right",
                cursor: "text",
                "&:hover": { color: "primary.main" },
              }}
            >
              {valueText}
            </Typography>
          ))}
    </>
  );

  // Extras that render BELOW the row, spanning the full width in grid mode:
  // the palette-index swatch chooser and the color channel decomposition.
  const extras = (
    <>
      {isSlider && p.swatches != null && (
        <PaletteChoice instance={instance} path={path} p={p} />
      )}
      {p.type === "color" && (
        <ColorChannels instance={instance} path={path} p={p} channels={colorChannels ?? []} />
      )}
    </>
  );

  const popovers = (
    <>
      {canModulate && (
        <ModPopover
          instance={instance}
          path={path}
          p={p}
          anchorEl={modAnchor}
          onClose={() => setModAnchor(null)}
        />
      )}
      {isSlider && (
        <RangePopover
          instance={instance}
          path={path}
          p={p}
          anchorEl={rangeAnchor}
          onClose={() => setRangeAnchor(null)}
        />
      )}
      {hasModes && (
        <BindPopover
          instance={instance}
          scene={scene}
          path={path}
          p={p}
          bindings={bindingsFor}
          learning={controls.midi.learning}
          anchorEl={bindAnchor}
          onClose={() => setBindAnchor(null)}
        />
      )}
    </>
  );

  // Grid mode: `.widget` is display:contents so its children ARE the section
  // grid's items — label in column 1, cluster in column 2, extras spanning both.
  // The `.widget` class, the `modulated` marker, and every data-* hook stay on
  // the exact same elements as before (NFR-1) — only geometry changes.
  if (grid) {
    return (
      <Box className={`widget${modulated ? " modulated" : ""}`} sx={{ display: "contents" }}>
        {labelEl}
        <Box
          sx={{
            gridColumn: 2,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            gap: 0.5,
            flexWrap: p.labels != null ? "wrap" : undefined,
          }}
        >
          {cluster}
        </Box>
        {(isSlider && p.swatches != null) || p.type === "color" ? (
          <Box sx={{ gridColumn: "1 / -1", minWidth: 0 }}>{extras}</Box>
        ) : null}
        {popovers}
      </Box>
    );
  }

  return (
    <Box
      className={`widget${modulated ? " modulated" : ""}`}
      sx={{ mb: dense ? (fill ? 0.5 : 0) : 0.75, width: fill || !dense ? "auto" : 170 }}
    >
      <Stack
        direction="row"
        spacing={0.5}
        alignItems="center"
        flexWrap={p.labels != null ? "wrap" : undefined}
      >
        {labelEl}
        {cluster}
      </Stack>
      {extras}
      {popovers}
    </Box>
  );
}

/** Two color-channel lists are equal when they hold the same [path, desc] pairs by
 *  reference — the descriptors keep identity across ticks while unchanged (R7.4). */
function sameChannels(a?: Array<[string, ParamDesc]>, b?: Array<[string, ParamDesc]>): boolean {
  const la = a?.length ?? 0;
  const lb = b?.length ?? 0;
  if (la !== lb) return false;
  for (let i = 0; i < la; i++) {
    if (a![i]![0] !== b![i]![0] || a![i]![1] !== b![i]![1]) return false;
  }
  return true;
}

/**
 * Memoized so an UNCHANGED param's widget bails out when the panel re-renders on
 * another param's value change (FR-1). `EngineLink` keeps a stable `p` identity for
 * any param whose value didn't move, so the `a.p === b.p` compare is exact; an
 * animating/modulated param thus re-renders ONLY its own widget, not all N. Local
 * state (drag/edit/popovers) and the `useControls()` subscription still re-render
 * normally — `memo` gates props only, never hooks.
 */
export const ParamWidget = memo(
  ParamWidgetImpl,
  (a, b) =>
    a.instance === b.instance &&
    a.path === b.path &&
    a.p === b.p &&
    a.label === b.label &&
    a.dense === b.dense &&
    a.fill === b.fill &&
    a.grid === b.grid &&
    sameChannels(a.colorChannels, b.colorChannels),
);
