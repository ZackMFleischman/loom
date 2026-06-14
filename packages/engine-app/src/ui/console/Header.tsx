import {
  Box,
  Button,
  ButtonGroup,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  ListItemText,
  Menu,
  MenuItem,
  NativeSelect,
  Radio,
  TextField,
  Typography,
} from "@mui/material";
import { useEffect, useRef, useState } from "react";
import type { PanicMode, SessionSnapshot } from "@loom/sidecar/protocol";
import { useRenderFps } from "../fps-meter";
import { useEngine } from "../hooks";
import { mono } from "../theme";
import { countRender, fail, primeMidiPermission } from "../util";
import { hintFor } from "./keybindings";
import { MidiMonitorDialog } from "./MidiMonitorDialog";
import { TopBar } from "./primitives";

/** A light vertical separator between header clusters (FR-4). */
function GroupSep() {
  return <Divider orientation="vertical" flexItem sx={{ my: 0.75, borderColor: "divider" }} />;
}

type Props = {
  session: SessionSnapshot;
  onToggleRack: () => void;
  previewing: boolean;
  onTogglePreview: () => void;
  perfOpen: boolean;
  onTogglePerf: () => void;
};

export function Header({ session: s, onToggleRack, previewing, onTogglePreview, perfOpen, onTogglePerf }: Props) {
  countRender("Header");
  const link = useEngine();
  // The Console's own paint rate — independent of the engine's output fps below.
  const uiFps = useRenderFps();
  return (
    <TopBar component="header" spacing={1.25}>
      {/* ── Transport + audio ──────────────────────────────────── */}
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
        title={`tap tempo — click on the beat ${hintFor("tap")}`}
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

      <GroupSep />

      {/* ── Nav / views ────────────────────────────────────────── */}
      <Button onClick={onToggleRack} title={`input rack ${hintFor("rack")}`}>
        RACK
      </Button>
      <Button
        id="previewbtn"
        // FR-1: a real resting affordance in BOTH states. Resting = outlined
        // (reads as a button, weighted like a verb); active = contained (filled,
        // unmistakably engaged). Behavior (the `p` hotkey + click) is unchanged.
        variant={previewing ? "contained" : "outlined"}
        color={previewing ? "primary" : "inherit"}
        onClick={onTogglePreview}
        title={`preview the selected instance full-screen ${hintFor("preview")}`}
        sx={{ fontWeight: 700 }}
      >
        PREVIEW
      </Button>
      <ProjectsControl session={s} />

      <Box sx={{ flex: 1 }} />

      {/* ── Monitoring ─────────────────────────────────────────── */}
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
      <Button
        id="perfbtn"
        variant={perfOpen ? "contained" : "outlined"}
        color={perfOpen ? "primary" : "inherit"}
        onClick={onTogglePerf}
        title={`perf diagnostics overlay ${hintFor("perf")}`}
        sx={{ fontWeight: 700, minWidth: "unset", px: 1 }}
      >
        PERF
      </Button>
      <Button
        variant="ghost"
        component="a"
        href="/"
        target="_blank"
        rel="noopener"
        title="open the Output window in a new tab"
      >
        output ⧉
      </Button>
      <Button
        variant="ghost"
        component="a"
        href="/staged.html"
        target="_blank"
        rel="noopener"
        title="open the staged preview in a new tab"
      >
        staged ⧉
      </Button>

      <GroupSep />

      {/* ── Emergency ──────────────────────────────────────────── */}
      <PanicControls session={s} />
    </TopBar>
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
 * PANIC as a split button (panic-safe-scene-redesign FR-5). The big red primary
 * (`#panic`, one click executes the armed mode / RESUME while panicked) plus an
 * attached `▾` (`#panicmenu`) that opens the only place mode/target live:
 *
 * - **Arm: Hold** (`#panic-arm-hold`) — the resting default.
 * - **Arm: Safe scene** (`#panic-arm-scene`) — DISABLED until a SAFE target is
 *   designated (FR-4/Q4: disable + inline picker, never silently degrade). The
 *   inline target list (`[data-panictarget="<id>"]`) designates any existing
 *   instance via `set_panic_instance`; choosing one and arming scene is one flow.
 *
 * Arming is human-only and the armed MODE is persisted in localStorage so a
 * reload re-arms the same behavior (the SAFE *target* is not persisted, NFR-2 —
 * a fresh boot has none and scene-panic stays unavailable until re-designated).
 * The armed mode reflects the engine snapshot; flipping the arm WHILE panicked
 * re-executes it — the hold→scene escalation (Stage no-ops a scene→hold
 * downgrade). FR-7: scene-panic distinguishes "none" (pick a target) from
 * "error" (designated target broke → ⚠).
 */
function PanicControls({ session: s }: { session: SessionSnapshot }) {
  const link = useEngine();
  const mode = s.panicMode; // engine is the source of truth
  const synced = useRef(false);
  const groupRef = useRef<HTMLDivElement>(null);
  const [menuOpen, setMenuOpen] = useState(false);

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

  const designate = (id: string) => {
    void link
      .req("set_panic_instance", { instance: id })
      .then(() => arm("scene")) // choosing a target + arming scene is one gesture
      .catch(fail);
  };

  // status: "none" (no target → scene-panic unavailable) vs "error" (designated
  // target broke) vs "ok". `safeId` is the currently designated instance, if any.
  const sceneStatus = s.panicScene.status;
  const sceneAvailable = sceneStatus === "ok";
  const sceneBroken = sceneStatus === "error";
  const safeId = s.instances.find((i) => i.pinned === "panic")?.id ?? null;
  // Candidates: any instance can be designated (matches LIVE/STAGED pointers).
  const candidates = s.instances;

  return (
    <ButtonGroup
      ref={groupRef}
      variant="outlined"
      disableElevation
      sx={{ "& .MuiButtonGroup-grouped": { minWidth: "unset" } }}
    >
      <Button
        id="panic"
        color="error"
        // danger taxonomy: outlined-red at rest, FILLED while engaged (Q2 — the
        // highest-stakes verb reads loudest only when it's live). The `danger`
        // variant carries the heavy weight + red border once; only the larger
        // hit padding (this is the emergency hatch) stays local.
        variant={s.panicked ? "contained" : "danger"}
        onClick={() => void link.req(s.panicked ? "resume" : "panic", s.panicked ? {} : { mode }).catch(fail)}
        title={`${
          s.panicked
            ? "RESUME — return to the live output"
            : mode === "scene"
              ? sceneAvailable
                ? `PANIC → cut to safe scene "${s.panicScene.name}"`
                : "PANIC → will hold (no usable SAFE target)"
              : "PANIC → freeze the last frame (hold)"
        } ${hintFor("panic")}`}
        sx={{ fontSize: 15, px: 2.5 }}
      >
        {s.panicked ? "RESUME" : "PANIC"}
      </Button>
      <Button
        id="panicmenu"
        color="error"
        variant={s.panicked ? "contained" : "danger"}
        size="small"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        title="PANIC mode & SAFE target"
        onClick={() => setMenuOpen((o) => !o)}
        sx={{ px: 0.5, fontSize: 12, lineHeight: 1 }}
      >
        ▾
      </Button>
      <Menu
        id="panic-menu"
        anchorEl={groupRef.current}
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: { minWidth: 240 } } }}
      >
        <Typography variant="caption" sx={{ px: 2, py: 0.5, display: "block", color: "text.secondary" }}>
          PANIC mode
        </Typography>
        <MenuItem id="panic-arm-hold" onClick={() => arm("hold")} sx={{ py: 0.25 }}>
          <Radio checked={mode === "hold"} size="small" sx={{ p: 0.5, mr: 1 }} />
          <ListItemText primary="Hold" secondary="freeze the last frame" />
        </MenuItem>
        <MenuItem
          id="panic-arm-scene"
          disabled={!sceneAvailable}
          onClick={() => arm("scene")}
          sx={{ py: 0.25 }}
        >
          <Radio checked={mode === "scene"} disabled={!sceneAvailable} size="small" sx={{ p: 0.5, mr: 1 }} />
          <ListItemText
            primary={
              <Box component="span" sx={{ color: sceneBroken ? "warning.main" : undefined }}>
                {sceneBroken ? "⚠ Safe scene" : "Safe scene"}
              </Box>
            }
            secondary={
              sceneAvailable
                ? `cut to "${s.panicScene.name}"`
                : sceneBroken
                  ? `target broke — ${s.panicScene.error ?? "build failed"}`
                  : "pick a SAFE target below"
            }
          />
        </MenuItem>
        <Divider />
        <Typography variant="caption" sx={{ px: 2, py: 0.5, display: "block", color: "text.secondary" }}>
          SAFE target {safeId == null ? "(none — scene-panic unavailable)" : null}
        </Typography>
        {candidates.length === 0 && (
          <MenuItem disabled sx={{ py: 0.25 }}>
            <ListItemText secondary="spawn an instance to designate one" />
          </MenuItem>
        )}
        {candidates.map((i) => (
          <MenuItem
            key={i.id}
            data-panictarget={i.id}
            selected={i.id === safeId}
            onClick={() => designate(i.id)}
            sx={{ py: 0.25 }}
          >
            <Radio checked={i.id === safeId} size="small" sx={{ p: 0.5, mr: 1 }} />
            <ListItemText
              primary={i.id}
              secondary={i.scene}
              slotProps={{ primary: { sx: { fontFamily: mono, fontSize: 13 } } }}
            />
          </MenuItem>
        ))}
      </Menu>
    </ButtonGroup>
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
