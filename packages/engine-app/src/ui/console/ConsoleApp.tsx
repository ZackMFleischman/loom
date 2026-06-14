import {
  DndContext,
  PointerSensor,
  closestCenter,
  pointerWithin,
  useSensor,
  useSensors,
  type CollisionDetection,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove } from "@dnd-kit/sortable";
import { Box } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import { downloadConsoleCapture } from "../../console-capture";
import { Disconnected } from "../Disconnected";
import { useAvailableScenes, useConnected, useEngine, useEngineState, useHasSession, useInstanceIds } from "../hooks";
import { countRender, fail } from "../util";
import { toggleAdvanced } from "./advanced-store";
import { HotkeyCheatsheet } from "./HotkeyCheatsheet";
import { Header } from "./Header";
import { KEYBINDINGS } from "./keybindings";
import type { KeymapContext } from "./keymap";
import { useKeymap } from "./keymap";
import { ParamPanel } from "./ParamPanel";
import { PerfOverlay } from "./PerfOverlay";
import { PreviewMode } from "./PreviewMode";
import { Rack } from "./Rack";
import { STAGE_ZONE_ID, StageDropZone } from "./StageDropZone";
import { StageStrip } from "./StageStrip";
import { sortTiles, TileGrid } from "./TileGrid";

const EMBED_AFTER_MS = 2500;
const ORDER_KEY = "loom.tileorder";

const loadOrder = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(ORDER_KEY) ?? "[]") as string[];
  } catch {
    return [];
  }
};

// The stage zone wins whenever the pointer is inside it; otherwise tiles
// sort by closest center (the grid strategy's preference).
const collision: CollisionDetection = (args) => {
  const zone = pointerWithin(args).find((c) => c.id === STAGE_ZONE_ID);
  return zone ? [zone] : closestCenter(args).filter((c) => c.id !== STAGE_ZONE_ID);
};

type EngineWindow = Window & { __loom?: { resumeAudio?: () => void } };

/**
 * The top chrome (Header + StageStrip) that DOES need the live ~10 Hz session.
 * Isolated into its own subcomponent so its per-tick re-render stays here — it is
 * a SIBLING of TileGrid, not an ancestor, so it can't cascade into the tiles
 * (FR-1). ConsoleApp itself never reads the full snapshot.
 */
function TopChrome(props: {
  onToggleRack: () => void;
  previewing: boolean;
  onTogglePreview: () => void;
  perfOpen: boolean;
  onTogglePerf: () => void;
}) {
  const { session } = useEngineState();
  if (session == null) return null;
  return (
    <StageDropZone>
      <Header
        session={session}
        onToggleRack={props.onToggleRack}
        previewing={props.previewing}
        onTogglePreview={props.onTogglePreview}
        perfOpen={props.perfOpen}
        onTogglePerf={props.onTogglePerf}
      />
      <StageStrip session={session} />
    </StageDropZone>
  );
}

/** The rack drawer — needs live `inputs` meter values + the globals manifest. */
function RackDrawer() {
  const { session, manifests } = useEngineState();
  if (session == null) return null;
  return <Rack session={session} globals={manifests.globals ?? {}} />;
}

/** The full-res preview overlay — needs the live session for pointers/scene. */
function PreviewOverlay({ instance, onExit }: { instance: string | null; onExit: () => void }) {
  const { session } = useEngineState();
  if (session == null) return null;
  return <PreviewMode instance={instance} session={session} onExit={onExit} />;
}

