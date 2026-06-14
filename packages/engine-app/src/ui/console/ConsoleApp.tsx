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
import { useEffect, useRef, useState } from "react";
import { downloadConsoleCapture } from "../../console-capture";
import { Disconnected } from "../Disconnected";
import { useEngine, useEngineState } from "../hooks";
import { fail } from "../util";
import { Header } from "./Header";
import { ParamPanel } from "./ParamPanel";
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

export function ConsoleApp() {
  const link = useEngine();
  const { session, manifests, connected } = useEngineState();
  const [selected, setSelected] = useState<string | null>(null);
  const [solo, setSolo] = useState<string | null>(null);
  const [rackOpen, setRackOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [order, setOrder] = useState<string[]>(loadOrder);

  const applyOrder = (next: string[]) => {
    try {
      localStorage.setItem(ORDER_KEY, JSON.stringify(next));
    } catch {
      // order just won't persist across reloads
    }
    setOrder(next);
  };

  // Tile drags start after 8px of slop, so click/double-click still work.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 8 } }));
  const onDragEnd = (e: DragEndEvent) => {
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
    if (overId == null || overId === activeId || session == null) return;
    const cur = sortTiles(session.instances, order).map((i) => i.id);
    const from = cur.indexOf(activeId);
    const to = cur.indexOf(overId);
    if (from < 0 || to < 0) return;
    applyOrder(arrayMove(cur, from, to));
  };

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

  // Hotkeys — "i" toggles the rack, "p" toggles preview mode, "s" downloads a
  // self-capture of the cockpit (the same path the screenshot_console MCP tool
  // exercises — free human debugging), Escape leaves preview. All ignore the
  // human typing in a field (rename box, save dialog).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target;
      const typing =
        t instanceof HTMLInputElement ||
        t instanceof HTMLSelectElement ||
        t instanceof HTMLTextAreaElement;
      if (typing) return;
      if (e.key === "i") setRackOpen((o) => !o);
      else if (e.key === "p") setPreviewing((p) => !p);
      else if (e.key === "s") void downloadConsoleCapture().catch(fail);
      else if (e.key === "Escape") setPreviewing(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Box
      sx={{ height: "100vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
      // AudioContexts need a user gesture; the embedded engine's document never
      // gets one, but activation is visible to same-origin frames — forward ours.
      onPointerDownCapture={() => {
        (embedFrame.current?.contentWindow as EngineWindow | null)?.__loom?.resumeAudio?.();
      }}
    >
      {session && (
        <DndContext sensors={sensors} collisionDetection={collision} onDragEnd={onDragEnd}>
          <StageDropZone>
            <Header
              session={session}
              onToggleRack={() => setRackOpen((o) => !o)}
              previewing={previewing}
              onTogglePreview={() => setPreviewing((p) => !p)}
            />
            <StageStrip session={session} />
          </StageDropZone>
          <Box component="main" sx={{ flex: 1, display: "flex", minHeight: 0 }}>
            <TileGrid
              session={session}
              selected={selected}
              solo={solo}
              order={order}
              onOrderChange={applyOrder}
              onSelect={setSelected}
              onSolo={(id) => setSolo((cur) => (cur === id ? null : id))}
              onCreated={setSelected}
            />
            {/* While previewing, the overlay carries the (single) params drawer —
                don't mount a second one here or two #panel ids would collide. */}
            {!previewing && (
              <ParamPanel
                instance={selected}
                manifest={selected != null ? manifests[selected] : undefined}
                session={session}
              />
            )}
          </Box>
          {rackOpen && <Rack session={session} globals={manifests.globals ?? {}} />}
        </DndContext>
      )}
      {session && previewing && (
        <PreviewMode
          instance={selected}
          manifest={selected != null ? manifests[selected] : undefined}
          session={session}
          onExit={() => setPreviewing(false)}
        />
      )}
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
      <Disconnected connected={connected} starting={embed} />
    </Box>
  );
}
