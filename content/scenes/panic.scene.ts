// The PANIC pointer: the scene the engine routes to in SAFE SCENE panic mode.
// Twin of live.scene.ts — a one-line re-export with the same HMR semantics and
// the same "don't delete it" rule. The engine builds a dedicated, always-warm
// "panic" instance from whatever this points at. Repoint it to designate a
// different safe scene (e.g. a venue blackout or logo).
export { default } from "./safe.scene";
