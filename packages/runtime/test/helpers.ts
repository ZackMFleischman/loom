import type { FrameCtx } from "../src/frame";

export const F = (frame: number, now = frame / 60, dt = 1 / 60): FrameCtx => ({
  frame,
  now,
  dt,
});

/** Generate a sequence of consecutive frames at a fixed dt. */
export function frames(count: number, dt = 1 / 60, startFrame = 0): FrameCtx[] {
  const out: FrameCtx[] = [];
  for (let i = 0; i < count; i++) {
    out.push({ frame: startFrame + i, now: (startFrame + i) * dt, dt });
  }
  return out;
}
