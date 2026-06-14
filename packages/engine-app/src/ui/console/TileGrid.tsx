import { SortableContext, rectSortingStrategy } from "@dnd-kit/sortable";
import { Box } from "@mui/material";
import { memo, useCallback, useRef, useState } from "react";
import { useInstanceIds } from "../hooks";
import { countRender } from "../util";
import { NewInstanceTile } from "./NewInstanceTile";
import { Tile } from "./Tile";

type Props = {
  /** Available scene names for the "+" picker (from the rarely-changing meta slice). */
  scenes: string[];
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

/** Sort bare ids by the persisted order (the id-only variant of {@link sortTiles}). */
function sortIds(ids: string[], order: string[]): string[] {
  const pos = (id: string) => {
    const i = order.indexOf(id);
    return i < 0 ? order.length : i;
  };
  return [...ids].sort((a, b) => pos(a) - pos(b));
}

/**
 * The instance grid. Tiles drag-reorder via dnd-kit sortables (order persists
 * locally; the DndContext in ConsoleApp also lets the same drag go LIVE on the
 * stage bar). DOM contract: #grid, tiles render in display order.
 */
function TileGridImpl({ scenes, selected, solo, order, onOrderChange, onSelect, onSolo, onCreated }: Props) {
  countRender("TileGrid");
  // The grid wakes only on instance add/remove/reorder (the id LIST slice), not
  // on the 10 Hz per-instance churn — each Tile subscribes to its own slice.
  const ids = useInstanceIds();
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
  // Stable callbacks so the memoized Tiles don't re-render on a grid render.
  const hidePreview = useCallback((id: string) => {
    hiddenPreviews.current.set(id, false);
    bump((n) => n + 1);
  }, []);
  const adoptPreview = useCallback((id: string) => {
    hiddenPreviews.current.delete(id);
    bump((n) => n + 1);
  }, []);

  for (const [id, seen] of hiddenPreviews.current) {
    const inSession = ids.includes(id);
    if (inSession) {
      if (!seen) hiddenPreviews.current.set(id, true);
    } else if (seen) {
      hiddenPreviews.current.delete(id); // gone for good — ids never repeat
    }
  }

  const sorted = sortIds(
    ids.filter((id) => !hiddenPreviews.current.has(id)),
    order,
  );

  // A rename keeps the tile's slot and the selection: pin the whole current
  // visual order with the new id swapped in (the engine re-keys the entry to
  // the end of its map, so an unpinned tile would jump). Kept stable via a ref to
  // the latest sorted order so the memoized Tiles' `onRenamed` prop never churns.
  const sortedRef = useRef(sorted);
  sortedRef.current = sorted;
  const renamed = useCallback(
    (from: string, to: string) => {
      onOrderChange(sortedRef.current.map((id) => (id === from ? to : id)));
      onSelect(to);
    },
    [onOrderChange, onSelect],
  );

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
      <SortableContext items={sorted} strategy={rectSortingStrategy}>
        {sorted.map((id) => (
          <Tile
            key={id}
            id={id}
            selected={id === selected}
            solo={id === solo}
            onSelect={onSelect}
            onSolo={onSolo}
            onRenamed={renamed}
          />
        ))}
      </SortableContext>
      <NewInstanceTile
        scenes={scenes}
        onCreated={onCreated}
        onPreviewSpawn={hidePreview}
        onPreviewAdopt={adoptPreview}
      />
    </Box>
  );
}

/**
 * Memoized (FR-1): ConsoleApp re-renders ~10 Hz on the state broadcast, but the
 * grid only needs to re-render on instance add/remove/reorder (its own
 * `useInstanceIds`) or a selection/order change — all its props are now stable
 * (primitives + useCallback'd handlers), so the shallow comparison holds and the
 * 10 Hz parent render no longer reconciles the whole grid.
 */
export const TileGrid = memo(TileGridImpl);