export function ConsoleApp() {
  countRender("ConsoleApp");
  const link = useEngine();
  // FR-1: ConsoleApp hosts the DndContext, whose value the dnd-kit `useSortable`
  // tiles consume. A context-value change re-renders EVERY consumer regardless of
  // React.memo, so ConsoleApp must NOT re-render on the 10 Hz state broadcast. It
  // subscribes ONLY to rarely-changing narrow stores — never the full snapshot.
  // The chrome that needs live session data reads it in its own subcomponent
  // (TopChrome / RackDrawer / PreviewOverlay), so the churn never reaches the grid.
  const hasSession = useHasSession();
  const connected = useConnected();
  const ids = useInstanceIds();
  const scenes = useAvailableScenes();
  const [selected, setSelected] = useState<string | null>(null);
  const [solo, setSolo] = useState<string | null>(null);
  const [rackOpen, setRackOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [perfOpen, setPerfOpen] = useState(false);
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  const [order, setOrder] = useState<string[]>(loadOrder);
  // Refs let the drag handler read the current ids/order without re-subscribing,
  // keeping its identity (and thus the DndContext value) stable across renders.
  const idsRef = useRef(ids);
  idsRef.current = ids;
  const orderRef = useRef(order);
  orderRef.current = order;
  // The keymap context getter (below) runs at keystroke time, not render time,
  // so it reads the freshest selection/solo through refs rather than re-running.
  const selectedRef = useRef(selected);
  selectedRef.current = selected;

  // Stable callbacks (FR-1): a fresh function identity every render would defeat
  // the memoized Tiles (their `onSelect`/`onSolo`/`onRenamed`/`onCreated` props),
  // re-rendering the whole grid on every state tick despite the slice stores.
  const applyOrder = useCallback((next: string[]) => {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(next));
    } catch {
      // order just won't persist across reloads
    }
    setOrder(next);
  }, []);
  const onSolo = useCallback((id: string) => setSolo((cur) => (cur === id ? null : id)), []);

  // Tile drags start after 8px of slop, so click/double-click still work.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const onDragEnd = useCallback(
    (e: DragEndEvent) => {
      const activeId = String(e.active.id);
      const overId = e.over != null ? String(e.over.id) : null;
      if (overId === STAGE_ZONE_ID) {
        // One gesture, all the way: drop on the top bar = stage + commit.
        void link
          .req("stage", { instance: activeId })
          .then(() => link.req("commit", {}))
          .catch(fail);
        return;
      }
      if (overId == null || overId === activeId) return;
      const cur = sortTiles(
        idsRef.current.map((id) => ({ id })),
        orderRef.current,
      ).map((i) => i.id);
      const from = cur.indexOf(activeId);
      const to = cur.indexOf(overId);
      if (from < 0 || to < 0) return;
      applyOrder(arrayMove(cur, from, to));
    },
    [link, applyOrder],
  );

  // The Output window is optional: if no engine says hello within a grace
  // period, boot one in a hidden same-origin iframe. It stands down by itself
  // if a real Output window opens later. ?embed=0 disables (validators use it
  // so an embedded engine never dials their isolated sidecar's default port).
  const allowEmbed = new URLSearchParams(location.search).get("embed") !== "0";
  const [embed, setEmbed] = useState(false);
  const embedFrame = useRef<HTMLIFrameElement | null>(null);
  useEffect(() => {
    if (!allowEmbed || embed || connected) return;
    const t = window.setTimeout(() => setEmbed(true), EMBED_AFTER_MS);
    return () => window.clearTimeout(t);
  }, [allowEmbed, embed, connected]);

  // The visible tile order (for j/k tile navigation) — same ordering the grid
  // renders, computed lazily at keystroke time.
  const orderedIds = useCallback(
    () =>
      sortTiles(
        idsRef.current.map((id) => ({ id })),
        orderRef.current,
      ).map((i) => i.id),
    [],
  );

  // Hotkeys — the entire Console keymap is one delegated listener driven by the
  // data-driven registry (keyboard-shortcuts FR-1/NFR-2). The context getter runs
  // at keystroke time and reads the freshest engine state straight from the link
  // (no re-render churn) and UI state through refs. `i`/`p`/`d`/`Esc`/`t` keep
  // their exact prior behavior; the rest delegate to existing handlers (NFR-1).
  const getKeymapContext = useCallback((): KeymapContext => {
    const pointers = link.pointers();
    const meta = link.meta();
    const sel = selectedRef.current;
    return {
      req: (type, args = {}) => void link.req(type, args).catch(fail),
      toggleRack: () => setRackOpen((o) => !o),
      togglePreview: () => setPreviewing((p) => !p),
      togglePerf: () => setPerfOpen((o) => !o),
      toggleAdvanced,
      closeTopPopover: () => true, // MUI's modal closes itself on Escape (passive)
      leaveOverlays: () => {
        setPreviewing(false);
        setPerfOpen(false);
      },
      capture: () => void downloadConsoleCapture().catch(fail),
      toggleCheatsheet: () => setCheatsheetOpen((o) => !o),
      cheatsheetOpen,
      selectStep: (dir) => {
        const list = orderedIds();
        if (list.length === 0) return;
        const cur = selectedRef.current;
        const i = cur != null ? list.indexOf(cur) : -1;
        const next = i < 0 ? (dir > 0 ? 0 : list.length - 1) : (i + dir + list.length) % list.length;
        setSelected(list[next] ?? null);
      },
      soloSelected: () => {
        if (sel != null) onSolo(sel);
      },
      stageSelected: () => {
        if (sel == null || sel === "globals") return;
        const isStaged = pointers.staged === sel;
        if (pointers.live === sel) return;
        void link.req(isStaged ? "unstage" : "stage", isStaged ? {} : { instance: sel }).catch(fail);
      },
      destroySelected: () => {
        if (sel == null || pointers.live === sel) return;
        void link.req("destroy_instance", { instance: sel }).catch(fail);
      },
      selected: sel,
      panicked: pointers.panicked,
      staged: pointers.staged,
      midiLearning: meta?.midi.learning != null,
    };
  }, [link, cheatsheetOpen, onSolo, orderedIds]);
  useKeymap(KEYBINDINGS, getKeymapContext);

  return (
    <Box
      sx={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
      // AudioContexts need a user gesture; the embedded engine's document never
      // gets one, but activation is visible to same-origin frames — forward ours.
      onPointerDownCapture={() => {
        (embedFrame.current?.contentWindow as EngineWindow | null)?.__loom?.resumeAudio?.();
      }}
    >
      {hasSession && (
        <DndContext sensors={sensors} collisionDetection={collision} onDragEnd={onDragEnd}>
          <TopChrome
            onToggleRack={() => setRackOpen((o) => !o)}
            previewing={previewing}
            onTogglePreview={() => setPreviewing((p) => !p)}
            perfOpen={perfOpen}
            onTogglePerf={() => setPerfOpen((o) => !o)}
          />
          <Box component="main" sx={{ flex: 1, display: "flex", minHeight: 0 }}>
            <TileGrid
              scenes={scenes}
              selected={selected}
              solo={solo}
              order={order}
              onOrderChange={applyOrder}
              onSelect={setSelected}
              onSolo={onSolo}
              onCreated={setSelected}
            />
            {/* While previewing, the overlay carries the (single) params drawer —
                don't mount a second one here or two #panel ids would collide. */}
            {!previewing && <ParamPanel instance={selected} />}
          </Box>
          {rackOpen && <RackDrawer />}
        </DndContext>
      )}
      {hasSession && previewing && <PreviewOverlay instance={selected} onExit={() => setPreviewing(false)} />}
      {embed && (
        <Box
          component="iframe"
          ref={embedFrame}
          src="/?embedded=1&audio=test"
          title="embedded loom engine"
          allow="autoplay; microphone"
          sx={{
            position: "fixed",
            bottom: 0,
            right: 0,
            width: 2,
            height: 2,
            opacity: 0,
            border: 0,
            pointerEvents: "none",
          }}
        />
      )}
      {perfOpen && <PerfOverlay onClose={() => setPerfOpen(false)} />}
      {cheatsheetOpen && <HotkeyCheatsheet onClose={() => setCheatsheetOpen(false)} />}
      <Disconnected connected={connected} starting={embed} />
    </Box>
  );
}
