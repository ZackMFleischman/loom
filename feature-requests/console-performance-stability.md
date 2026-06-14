# Console performance & stability

**Status:** requested (2026-06-13). Not yet investigated.

The Loom Console isn't stable — it looks like it's having performance problems.

## Symptoms observed

- An "Aw, snap" crash with **Error code STATUS_BREAKPOINT**.
- Not all instance previews are loading.
- Clicking a dropdown — the options in the popover are **super delayed** in showing up.
- Generally feels like **very low FPS**.

## Ask

- Debug through this **methodically**, find the root cause(s), then implement fixes.
- Make it **robust**.

## Secondary goal

- In general we should have ways for the **user to diagnose and see perf problems in the UI**. Explore options around this too.

## Related

- [[app-instrumentation]] — instrumentation could feed the in-UI perf diagnostics.
