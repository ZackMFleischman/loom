import { useDndContext, useDroppable } from "@dnd-kit/core";
import { Box, Typography } from "@mui/material";
import type { ReactNode } from "react";

/** The droppable id ConsoleApp's onDragEnd matches to stage + commit. */
export const STAGE_ZONE_ID = "stage-zone";

/**
 * Drop-to-go-live target spanning the whole console top (header + stage
 * strip — the strip alone was too thin to hit mid-set): dropping a tile
 * anywhere up top stages AND commits (R9.3; the human-sourced commit is
 * never gated). A dnd-kit droppable inside ConsoleApp's DndContext — it
 * arms (outline + label) the moment any tile drag starts and intensifies
 * while hovered; the actual stage+commit fires in ConsoleApp's onDragEnd.
 * #stagestrip keeps its id as the validators' dispatch target.
 */
export function StageDropZone({ children }: { children: ReactNode }) {
  const { setNodeRef, isOver } = useDroppable({ id: STAGE_ZONE_ID });
  // Any active drag in this context is a tile drag (FX chains run their own
  // DndContext inside the param panel — those never arm the zone).
  const armed = useDndContext().active != null;

  return (
    <Box
      ref={setNodeRef}
      sx={{
        position: "relative",
        flex: "0 0 auto",
        outline: armed ? "2px dashed" : "none",
        outlineColor: "warning.main",
        outlineOffset: "-2px",
      }}
    >
      {children}
      {armed && (
        <Typography
          sx={{
            position: "absolute",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            bgcolor: isOver ? "#000c" : "#0007",
            color: "warning.main",
            fontWeight: 700,
            letterSpacing: ".1em",
            pointerEvents: "none",
            zIndex: 1,
            transition: "background-color 120ms",
          }}
        >
          drop to go LIVE
        </Typography>
      )}
    </Box>
  );
}
