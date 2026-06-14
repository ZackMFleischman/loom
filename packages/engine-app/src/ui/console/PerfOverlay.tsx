import { Box, Stack, Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { useRenderFps } from "../fps-meter";
import { useEngineState } from "../hooks";

/**
 * PerfOverlay (console-performance-stability FR-6): a toggleable, READ-ONLY
 * in-UI perf-diagnostics panel — the human's window into the same instrumentation
 * pipeline the agent reads over MCP ("one pipeline, two readers").
 *
 * It surfaces only meters that already exist on the wire — it builds NO new
 * pipeline (NFR-5):
 *  - Console UI paint rate (`#uifps`, the React app's own loop) — the meter that
 *    drops under the re-render storm this feature fixes.
 *  - Output engine fps + clock source (from the broadcast `perf` rollup — the
 *    SAME `PerfSnapshot` the agent gets via `get_diagnostics.perf` /
 *    `get_session.perf`).
 *  - Thumbnail pass time (`perf.thumbPassMs`) — the Console back-pressure meter
 *    (FR-2); a value approaching the 150 ms thumb interval means passes are
 *    saturating and the round-robin cap is doing its job.
 *  - Worst recent frame + the costliest instance's `frameMs` and `slowSignals`
 *    (the per-signal cost attribution already on `InstanceInfo`).
 *  - three's renderer.info counts when the backend exposes them (leak watch).
 *  - A coarse JS heap readout (`performance.memory`, Chromium only).
 *
 * Never touches the live path; the overlay is pure presentation over data already
 * flowing for the tiles. Toggled from the Header button or the `d` hotkey
 * (consistent with the existing `i`/`p`).
 */
export function PerfOverlay({ onClose }: { onClose: () => void }) {
  const uiFps = useRenderFps();
  // The overlay is mounted only while open, so reading the whole snapshot here
  // (its 10 Hz re-render) is bounded to this one panel — the tiles stay isolated.
  const { session } = useEngineState();
  const perf = session?.perf;
  const [heapMB, setHeapMB] = useState<number | null>(null);

  // Sample the coarse heap on a slow timer (Chromium-only; null elsewhere).
  useEffect(() => {
    const read = () => {
      const m = (performance as Performance & { memory?: { usedJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
      setHeapMB(m ? Math.round(m.usedJSHeapSize / 1e5) / 10 : null);
    };
    read();
    const t = window.setInterval(read, 1000);
    return () => window.clearInterval(t);
  }, []);

  const instances = session?.instances ?? [];
  const costliest = instances.reduce<(typeof instances)[number] | null>(
    (worst, i) => (worst == null || i.frameMs > worst.frameMs ? i : worst),
    null,
  );

  return (
    <Box
      id="perfoverlay"
      role="dialog"
      aria-label="performance diagnostics"
      sx={{
        position: "fixed",
        top: 56,
        right: 12,
        zIndex: 1400,
        width: 320,
        maxHeight: "80vh",
        overflowY: "auto",
        p: 1.5,
        bgcolor: "rgba(12,14,18,0.94)",
        border: 1,
        borderColor: "divider",
        borderRadius: 1.5,
        boxShadow: 8,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      }}
    >
      <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
        <Typography sx={{ fontWeight: 800, letterSpacing: ".12em", fontSize: 13, flex: 1 }}>
          PERF DIAGNOSTICS
        </Typography>
        <Box
          component="button"
          id="perfoverlay-close"
          onClick={onClose}
          aria-label="close perf overlay"
          sx={{
            border: 0,
            bgcolor: "transparent",
            color: "text.secondary",
            cursor: "pointer",
            fontSize: 16,
            lineHeight: 1,
            "&:hover": { color: "text.primary" },
          }}
        >
          ×
        </Box>
      </Stack>

      <Row label="ui fps" value={uiFps.toFixed(0)} warn={uiFps > 0 && uiFps < 50} cls="perf-uifps" />
      <Row label="out fps" value={(perf?.fps ?? session?.fps ?? 0).toFixed(0)} cls="perf-outfps" />
      <Row label="clock" value={perf?.clockSource ?? "?"} />
      <Row
        label="thumb pass"
        value={perf?.thumbPassMs != null ? `${perf.thumbPassMs.toFixed(0)} ms` : "—"}
        warn={(perf?.thumbPassMs ?? 0) > 130}
        cls="perf-thumbms"
      />
      <Row
        label="worst frame"
        value={perf?.worstFrameMsRecent != null ? `${perf.worstFrameMsRecent.toFixed(1)} ms` : "—"}
        warn={(perf?.worstFrameMsRecent ?? 0) > 16.7}
      />
      <Row label="instances" value={String(instances.length)} />
      <Row label="heap" value={heapMB != null ? `${heapMB.toFixed(1)} MB` : "n/a"} cls="perf-heap" />
      {perf?.renderer != null && (
        <Row
          label="gpu res"
          value={`g${perf.renderer.geometries} t${perf.renderer.textures} d${perf.renderer.drawCalls}`}
        />
      )}

      {costliest != null && costliest.frameMs > 0 && (
        <Box sx={{ mt: 1.25, pt: 1, borderTop: 1, borderColor: "divider" }}>
          <Typography sx={{ fontSize: 11, color: "text.secondary", mb: 0.5 }}>
            costliest · {costliest.id} ({costliest.frameMs.toFixed(1)} ms)
          </Typography>
          {costliest.slowSignals.length === 0 ? (
            <Typography sx={{ fontSize: 11, color: "text.secondary" }}>no signal cost (profiling off?)</Typography>
          ) : (
            costliest.slowSignals
              .slice(0, 4)
              .map((s) => <Row key={s.label} label={s.label} value={`${s.ms.toFixed(2)} ms`} small />)
          )}
        </Box>
      )}
    </Box>
  );
}

function Row({
  label,
  value,
  warn,
  small,
  cls,
}: {
  label: string;
  value: string;
  warn?: boolean;
  small?: boolean;
  cls?: string;
}) {
  return (
    <Stack direction="row" sx={{ py: 0.25 }}>
      <Typography sx={{ fontSize: small ? 11 : 12, color: "text.secondary", flex: 1, minWidth: 0 }} noWrap>
        {label}
      </Typography>
      <Typography
        className={cls}
        sx={{ fontSize: small ? 11 : 12, fontWeight: 700, color: warn ? "warning.main" : "text.primary" }}
      >
        {value}
      </Typography>
    </Stack>
  );
}
