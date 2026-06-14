import { describe, expect, it } from "vitest";
import { injectLoopGuards, isLoopBudgetError, LOOP_GUARD_PREFIX } from "../src/loopguard";

/** Transform `src`, run it with a fresh `s` state object, return `s`. */
function run(src: string, budget: number, state: Record<string, unknown> = {}): Record<string, unknown> {
  const code = injectLoopGuards(src, { budget });
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function("s", code)(state);
  return state;
}

describe("injectLoopGuards", () => {
  it("throws a recognizable error on an infinite while loop", () => {
    let thrown: unknown;
    try {
      run("while (true) { s.n = (s.n || 0) + 1; }", 50);
    } catch (e) {
      thrown = e;
    }
    expect(isLoopBudgetError(thrown)).toBe(true);
    expect((thrown as Error).message).toContain(LOOP_GUARD_PREFIX);
  });

  it("throws on for(;;)", () => {
    expect(() => run("for (;;) { s.n = (s.n || 0) + 1; }", 50)).toThrow(/loop guard/);
  });

  it("lets a finite loop complete with the correct result", () => {
    const s = run("for (let i = 0; i < 10; i++) { s.sum = (s.sum || 0) + i; }", 1000, { sum: 0 });
    expect(s.sum).toBe(45);
  });

  it("resets the budget per loop entry (nested loops share no counter)", () => {
    // Total iterations (3 outer + 9 inner = 12) exceed the budget of 5, but each
    // loop ENTRY gets a fresh counter, so this completes — proving per-entry reset.
    const s = run("for (let i=0;i<3;i++){ for (let j=0;j<3;j++){ s.k = (s.k||0)+1; } }", 5, { k: 0 });
    expect(s.k).toBe(9);
  });

  it("guards a non-block loop body", () => {
    expect(() => run("while (s.go) s.n = (s.n||0)+1;", 20, { go: true, n: 0 })).toThrow(/loop guard/);
  });

  it("guards do-while (both runaway and finite)", () => {
    expect(() => run("do { s.n = (s.n||0)+1; } while (true);", 20, { n: 0 })).toThrow(/loop guard/);
    const s = run("do { s.n = (s.n||0)+1; } while (s.n < 5);", 100, { n: 0 });
    expect(s.n).toBe(5);
  });

  it("guards for-of without changing semantics", () => {
    const s = run("for (const v of [1,2,3]) { s.sum = (s.sum||0)+v; }", 100, { sum: 0 });
    expect(s.sum).toBe(6);
  });

  it("preserves labeled continue/break semantics", () => {
    const s = run(
      "outer: for (let i=0;i<3;i++){ for (let j=0;j<3;j++){ if (j===1) continue outer; s.n=(s.n||0)+1; } }",
      100,
      { n: 0 },
    );
    expect(s.n).toBe(3); // j=0 runs then `continue outer` — once per i
  });

  it("guards a labeled infinite loop", () => {
    expect(() => run("outer: while (true) { s.n=(s.n||0)+1; }", 30, { n: 0 })).toThrow(/loop guard/);
  });

  it("passes loopless code through unchanged in behavior", () => {
    const s = run("s.x = 1 + 2;", 10, {});
    expect(s.x).toBe(3);
  });
});
