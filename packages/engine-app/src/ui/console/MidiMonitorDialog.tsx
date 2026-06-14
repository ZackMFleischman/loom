import { Box, Dialog, DialogContent, DialogTitle, Stack, Typography } from "@mui/material";
import type { SessionSnapshot } from "@loom/sidecar/protocol";
import { mono } from "../theme";

type Midi = SessionSnapshot["midi"];
type Msg = Midi["recent"][number];

const hex = (b: number) => b.toString(16).padStart(2, "0");

/** Human gloss for one message; CC is what LOOM acts on, the rest is context. */
function describe(m: Msg): string {
  const d = m.data;
  switch (m.kind) {
    case "cc":
      return `CC ${d[1]} = ${d[2]}`;
    case "noteon":
      return `note ${d[1]} vel ${d[2]}`;
    case "noteoff":
      return `note ${d[1]} off`;
    case "pitchbend":
      return `bend ${((((d[2] ?? 0) << 7) | (d[1] ?? 0)) - 8192).toString()}`;
    case "program":
      return `program ${d[1]}`;
    default:
      return m.kind;
  }
}

type Props = { midi: Midi; open: boolean; onClose: () => void };

/**
 * Live raw-MIDI monitor (header → MIDI status click): the last messages the
 * engine received, INCLUDING ones it ignores (LOOM binds Control Change only).
 * This is the "is my controller actually saying what I think?" debugging view —
 * e.g. a nanoKONTROL2 stuck in a DAW mode sends pitch bend from its faders,
 * which is invisible everywhere else in the UI.
 */
export function MidiMonitorDialog({ midi, open, onClose }: Props) {
  const msgs = [...midi.recent].reverse(); // newest first
  const ignored = msgs.some((m) => m.kind !== "cc");
  return (
    <Dialog open={open} onClose={onClose} maxWidth="xs" fullWidth>
      <DialogTitle sx={{ fontFamily: mono, fontSize: 15 }}>
        MIDI monitor
        <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
          {midi.status !== "ready"
            ? "no access yet"
            : midi.devices.length > 0
              ? midi.devices.join(" · ")
              : "no devices"}
        </Typography>
      </DialogTitle>
      <DialogContent>
        <Stack id="midimon" spacing={0.25} sx={{ fontFamily: mono, fontSize: 12, minHeight: 120 }}>
          {msgs.length === 0 && (
            <Typography variant="caption" color="text.secondary">
              no messages yet — move a control on your controller
            </Typography>
          )}
          {msgs.map((m, i) => (
            <Stack key={`${msgs.length - i}`} direction="row" spacing={1} alignItems="baseline">
              <Box component="span" sx={{ color: "text.secondary", width: 70, flex: "0 0 auto" }}>
                {m.data.map(hex).join(" ")}
              </Box>
              <Box component="span" sx={{ width: 36, flex: "0 0 auto", color: "text.secondary" }}>
                {m.ch != null ? `ch ${m.ch}` : "sys"}
              </Box>
              <Box component="span" sx={{ color: m.kind === "cc" ? "text.primary" : "warning.main" }}>
                {describe(m)}
                {m.kind !== "cc" && " · ignored"}
              </Box>
            </Stack>
          ))}
        </Stack>
        {ignored && (
          <Typography variant="caption" color="warning.main" sx={{ display: "block", mt: 1 }}>
            LOOM binds Control Change only. Faders sending pitch bend / knobs repeating one value
            usually mean the controller is in a DAW mode — factory-reset it to CC mode.
          </Typography>
        )}
      </DialogContent>
    </Dialog>
  );
}
