import {
  Box,
  Button,
  ButtonGroup,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  NativeSelect,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import type { PanicMode, SessionSnapshot } from "@loom/sidecar/protocol";
import { useRenderFps } from "../fps-meter";
import { useEngine } from "../hooks";
import { mono } from "../theme";
import { fail, primeMidiPermission } from "../util";
import { MidiMonitorDialog } from "./MidiMonitorDialog";

type Props = {
  session: SessionSnapshot;
  onToggleRack: () => void;
  previewing: boolean;
  onTogglePreview: () => void;
};

export function Header({ session: s, onToggleRack, previewing, onTogglePreview }: Props) {
  const link = useEngine();
  // The Console's own paint rate — independent of the engine's output fps below.
  const uiFps = useRenderFps();
  return (
    <Stack
      direction="row"
      spacing={1.25}
      alignItems="center"
      component="header"
      sx={{ px: 1.25, py: 0.5, bgcolor: "background.paper", borderBottom: 1, borderColor: "divider", flex: "0 0 auto" }}
    >
      <Typography
        sx={{
          fontFamily: mono,
          fontWeight: 800,
          letterSpacing: ".28em",
          color: "primary.main",
          fontSize: 14,
          userSelect: "none",
          mr: 0.25,
        }}
      >
        LOOM
      </Typography>
      <Button
        id="tap"
        title="tap tempo — click on the beat"
        onClick={() => void link.req("set_transport", { tap: true }).catch(fail)}
        sx={{ fontFamily: mono, px: 1 }}
      >
        <Box component="b" id="bpm" sx={{ fontSize: 13 }}>
          {s.bpm.toFixed(0)}
        </Box>
        <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
          BPM
        </Typography>
      </Button>
      <Box
        title="audio level"
        sx={{
          width: 80,
          height: 8,
          bgcolor: "#0006",
          border: 1,
          borderColor: "divider",
          borderRadius: "4px",
          overflow: "hidden",
        }}
      >
        <Box
          id="rmsfill"
          sx={{ height: "100%", bgcolor: "primary.main", transition: "width 80ms linear" }}
          style={{ width: `${Math.min(100, s.rms * 220)}%` }}
        />
      </Box>
      <AudioPicker session={s} />
      <MidiStatus midi={s.midi} />
      <Button onClick={onToggleRack} title="input rack (i)">
        RACK
      </Button>
      <Button
        id="previewbtn"
        variant={previewing ? "contained" : "text"}
        onClick={onTogglePreview}
        title="preview the selected instance full-screen (p)"
      >
        PREVIEW
      </Button>
      <ProjectsControl session={s} />
      <Box sx={{ flex: 1 }} />
      {/* Two independent meters: the Output window's render rate (engine, from
          the snapshot) and the Console's own paint rate (this React app). When
          the Console janks while Output stays smooth, the gap shows it here. */}
      <Typography
        id="uifps"
        title="Console UI paint rate — this app's own render loop (independent of the Output engine)"
        sx={{
          fontFamily: mono,
          fontSize: 14,
          fontWeight: 700,
          color: uiFps > 0 && uiFps < 30 ? "warning.main" : "text.primary",
        }}
      >
        {uiFps.toFixed(0)}
        <Box component="span" sx={{ color: "text.secondary", fontSize: 11, fontWeight: 400 }}>
          {" ui"}
        </Box>
      </Typography>
      <Typography
        id="fps"
        title="Output window render rate · frame counter (engine)"
        sx={{ fontFamily: mono, fontSize: 14, fontWeight: 700 }}
      >
        {s.fps.toFixed(0)}
        <Box component="span" sx={{ color: "text.secondary", fontSize: 11, fontWeight: 400 }}>
          {` out · f${s.frame}`}
        </Box>
      </Typography>
      <Button component="a" href="/" target="_blank" rel="noopener" title="open the Output window in a new tab">
        output ⧉
      </Button>
      <Button
        component="a"
        href="/staged.html"
        target="_blank"
        rel="noopener"
        title="open the staged preview in a new tab"
      >
        staged ⧉
      </Button>
      <PanicControls session={s} />
    </Stack>
  );
}

/**
 * Projects — set lists: load a saved set (audience-safe: sandboxes only, LIVE
 * keeps playing until you commit from the loaded set) and save the current one
 * (in tile order). The select reflects the engine's cached project list.
 */
function ProjectsControl({ session: s }: { session: SessionSnapshot }) {
  const link = useEngine();
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");

  const load = (n: string) => {
    if (!n) return;
    void link.req("load_project", { name: n }).catch(fail);
  };
  const save = () => {
    const n = name.trim();
    if (!n) return;
    let tileOrder: string[] = [];
    try {
      tileOrder = JSON.parse(localStorage.getItem("loom.tileorder") ?? "[]") as string[];
    } catch {
      // engine (creation) order is a fine fallback
    }
    void link
      .req("save_project", { name: n, tileOrder })
      .then(() => {
        setSaveOpen(false);
        setName("");
      })
      .catch(fail);
  };

  return (
    <>
      <NativeSelect
        value=""
        inputProps={{ id: "projects", title: "load a saved project — sandboxes only, LIVE keeps playing" }}
        onChange={(e) => load(e.target.value)}
        sx={{ fontSize: 12 }}
      >
        <option value="" disabled>
          {s.projects.length > 0 ? "load project…" : "(no projects)"}
        </option>
        {s.projects.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </NativeSelect>
      <Button id="projsave" title="save the current instance set as a project" onClick={() => setSaveOpen(true)}>
        ⌑ save set
      </Button>
      <Dialog open={saveOpen} onClose={() => setSaveOpen(false)}>
        <DialogTitle sx={{ fontSize: 16 }}>Save project</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            size="small"
            margin="dense"
            label='name (e.g. "01-opener")'
            fullWidth
            value={name}
            inputProps={{ id: "projname" }}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
            }}
            helperText="writes content/state/projects/<name>.json — set lists live in git"
          />
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setSaveOpen(false)}>cancel</Button>
          <Button id="projsaveok" onClick={save} variant="contained" disabled={name.trim() === ""}>
            save
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

const PANIC_MODE_KEY = "loom.panicMode";

/**
 * The big red button (one click, executes the armed mode) plus the
 * arm-in-advance HOLD | SAFE SCENE control. Arming is human-only and persisted
 * in localStorage so a reload never silently re-arms a different behavior. The
 * armed mode reflects the engine snapshot; flipping the arm WHILE panicked also
 * re-executes it, which is the hold→scene escalation path (Stage ignores a
 * scene→hold downgrade). FR-7: the SCENE option shows a warning when the panic
 * instance is in build-fallback.
 */
function PanicControls({ session: s }: { session: SessionSnapshot }) {
  const link = useEngine();
  const mode = s.panicMode; // engine is the source of truth
  const synced = useRef(false);

  // On first connect, re-arm the engine from the persisted choice (the engine
  // boots in "hold"); thereafter the snapshot drives the UI.
  useEffect(() => {
    if (synced.current) return;
    const saved = localStorage.getItem(PANIC_MODE_KEY);
    if ((saved === "hold" || saved === "scene") && saved !== s.panicMode) {
      void link.req("arm_panic_mode", { mode: saved }).catch(fail);
    }
    synced.current = true;
  }, [s.panicMode, link]);

  const arm = (next: PanicMode) => {
    localStorage.setItem(PANIC_MODE_KEY, next);
    void link.req("arm_panic_mode", { mode: next }).catch(fail);
    // Escalate live if already panicked (hold→scene); Stage no-ops scene→hold.
    if (s.panicked) void link.req("panic", { mode: next }).catch(fail);
  };

  const sceneBroken = s.panicScene.status === "error";
  const safeId = s.instances.find((i) => i.pinned === "panic")?.id ?? null;
  return (
    <Stack direction="row" spacing={1} alignItems="center">
      <ButtonGroup id="panicmode" size="small" variant="outlined" disableElevation>
        <Button
          id="panicmode-hold"
          variant={mode === "hold" ? "contained" : "outlined"}
          onClick={() => arm("hold")}
          sx={{ fontSize: 11, lineHeight: 1.1, px: 1 }}
        >
          HOLD
        </Button>
        <Button
          id="panicmode-scene"
          color={sceneBroken ? "warning" : "primary"}
          variant={mode === "scene" ? "contained" : "outlined"}
          onClick={() => arm("scene")}
          title={
            sceneBroken
              ? `safe scene unavailable — PANIC will hold (${s.panicScene.error ?? "build failed"})`
              : `cut to safe scene "${s.panicScene.name}"`
          }
          sx={{ fontSize: 11, lineHeight: 1.1, px: 1, textTransform: "none" }}
        >
          {sceneBroken ? "⚠ " : ""}SAFE SCENE
        </Button>
      </ButtonGroup>
      <NativeSelect
        value={safeId ?? ""}
        inputProps={{ id: "panicscene", title: "SAFE target — the instance scene-panic cuts to" }}
        onChange={(e) => void link.req("set_panic_instance", { instance: e.target.value }).catch(fail)}
        sx={{ fontSize: 12, color: sceneBroken ? "warning.main" : "text.primary" }}
      >
        {/* Pick any existing instance as the safe target; its scene is what
            scene-panic cuts to. Spawn + tune a tile, then designate it here. */}
        {safeId == null && <option value="">(none)</option>}
        {s.instances.map((i) => (
          <option key={i.id} value={i.id}>
            {i.id} · {i.scene}
          </option>
        ))}
      </NativeSelect>
      <Button
        id="panic"
        color="error"
        variant={s.panicked ? "contained" : "outlined"}
        onClick={() => void link.req(s.panicked ? "resume" : "panic", s.panicked ? {} : { mode }).catch(fail)}
        sx={{ fontWeight: 700, fontSize: 15, px: 2.5 }}
      >
        {s.panicked ? "RESUME" : "PANIC"}
      </Button>
    </Stack>
  );
}

/** Audio source picker: reflects the engine's mode unless the user is mid-interaction. */
function AudioPicker({ session: s }: { session: SessionSnapshot }) {
  const link = useEngine();
  const [focused, setFocused] = useState(false);
  const [value, setValue] = useState("test");
  useEffect(() => {
    if (focused) return;
    if (s.audioMode === "test") {
      setValue("test");
    } else if (s.audioMode === "mic") {
      setValue((v) => (v.startsWith("mic:") ? v : s.audioDevices[0] ? `mic:${s.audioDevices[0].id}` : v));
    }
  }, [s.audioMode, s.audioDevices, focused]);
  return (
    <NativeSelect
      value={value}
      inputProps={{ id: "audiomode", title: "audio input" }}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        const v = e.target.value;
        setValue(v);
        void link
          .req("set_audio", v === "test" ? { mode: "test" } : { mode: "mic", deviceId: v.slice(4) || undefined })
          .catch(fail);
      }}
    >
      <option value="test">test signal</option>
      {s.audioDevices.map((d) => (
        <option key={d.id} value={`mic:${d.id}`}>
          {d.label}
        </option>
      ))}
    </NativeSelect>
  );
}

