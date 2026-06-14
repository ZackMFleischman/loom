import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { Box, Button, Card, IconButton, Stack, Typography } from "@mui/material";
import { alpha, type Theme } from "@mui/material/styles";
import { memo, useEffect, useState, type ChangeEvent, type KeyboardEvent, type MouseEvent } from "react";
import { tileFps } from "../fps-meter";
import { useEngine, useEngineFps, useStagePointers, useThumb, useTile } from "../hooks";
import { snapshotScene } from "../scene-thumbs";
import { countRender, fail } from "../util";
import { hintFor } from "./keybindings";
import { StatusPill } from "./primitives";

type Props = {
  /** This tile's instance id. Tile reads its own slice (FR-1) — no `inst` prop. */
  id: string;
  selected: boolean;
  solo: boolean;
  onSelect: (id: string) => void;
  onSolo: (id: string) => void;
  /** The engine accepted a rename — keep order/selection pointing at the new id. */
  onRenamed: (from: string, to: string) => void;
};

/**
 * One instance tile. DOM contract: .tile[data-id], child <img> (src only once
 * a thumb arrives), .live-badge/.staged-badge with a "show" class, .stagebtn
 * with exact text "stage"/"unstage". The whole card is a dnd-kit sortable
 * (pointer drags after an 8px slop, so click/double-click still select/solo);
 * the same drag released on the stage bar goes live.
 *
 * Two visual channels that never compete: stage status is the INNER ring
 * (red LIVE / amber STAGED, hugging the card) + chip; selection is an OUTER
 * green halo offset past a gap, plus a tinted name row — a selected live tile
 * reads as "red ring inside a green halo".
 */
