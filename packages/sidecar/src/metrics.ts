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

/** Per-tool call latency + outcome (FR-6) — the one layer the engine can't see. */
export interface ToolLatency {
  tool: string;
  count: number;
  ok: number;
  error: number;
  timeout: number;
  /** Latency percentiles (ms) over the observed durations. */
  p50: number;
  p95: number;
  /** Slowest observed call (ms). */
  max: number;
  /** Last error message for this tool, or null. */
  lastError: string | null;
}

/**
 * Mutable per-tool latency accumulator. Durations are kept in a bounded sample
 * window so percentiles cost a small sort on read (off the hot path) and memory
 * stays bounded across a multi-hour session (NFR-3 in spirit).
 */
interface LatencyAcc {
  count: number;
  ok: number;
  error: number;
  timeout: number;
  max: number;
  lastError: string | null;
  /** Recent durations (ms), newest pushed; capped at {@link LATENCY_SAMPLES}. */
  samples: number[];
}

/** Per-tool retained latency samples for percentile estimation. */
const LATENCY_SAMPLES = 200;

export class ToolMetrics {
  private readonly counts = new Map<string, number>();
  private batchedCalls = 0;
  private batchCount = 0;
  private missedBatchable = 0;
  private total = 0;
  // Current unbroken run of set_param to one instance (any other tool breaks it).
  private runInstance: string | null = null;
  // Per-tool latency/outcome table (FR-6), populated by observe().
  private readonly latency = new Map<string, LatencyAcc>();

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

  /**
   * Record one settled MCP/WS call's latency + outcome (FR-6). Called from the
   * broker at settle. Never throws — instrumentation must not break a tool call.
   */
  observe(tool: string, durationMs: number, outcome: "ok" | "error" | "timeout", error?: string): void {
    try {
      let acc = this.latency.get(tool);
      if (acc == null) {
        acc = { count: 0, ok: 0, error: 0, timeout: 0, max: 0, lastError: null, samples: [] };
        this.latency.set(tool, acc);
      }
      acc.count++;
      acc[outcome]++;
      if (durationMs > acc.max) acc.max = durationMs;
      if (outcome !== "ok" && error != null) acc.lastError = error;
      acc.samples.push(durationMs);
      if (acc.samples.length > LATENCY_SAMPLES) acc.samples.shift();
    } catch {
      // never let metrics break a real call
    }
  }

  /** The per-tool latency/outcome table, percentiles computed on read (FR-6). */
  latencyTable(): ToolLatency[] {
    return [...this.latency.entries()]
      .map(([tool, a]) => ({
        tool,
        count: a.count,
        ok: a.ok,
        error: a.error,
        timeout: a.timeout,
        p50: pct(a.samples, 0.5),
        p95: pct(a.samples, 0.95),
        max: Math.round(a.max * 100) / 100,
        lastError: a.lastError,
      }))
      .sort((x, y) => y.count - x.count);
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

/** Nearest-rank percentile of a duration sample (ms), rounded to 2 dp. 0 when empty. */
function pct(samples: number[], q: number): number {
  if (samples.length === 0) return 0;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return Math.round(sorted[idx]! * 100) / 100;
}