function MidiStatus({ midi }: { midi: SessionSnapshot["midi"] }) {
  const [monitorOpen, setMonitorOpen] = useState(false);
  let text: string;
  let title: string;
  if (midi.status !== "ready") {
    text = "MIDI: connect";
    title = "click to grant MIDI access (Chrome prompts once per site)";
  } else if (midi.devices.length === 0) {
    text = "MIDI: no devices";
    title = "access granted — plug in a controller, it hot-plugs · click for the monitor";
  } else {
    text = `MIDI ${midi.devices.join(" · ")}`;
    title = "connected MIDI inputs · click for the monitor";
  }
  return (
    <>
      <Typography
        id="midistat"
        variant="caption"
        title={title}
        onClick={() => {
          // No access yet? This click IS the user gesture — pop the prompt too.
          if (midi.status !== "ready") primeMidiPermission();
          setMonitorOpen(true);
        }}
        sx={{
          color:
            midi.status !== "ready" ? "warning.main" : midi.devices.length === 0 ? "text.secondary" : "text.primary",
          cursor: "pointer",
          textDecoration: midi.status !== "ready" ? "underline dotted" : "none",
        }}
      >
        {text}
      </Typography>
      <MidiMonitorDialog midi={midi} open={monitorOpen} onClose={() => setMonitorOpen(false)} />
    </>
  );
}
