/** Error sink for fire-and-forget cockpit requests — never throw into React. */
export const fail = (err: unknown) => console.error("[loom-ui]", err);

/**
 * Chrome gates WebMIDI behind a per-origin permission prompt, and the engine
 * (Output window) is a bare projector page nobody clicks. Requesting access
 * from the cockpit pops the prompt in the window the human is actually using;
 * the grant is origin-wide, and the engine re-attaches the moment it lands.
 */
export function primeMidiPermission(): void {
  const nav = navigator as Navigator & { requestMIDIAccess?: () => Promise<unknown> };
  void nav.requestMIDIAccess?.().catch(() => {});
}
