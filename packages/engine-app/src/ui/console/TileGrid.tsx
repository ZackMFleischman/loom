import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { Box } from "@mui/material";
import { useRef, useState } from "react";
import type { SessionSnapshot } from "@loom/sidecar/protocol";
import { NewInstanceTile } from "./NewInstanceTile";
import { Tile } from "./Tile";

type Props = {
  session: SessionSnapshot;
  selected: string | null;
  solo: string | null;
  /** Display order (ConsoleApp owns it — the DndContext lives up there). */
  order: string[];
  onOrderChange: (next: string[]) => void;
  onSelect: (id: string) => void;
  onSolo: (id: string) => void;
  onCreated: (id: string) => void;
};

/** Sort instance ids by a persisted order; unknown ids keep engine order at the end. */
export function sortTiles<T extends { id: string }>(instances: T[], order: string[]): T[] {
  const pos = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  return [...instances].sort((a, b) => pos(a.id) - pos(b.id));
}

/**
 * The instance grid. Tiles drag-reorder via dnd-kit sortables (order persists
 * locally; the DndContext in ConsoleApp also lets the same drag go LIVE on the
 * stage bar). DOM contract: #grid, tiles render in display order.
 */
export function TileGrid({ session: s, selected, solo, order, onOrderChange, onSelect, onSolo, onCreated }: Props) {
  // The "+" tile's preview instances render inside that tile, never as grid
  // tiles. Hiding must outlive the preview pointer: a destroyed preview stays
  // in the session for a state tick or two, and clearing its id immediately
  // made the dying tile flash in (shifting the whole grid — the flicker).
  // Spawned ids stay hidden until they leave the session; picking adopts one.
  // id → "seen in a session snapshot yet". Hidden ids are added at
  // create-response time, often BEFORE the 10 Hz snapshot includes them —
  // prune only after seen-then-gone, or fresh ids get unhidden by the race.
  const hiddenPreviews = useRef<Map<string, boolean>>(new Map());
  const [, bump] = useState(0);
  const hidePreview = (id: string) => {
    hiddenPreviews.current.set(id, false);
    bump((n) => n + 1);
  };
  const adoptPreview = (id: string) => {
    hiddenPreviews.current.delete(id);
    bump((n) => n + 1);
  };

  for (const [id, seen] of hiddenPreviews.current) {
    const inSession = s.instances.some((i) => i.id === id);
    if (inSession) {
      if (!seen) hiddenPreviews.current.set(id, true);
    } else if (seen) {
      hiddenPreviews.current.delete(id); // gone for good — ids never repeat
    }
  }

  const sorted = sortTiles(
    s.instances.filter((i) => !hiddenPreviews.current.has(i.id)),
    order,
  );

  // A rename keeps the tile's slot and the selection: pin the whole current
  // visual order with the new id swapped in (the engine re-keys the entry to
  // the end of its map, so an unpinned tile would jump).
  const renamed = (from: string, to: string) => {
    onOrderChange(sorted.map((i) => (i.id === from ? to : i.id)));
    onSelect(to);
  };

  return (
    <Box
      id="grid"
      sx={{
        flex: 1,
        display: "grid",
        gridTemplateColumns: "repeat(auto-fill, minmax(480px, 1fr))",
        gap: 1,
        p: 1,
        alignContent: "start",
        overflowY: "auto",
      }}
    >
      <SortableContext items={sorted.map((i) => i.id)} strategy={rectSortingStrategy}>
        {sorted.map((inst) => (
          <Tile
            key={inst.id}
            inst={inst}
            isLive={inst.id === s.live}
            isStaged={inst.id === s.staged}
            selected={inst.id === selected}
            solo={inst.id === solo}
            engineFps={s.fps}
            onSelect={onSelect}
            onSolo={onSolo}
            onRenamed={renamed}
          />
        ))}
      </SortableContext>
      <NewInstanceTile
        scenes={s.availableScenes}
        onCreated={onCreated}
        onPreviewSpawn={hidePreview}
        onPreviewAdopt={adoptPreview}
      />
    </Box>
  );
}