function TileImpl({ id, selected, solo, onSelect, onSolo, onRenamed }: Props) {
  countRender("Tile");
  const link = useEngine();
  const inst = useTile(id);
  const pointers = useStagePointers();
  const engineFps = useEngineFps();
  const thumb = useThumb(id);
  const isLive = pointers.live === id;
  const isStaged = pointers.staged === id;
  // Every rendering instance keeps its scene's snapshot fresh — the scene
  // picker shows these as "last time it ran". (Hooks before the early return.)
  // Depend only on the scene + thumb actually read, not the whole slice — a
  // frameMs tick must not re-run this. (biome wants `inst`; that's intentional.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: scene+thumb are the only inputs used
  useEffect(() => {
    if (inst != null) snapshotScene(inst.scene, thumb);
  }, [inst?.scene, thumb]);

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(id);
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: editing,
  });
  // The slice can briefly be absent (a fresh id before the next state tick, or a
  // just-destroyed one): render nothing rather than crash — TileGrid drives keys.
  if (inst == null) return null;
  const fps = tileFps(inst.frameMs, engineFps, inst.status !== "ok");
  const startRename = () => {
    setDraft(inst.id);
    setEditing(true);
  };
  const commitRename = () => {
    setEditing(false);
    const to = draft.trim();
    if (!to || to === inst.id) return;
    void link
      .req("rename_instance", { instance: inst.id, to })
      .then(() => onRenamed(inst.id, to))
      .catch(fail);
  };
  const onRenameKey = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.key === "Enter") commitRename();
    if (e.key === "Escape") setEditing(false);
  };

  const ring = (t: Theme): string => {
    const status = isLive ? t.palette.error.main : isStaged ? t.palette.warning.main : null;
    if (selected) {
      // status ring inside · gap · selection halo outside
      const inner = status ?? t.palette.primary.main;
      return `0 0 0 1.5px ${inner}, 0 0 0 3.5px ${t.palette.background.default}, 0 0 0 5px ${t.palette.primary.main}`;
    }
    return status ? `0 0 0 1.5px ${status}` : "none";
  };

  return (
    <Card
      className="tile"
      data-id={inst.id}
      variant="outlined"
      ref={setNodeRef}
      style={{ transform: CSS.Transform.toString(transform), transition }}
      {...attributes}
      {...listeners}
      onClick={() => onSelect(inst.id)}
      onDoubleClick={() => onSolo(inst.id)}
      sx={(t) => ({
        position: "relative",
        cursor: "grab",
        opacity: isDragging ? 0.6 : 1,
        zIndex: isDragging ? 2 : undefined,
        bgcolor: "background.paper",
        borderColor: isLive ? "error.main" : isStaged ? "warning.main" : selected ? "primary.main" : "divider",
        boxShadow: ring(t),
        gridColumn: solo ? "1 / -1" : undefined,
        "&:hover .destroybtn": { opacity: 1, pointerEvents: "auto" },
      })}
    >
      <Box
        component="img"
        alt=""
        src={thumb}
        sx={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", display: "block", bgcolor: "#000" }}
      />
      <StatusPill kind="live" variant="badge" badgeClass="live-badge" show={isLive} sx={{ left: 6 }} />
      <StatusPill
        kind="staged"
        variant="badge"
        badgeClass="staged-badge"
        show={isStaged}
        sx={{ left: isLive ? 44 : 6 }}
      />
      {inst.pinned === "panic" && (
        <StatusPill
          kind="safe"
          variant="badge"
          badgeClass="safe-badge"
          title="SAFE target — scene-panic cuts here; protected from destroy while designated"
          sx={{ right: 6 }}
        />
      )}
      {!isLive && inst.pinned !== "panic" && (
        <IconButton
          className="destroybtn"
          title={`destroy ${hintFor("destroy")}`}
          size="small"
          onClick={(e) => {
            e.stopPropagation();
            void link.req("destroy_instance", { instance: inst.id }).catch(fail);
          }}
          sx={{
            position: "absolute",
            top: 2,
            right: 2,
            opacity: 0,
            pointerEvents: "none",
            transition: "opacity 120ms",
            color: "#fff",
            bgcolor: "#000a",
            fontSize: 14,
            width: 22,
            height: 22,
            "&:hover": { bgcolor: "error.main" },
          }}
        >
          ×
        </IconButton>
      )}
      <Stack
        direction="row"
        spacing={0.75}
        alignItems="center"
        sx={(t) => ({
          px: 1,
          py: 0.5,
          color: "text.primary",
          bgcolor: selected ? alpha(t.palette.primary.main, 0.12) : "transparent",
        })}
      >
        <Box
          component="span"
          className={`chip ${inst.status}`}
          title={inst.error ?? inst.status}
          sx={{ fontWeight: 700, fontSize: 11, color: inst.status === "ok" ? "primary.main" : "error.main" }}
        >
          {inst.status === "ok" ? "✓" : "✗"}
        </Box>
        {editing ? (
          <Box
            component="input"
            autoFocus
            value={draft}
            onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
            onKeyDown={onRenameKey}
            onBlur={commitRename}
            onClick={(e: MouseEvent) => e.stopPropagation()}
            onDoubleClick={(e: MouseEvent) => e.stopPropagation()}
            sx={{
              flex: 1,
              minWidth: 0,
              font: "inherit",
              color: "inherit",
              bgcolor: "#0006",
              border: 1,
              borderColor: "primary.main",
              borderRadius: "3px",
              px: 0.5,
              py: 0,
              outline: "none",
            }}
          />
        ) : (
          <Typography
            className="name"
            variant="body2"
            noWrap
            title={`scene: ${inst.scene} — double-click to rename`}
            onDoubleClick={(e) => {
              e.stopPropagation();
              startRename();
            }}
            sx={{ flex: 1, minWidth: 0, cursor: "text" }}
          >
            {inst.id}
          </Typography>
        )}
        <Typography
          className="tilefps"
          data-fps={fps}
          variant="caption"
          title="per-tile render rate — engine fps, capped by this tile's CPU budget (0 = frozen)"
          sx={{
            fontSize: 10,
            fontWeight: 700,
            color: inst.status !== "ok" ? "error.main" : fps < 30 ? "warning.main" : "primary.main",
            flex: "0 0 auto",
          }}
        >
          {fps.toFixed(0)}fps
        </Typography>
        <Typography
          className="framems"
          data-ms={inst.frameMs}
          variant="caption"
          title="per-frame render cost (CPU submit, smoothed) — the perf early-warning meter"
          sx={{
            fontSize: 10,
            color: inst.frameMs > 8 ? "warning.main" : "text.secondary",
            opacity: 0.85,
            flex: "0 0 auto",
          }}
        >
          {inst.frameMs.toFixed(1)}ms
        </Typography>
        <Button
          className="stagebtn"
          title={`stage / unstage this tile ${hintFor("stage")}`}
          disabled={isLive}
          onClick={(e) => {
            e.stopPropagation();
            void link.req(isStaged ? "unstage" : "stage", isStaged ? {} : { instance: inst.id }).catch(fail);
          }}
          sx={{ px: 0.75, py: 0, fontSize: 11 }}
        >
          {isStaged ? "unstage" : "stage"}
        </Button>
      </Stack>
    </Card>
  );
}

/**
 * Memoized so a tile re-renders ONLY when its own props change (FR-1). Its
 * instance data, thumbnail, stage pointers and fps all arrive via narrow
 * selector stores (useInstance/useThumb/useStagePointers/useEngineFps), so the
 * 10 Hz state broadcast no longer reconciles the whole grid — each tile wakes on
 * its own slice. Props are now all primitives + stable callbacks, so the default
 * shallow comparison is correct.
 */
export const Tile = memo(TileImpl);
