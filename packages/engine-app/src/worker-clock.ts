/**
 * setInterval that keeps firing in a hidden tab. Browsers clamp main-thread
 * timers to >=1 s (and freeze rAF entirely) when a tab is backgrounded, which
 * starved the Console of frames and previews whenever the Output tab wasn't
 * showing. Dedicated workers are exempt from timer throttling, so the clock
 * ticks there and posts back.
 */
export function workerInterval(fn: () => void, ms: number): () => void {
  const src = `setInterval(() => postMessage(0), ${ms});`;
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  worker.onmessage = fn;
  return () => worker.terminate();
}
