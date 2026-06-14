/**
 * Lightweight tool-call instrumentation — the signal for "are agents actually
 * using set_params/batch, or still streaming single set_param calls?" Counts
 * are in-memory only and logged to stderr (stdout belongs to MCP); nothing
 * here touches the wire or the engine.
 *
 * The headline metric is `missedBatchable`: consecutive set_param calls to the
 * SAME instance, unbroken by any other tool, that could have folded into one
 * set_params. Each call past the first in such a run is one missed fold — a
 * direct count of latency left on the table.
 */
export interface MetricsSummary {
  total: number;
  set_param: number;
  set_params: number;
  batch: number;
  /** Sub-calls folded into batches (sum of every batch's call count). */
  batchedCalls: number;
  /** Mean calls per batch, 1 decimal. */
  avgBatchSize: number;
  /** set_param calls that extended a same-instance run (would have folded into set_params). */
  missedBatchable: number;
}

export class ToolMetrics {
  private readonly counts = new Map<string, number>();
  private batchedCalls = 0;
  private batchCount = 0;
  private missedBatchable = 0;
  private total = 0;
  // Current unbroken run of set_param to one instance (any other tool breaks it).
  private runInstance: string | null = null;

  /** Record one inbound tool call by name + its raw args. Never throws. */
  record(tool: string, args: Record<string, unknown> = {}): void {
    this.total++;
    this.counts.set(tool, (this.counts.get(tool) ?? 0) + 1);

    if (tool === "batch") {
      const calls = (args as { calls?: unknown }).calls;
      if (Array.isArray(calls)) {
        this.batchedCalls += calls.length;
        this.batchCount++;
      }
    }

    if (tool === "set_param") {
      const inst = String((args as { instance?: unknown }).instance ?? "live");
      if (this.runInstance === inst) this.missedBatchable++;
      else this.runInstance = inst;
    } else {
      // Any non-set_param call (a read, a screenshot, a different instance flow)
      // closes the current run — the next set_param starts fresh.
      this.runInstance = null;
    }
  }

  summary(): MetricsSummary {
    return {
      total: this.total,
      set_param: this.counts.get("set_param") ?? 0,
      set_params: this.counts.get("set_params") ?? 0,
      batch: this.counts.get("batch") ?? 0,
      batchedCalls: this.batchedCalls,
      avgBatchSize: this.batchCount === 0 ? 0 : Math.round((this.batchedCalls / this.batchCount) * 10) / 10,
      missedBatchable: this.missedBatchable,
    };
  }

  /** Compact one-line digest for stderr. */
  format(): string {
    const s = this.summary();
    return (
      `calls=${s.total} set_param=${s.set_param} set_params=${s.set_params} ` +
      `batch=${s.batch} (avg ${s.avgBatchSize}, ${s.batchedCalls} folded) ` +
      `missedBatchable=${s.missedBatchable}`
    );
  }
}
