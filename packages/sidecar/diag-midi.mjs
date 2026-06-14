// One-shot diagnostic: pose as the sidecar on 7341, wait for the live engine
// to dial in, and dump the MIDI-relevant slice of its session snapshot.
import { WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: Number(process.env.LOOM_WS_PORT) || 7341 });
const bail = setTimeout(() => {
  console.log("NO_ENGINE: nothing connected within 20s — is the Output window open?");
  process.exit(2);
}, 20_000);

wss.on("connection", (ws) => {
  clearTimeout(bail);
  ws.send(JSON.stringify({ id: "d1", kind: "req", type: "get_session", args: {} }));
  ws.on("message", (data) => {
    const res = JSON.parse(data.toString());
    if (!res.ok) {
      console.log("ENGINE_ERROR:", res.error);
      process.exit(1);
    }
    const s = res.result;
    console.log(
      JSON.stringify(
        {
          frame: s.frame,
          fps: s.fps,
          audioMode: s.audioMode,
          midi: s.midi ?? "MISSING (engine running pre-fix code)",
          bindings: s.bindings,
          inputs: s.inputs,
          live: s.live,
          scene: s.scene,
        },
        null,
        2,
      ),
    );
    process.exit(0);
  });
});
wss.on("error", (e) => {
  console.log("WS_BIND_ERROR:", e.message, "(a real sidecar likely holds the port)");
  process.exit(1);
});
console.log("listening on 7341, waiting for the engine (reconnects every 2s)…");
