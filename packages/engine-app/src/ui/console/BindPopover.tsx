import { Box, Button, Popover, Stack, Typography } from "@mui/material";
import type { MidiBinding, SessionSnapshot } from "@loom/sidecar/protocol";
import type { ParamDesc } from "../engine-link";
import { useEngine } from "../hooks";
import { fail } from "../util";

type Mode = "absolute" | "set" | "cycle";

type Props = {
  instance: string;
  /** The instance's scene (bindings are scene-keyed; null until resolved). */
  scene: string | null;
  path: string;
  p: ParamDesc;
  /** This param's bindings (scene-resolved by the caller). */
  bindings: MidiBinding[];
  learning: SessionSnapshot["midi"]["learning"];
  anchorEl: HTMLElement | null;
  onClose: () => void;
};

/**
 * Pick HOW a control drives this param, then arm learn: absolute follows a
 * knob, cycle/toggle steps per button press, set <option> builds a radio
 * group (one button per option — S/M/R rows). Existing bindings list with
 * per-binding unbind, which radio groups need.
 */
export function BindPopover({ instance, scene, path, p, bindings, learning, anchorEl, onClose }: Props) {
  const link = useEngine();
  const isBool = p.type === "bool";
  const min = typeof p.min === "number" ? p.min : 0;
  const labels = Array.isArray(p.labels) ? p.labels : null;

  // Scene must match too: the same path (palette.source) exists on many
  // scenes, and pulsing the wrong tile's row invites a misbind.
  const armed = (mode: Mode, value?: number) =>
    learning != null &&
    learning.scene === scene &&
    learning.path === path &&
    (learning.mode ?? "absolute") === mode &&
    learning.value === value;

  const arm = (mode: Mode, value?: number) =>
    void link
      .req("midi_learn", { instance, path, mode, ...(value !== undefined ? { value } : {}) })
      .catch(fail);

  const row = (label: string, mode: Mode, value?: number) => (
    <Button
      key={`${mode}:${value ?? ""}`}
      data-bindmode={value !== undefined ? `${mode}:${value}` : mode}
      onClick={() => arm(mode, value)}
      sx={{
        justifyContent: "flex-start",
        fontSize: 12,
        py: 0.25,
        ...(armed(mode, value)
          ? { bgcolor: "warning.main", color: "#000", animation: "learnpulse 0.9s infinite alternate" }
          : {}),
      }}
    >
      {armed(mode, value) ? `${label} — move a control…` : label}
    </Button>
  );

  const describeBinding = (b: MidiBinding) =>
    b.mode === "set"
      ? `set ${labels?.[(b.value ?? 0) - min] ?? b.value}`
      : b.mode === "cycle" && isBool
        ? "toggle"
        : b.mode;

  return (
    <Popover
      open={anchorEl != null}
      anchorEl={anchorEl}
      onClose={onClose}
      anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
      transformOrigin={{ vertical: "top", horizontal: "right" }}
    >
      <Stack className="bindpop" sx={{ p: 1, width: 250 }}>
        {row("absolute — follow a knob", "absolute")}
        {row(isBool ? "toggle — button flips it" : "cycle — button steps, wraps", "cycle")}
        {labels?.map((l, i) => row(`set: ${l}`, "set", i + min))}
        {bindings.length > 0 && (
          <Box sx={{ borderTop: 1, borderColor: "divider", mt: 0.5, pt: 0.5 }}>
            {bindings.map((b) => (
              <Stack
                key={`${b.cc}:${b.mode}:${b.value ?? ""}`}
                direction="row"
                alignItems="center"
                spacing={0.5}
              >
                <Typography variant="caption" sx={{ flex: 1 }}>
                  cc{b.cc} → {describeBinding(b)}
                </Typography>
                <Button
                  size="small"
                  data-unbind={`${b.cc}:${b.mode}:${b.value ?? ""}`}
                  sx={{ minWidth: 0, px: 0.5, color: "text.secondary" }}
                  onClick={() =>
                    void link
                      .req("midi_unbind", {
                        instance,
                        path,
                        mode: b.mode,
                        ...(b.mode === "set" && b.value !== undefined ? { value: b.value } : {}),
                      })
                      .catch(fail)
                  }
                >
                  ✕
                </Button>
              </Stack>
            ))}
          </Box>
        )}
      </Stack>
    </Popover>
  );
}
