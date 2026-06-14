export class FpsMeter {
  /** Last measured fps; 0 until the first 500 ms window completes. */
  current = 0;

  private frames = 0;
  private last = performance.now();

  constructor(private readonly el: HTMLElement) {}

  tick(): void {
    this.frames++;
    const now = performance.now();
    const elapsed = now - this.last;
    if (elapsed >= 500) {
      this.current = (this.frames * 1000) / elapsed;
      this.el.textContent = `${this.current.toFixed(0)} fps`;
      this.frames = 0;
      this.last = now;
    }
  }
}
