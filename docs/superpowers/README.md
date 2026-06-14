# docs/superpowers/

**In-flight plan/spec pairs only.** Each `plans/<date>-<name>.md` (and its optional
`specs/<date>-<name>-design.md`) is the execution scratch for one milestone —
subagent task lists with checkboxes, not a durable reference.

## Graduate-to-history rule

**A plan graduates to `docs/history/superpowers/` the moment its milestone hits the
`docs/roadmap.md` Shipped table.** Move the plan *and* its paired spec together with
`git mv` (preserve history); never delete them — they hold rationale that
`DECISIONS.md` only summarizes. The durable facts (the *why*) belong in a `DECISIONS.md`
SHIPPED entry or a skill; the long-form plan is the archived record.

Keeping this rule is why this folder shouldn't re-accumulate stale, shipped plans the
way it did before the 2026-06-13 audit.
