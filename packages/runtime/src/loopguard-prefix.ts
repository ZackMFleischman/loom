/**
 * The loop-guard throw's message prefix, factored into a DEPENDENCY-FREE module
 * so the browser kernel (instance.ts) can recognize a loop-guard trip without
 * importing loopguard.ts — which pulls in the `typescript` compiler (a Node,
 * build-time-only dependency that must never enter the engine bundle).
 *
 * loopguard.ts re-exports {@link LOOP_GUARD_PREFIX} so its public API is
 * unchanged.
 */
export const LOOP_GUARD_PREFIX = "[loom] loop guard: ";
